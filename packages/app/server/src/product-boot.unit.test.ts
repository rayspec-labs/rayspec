/**
 * Product-YAML boot — PURE unit proofs of the fail-closed env handling + the live-agent prompt/config
 * assembly (no DB, no DBOS, no network). The full real-DBOS composition is proven in
 * product-yaml-boot.db.test.ts + the live gpt-5 smoke. Fail-the-fix: buildLiveAgent asserts the base
 * prompt AND the DECLARED extraction_constraints are BOTH composed into the instructions.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlannedMigration } from '@rayspec/api-auth';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  anthropicApiKeyOverrideWarning,
  anthropicReuseLoginBanner,
  anthropicReuseLoginEnabled,
  anthropicReuseLoginShadowWarning,
  assembleExtractionInstructions,
  buildLiveAgent,
  buildSttAdapter,
  type DestructiveTargetProbe,
  extractDestructiveTarget,
  LEFTOVER_UPDATE_ENV_MOUNT_LOG,
  makeExtractionBackend,
  mediaPrepEnabled,
  nativeValidatedDowngradeWarning,
  nonRealProviderBanner,
  ProductBootError,
  planUpdateBoot,
  readProductUpdateMigrations,
  resolveExtractorConfigPath,
  resolveInputContext,
  resolveStructuredOutputMode,
  routePresentMatchingUpdate,
  WIRED_EXTRACTION_BACKENDS,
} from './product-boot.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const fakeBlob = {} as never; // fail-closed cases throw before touching the blob store

function acmeSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(ACME_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`acme-notes.yaml must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe('assembleExtractionInstructions (donor prompt + declared contract — ledger 1.1)', () => {
  it('composes the base prompt AND every declared extraction_constraint', () => {
    const spec = acmeSpec();
    const constraints = spec.extractors[0]?.extraction_constraints ?? [];
    expect(constraints.length).toBeGreaterThan(0);
    const out = assembleExtractionInstructions('BASE-PROMPT', constraints);
    expect(out).toContain('BASE-PROMPT'); // the donor prompt is present
    for (const c of constraints) expect(out).toContain(`- ${c}`); // every declared constraint composed
  });
  it('returns the base prompt unchanged when there are no constraints', () => {
    expect(assembleExtractionInstructions('P', [])).toBe('P');
  });
});

describe('buildSttAdapter (fail-closed)', () => {
  it('rejects a missing STT_PROVIDER, naming it', () => {
    expect(() => buildSttAdapter({}, fakeBlob, undefined)).toThrow(/STT_PROVIDER is required/);
  });
  it('rejects deepgram without a key, naming it', () => {
    expect(() => buildSttAdapter({ STT_PROVIDER: 'deepgram' }, fakeBlob, undefined)).toThrow(
      /DEEPGRAM_API_KEY is required/,
    );
  });
  it('rejects an unsupported provider', () => {
    expect(() => buildSttAdapter({ STT_PROVIDER: 'whisper' }, fakeBlob, undefined)).toThrow(
      /not supported \(wired: deepgram \| fake\)/,
    );
  });
  it('builds the fake adapter for STT_PROVIDER=fake', () => {
    expect(buildSttAdapter({ STT_PROVIDER: 'fake' }, fakeBlob, undefined).kind).toBe('fake');
  });
});

describe('mediaPrepEnabled — honors RAYSPEC_MEDIA_PREP', () => {
  it('wires media-prep when unset (default ffmpeg)', () => {
    expect(mediaPrepEnabled({})).toBe(true);
  });
  it('wires media-prep for RAYSPEC_MEDIA_PREP=ffmpeg', () => {
    expect(mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'ffmpeg' })).toBe(true);
  });
  it('DISABLES media-prep for RAYSPEC_MEDIA_PREP=off', () => {
    expect(mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'off' })).toBe(false);
  });
  it('fail-closes on any OTHER value, naming it (the S13.2 env contract)', () => {
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'yes' })).toThrow(ProductBootError);
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'yes' })).toThrow(
      /RAYSPEC_MEDIA_PREP 'yes' is not supported/,
    );
  });
});

describe('nonRealProviderBanner — loud marker for non-real providers (F4)', () => {
  it('returns null when both providers are real (deepgram + live)', () => {
    expect(nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live')).toBeNull();
  });
  it('warns loudly on STT_PROVIDER=fake (env-selected, no injected adapter)', () => {
    const b = nonRealProviderBanner({ STT_PROVIDER: 'fake' }, false, 'live');
    expect(b).toContain('NON-REAL PROVIDER');
    expect(b).toContain('STT_PROVIDER=fake');
  });
  it('does NOT count an injected STT adapter as a fake-provider misconfig', () => {
    expect(nonRealProviderBanner({ STT_PROVIDER: 'fake' }, true, 'live')).toBeNull();
  });
  it('warns loudly on RAYSPEC_EXTRACTION_MODE=deterministic', () => {
    const b = nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'deterministic');
    expect(b).toContain('RAYSPEC_EXTRACTION_MODE=deterministic');
  });
  it('lists BOTH when both are non-real', () => {
    const b = nonRealProviderBanner({ STT_PROVIDER: 'fake' }, false, 'deterministic');
    expect(b).toContain('STT_PROVIDER=fake');
    expect(b).toContain('RAYSPEC_EXTRACTION_MODE=deterministic');
  });
  it('warns loudly on RAYSPEC_RESPONDER_MODE=deterministic (consistency with fake STT/extraction)', () => {
    const b = nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live', 'deterministic');
    expect(b).toContain('NON-REAL PROVIDER');
    expect(b).toContain('RAYSPEC_RESPONDER_MODE=deterministic');
  });
  it('a live responder mode (or a non-conversation doc passing "") trips no arm', () => {
    expect(nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live', 'live')).toBeNull();
    expect(nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live', '')).toBeNull();
  });
});

describe('buildLiveAgent (fail-closed)', () => {
  it('serves the declared agent id + returns a per-agent node factory (single-agent transcript-shaped)', () => {
    // The neutral anchor ships NO runtime extraction config (its executor is deployer-injected — see the
    // acme-notes header); buildLiveAgent's live-config resolution is exercised against a throwaway dir.
    const specPath = writeExtractionDir([{ id: 'note_extractor', backend: 'openai' }]);
    const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-test' }, specPath, acmeSpec());
    expect(live.agentIds).toEqual(['note_extractor']);
    expect(typeof live.buildNodeForAgent).toBe('function');
    // The single transcript-shaped agent resolves its per-agent extractor config (backend openai, native).
    const node = live.buildNodeForAgent('note_extractor', {
      tdb: {} as never,
      tenantId: '00000000-0000-0000-0000-0000000000d5',
    });
    expect(typeof node).toBe('function');
  });
  it('rejects when OPENAI_API_KEY is missing (openai backend), naming it', () => {
    const specPath = writeExtractionDir([{ id: 'note_extractor', backend: 'openai' }]);
    expect(() => buildLiveAgent({}, specPath, acmeSpec())).toThrow(/OPENAI_API_KEY is required/);
  });
  it('rejects a document that declares no extractors (zero-extractor guard)', () => {
    const noAgents: ProductSpec = { ...acmeSpec(), extractors: [] };
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-test' }, ACME_YAML, noAgents)).toThrow(
      ProductBootError,
    );
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-test' }, ACME_YAML, noAgents)).toThrow(
      /declares no extractors/,
    );
  });
});

// ── multi-agent + multi-backend live extraction ──────────────────────────────────────────────────

const S5_TMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of S5_TMP_DIRS) rmSync(d, { recursive: true, force: true });
});
const FAKE_TDB = {} as never;
const S5_TENANT = '00000000-0000-0000-0000-0000000000d5';

/** acmeSpec re-shaped to declare N extractors with the given ids (extraction contract cloned). */
function specWithAgents(ids: string[]): ProductSpec {
  const base = acmeSpec();
  const proto = base.extractors[0];
  if (!proto) throw new Error('acme-notes must declare an extractor');
  return { ...base, extractors: ids.map((id) => ({ ...proto, id })) };
}

/** Write a throwaway specDir with per-agent extractor configs; returns the (unread) specPath. */
function writeExtractionDir(
  configs: Array<{
    id: string;
    backend: string;
    mode?: 'native' | 'validated';
    legacyBool?: boolean;
    inputContext?: unknown;
  }>,
): string {
  const d = mkdtempSync(join(tmpdir(), 'rayspec-s5-'));
  S5_TMP_DIRS.push(d);
  const extractionDir = join(d, 'extraction');
  mkdirSync(extractionDir, { recursive: true });
  for (const c of configs) {
    writeFileSync(join(extractionDir, `${c.id}.prompt.md`), `PROMPT for ${c.id}`);
    writeFileSync(join(extractionDir, `${c.id}.schema.json`), JSON.stringify({ type: 'object' }));
    const cfg: Record<string, unknown> = {
      agent_id: c.id,
      backend: c.backend,
      model: 'gpt-5',
      prompt_file: `${c.id}.prompt.md`,
      schema_file: `${c.id}.schema.json`,
      output_schema_name: `schema_${c.id}`,
    };
    if (c.mode) cfg.structured_output_mode = c.mode;
    if (c.legacyBool !== undefined) cfg.require_native_structured_output = c.legacyBool;
    if (c.inputContext !== undefined) cfg.input_context = c.inputContext;
    writeFileSync(join(extractionDir, `${c.id}.extractor.json`), JSON.stringify(cfg));
  }
  return join(d, 'product.yaml');
}

describe('makeExtractionBackend — the boot-side backend factory (S5, fail-closed per-backend env)', () => {
  it("constructs the OpenAIAdapter for 'openai' (demands OPENAI_API_KEY)", () => {
    expect(makeExtractionBackend({ OPENAI_API_KEY: 'sk-x' }, 'openai').id).toBe('openai');
    expect(() => makeExtractionBackend({}, 'openai')).toThrow(/OPENAI_API_KEY is required/);
  });
  it("constructs the AnthropicAdapter for 'anthropic' (subscription token + config root)", () => {
    const ok = { CLAUDE_CODE_OAUTH_TOKEN: 'tok', RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' };
    expect(makeExtractionBackend(ok, 'anthropic').id).toBe('anthropic');
    // A stray ANTHROPIC_API_KEY alone also satisfies the token demand (the adapter bills the API).
    expect(
      makeExtractionBackend(
        { ANTHROPIC_API_KEY: 'k', RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' },
        'anthropic',
      ).id,
    ).toBe('anthropic');
    // Neither token → fail-closed, naming BOTH paths.
    expect(() =>
      makeExtractionBackend({ RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' }, 'anthropic'),
    ).toThrow(/CLAUDE_CODE_OAUTH_TOKEN .* or an ANTHROPIC_API_KEY/);
    // Token but no config root → fail-closed, naming it.
    expect(() => makeExtractionBackend({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, 'anthropic')).toThrow(
      /RAYSPEC_ANTHROPIC_CONFIG_ROOT is required/,
    );
  });
  it("constructs the PiAdapter for 'pi' (runs on the OpenAI key)", () => {
    expect(makeExtractionBackend({ OPENAI_API_KEY: 'sk-x' }, 'pi').id).toBe('pi');
    expect(() => makeExtractionBackend({}, 'pi')).toThrow(/OPENAI_API_KEY is required/);
  });
  it("constructs the CodexAdapter for 'codex' (subscription via CODEX_HOME)", () => {
    expect(makeExtractionBackend({ CODEX_HOME: '/tmp/codex' }, 'codex').id).toBe('codex');
    expect(() => makeExtractionBackend({}, 'codex')).toThrow(/CODEX_HOME is required/);
  });
  it('rejects an unknown backend, naming the wired set', () => {
    expect(() => makeExtractionBackend({}, 'gemini')).toThrow(
      /backend 'gemini' is not wired .* openai \| anthropic \| pi \| codex/,
    );
  });
  it('WIRED_EXTRACTION_BACKENDS lists exactly the four in-process adapters', () => {
    expect([...WIRED_EXTRACTION_BACKENDS]).toEqual(['openai', 'anthropic', 'pi', 'codex']);
  });

  // ── SHOULD-2 (S5 review): the $0-subscription billing footgun ────────────────────────────────────
  // The AnthropicAdapter passes the whole process.env to the child SDK; the SDK precedence is
  // ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN. So a deployment that INTENDS the $0 subscription but
  // ALSO carries a stray ANTHROPIC_API_KEY silently bills the API. We warn LOUD (boot-side, names-only).
  it('SHOULD-2: warns when BOTH the subscription token AND a stray ANTHROPIC_API_KEY are set', () => {
    const OAUTH = 'ZZOAUTHSECRETZZ';
    const APIKEY = 'ZZAPIKEYSECRETZZ';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeExtractionBackend(
        {
          CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
          ANTHROPIC_API_KEY: APIKEY,
          RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro',
        },
        'anthropic',
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const msg = String(spy.mock.calls[0]?.[0]);
      expect(msg).toMatch(/OVERRIDDEN & BILLED/);
      expect(msg).toContain('ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN');
      // NAMES only — never the secret VALUES.
      expect(msg).not.toContain(OAUTH);
      expect(msg).not.toContain(APIKEY);

      // Only the subscription token → NO warning.
      spy.mockClear();
      makeExtractionBackend(
        { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' },
        'anthropic',
      );
      expect(spy).not.toHaveBeenCalled();

      // Only the API key (a deliberate API-path deployment) → NO warning (do NOT hard-block).
      makeExtractionBackend(
        { ANTHROPIC_API_KEY: APIKEY, RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' },
        'anthropic',
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('SHOULD-2 pure: anthropicApiKeyOverrideWarning fires ONLY when both are set', () => {
    expect(
      anthropicApiKeyOverrideWarning({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }),
    ).toMatch(/OVERRIDDEN & BILLED/);
    expect(anthropicApiKeyOverrideWarning({ CLAUDE_CODE_OAUTH_TOKEN: 't' })).toBeNull();
    expect(anthropicApiKeyOverrideWarning({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(anthropicApiKeyOverrideWarning({})).toBeNull();
  });

  // ── Opt-in reuse-login: RAYSPEC_ANTHROPIC_REUSE_LOGIN ───────────────────────────────────────────
  // A box where a human has run `claude` login and seeded the per-tenant CLAUDE_CONFIG_DIR can run the
  // anthropic backend with NO token in the server env. The adapter authenticates the child from
  // CLAUDE_CONFIG_DIR; the flag only RELAXES the boot-side token demand. Strictly opt-in: absent ⇒ throw.
  it('reuse-login: with the flag set + NO token/key, constructs the anthropic backend (does NOT throw)', () => {
    expect(
      makeExtractionBackend(
        {
          RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true',
          RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro',
        },
        'anthropic',
      ).id,
    ).toBe('anthropic');
  });
  it('reuse-login: WITHOUT the flag + no token/key still throws the UNCHANGED fail-closed message', () => {
    // Byte-identical to the pre-flag throw — the flag is strictly additive.
    expect(() =>
      makeExtractionBackend({ RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' }, 'anthropic'),
    ).toThrow(/CLAUDE_CODE_OAUTH_TOKEN .* or an ANTHROPIC_API_KEY .* Fail-closed\./);
  });
  it('reuse-login: the config root is STILL required (the seed lives under it) even with the flag', () => {
    expect(() =>
      makeExtractionBackend({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true' }, 'anthropic'),
    ).toThrow(/RAYSPEC_ANTHROPIC_CONFIG_ROOT is required/);
  });
  it('reuse-login: an INVALID flag value fail-closes with a named error (env contract)', () => {
    expect(() =>
      makeExtractionBackend(
        {
          RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'yes-please',
          RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro',
        },
        'anthropic',
      ),
    ).toThrow(/RAYSPEC_ANTHROPIC_REUSE_LOGIN 'yes-please' is not supported/);
  });
  it('anthropicReuseLoginEnabled parses truthy/falsy values and fail-closes on the rest', () => {
    for (const v of ['true', '1', 'on', 'TRUE', ' On ']) {
      expect(anthropicReuseLoginEnabled({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: v })).toBe(true);
    }
    for (const v of [undefined, '', 'false', '0', 'off', ' OFF ']) {
      expect(
        anthropicReuseLoginEnabled(v === undefined ? {} : { RAYSPEC_ANTHROPIC_REUSE_LOGIN: v }),
      ).toBe(false);
    }
    expect(() => anthropicReuseLoginEnabled({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe' })).toThrow(
      /RAYSPEC_ANTHROPIC_REUSE_LOGIN 'maybe' is not supported/,
    );
  });

  // The reuse-login shadow footgun: a token/key present alongside the flag shadows the seeded login
  // (SDK precedence ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN > /login) — warn LOUD, NAMES only.
  it('reuse-login: warns when a token/key is present alongside the flag (seeded login shadowed)', () => {
    const APIKEY = 'ZZAPIKEYSECRETZZ';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeExtractionBackend(
        {
          RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true',
          ANTHROPIC_API_KEY: APIKEY,
          RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro',
        },
        'anthropic',
      );
      const msg = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toMatch(/REUSE-LOGIN INTENT WILL BE SHADOWED/);
      expect(msg).toContain('BILLS the API');
      expect(msg).not.toContain(APIKEY); // NAMES only, never the secret VALUE
    } finally {
      spy.mockRestore();
    }
  });
  it('anthropicReuseLoginShadowWarning fires ONLY with the flag AND a present credential', () => {
    // Flag + a credential → fires.
    expect(
      anthropicReuseLoginShadowWarning({
        RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true',
        ANTHROPIC_API_KEY: 'k',
      }),
    ).toMatch(/SHADOWED/);
    expect(
      anthropicReuseLoginShadowWarning({
        RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true',
        CLAUDE_CODE_OAUTH_TOKEN: 't',
      }),
    ).toMatch(/SHADOWED/);
    // Flag alone (the intended reuse-login path) → no warning.
    expect(anthropicReuseLoginShadowWarning({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true' })).toBeNull();
    // No flag (a credential present is the normal path) → no warning.
    expect(anthropicReuseLoginShadowWarning({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(anthropicReuseLoginShadowWarning({})).toBeNull();
  });

  // Reuse-login ACTIVE banner (mirrors nonRealProviderBanner): the flag boots clean but an unseeded
  // per-tenant dir fails only at first run, so make the posture LOUD + operator-visible at boot.
  it('anthropicReuseLoginBanner is present when the flag is on, absent when off', () => {
    const on = anthropicReuseLoginBanner({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true' });
    expect(on).toContain('REUSE-LOGIN ACTIVE');
    expect(on).toContain('RAYSPEC_ANTHROPIC_CONFIG_ROOT');
    expect(on).toContain('fail at first run');
    // Off / unset → no banner.
    expect(anthropicReuseLoginBanner({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'false' })).toBeNull();
    expect(anthropicReuseLoginBanner({})).toBeNull();
  });
  it('reuse-login: the ACTIVE banner is emitted at backend construction when the flag is on', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeExtractionBackend(
        { RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true', RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro' },
        'anthropic',
      );
      const msg = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toMatch(/REUSE-LOGIN ACTIVE/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveStructuredOutputMode — the fork-4 structured-output policy (native default)', () => {
  const cfg = (o: Record<string, unknown>): Parameters<typeof resolveStructuredOutputMode>[0] =>
    o as unknown as Parameters<typeof resolveStructuredOutputMode>[0];
  it('defaults to native when NEITHER field is set (native-default)', () => {
    expect(resolveStructuredOutputMode(cfg({}))).toBe('native');
  });
  it("honors an explicit structured_output_mode: 'validated'", () => {
    expect(resolveStructuredOutputMode(cfg({ structured_output_mode: 'validated' }))).toBe(
      'validated',
    );
  });
  it("honors an explicit structured_output_mode: 'native'", () => {
    expect(resolveStructuredOutputMode(cfg({ structured_output_mode: 'native' }))).toBe('native');
  });
  it('maps legacy require_native_structured_output:false → validated (opt-out)', () => {
    expect(resolveStructuredOutputMode(cfg({ require_native_structured_output: false }))).toBe(
      'validated',
    );
  });
  it('maps legacy require_native_structured_output:true → native (acme-notes)', () => {
    expect(resolveStructuredOutputMode(cfg({ require_native_structured_output: true }))).toBe(
      'native',
    );
  });
  it('rejects an invalid structured_output_mode, naming it', () => {
    expect(() => resolveStructuredOutputMode(cfg({ structured_output_mode: 'loose' }))).toThrow(
      /structured_output_mode 'loose' is invalid/,
    );
  });
});

describe('resolveExtractorConfigPath — the per-agent config convention (S5)', () => {
  const one = specWithAgents(['note_extractor']);
  const two = specWithAgents(['agent_one', 'agent_two']);
  it('single-agent: falls back to the legacy extraction/extractor.json (acme-notes byte-identity)', () => {
    const p = resolveExtractorConfigPath({}, '/x/acme.yaml', one, 'note_extractor');
    expect(p).toBe(resolve('/x/extraction/extractor.json'));
  });
  it('single-agent: honors the RAYSPEC_EXTRACTION_CONFIG single-file override', () => {
    const p = resolveExtractorConfigPath(
      { RAYSPEC_EXTRACTION_CONFIG: '/o/custom.json' },
      '/x/m.yaml',
      one,
      'note_extractor',
    );
    expect(p).toBe(resolve('/o/custom.json'));
  });
  it('single-agent: prefers a per-agent file when it exists', () => {
    const specPath = writeExtractionDir([{ id: 'note_extractor', backend: 'openai' }]);
    const p = resolveExtractorConfigPath({}, specPath, one, 'note_extractor');
    expect(p).toBe(resolve(dirname(specPath), 'extraction/note_extractor.extractor.json'));
  });
  it('multi-agent: resolves per-agent extraction/<agent_id>.extractor.json', () => {
    const p = resolveExtractorConfigPath({}, '/x/m.yaml', two, 'agent_two');
    expect(p).toBe(resolve('/x/extraction/agent_two.extractor.json'));
  });
  it('multi-agent: REJECTS the ambiguous single-file override, naming it', () => {
    expect(() =>
      resolveExtractorConfigPath(
        { RAYSPEC_EXTRACTION_CONFIG: '/o/c.json' },
        '/x/m.yaml',
        two,
        'agent_two',
      ),
    ).toThrow(/ambiguous for a multi-extractor/);
  });

  // ── SHOULD-1 (S5 review): the belt-and-suspenders traversal jail (the SINK half; the grammar
  // SafeIdentifier is the SOURCE half). A `..`/`/` agent id (a code-built spec, or a future grammar
  // regression bypassing the parser) resolves OUTSIDE extraction/ — the jail must refuse to read it.
  it('SHOULD-1: multi-agent — throws when an agent id path-traverses OUT of the extraction dir', () => {
    const evilId = '../../../../../tmp/pwned';
    const spec = specWithAgents(['agent_one', evilId]);
    expect(() => resolveExtractorConfigPath({}, '/x/deploy/acme.yaml', spec, evilId)).toThrow(
      ProductBootError,
    );
    expect(() => resolveExtractorConfigPath({}, '/x/deploy/acme.yaml', spec, evilId)).toThrow(
      /extractor '\.\.\/.*\/tmp\/pwned': the resolved extractor-config path escapes the deployment extraction/,
    );
  });

  it('SHOULD-1: single-agent — throws when the sole agent id path-traverses out', () => {
    const evilId = '../../../../../tmp/pwned';
    const spec = specWithAgents([evilId]);
    expect(() => resolveExtractorConfigPath({}, '/x/deploy/acme.yaml', spec, evilId)).toThrow(
      /path-traversal guard/,
    );
  });
});

describe('buildLiveAgent — multi-agent + multi-backend', () => {
  it('resolves a per-agent config PER agent and builds DISTINCT nodes (openai + anthropic)', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'anthropic' },
    ]);
    const env = {
      OPENAI_API_KEY: 'sk-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: join(dirname(specPath), 'anthro'),
    };
    const live = buildLiveAgent(env, specPath, spec);
    expect(live.agentIds).toEqual(['agent_one', 'agent_two']);
    // The SAME declared extraction agent shape runs on OpenAI AND Anthropic: each agent builds its own
    // node closing over its own backend/config — the nodes are distinct object identities.
    const nodeOne = live.buildNodeForAgent('agent_one', { tdb: FAKE_TDB, tenantId: S5_TENANT });
    const nodeTwo = live.buildNodeForAgent('agent_two', { tdb: FAKE_TDB, tenantId: S5_TENANT });
    expect(typeof nodeOne).toBe('function');
    expect(typeof nodeTwo).toBe('function');
    expect(nodeOne).not.toBe(nodeTwo);
  });
  it('fail-closes AT BOOT when a native-demand config targets pi (emulated-only)', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    // agent_two: backend pi, structured_output_mode UNSET ⇒ native DEFAULT ⇒ boot must reject.
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'pi' },
    ]);
    const env = { OPENAI_API_KEY: 'sk-x' };
    expect(() => buildLiveAgent(env, specPath, spec)).toThrow(ProductBootError);
    expect(() => buildLiveAgent(env, specPath, spec)).toThrow(
      /demands NATIVE structured output.*backend 'pi' only[\s\S]*EMULATES/,
    );
  });
  it("allows pi when the config opts into structured_output_mode: 'validated'", () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'pi', mode: 'validated' },
    ]);
    const env = { OPENAI_API_KEY: 'sk-x' };
    const live = buildLiveAgent(env, specPath, spec);
    expect(live.agentIds).toEqual(['agent_one', 'agent_two']);
    expect(typeof live.buildNodeForAgent('agent_two', { tdb: FAKE_TDB, tenantId: S5_TENANT })).toBe(
      'function',
    );
  });
  it('rejects when a per-agent config names the WRONG agent (config/agent mismatch)', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    // Write agent_two's file but with agent_id pointing at a different id.
    const d = mkdtempSync(join(tmpdir(), 'rayspec-s5-'));
    S5_TMP_DIRS.push(d);
    const extractionDir = join(d, 'extraction');
    mkdirSync(extractionDir, { recursive: true });
    for (const id of ['agent_one', 'agent_two']) {
      writeFileSync(join(extractionDir, `${id}.prompt.md`), 'P');
      writeFileSync(join(extractionDir, `${id}.schema.json`), '{"type":"object"}');
    }
    writeFileSync(
      join(extractionDir, 'agent_one.extractor.json'),
      JSON.stringify({
        agent_id: 'agent_one',
        backend: 'openai',
        model: 'gpt-5',
        prompt_file: 'agent_one.prompt.md',
        schema_file: 'agent_one.schema.json',
        output_schema_name: 's',
      }),
    );
    writeFileSync(
      join(extractionDir, 'agent_two.extractor.json'),
      JSON.stringify({
        agent_id: 'WRONG',
        backend: 'openai',
        model: 'gpt-5',
        prompt_file: 'agent_two.prompt.md',
        schema_file: 'agent_two.schema.json',
        output_schema_name: 's',
      }),
    );
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, join(d, 'product.yaml'), spec)).toThrow(
      /names agent 'WRONG', not 'agent_two'/,
    );
  });

  // ── S5-MINOR-1 / S5-TQ-1: a built node genuinely BINDS to its DECLARED backend (not a shared openai
  // one). Proof: agent_two declares `anthropic` but the env lacks the anthropic creds → construction
  // fails with the ANTHROPIC-SPECIFIC demand, naming agent_two. A shared/openai node would not demand it.
  it('S5-MINOR-1: a node binds to its declared backend — anthropic without anthropic env throws at that agent', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'anthropic' },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'agent_two':.*CLAUDE_CODE_OAUTH_TOKEN .* or an ANTHROPIC_API_KEY/,
    );
  });

  // ── S5-TQ-3: an unknown backend surfaces at buildLiveAgent, naming the AGENT + the wired set (not
  // only at the makeExtractionBackend unit) — the boot-level wrap adds the agent context.
  it('S5-TQ-3: an unknown backend at buildLiveAgent names the agent + the wired set', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'gemini' },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'agent_two':.*backend 'gemini' is not wired.*openai \| anthropic \| pi \| codex/,
    );
  });

  // ── S5-TQ-2: validated-on-native is ALLOWED but silently drops native constrained decode — make the
  // downgrade boot-visible (a console.warn), and pin that the semantics degrade (not reject).
  it('S5-TQ-2: validated-on-native (openai) is ALLOWED and warns loudly (downgrade visible)', () => {
    const spec = specWithAgents(['agent_one']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai', mode: 'validated' },
    ]);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec);
      // ALLOWED: it builds (validated-on-native degrades, it does NOT fail-closed like native-on-pi).
      expect(live.agentIds).toEqual(['agent_one']);
      expect(
        typeof live.buildNodeForAgent('agent_one', { tdb: FAKE_TDB, tenantId: S5_TENANT }),
      ).toBe('function');
      // VISIBLE: the downgrade warning fired.
      const warned = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/NATIVE STRUCTURED OUTPUT DOWNGRADED \(extractor 'agent_one'\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it('S5-TQ-2 pure: nativeValidatedDowngradeWarning fires ONLY for a native backend in validated mode', () => {
    expect(nativeValidatedDowngradeWarning('a', 'openai', 'validated', true)).toMatch(/DOWNGRADED/);
    // native mode on a native backend → no downgrade.
    expect(nativeValidatedDowngradeWarning('a', 'openai', 'native', true)).toBeNull();
    // pi (not native-capable) in validated mode → nothing to downgrade.
    expect(nativeValidatedDowngradeWarning('a', 'pi', 'validated', false)).toBeNull();
  });
});

// ── the input_context extractor-config seam ──────────────────────────────────────────────────────

const EXPENSE_YAML = resolve(here, '../../../../examples/expense-claim/expense-claim.product.yaml');

function expenseSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(EXPENSE_YAML, 'utf8'));
  if (!parsed.ok) {
    throw new Error(`expense-claim yaml must parse: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.value;
}

/**
 * acmeSpec re-shaped into a GENERIC (non-transcript) declaration: no closed_source_artifacts, no
 * grounding demand — the shape a non-audio document product declares (the expense-claim shape).
 */
function specWithGenericAgents(ids: string[]): ProductSpec {
  const base = specWithAgents(ids);
  return {
    ...base,
    extractors: base.extractors.map((a) => ({
      ...a,
      extraction: {
        ...a.extraction,
        acceptance_boundary: { type: 'validation_node' as const, requires: ['validation.check'] },
      },
    })),
  };
}

const CLAIM_INPUT_CONTEXT = { payload_fields: ['merchant', 'amount_cents'] };

describe('resolveInputContext — the branch discriminator is the DECLARATION', () => {
  const cfgWith = (input_context?: unknown) =>
    ({ input_context }) as Parameters<typeof resolveInputContext>[0];

  it('acme-notes-identity pin: a transcript-shaped agent with NO input_context resolves to undefined', () => {
    const agent = acmeSpec().extractors[0];
    if (!agent) throw new Error('acme-notes must declare an extractor');
    // The node config for acme-notes carries NO inputContext — the transcript path is untouched.
    expect(resolveInputContext(cfgWith(undefined), agent, '/x/extractor.json')).toBeUndefined();
  });

  it('normalizes a valid generic input_context (defaults preserved, unknown keys dropped)', () => {
    const agent = specWithGenericAgents(['doc_agent']).extractors[0];
    if (!agent) throw new Error('spec must declare an extractor');
    expect(
      resolveInputContext(
        cfgWith({ payload_fields: ['merchant'], artifact_inputs: false, extra: 1 }),
        agent,
        '/x/extractor.json',
      ),
    ).toEqual({ payload_fields: ['merchant'], artifact_inputs: false });
    // artifact_inputs absent stays absent (the node's default-true applies at run time).
    expect(
      resolveInputContext(cfgWith({ payload_fields: ['merchant'] }), agent, '/x/extractor.json'),
    ).toEqual({ payload_fields: ['merchant'] });
  });

  it('GB-1: rejects ZERO effective channels — no payload fields AND no declared input artifacts', () => {
    const base = specWithGenericAgents(['doc_agent']).extractors[0];
    if (!base) throw new Error('spec must declare an extractor');
    // The extractor declares NO input artifacts ⇒ artifact_inputs true/omitted serializes NOTHING —
    // the old exact-combo guard ({payload_fields:[], artifact_inputs:false}) missed this.
    const noArtifacts = { ...base, extraction: { ...base.extraction, input_artifacts: [] } };
    for (const vacuous of [
      { payload_fields: [] }, // artifact_inputs omitted — irrelevant with zero declared artifacts
      { artifact_inputs: true }, // payload_fields absent + nothing an artifact serialize could add
    ]) {
      expect(() => resolveInputContext(cfgWith(vacuous), noArtifacts, '/x/e.json')).toThrow(
        ProductBootError,
      );
      expect(() => resolveInputContext(cfgWith(vacuous), noArtifacts, '/x/e.json')).toThrow(
        /extractor 'doc_agent'.*no input channel/s,
      );
    }
    // The artifact channel counts as OPEN only when artifacts are DECLARED: payload-free configs
    // stay accepted on an agent that declares input artifacts (acme-notes-derived base does).
    expect(resolveInputContext(cfgWith({ payload_fields: [] }), base, '/x/e.json')).toEqual({
      payload_fields: [],
    });
  });
});

describe('buildLiveAgent — the GENERIC-branch input_context demand (boot fail-closed)', () => {
  it('REJECTS a generic (no closed_source_artifacts) agent whose config declares NO input_context', () => {
    const spec = specWithGenericAgents(['doc_agent']);
    const specPath = writeExtractionDir([{ id: 'doc_agent', backend: 'openai' }]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      ProductBootError,
    );
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'doc_agent' declares no closed_source_artifacts.*requires an input_context/s,
    );
  });

  it('REJECTS an input_context on a TRANSCRIPT-shaped agent (it would be silently ignored)', () => {
    // acme-notes-shaped: closed_source_artifacts present ⇒ the transcript path never consumes an
    // input_context — accepting one would misdescribe what reaches the model.
    const spec = specWithAgents(['mi_agent']);
    const specPath = writeExtractionDir([
      { id: 'mi_agent', backend: 'openai', inputContext: CLAIM_INPUT_CONTEXT },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'mi_agent':.*closed_source_artifacts.*input_context/s,
    );
  });

  it('ACCEPTS a generic agent with a valid input_context and builds its node', () => {
    const spec = specWithGenericAgents(['doc_agent']);
    const specPath = writeExtractionDir([
      { id: 'doc_agent', backend: 'openai', inputContext: CLAIM_INPUT_CONTEXT },
    ]);
    const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec);
    expect(live.agentIds).toEqual(['doc_agent']);
    expect(typeof live.buildNodeForAgent('doc_agent', { tdb: FAKE_TDB, tenantId: S5_TENANT })).toBe(
      'function',
    );
  });

  it('REJECTS a malformed input_context, naming the defect (shape-validated at boot)', () => {
    const arms: Array<{ inputContext: unknown; want: RegExp }> = [
      { inputContext: 'yes', want: /input_context must be an object/ },
      { inputContext: { payload_fields: 'merchant' }, want: /payload_fields must be an array/ },
      { inputContext: { payload_fields: ['merchant', ''] }, want: /non-empty strings/ },
      {
        inputContext: { payload_fields: ['m'], artifact_inputs: 'yes' },
        want: /artifact_inputs must be a boolean/,
      },
    ];
    for (const arm of arms) {
      const spec = specWithGenericAgents(['doc_agent']);
      const specPath = writeExtractionDir([
        { id: 'doc_agent', backend: 'openai', inputContext: arm.inputContext },
      ]);
      expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(arm.want);
    }
  });

  it('REJECTS an input_context that declares NO input channel (empty fields + artifacts off)', () => {
    const spec = specWithGenericAgents(['doc_agent']);
    const specPath = writeExtractionDir([
      {
        id: 'doc_agent',
        backend: 'openai',
        inputContext: { payload_fields: [], artifact_inputs: false },
      },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /no input channel/,
    );
  });

  it('GB-1: REJECTS at BOOT a vacuous input_context on an agent with ZERO declared input artifacts', () => {
    // Symmetric with the arm above: artifact_inputs true/omitted is STILL zero channels when the
    // agent declares no input artifacts (the compiled step would serialize nothing) — every run
    // would fail agent_input_empty at run time; boot must fail closed instead.
    const base = specWithGenericAgents(['doc_agent']);
    const spec: ProductSpec = {
      ...base,
      extractors: base.extractors.map((a) => ({
        ...a,
        extraction: { ...a.extraction, input_artifacts: [] },
      })),
    };
    for (const inputContext of [{ payload_fields: [] }, { artifact_inputs: true }]) {
      const specPath = writeExtractionDir([{ id: 'doc_agent', backend: 'openai', inputContext }]);
      expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
        /extractor 'doc_agent'.*no input channel/s,
      );
    }
  });

  it('REJECTS a generic agent that demands grounding.check (document grounding is out of v1) at BOOT', () => {
    const base = specWithGenericAgents(['doc_agent']);
    const spec: ProductSpec = {
      ...base,
      extractors: base.extractors.map((a) => ({
        ...a,
        extraction: {
          ...a.extraction,
          acceptance_boundary: {
            type: 'validation_node' as const,
            requires: ['grounding.check', 'validation.check'],
          },
        },
      })),
    };
    const specPath = writeExtractionDir([
      { id: 'doc_agent', backend: 'openai', inputContext: CLAIM_INPUT_CONTEXT },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /document grounding is not supported in v1/,
    );
  });

  it('a single-agent transcript-shaped config (NO input_context) builds unchanged', () => {
    // Transcript-shaped (closed_source_artifacts present) ⇒ the config carries no input_context; it builds.
    const specPath = writeExtractionDir([{ id: 'note_extractor', backend: 'openai' }]);
    const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-test' }, specPath, acmeSpec());
    expect(live.agentIds).toEqual(['note_extractor']);
  });

  it('ACCEPTANCE: the SHIPPED expense-claim config is live-capable (input_context resolves)', () => {
    // The real example dir: agent 'expense_coder' declares NO closed_source_artifacts (generic
    // branch) and its shipped extractor config now carries the input_context — the boot accepts it.
    const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-test' }, EXPENSE_YAML, expenseSpec());
    expect(live.agentIds).toEqual(['expense_coder']);
    expect(
      typeof live.buildNodeForAgent('expense_coder', { tdb: FAKE_TDB, tenantId: S5_TENANT }),
    ).toBe('function');
  });
});

describe('readProductUpdateMigrations — the ENV-DRIVEN update seam, fail-closed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rayspec-prod-update-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns undefined when RAYSPEC_UPDATE_MIGRATION is unset (⇒ mount/materialize, behavior-identical)', () => {
    expect(readProductUpdateMigrations({})).toBeUndefined();
    expect(readProductUpdateMigrations({ migrationPath: '  ' })).toBeUndefined();
  });

  it('throws a named ProductBootError when the delta .sql path is unreadable', () => {
    expect(() => readProductUpdateMigrations({ migrationPath: join(tmp, 'nope.sql') })).toThrow(
      ProductBootError,
    );
    expect(() => readProductUpdateMigrations({ migrationPath: join(tmp, 'nope.sql') })).toThrow(
      /RAYSPEC_UPDATE_MIGRATION points at an unreadable file/,
    );
  });

  it('builds one PlannedMigration keyed by filename with an empty allowlist when none is given', () => {
    const sqlPath = join(tmp, '0001_add_pinned.sql');
    writeFileSync(sqlPath, 'CREATE TABLE "pinned_moments" ();', 'utf8');
    const out = readProductUpdateMigrations({ migrationPath: sqlPath });
    expect(out).toHaveLength(1);
    const [m] = out ?? [];
    expect(m?.name).toBe('0001_add_pinned.sql');
    expect(m?.sql).toContain('CREATE TABLE "pinned_moments"');
    expect(m?.allowlist).toEqual([]);
  });

  it('throws a named ProductBootError when the allowlist file is unreadable', () => {
    const sqlPath = join(tmp, '0002.sql');
    writeFileSync(sqlPath, 'DROP TABLE "x";', 'utf8');
    expect(() =>
      readProductUpdateMigrations({
        migrationPath: sqlPath,
        allowlistPath: join(tmp, 'gone.json'),
      }),
    ).toThrow(/RAYSPEC_UPDATE_ALLOWLIST points at an unreadable file/);
  });

  it('throws when the allowlist file is not a JSON array of entries', () => {
    const sqlPath = join(tmp, '0003.sql');
    writeFileSync(sqlPath, 'DROP TABLE "x";', 'utf8');
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{"not":"an array"}', 'utf8');
    expect(() =>
      readProductUpdateMigrations({ migrationPath: sqlPath, allowlistPath: bad }),
    ).toThrow(/must be a JSON array/);
  });

  it('throws on a malformed entry (missing reason)', () => {
    const sqlPath = join(tmp, '0004.sql');
    writeFileSync(sqlPath, 'DROP TABLE "x";', 'utf8');
    const bad = join(tmp, 'bad-entry.json');
    writeFileSync(bad, JSON.stringify([{ kind: 'drop-table', match: 'DROP TABLE "x"' }]), 'utf8');
    expect(() =>
      readProductUpdateMigrations({ migrationPath: sqlPath, allowlistPath: bad }),
    ).toThrow(/entry \[0\]\.reason must be non-empty/);
  });

  it('parses a well-formed reviewed allowlist into entries', () => {
    const sqlPath = join(tmp, '0005.sql');
    writeFileSync(sqlPath, 'DROP TABLE "pinned_moments";', 'utf8');
    const ok = join(tmp, 'ok.json');
    writeFileSync(
      ok,
      JSON.stringify([
        { kind: 'drop-table', match: 'DROP TABLE "pinned_moments"', reason: 'reviewed' },
      ]),
      'utf8',
    );
    const out = readProductUpdateMigrations({ migrationPath: sqlPath, allowlistPath: ok });
    expect(out?.[0]?.allowlist).toHaveLength(1);
    expect(out?.[0]?.allowlist?.[0]?.kind).toBe('drop-table');
  });
});

describe('planUpdateBoot — the ENV-DRIVEN update boot is REBOOT-SAFE by classification', () => {
  // An ADDITIVE delta (no destructive findings): at present-matching it is a leftover ⇒ MOUNT, no probe.
  const ADDITIVE: PlannedMigration[] = [
    { name: '0001_add_pinned.sql', sql: 'CREATE TABLE "pinned_moments" ();', allowlist: [] },
  ];
  // A pure-SUBSET destructive delta: at present-matching FIX-2 must PROBE the drop target.
  const DROP_HIGHLIGHTS: PlannedMigration[] = [
    {
      name: '0002_drop_highlights.sql',
      sql: 'DROP TABLE "highlights";',
      allowlist: [{ kind: 'drop-table', match: 'DROP TABLE "highlights"', reason: 'reviewed' }],
    },
  ];
  const SPEC = '/tmp/acme.product.yaml';
  const neverExists = async (): Promise<boolean> => false;
  const alwaysExists = async (): Promise<boolean> => true;

  it('drifted (the NORMAL update) → APPLIES the reviewed delta as deployMode "updated", no log', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot('drifted', ADDITIVE, SPEC, (m) => logs.push(m), neverExists);
    expect(plan.deployMode).toBe('updated');
    expect(plan.migrations).toBe(ADDITIVE); // the exact reviewed delta flows to deploy()'s gate
    expect(logs).toEqual([]); // no leftover-env warning on the normal update
  });

  it('present-matching + ADDITIVE-only leftover → MOUNTS with the loud log (behavior-identical to FIX-1)', async () => {
    // A stale RAYSPEC_UPDATE_MIGRATION carrying only additive DDL on a plain restart must NOT re-apply
    // the non-idempotent delta (42P07 crash-loop). No destructive finding ⇒ no probe ⇒ MOUNT.
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      ADDITIVE,
      SPEC,
      (m) => logs.push(m),
      neverExists,
    );
    expect(plan.deployMode).toBe('mounted');
    expect(plan.migrations).toEqual([]); // ZERO migrations — the delta is NOT re-applied
    expect(logs).toEqual([LEFTOVER_UPDATE_ENV_MOUNT_LOG]);
    expect(logs[0]).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // tells the operator to clear the stale env
  });

  it('present-matching + a SUBSET DROP whose target STILL EXISTS → APPLIES (FIX-2: not a silent mount)', async () => {
    // The regression FIX-2 closes: a pure-subset removal on its first boot present-matches (superset-blind)
    // but the drop target still exists ⇒ the delta is UNAPPLIED ⇒ it MUST run, not mount-and-lose it.
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      DROP_HIGHLIGHTS,
      SPEC,
      (m) => logs.push(m),
      alwaysExists,
    );
    expect(plan.deployMode).toBe('updated'); // APPLIES through deploy()'s gate
    expect(plan.migrations).toBe(DROP_HIGHLIGHTS);
    expect(logs).toEqual([]); // no leftover log — this is a real update, not a leftover env
  });

  it('present-matching + a SUBSET DROP whose target is GONE → MOUNTS (a genuine leftover env)', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      DROP_HIGHLIGHTS,
      SPEC,
      (m) => logs.push(m),
      neverExists,
    );
    expect(plan.deployMode).toBe('mounted');
    expect(plan.migrations).toEqual([]);
    expect(logs).toEqual([LEFTOVER_UPDATE_ENV_MOUNT_LOG]);
  });

  it('present-matching + an UNDETERMINABLE destructive statement (TRUNCATE) → REFUSES fail-closed', async () => {
    const truncate: PlannedMigration[] = [
      {
        name: '0003_truncate.sql',
        sql: 'TRUNCATE "note_artifacts";',
        allowlist: [{ kind: 'truncate', match: 'TRUNCATE "note_artifacts"', reason: 'reviewed' }],
      },
    ];
    await expect(
      planUpdateBoot('present-matching', truncate, SPEC, () => {}, neverExists),
    ).rejects.toThrow(ProductBootError);
    await expect(
      planUpdateBoot('present-matching', truncate, SPEC, () => {}, neverExists),
    ).rejects.toThrow(/CANNOT determine.*if this env is a LEFTOVER/s);
  });

  it('absent (a first boot, nothing to update) → REFUSES fail-closed, actionably', async () => {
    await expect(planUpdateBoot('absent', ADDITIVE, SPEC, () => {}, neverExists)).rejects.toThrow(
      ProductBootError,
    );
    await expect(planUpdateBoot('absent', ADDITIVE, SPEC, () => {}, neverExists)).rejects.toThrow(
      /NO product schema is materialized yet.*REMOVE RAYSPEC_UPDATE_MIGRATION/s,
    );
  });
});

describe('routePresentMatchingUpdate — the DB-free present-matching discriminator', () => {
  const mig = (sql: string, allowlist: PlannedMigration['allowlist'] = []): PlannedMigration[] => [
    { name: 'd.sql', sql, allowlist },
  ];
  const probe = (present: ReadonlySet<string>) => async (p: DestructiveTargetProbe) => {
    const key =
      p.kind === 'drop-table'
        ? p.table
        : p.kind === 'drop-column'
          ? `${p.table}.${p.column}`
          : p.kind === 'drop-index'
            ? p.index
            : `${p.table}#${p.constraint}`;
    return present.has(key);
  };

  it('a superset-blind drop whose target EXISTS → { kind: apply } (an unapplied subset removal)', async () => {
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";'),
      probe(new Set(['highlights'])),
    );
    expect(route).toEqual({ kind: 'apply' });
  });

  it('a superset-blind drop whose target is GONE → { kind: mount } (a genuine leftover)', async () => {
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";'),
      probe(new Set()),
    );
    expect(route).toEqual({ kind: 'mount' });
  });

  it('no destructive findings (additive-only) → { kind: mount }, probe never consulted', async () => {
    let probed = false;
    const route = await routePresentMatchingUpdate(mig('CREATE TABLE "x" ();'), async () => {
      probed = true;
      return true;
    });
    expect(route).toEqual({ kind: 'mount' });
    expect(probed).toBe(false);
  });

  it('a MIXED delta — one target gone, one still present → { kind: apply } (any-exists wins)', async () => {
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";\n--> statement-breakpoint\nDROP TABLE "pinned_moments";'),
      probe(new Set(['pinned_moments'])), // highlights gone, pinned_moments still there
    );
    expect(route).toEqual({ kind: 'apply' });
  });

  it('an APPLIED-AT-PRESENT-MATCHING kind (SET NOT NULL) → { kind: mount }, NOT refuse (no ENV-1 crash-loop)', async () => {
    // detectDrift catches an unapplied SET NOT NULL as column_nullability drift, so at present-matching it
    // is PROVEN applied — a legitimate leftover after a non-subset update must MOUNT, never refuse.
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL;', [
        {
          kind: 'set-not-null',
          match: 'ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL',
          reason: 'reviewed',
        },
      ]),
      probe(new Set()),
    );
    expect(route).toEqual({ kind: 'mount' });
  });

  it('an UNDETERMINABLE destructive kind (TRUNCATE) → { kind: refuse }', async () => {
    const route = await routePresentMatchingUpdate(
      mig('TRUNCATE "note_artifacts";', [
        { kind: 'truncate', match: 'TRUNCATE "note_artifacts"', reason: 'reviewed' },
      ]),
      probe(new Set()),
    );
    expect(route.kind).toBe('refuse');
  });

  it('a superset-blind drop we cannot parse a target from → { kind: refuse } (fail-closed)', async () => {
    // A multi-table DROP is flagged drop-table but the single-target extractor cannot parse it → refuse.
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "a", "b";', [
        { kind: 'drop-table', match: 'DROP TABLE "a", "b"', reason: 'reviewed' },
      ]),
      probe(new Set(['a'])),
    );
    expect(route.kind).toBe('refuse');
  });
});

describe('extractDestructiveTarget — target parsing for the superset-blind kinds', () => {
  it('drop-table', () => {
    expect(extractDestructiveTarget('drop-table', 'DROP TABLE "highlights"')).toEqual({
      kind: 'drop-table',
      table: 'highlights',
    });
    expect(extractDestructiveTarget('drop-table', 'DROP TABLE IF EXISTS "highlights";')).toEqual({
      kind: 'drop-table',
      table: 'highlights',
    });
  });
  it('drop-column (both DROP COLUMN and the bare DROP form)', () => {
    expect(extractDestructiveTarget('drop-column', 'ALTER TABLE "t" DROP COLUMN "c"')).toEqual({
      kind: 'drop-column',
      table: 't',
      column: 'c',
    });
    expect(extractDestructiveTarget('drop-column', 'ALTER TABLE "t" DROP "c"')).toEqual({
      kind: 'drop-column',
      table: 't',
      column: 'c',
    });
  });
  it('drop-index', () => {
    expect(extractDestructiveTarget('drop-index', 'DROP INDEX "t_c_unique"')).toEqual({
      kind: 'drop-index',
      index: 't_c_unique',
    });
  });
  it('drop-constraint', () => {
    expect(
      extractDestructiveTarget(
        'drop-constraint',
        'ALTER TABLE "t" DROP CONSTRAINT "t_c_ref_id_fk"',
      ),
    ).toEqual({ kind: 'drop-constraint', table: 't', constraint: 't_c_ref_id_fk' });
  });
  it('returns undefined for an unparseable statement (fail-closed → refuse upstream)', () => {
    expect(extractDestructiveTarget('drop-table', 'DROP TABLE "a", "b"')).toBeUndefined();
    expect(extractDestructiveTarget('truncate', 'TRUNCATE "x"')).toBeUndefined();
  });
});
