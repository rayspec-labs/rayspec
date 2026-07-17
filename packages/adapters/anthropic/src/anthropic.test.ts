/**
 * Deterministic acceptance — credential-INDEPENDENT.
 *
 * Proves the parts that do not need a live Anthropic run:
 *   - per-tenant CLAUDE_CONFIG_DIR isolation (no cross-contamination)
 *   - bundled-binary verification works
 *   - auth-mode self-check detects a stray ANTHROPIC_API_KEY
 *   - JSONL session re-derivation round-trips into neutral ConvItems
 *   - the FAITHFUL recursive tool-arg Zod projection validate-and-repair
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AnthropicAdapter,
  deriveConversationFromObserved,
  jsonSchemaToZodShape,
  jsonSchemaToZodType,
  reconcileAuthMode,
  reDeriveJsonl,
} from './index.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'rayspec-a1-'));
}

describe('Per-tenant config-dir isolation', () => {
  it('creates distinct config dirs per tenant', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const a = adapter.configDirFor('alpha');
    const b = adapter.configDirFor('beta');
    expect(a).not.toBe(b);
    expect(a).toContain('tenant-alpha');
    expect(b).toContain('tenant-beta');
  });
});

describe('tenant config-dir hardening (credential isolation on disk)', () => {
  it('creates the tenant dir private — mode 0700, no group/world access', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const dir = adapter.configDirFor('alpha');
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it('refuses a tenant path that is already a symlink (never follows it into place)', () => {
    const root = tmpRoot();
    symlinkSync(tmpRoot(), join(root, 'tenant-alpha'));
    const adapter = new AnthropicAdapter({ configRoot: root });
    expect(() => adapter.configDirFor('alpha')).toThrow(/symlink|not a directory/);
  });

  it('refuses a group/world-accessible existing tenant dir instead of trusting it', () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'tenant-alpha'), { mode: 0o755 });
    const adapter = new AnthropicAdapter({ configRoot: root });
    expect(() => adapter.configDirFor('alpha')).toThrow(/group|world|access/);
  });

  it('refuses a tenant id that escapes the configured root (containment)', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    expect(() => adapter.configDirFor('nested/evil')).toThrow(/root/);
  });

  it('is idempotent — a second call returns the same private dir without error', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const first = adapter.configDirFor('alpha');
    const second = adapter.configDirFor('alpha');
    expect(second).toBe(first);
    expect(statSync(first).mode & 0o077).toBe(0);
  });
});

describe('config-dir hardening — atomic create, validated on the EEXIST branch', () => {
  // A concurrently-planted (or pre-existing) entry surfaces as EEXIST from the non-recursive mkdir
  // and is validated, never silently accepted. Capping the EEXIST-branch validation lets the bad
  // entry through — the deterministic fail-the-fix (the pure race window is not unit-testable; see
  // the report). chmod defeats umask so the mode is unambiguous regardless of the runner's umask.

  it('rejects a pre-existing group/world-accessible tenant dir (mode-check on EEXIST)', () => {
    const root = tmpRoot();
    const bad = join(root, 'tenant-alpha');
    mkdirSync(bad, { mode: 0o700 });
    chmodSync(bad, 0o077);
    const adapter = new AnthropicAdapter({ configRoot: root });
    // Cap the EEXIST mode-check → this bad dir is returned instead of thrown → RED.
    expect(() => adapter.configDirFor('alpha')).toThrow(/group|world|access/);
  });

  it('rejects a pre-existing regular file at the tenant path (not-a-directory on EEXIST)', () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'tenant-alpha'), 'x', { mode: 0o600 });
    const adapter = new AnthropicAdapter({ configRoot: root });
    // Cap the isDirectory-check → a 0o600 file passes the mode-check + realpath → accepted → RED.
    expect(() => adapter.configDirFor('alpha')).toThrow(/symlink|not a directory/);
  });

  it('rejects a pre-existing symlink at the tenant path (never follows it into place)', () => {
    const root = tmpRoot();
    // Symlink to a real dir DIRECTLY under root so realpath-containment passes — the EEXIST symlink
    // check is then the sole guard.
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), join(root, 'tenant-alpha'));
    const adapter = new AnthropicAdapter({ configRoot: root });
    expect(() => adapter.configDirFor('alpha')).toThrow(/symlink|not a directory/);
  });

  it('a fresh create is atomic and yields a private dir (no group/world bits)', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const dir = adapter.configDirFor('fresh');
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

describe('config-dir hardening — config root mode asserted at boot', () => {
  it('rejects a group/world-accessible config root at construction', () => {
    const root = tmpRoot();
    chmodSync(root, 0o750);
    // Cap assertConfigRoot → construction succeeds → RED.
    expect(() => new AnthropicAdapter({ configRoot: root })).toThrow(
      /config root is group\/world-accessible/,
    );
  });

  it('creates an absent config root private (0o700), giving the non-recursive create its parent', () => {
    const root = join(tmpRoot(), 'nested', 'anthropic-root');
    new AnthropicAdapter({ configRoot: root });
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o077).toBe(0);
  });

  it('rejects a symlinked config root', () => {
    // A 0o700 symlink pointing at a real dir must be caught by the TYPE guard, not followed. The
    // guard ensures existence first (a recursive mkdir no-ops on the symlink), then lstat (no-follow)
    // sees the symlink. This message-specific assertion is the fail-the-fix: cap the type guard and
    // the symlinked root falls through to the mode check, which throws the group/world message
    // instead — so the assertion goes RED. (A symlink's own lstat mode is not portably controllable,
    // so we assert on the message, not on reaching the mode/ownership guards.)
    const base = tmpRoot();
    const realDir = join(base, 'real');
    const linkRoot = join(base, 'link-root');
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkRoot);
    expect(() => new AnthropicAdapter({ configRoot: linkRoot })).toThrow(
      /is a symlink or not a directory/,
    );
  });

  it('rejects a pre-existing group/world-accessible config root', () => {
    // Exercises the UNCONDITIONAL re-validate: the root already exists (0o777) at construction, so
    // the recursive mkdir no-ops and does NOT tighten its mode — the guard must still reject it.
    // chmod defeats umask so the mode is unambiguous. Fail-the-fix: cap the mode check and this
    // process-owned 0o777 dir passes the type + ownership guards and is accepted → RED.
    const root = tmpRoot();
    chmodSync(root, 0o777);
    expect(() => new AnthropicAdapter({ configRoot: root })).toThrow(/group\/world-accessible/);
  });

  it('rejects a foreign-owned config root', () => {
    // Ownership cannot be changed without privileges, so stub process.getuid to a uid that does NOT
    // match the real (process-owned) 0o700 root — the deterministic proxy for a foreign owner.
    // Fail-the-fix: cap the ownership check and this real 0o700 process-created dir is accepted → RED.
    const root = tmpRoot();
    const realUid = process.getuid?.() ?? 0;
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
    try {
      expect(() => new AnthropicAdapter({ configRoot: root })).toThrow(/not owned by this process/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('config-dir hardening — tenantId validated BEFORE any path op', () => {
  // A hostile raw tenantId is rejected fail-closed before join/resolve — no directory is created.
  // Cap the validator → the empty and bare-`..` ids reach mkdir and CREATE a directory (RED); the
  // separator ids ('a/b', '../evil') are additionally caught by the pre-existing containment check.
  for (const bad of ['../evil', 'a/b', '..', '']) {
    it(`rejects tenantId ${JSON.stringify(bad)} and creates no directory`, () => {
      const root = tmpRoot();
      const adapter = new AnthropicAdapter({ configRoot: root });
      const before = readdirSync(root);
      expect(() => adapter.configDirFor(bad)).toThrow();
      expect(readdirSync(root)).toEqual(before);
    });
  }
});

describe('bundled binary verification', () => {
  it('verifies the bundled claude binary runs', () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const res = adapter.verifyBinary();
    // The platform-specific binary is installed as an optional dep on this host.
    expect(res.ok).toBe(true);
    expect(res.version).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('auth-mode self-check (trustworthy)', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const restore = (name: string, val: string | undefined) => {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  };
  afterEach(() => {
    restore('ANTHROPIC_API_KEY', savedKey);
    restore('CLAUDE_CODE_OAUTH_TOKEN', savedTok);
  });

  it('flags a stray ANTHROPIC_API_KEY as api-key (even with an OAuth token present)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stray';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-xxx';
    const check = new AnthropicAdapter({ configRoot: tmpRoot() }).envAuthCheck();
    expect(check.strayApiKeyDetected).toBe(true);
    expect(check.authMode).toBe('api-key');
  });

  it('reports subscription official-harness ONLY when an OAuth token is actually present', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-xxx';
    const check = new AnthropicAdapter({ configRoot: tmpRoot() }).envAuthCheck();
    expect(check.oauthTokenPresent).toBe(true);
    expect(check.authMode).toBe('subscription-oauth-official-harness');
  });

  it('reports unauthenticated when NEITHER a stray key nor an OAuth token is present', () => {
    // The previously-wrong case: absence of a stray key is NOT evidence of a working
    // subscription, so auth_mode must not overclaim 'subscription-oauth-official-harness'.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const check = new AnthropicAdapter({ configRoot: tmpRoot() }).envAuthCheck();
    expect(check.strayApiKeyDetected).toBe(false);
    expect(check.oauthTokenPresent).toBe(false);
    expect(check.authMode).toBe('unauthenticated');
  });
});

describe('auth_mode reconciliation — fixtured, no live token', () => {
  // A live check (claude-agent-sdk 0.3.185) found a SUCCESSFUL
  // subscription run reports system/init apiKeySource='none' (NOT 'oauth'), so the prior logic
  // mislabeled it 'unauthenticated'. These drive the reconciliation from a FIXTURED apiKeySource
  // so the regression runs in CI without a live token.

  it('SUCCESSFUL subscription run (apiKeySource="none" + OAuth token present) => subscription-oauth-official-harness', () => {
    // THE fix: the success value is 'none', not 'oauth'. With the sanctioned OAuth credential
    // present and no API key, this is the official-harness subscription path.
    expect(reconcileAuthMode('none', { strayApiKeyDetected: false, oauthTokenPresent: true })).toBe(
      'subscription-oauth-official-harness',
    );
  });

  it('forward-compat: apiKeySource="oauth" + OAuth token still => subscription-oauth-official-harness', () => {
    expect(
      reconcileAuthMode('oauth', { strayApiKeyDetected: false, oauthTokenPresent: true }),
    ).toBe('subscription-oauth-official-harness');
  });

  it('a stray ANTHROPIC_API_KEY still journals api-key (env-precedence preserved)', () => {
    // Even with apiKeySource='none', a stray API key means the API was billed → 'api-key'.
    expect(reconcileAuthMode('none', { strayApiKeyDetected: true, oauthTokenPresent: true })).toBe(
      'api-key',
    );
    // And an init that names an API key source is api-key regardless of the OAuth token.
    expect(
      reconcileAuthMode('ANTHROPIC_API_KEY', {
        strayApiKeyDetected: false,
        oauthTokenPresent: true,
      }),
    ).toBe('api-key');
  });

  it('a genuinely unauthenticated run (no key, no OAuth token) still journals unauthenticated', () => {
    expect(
      reconcileAuthMode('none', { strayApiKeyDetected: false, oauthTokenPresent: false }),
    ).toBe('unauthenticated');
  });
});

describe('Quarantine: deriveConversationFromObserved excludes non-MCP (built-in) tool blocks', () => {
  const spec = {
    name: 'weather-agent',
    instructions: 'You are concise.',
    model: 'claude-haiku-4-5',
    input: 'Weather in Berlin?',
    maxTurns: 8,
    tools: [],
  };
  // The run() path passes the sanctioned set: the bare name + the mcp__rayspec__ name.
  const sanctioned = new Set(['get_weather', 'mcp__rayspec__get_weather']);
  const observed = [
    // A BUILT-IN tool_use (ToolSearch) — must be quarantined.
    {
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'builtin-1', name: 'ToolSearch', input: { q: 'x' } }],
    },
    // The built-in's raw tool_result — must be quarantined (never enters the SoT).
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: 'builtin-1', content: [{ type: 'text', text: 'RAW' }] },
      ],
    },
    // A sanctioned MCP tool_use + its opaque tool_data result — must SURVIVE.
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use',
          id: 'mcp-1',
          name: 'mcp__rayspec__get_weather',
          input: { city: 'Berlin' },
        },
      ],
    },
    {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'mcp-1',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                kind: 'tool_data',
                name: 'get_weather',
                toolCallId: 'mcp-1',
                data: {},
              }),
            },
          ],
        },
      ],
    },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'It is cloudy.' }] },
  ];

  it('drops the built-in tool_use + its raw result, keeps ONLY the sanctioned MCP tool (tool_data)', () => {
    const turns = deriveConversationFromObserved(spec, observed, 'It is cloudy.', sanctioned);
    const parts = turns.flatMap((t) => t.parts);
    // No trace of the built-in (by name or by id) anywhere in the neutral transcript.
    expect(parts.some((p) => p.kind === 'tool_call' && p.name === 'ToolSearch')).toBe(false);
    expect(
      parts.some(
        (p) => (p.kind === 'tool_call' || p.kind === 'tool_result') && p.toolCallId === 'builtin-1',
      ),
    ).toBe(false);
    // The raw 'RAW' built-in output never appears.
    expect(JSON.stringify(parts)).not.toContain('RAW');
    // The sanctioned MCP tool survives with an opaque tool_data result.
    const callNames = parts
      .filter((p) => p.kind === 'tool_call')
      .map((p) => (p as { name: string }).name);
    expect(callNames).toEqual(['mcp__rayspec__get_weather']);
    const resultParts = parts.filter((p) => p.kind === 'tool_result');
    expect(resultParts).toHaveLength(1);
    if (resultParts[0]?.kind === 'tool_result') {
      expect((resultParts[0].result as { kind?: string }).kind).toBe('tool_data');
    }
  });

  it('with NO sanctioned set (legacy/fixtured call) quarantine is OFF — all blocks pass through', () => {
    const turns = deriveConversationFromObserved(spec, observed, 'It is cloudy.');
    const callNames = turns
      .flatMap((t) => t.parts)
      .filter((p) => p.kind === 'tool_call')
      .map((p) => (p as { name: string }).name);
    expect(callNames).toContain('ToolSearch');
    expect(callNames).toContain('mcp__rayspec__get_weather');
  });
});

describe('JSONL session re-derivation round-trip', () => {
  it('re-derives a neutral transcript from a CLI-style JSONL session file', async () => {
    const adapter = new AnthropicAdapter({ configRoot: tmpRoot() });
    const configDir = adapter.configDirFor('gamma');
    // Mimic the CLI layout: <configDir>/projects/<encoded-cwd>/<session_id>.jsonl
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const projectDir = join(configDir, 'projects', '-some-encoded-cwd');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'extract the date' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '{"launch_date":"July 15th"}' }],
        },
      }),
    ].join('\n');
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl);

    // Exercise the adapter's REAL re-derivation (the round-trip acceptance).
    // Re-derivation returns neutral ConvTurn[] (one text part per JSONL message).
    const turns = reDeriveJsonl(configDir, sessionId);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const assistantPart = turns[1]?.parts[0];
    expect(assistantPart?.kind).toBe('text');
    if (assistantPart?.kind === 'text') expect(assistantPart.text).toContain('July 15th');
  });
});

/**
 * The FAITHFUL recursive tool-arg projection validate-and-repair.
 *
 * The SDK's in-proc MCP server validates the model's tool arguments against the projected Zod schema
 * (validateToolInput -> cs(inputSchema) -> safeParseAsync — verified doc-first in sdk.mjs) BEFORE our
 * handler runs, and on failure returns a tool_result error that drives the model's repair loop. We
 * compile the SAME projection the adapter uses (jsonSchemaToZodShape -> z.object(shape), which is what
 * the SDK's `cs()` does to the raw shape) and assert it REJECTS a malformed (incl. NESTED) arg and
 * ACCEPTS a valid one — proving a weak model's malformed nested arg now repairs at the model boundary
 * instead of falling through to a late dispatchTool rejection (the MaxTurns churn). The over-rejection
 * guard: it must NOT reject args the neutral schema would accept (a SUBSET, never stricter).
 */
describe('Deep tool-arg Zod projection validate-and-repair (mirrors the SDK MCP validate)', () => {
  // A realistic structured tool arg: an array of objects with a nested required field + an
  // enum — the exact shape the OLD shallow projection (array→array(unknown)) could not validate.
  const params = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            owner: { type: 'string' },
            due_raw: { type: 'string' },
          },
          required: ['description'],
        },
      },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['title', 'action_items'],
    additionalProperties: false,
  };

  // Mirror the SDK: wrap the raw shape into a Zod object (what `cs()` does) and safeParse, exactly as
  // validateToolInput does before calling our handler.
  function compileLikeSdk() {
    const { shape, usedArgsFallback } = jsonSchemaToZodShape(params);
    expect(usedArgsFallback).toBe(false);
    return z.object(shape);
  }

  it('ACCEPTS a valid (deeply-nested) tool arg', () => {
    const v = compileLikeSdk();
    expect(
      v.safeParse({
        title: 'Weekly sync',
        action_items: [{ description: 'ship the release notes', owner: 'phil', due_raw: 'Friday' }],
        priority: 'high',
      }).success,
    ).toBe(true);
  });

  it('REJECTS a malformed nested arg (action_items entry missing required `description`)', () => {
    const v = compileLikeSdk();
    expect(v.safeParse({ title: 'Weekly sync', action_items: [{ owner: 'phil' }] }).success).toBe(
      false,
    );
  });

  it('REJECTS a wrong-typed nested field (action_items is a string, not an array)', () => {
    const v = compileLikeSdk();
    expect(v.safeParse({ title: 'x', action_items: 'not-an-array' }).success).toBe(false);
  });

  it('REJECTS a bad enum value (priority not in low|medium|high)', () => {
    const v = compileLikeSdk();
    expect(
      v.safeParse({ title: 'x', action_items: [{ description: 'd' }], priority: 'urgent' }).success,
    ).toBe(false);
  });

  it('over-rejection guard: ACCEPTS (stripping) an undeclared extra key — a SUBSET, never stricter', () => {
    const v = compileLikeSdk();
    const r = v.safeParse({
      title: 'x',
      action_items: [{ description: 'd' }],
      stray_unknown_key: 123,
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).stray_unknown_key).toBeUndefined();
  });

  // The untrusted-content-boundary subset invariant for `integer`. dispatchTool's
  // AUTHORITATIVE ajv accepts ANY integer value for `{type:'integer'}` (no JS-safe-int clamp), so the
  // model-facing Zod shape must too. The OLD mapping `z.number().int()` clamps to the JS safe-integer
  // range (<=Number.MAX_SAFE_INTEGER = 2^53-1) and would OVER-reject larger integers ajv accepts (a
  // behavior regression + cross-backend asymmetry — Pi's TypeBox accepts them). The fix maps
  // `integer → z.number().refine(Number.isInteger)`. Doc-first probe: refine(Number.isInteger) matches
  // ajv's `{type:'integer'}` accept/reject on every probed value (2^53 → accept, 1e21 → accept,
  // 3.5 → reject, 3 → accept). (2^53 = 9007199254740992 is an EXACT float — no precision loss.)
  describe('FIX 2 — `integer` accepts large ints (>safe-int) like dispatchTool ajv (never .int()-clamped)', () => {
    const v = jsonSchemaToZodType({ type: 'integer' });

    it('ACCEPTS 9007199254740992 (2^53, above the safe-int range) — RED on the base (.int() clamps), GREEN after refine', () => {
      // dispatchTool's ajv accepts this as an integer; the model-facing shape must not be stricter.
      // 2^53 = Number.MAX_SAFE_INTEGER + 1 — an exact float, so the test value loses no precision.
      expect(v.safeParse(9007199254740992).success).toBe(true);
    });

    it('ACCEPTS 1e21 (a very large integer-valued float) — matching dispatchTool ajv', () => {
      expect(v.safeParse(1e21).success).toBe(true);
    });

    it('STILL rejects a non-integer (3.5) — faithful, not loosened to accept-all', () => {
      expect(v.safeParse(3.5).success).toBe(false);
    });

    it('ACCEPTS a normal integer (3)', () => {
      expect(v.safeParse(3).success).toBe(true);
    });
  });
});
