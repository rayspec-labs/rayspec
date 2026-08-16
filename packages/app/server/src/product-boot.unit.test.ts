/**
 * Product-YAML boot — PURE unit proofs of the fail-closed env handling + the live-agent prompt/config
 * assembly (no DB, no DBOS, no network). The full real-DBOS composition is proven in
 * product-yaml-boot.db.test.ts + the live gpt-5 smoke. Fail-the-fix: buildLiveAgent asserts the base
 * prompt AND the DECLARED extraction_constraints are BOTH composed into the instructions.
 */
import { createHash } from 'node:crypto';
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
  extractAdditiveObjects,
  extractDestructiveTarget,
  leftoverUpdateEnvMountLog,
  makeExtractionBackend,
  mediaPrepEnabled,
  nativeValidatedDowngradeWarning,
  nonRealProviderBanner,
  ProductBootError,
  planUpdateBoot,
  readProductUpdateMigrations,
  resolveExtractorConfigPath,
  resolveExtractorPromptText,
  resolveInputContext,
  resolveStructuredOutputMode,
  routePresentMatchingUpdate,
  type SchemaObjectProbe,
  WIRED_EXTRACTION_BACKENDS,
} from './product-boot.js';

/**
 * The two `@openai/agents` registration entry points, spied so the boot-side wiring can be observed
 * through what the adapter REALLY registers — the technique packages/adapters/openai/src/auth.test.ts
 * uses, which pins the adapter's half of the same contract. Everything else in the SDK stays the real
 * module. `vi.hoisted` holds the spies, because this file imports its subject statically and the mock
 * factory therefore runs before any plain top-level const exists.
 */
const openaiRegistration = vi.hoisted(() => ({
  setDefaultOpenAIKey: vi.fn(),
  setDefaultOpenAIClient: vi.fn(),
}));

vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    setDefaultOpenAIKey: (...args: unknown[]) => openaiRegistration.setDefaultOpenAIKey(...args),
    setDefaultOpenAIClient: (...args: unknown[]) =>
      openaiRegistration.setDefaultOpenAIClient(...args),
  };
});

/** The client handed to setDefaultOpenAIClient by the single registration a case performed. */
function registeredClient(): { timeout: number; maxRetries: number; apiKey: string | null } {
  expect(openaiRegistration.setDefaultOpenAIClient).toHaveBeenCalledTimes(1);
  return openaiRegistration.setDefaultOpenAIClient.mock.calls[0]?.[0] as {
    timeout: number;
    maxRetries: number;
    apiKey: string | null;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const fakeBlob = {} as never; // fail-closed cases throw before touching the blob store

function acmeSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(ACME_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`acme-notes.yaml must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe('assembleExtractionInstructions (base prompt + declared contract — ledger 1.1)', () => {
  it('composes the base prompt AND every declared extraction_constraint', () => {
    const spec = acmeSpec();
    const constraints = spec.extractors[0]?.extraction_constraints ?? [];
    expect(constraints.length).toBeGreaterThan(0);
    const out = assembleExtractionInstructions('BASE-PROMPT', constraints);
    expect(out).toContain('BASE-PROMPT'); // the base prompt is present
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
  it('treats a BLANK value as unset (empty string ⇒ default ffmpeg)', () => {
    expect(mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: '' })).toBe(true);
  });
  it('treats a WHITESPACE-ONLY value as unset (trimmed ⇒ default ffmpeg)', () => {
    expect(mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: '   ' })).toBe(true);
    expect(mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: '\t\n' })).toBe(true);
  });
  it('fail-closes on any OTHER value, naming it (the env contract)', () => {
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'yes' })).toThrow(ProductBootError);
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'yes' })).toThrow(
      /RAYSPEC_MEDIA_PREP 'yes' is not supported/,
    );
  });
  it('the refusal tells the operator that blanking the variable is a way out', () => {
    // The reader accepts a blank value as unset, and the doc comment says so — but the message an
    // operator actually sees on a typo is the only place that reaches them. It named `unset` alone,
    // so "is emptying it the same as removing the line?" was answerable only from the source.
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'yes' })).toThrow(
      /unset or blank ⇒ ffmpeg/,
    );
  });

  it('fail-closes on a case variant of the wired value (no case coercion)', () => {
    expect(() => mediaPrepEnabled({ RAYSPEC_MEDIA_PREP: 'FFMPEG' })).toThrow(
      /RAYSPEC_MEDIA_PREP 'FFMPEG' is not supported/,
    );
  });
});

describe('nonRealProviderBanner — loud marker for non-real providers', () => {
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
  it('warns loudly on RAYSPEC_NORMALIZE_MODE=deterministic (the mirror of the responder arm)', () => {
    const b = nonRealProviderBanner(
      { STT_PROVIDER: 'deepgram' },
      false,
      'live',
      'live',
      'deterministic',
    );
    expect(b).toContain('NON-REAL PROVIDER');
    expect(b).toContain('RAYSPEC_NORMALIZE_MODE=deterministic');
  });
  it('a live normalize mode (or a record input with no normalize step passing "") trips no arm', () => {
    expect(
      nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live', 'live', 'live'),
    ).toBeNull();
    expect(
      nonRealProviderBanner({ STT_PROVIDER: 'deepgram' }, false, 'live', 'live', ''),
    ).toBeNull();
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

const TMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});
const FAKE_TDB = {} as never;
const LIVE_TENANT = '00000000-0000-0000-0000-0000000000d5';

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
    /** Omit the sidecar prompt_file (+ its .prompt.md) — the prompt is inline / hash-pinned in the doc. */
    omitPrompt?: boolean;
  }>,
): string {
  const d = mkdtempSync(join(tmpdir(), 'rayspec-boot-'));
  TMP_DIRS.push(d);
  const extractionDir = join(d, 'extraction');
  mkdirSync(extractionDir, { recursive: true });
  for (const c of configs) {
    if (!c.omitPrompt)
      writeFileSync(join(extractionDir, `${c.id}.prompt.md`), `PROMPT for ${c.id}`);
    writeFileSync(join(extractionDir, `${c.id}.schema.json`), JSON.stringify({ type: 'object' }));
    const cfg: Record<string, unknown> = {
      agent_id: c.id,
      backend: c.backend,
      model: 'gpt-5',
      ...(c.omitPrompt ? {} : { prompt_file: `${c.id}.prompt.md` }),
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

describe('makeExtractionBackend — the boot-side backend factory (fail-closed per-backend env)', () => {
  it("constructs the OpenAIAdapter for 'openai' (demands OPENAI_API_KEY)", () => {
    expect(makeExtractionBackend({ OPENAI_API_KEY: 'sk-x' }, 'openai').id).toBe('openai');
    expect(() => makeExtractionBackend({}, 'openai')).toThrow(/OPENAI_API_KEY is required/);
  });
  it('carries BOTH agent request bounds from the env onto the client the openai backend registers', async () => {
    // The env-to-adapter wire: the resolvers are pinned in @rayspec/platform and what the adapter
    // registers is pinned in its own suite, but nothing observed the join — a dropped spread or a
    // misspelled key here leaves every suite green while the documented bounds stop applying.
    openaiRegistration.setDefaultOpenAIKey.mockClear();
    openaiRegistration.setDefaultOpenAIClient.mockClear();
    const backend = makeExtractionBackend(
      {
        OPENAI_API_KEY: 'sk-bounded',
        RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '45000',
        RAYSPEC_AGENT_MAX_ATTEMPTS: '2',
      },
      'openai',
    );
    // Registration happens in resolveAuth() — the one pre-run auth call — not in the constructor.
    expect(await backend.resolveAuth()).toBe('api-key');
    const client = registeredClient();
    expect(client.timeout).toBe(45_000); // RAYSPEC_AGENT_REQUEST_TIMEOUT_MS, verbatim
    expect(client.maxRetries).toBe(1); // RAYSPEC_AGENT_MAX_ATTEMPTS=2 ⇒ the first try plus one retry
    expect(client.apiKey).toBe('sk-bounded');
    expect(openaiRegistration.setDefaultOpenAIKey).not.toHaveBeenCalled();
  });
  it('registers the API KEY and NO client when neither agent request bound is set', async () => {
    // The other half of the promise: with both variables unset the boot registers auth exactly as it
    // did before they existed — the key alone, no client and so no bound of any kind.
    openaiRegistration.setDefaultOpenAIKey.mockClear();
    openaiRegistration.setDefaultOpenAIClient.mockClear();
    const backend = makeExtractionBackend({ OPENAI_API_KEY: 'sk-unbounded' }, 'openai');
    expect(await backend.resolveAuth()).toBe('api-key');
    expect(openaiRegistration.setDefaultOpenAIKey).toHaveBeenCalledTimes(1);
    expect(openaiRegistration.setDefaultOpenAIKey).toHaveBeenCalledWith('sk-unbounded');
    expect(openaiRegistration.setDefaultOpenAIClient).not.toHaveBeenCalled();
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

  // ── The $0-subscription billing footgun ────────────────────────────────────
  // The AnthropicAdapter passes the whole process.env to the child SDK; the SDK precedence is
  // ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN. So a deployment that INTENDS the $0 subscription but
  // ALSO carries a stray ANTHROPIC_API_KEY silently bills the API. We warn LOUD (boot-side, names-only).
  it('warns when BOTH the subscription token AND a stray ANTHROPIC_API_KEY are set', () => {
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

  it('pure: anthropicApiKeyOverrideWarning fires ONLY when both are set', () => {
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

describe('resolveExtractorConfigPath — the per-agent config convention', () => {
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

  // ── The belt-and-suspenders traversal jail (the SINK half; the grammar
  // SafeIdentifier is the SOURCE half). A `..`/`/` agent id (a code-built spec, or a future grammar
  // regression bypassing the parser) resolves OUTSIDE extraction/ — the jail must refuse to read it.
  it('multi-agent — throws when an agent id path-traverses OUT of the extraction dir', () => {
    const evilId = '../../../../../tmp/pwned';
    const spec = specWithAgents(['agent_one', evilId]);
    expect(() => resolveExtractorConfigPath({}, '/x/deploy/acme.yaml', spec, evilId)).toThrow(
      ProductBootError,
    );
    expect(() => resolveExtractorConfigPath({}, '/x/deploy/acme.yaml', spec, evilId)).toThrow(
      /extractor '\.\.\/.*\/tmp\/pwned': the resolved extractor-config path escapes the deployment extraction/,
    );
  });

  it('single-agent — throws when the sole agent id path-traverses out', () => {
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
    const nodeOne = live.buildNodeForAgent('agent_one', { tdb: FAKE_TDB, tenantId: LIVE_TENANT });
    const nodeTwo = live.buildNodeForAgent('agent_two', { tdb: FAKE_TDB, tenantId: LIVE_TENANT });
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
    expect(
      typeof live.buildNodeForAgent('agent_two', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
    ).toBe('function');
  });
  it('rejects when a per-agent config names the WRONG agent (config/agent mismatch)', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    // Write agent_two's file but with agent_id pointing at a different id.
    const d = mkdtempSync(join(tmpdir(), 'rayspec-boot-'));
    TMP_DIRS.push(d);
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

  // ── A built node genuinely BINDS to its DECLARED backend (not a shared openai
  // one). Proof: agent_two declares `anthropic` but the env lacks the anthropic creds → construction
  // fails with the ANTHROPIC-SPECIFIC demand, naming agent_two. A shared/openai node would not demand it.
  it('a node binds to its declared backend — anthropic without anthropic env throws at that agent', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'anthropic' },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'agent_two':.*CLAUDE_CODE_OAUTH_TOKEN .* or an ANTHROPIC_API_KEY/,
    );
  });

  // ── An unknown backend surfaces at buildLiveAgent, naming the AGENT + the wired set (not
  // only at the makeExtractionBackend unit) — the boot-level wrap adds the agent context.
  it('an unknown backend at buildLiveAgent names the agent + the wired set', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeExtractionDir([
      { id: 'agent_one', backend: 'openai' },
      { id: 'agent_two', backend: 'gemini' },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec)).toThrow(
      /extractor 'agent_two':.*backend 'gemini' is not wired.*openai \| anthropic \| pi \| codex/,
    );
  });

  // ── Validated-on-native is ALLOWED but silently drops native constrained decode — make the
  // downgrade boot-visible (a console.warn), and pin that the semantics degrade (not reject).
  it('validated-on-native (openai) is ALLOWED and warns loudly (downgrade visible)', () => {
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
        typeof live.buildNodeForAgent('agent_one', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
      ).toBe('function');
      // VISIBLE: the downgrade warning fired.
      const warned = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/NATIVE STRUCTURED OUTPUT DOWNGRADED \(extractor 'agent_one'\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it('pure: nativeValidatedDowngradeWarning fires ONLY for a native backend in validated mode', () => {
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
    expect(
      typeof live.buildNodeForAgent('doc_agent', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
    ).toBe('function');
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
      typeof live.buildNodeForAgent('expense_coder', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
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
  // A pure-SUBSET destructive delta: at present-matching the boot must PROBE the drop target.
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

  it('present-matching + ADDITIVE-only leftover whose table IS there → MOUNTS with the loud log', async () => {
    // A stale RAYSPEC_UPDATE_MIGRATION carrying only additive DDL on a plain restart must NOT re-apply
    // the non-idempotent delta (42P07 crash-loop). The table it creates is live ⇒ it really did run ⇒ MOUNT.
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      ADDITIVE,
      SPEC,
      (m) => logs.push(m),
      alwaysExists,
    );
    expect(plan.deployMode).toBe('mounted');
    expect(plan.migrations).toEqual([]); // ZERO migrations — the delta is NOT re-applied
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/table "pinned_moments"/); // the log names the object that proved it
    expect(logs[0]).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // tells the operator to clear the stale env
  });

  it('present-matching + a SUBSET DROP whose target STILL EXISTS → APPLIES (not a silent mount)', async () => {
    // The regression closed here: a pure-subset removal on its first boot present-matches (superset-blind)
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
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/table "highlights"/); // named as PROBED gone, which is what happened
    expect(logs[0]).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
  });

  // A delta whose ONLY object is a hand-shaped index — the object a `stores` generator cannot express,
  // and therefore one `detectDrift` never inspects: the classify says present-matching whether or not
  // the delta ran (#440).
  const HAND_INDEX: PlannedMigration[] = [
    {
      name: '0004_hand_index.sql',
      sql:
        "DO $tag1$ BEGIN PERFORM 1; RAISE NOTICE 'DROP TABLE scratchpad'; END $tag1$;\n" +
        '--> statement-breakpoint\n' +
        'CREATE INDEX "parts_label_idx" ON "parts" USING btree ("label");\n',
      allowlist: [],
    },
  ];

  it('present-matching + an object the delta CREATEs that is ABSENT → APPLIES, and the log NAMES it', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      HAND_INDEX,
      SPEC,
      (m) => logs.push(m),
      neverExists,
    );
    expect(plan.deployMode).toBe('updated'); // the delta runs — it is NOT a leftover
    expect(plan.migrations).toBe(HAND_INDEX); // through deploy()'s gate, exactly like a drifted boot
    expect(logs.join('\n')).toMatch(/parts_label_idx/); // says WHICH object it looked for and did not find
    expect(logs.join('\n')).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // the env is NOT stale
  });

  it('present-matching + that SAME delta with its object PRESENT → MOUNTS, and the log names what it PROBED', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      HAND_INDEX,
      SPEC,
      (m) => logs.push(m),
      alwaysExists,
    );
    expect(plan.deployMode).toBe('mounted'); // a genuinely applied delta is still recognised
    expect(plan.migrations).toEqual([]); // and NOT re-applied
    expect(logs[0]).toMatch(/index "parts_label_idx"/); // the claim names the object the probe answered for
    expect(logs[0]).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
  });

  it('present-matching + a delta naming NO probeable object → MOUNTS without claiming a probe it never ran', async () => {
    const dataOnly: PlannedMigration[] = [
      { name: '0005_seed.sql', sql: 'INSERT INTO "note_artifacts" ("note") VALUES (\'x\');\n' },
    ];
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      dataOnly,
      SPEC,
      (m) => logs.push(m),
      neverExists,
    );
    expect(plan.deployMode).toBe('mounted');
    expect(logs[0]).not.toMatch(/additive objects are present/); // nothing measured that
    expect(logs[0]).toMatch(/NO object whose live state can tell the two cases apart/);
    expect(logs[0]).toMatch(/nothing in this boot can tell you/); // true here: an INSERT leaves no trace
  });

  // A SET NOT NULL names no probeable object: whether it ran shows in the COLUMN'S SHAPE, which only the
  // classify looked at. It is therefore measured exactly when the classify INSPECTED that column — the
  // spec's own stores and their declared columns (detectDrift scopes every query to them). The two arms
  // below are the same delta on either side of that line.
  const NOT_NULL_DELTA: PlannedMigration[] = [
    {
      name: '0007_not_null.sql',
      sql: 'ALTER TABLE "parts" ALTER COLUMN "label" SET NOT NULL;\n',
      allowlist: [
        {
          kind: 'set-not-null',
          match: 'ALTER TABLE "parts" ALTER COLUMN "label" SET NOT NULL',
          reason: 'reviewed',
        },
      ],
    },
  ];

  it('present-matching + a delta the CLASSIFY itself measured → MOUNTS saying so, not "nothing can tell you"', async () => {
    // The column IS one the classify introspects, so unapplied it would have classified DRIFTED. Sending
    // the operator to a manual catalog check here, and dropping the "the env is stale" instruction, would
    // replace one false sentence with its opposite.
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      NOT_NULL_DELTA,
      SPEC,
      (m) => logs.push(m),
      neverExists,
      new Set(['parts.label']),
    );
    expect(plan.deployMode).toBe('mounted');
    expect(plan.migrations).toEqual([]);
    expect(logs[0]).toMatch(/PROVES its statements already ran/);
    expect(logs[0]).toMatch(/proven applied by the drift-clean classify/);
    expect(logs[0]).toMatch(/set-not-null/); // the evidence is quoted, not asserted
    expect(logs[0]).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // the env IS stale, and it says so
    expect(logs[0]).not.toMatch(/nothing in this boot can tell you/);
    expect(logs[0]).not.toMatch(/CHECK THE SCHEMA BY HAND/);
  });

  it('…but over a column the classify NEVER INSPECTS it claims nothing, and does not call the env stale', async () => {
    // The same statement on a column outside the spec's stores/columns: detectDrift never introspected
    // it, so "unapplied it would have shown as DRIFT" is simply not true there. Claiming it, and telling
    // the operator to remove the flag, is how a delta that never ran gets lost (#440).
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      NOT_NULL_DELTA,
      SPEC,
      (m) => logs.push(m),
      neverExists,
      new Set(['parts.other_column']), // "parts"."label" is NOT among the inspected columns
    );
    expect(plan.deployMode).toBe('mounted'); // still no re-apply — this kind never refuses on its own
    expect(logs[0]).not.toMatch(/PROVES its statements already ran/);
    expect(logs[0]).toMatch(/nothing in this boot can tell you/); // the honest wording, not a claim
    expect(logs[0]).toMatch(/CHECK THE SCHEMA BY HAND/);
  });

  it('present-matching + a reviewed RENAME whose OLD name is STILL there → APPLIES (it never ran)', async () => {
    // A rename names no created object, but it does name the object it renames AWAY — and that name is
    // probeable. Still there ⇒ the rename has not run ⇒ apply, instead of mounting and losing it while
    // telling the operator the env is stale (#440, for a statement class that names no CREATE).
    const renameDelta: PlannedMigration[] = [
      {
        name: '0008_rename.sql',
        sql: 'ALTER TABLE "scratch" RENAME TO "scratch_v2";\n',
        allowlist: [
          {
            kind: 'rename-table',
            match: 'ALTER TABLE "scratch" RENAME TO "scratch_v2"',
            reason: 'reviewed',
          },
        ],
      },
    ];
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      renameDelta,
      SPEC,
      (m) => logs.push(m),
      alwaysExists, // the live schema still holds "scratch"
    );
    expect(plan.deployMode).toBe('updated');
    expect(plan.migrations).toBe(renameDelta);
    expect(logs.join('\n')).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // the env is NOT stale
  });

  it('the zero-evidence wording fires ONLY when there is no evidence of any kind', () => {
    // Both wordings pinned side by side: the honest "nothing measured this" and the honest "this was
    // measured" must never be printed for the other case.
    expect(leftoverUpdateEnvMountLog({ present: [], gone: [], renamed: [], proven: [] })).toMatch(
      /nothing in this boot can tell you/,
    );
    expect(
      leftoverUpdateEnvMountLog({
        present: [],
        gone: [],
        renamed: [],
        proven: ["rename-table ('…')"],
      }),
    ).not.toMatch(/nothing in this boot can tell you/);
    expect(
      leftoverUpdateEnvMountLog({ present: ['index "x"'], gone: [], renamed: [], proven: [] }),
    ).not.toMatch(/nothing in this boot can tell you/);
  });

  it('present-matching + a HALF-LANDED delta → REFUSES, naming what it found and what it did not', async () => {
    const halfLanded: PlannedMigration[] = [
      {
        name: '0006_add_pinned.sql',
        sql:
          'CREATE TABLE "pinned_moments" (\n"id" uuid\n);\n' +
          '--> statement-breakpoint\n' +
          'CREATE INDEX "pinned_moments_label_idx" ON "pinned_moments" USING btree ("label");\n',
        allowlist: [],
      },
    ];
    const onlyTable = async (p: { index?: string }): Promise<boolean> => p.index === undefined;
    await expect(
      planUpdateBoot('present-matching', halfLanded, SPEC, () => {}, onlyTable),
    ).rejects.toThrow(ProductBootError);
    await expect(
      planUpdateBoot('present-matching', halfLanded, SPEC, () => {}, onlyTable),
    ).rejects.toThrow(/table "pinned_moments"[\s\S]*index "pinned_moments_label_idx"/);
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
  const probe = (present: ReadonlySet<string>) => async (p: SchemaObjectProbe) => {
    const key =
      p.kind === 'table'
        ? p.table
        : p.kind === 'column'
          ? `${p.table}.${p.column}`
          : p.kind === 'index'
            ? p.index
            : `${p.table}#${p.constraint}`;
    return present.has(key);
  };

  it('a superset-blind drop whose target EXISTS → { kind: apply } (an unapplied subset removal)', async () => {
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";'),
      probe(new Set(['highlights'])),
    );
    expect(route).toEqual({ kind: 'apply', absent: [] });
  });

  it('a superset-blind drop whose target is GONE → { kind: mount } (a genuine leftover)', async () => {
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";'),
      probe(new Set()),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: ['table "highlights"'], renamed: [], proven: [] },
    });
  });

  it('no destructive findings (additive-only) → the probe decides on the object the delta CREATEs', async () => {
    const probed: unknown[] = [];
    const route = await routePresentMatchingUpdate(mig('CREATE TABLE "x" ();'), async (p) => {
      probed.push(p);
      return true;
    });
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: ['table "x"'], gone: [], renamed: [], proven: [] },
    });
    expect(probed).toEqual([{ kind: 'table', table: 'x' }]);
  });

  it('a MIXED delta — one target gone, one still present → REFUSES (that IS a half-landed delta)', async () => {
    // Both halves are evidence, and they disagree: the delta's first DROP ran and its second did not.
    // Re-applying would raise 42P01 on the table that is already gone, which is exactly what the shipped
    // "a delta found only PARTLY applied is REFUSED" sentence promises not to do.
    const route = await routePresentMatchingUpdate(
      mig('DROP TABLE "highlights";\n--> statement-breakpoint\nDROP TABLE "pinned_moments";'),
      probe(new Set(['pinned_moments'])), // highlights gone, pinned_moments still there
    );
    expect(route).toEqual({
      kind: 'refuse-half-landed',
      landed: ['table "highlights" — a reviewed DROP in the delta names it, and it is GONE'],
      unlanded: [
        'table "pinned_moments" — a reviewed DROP in the delta names it, and it is STILL there',
      ],
    });
  });

  it('a column-shape kind (SET NOT NULL) over an INSPECTED column → { kind: mount }, NOT refuse (no ENV-1 crash-loop)', async () => {
    // detectDrift catches an unapplied SET NOT NULL as column_nullability drift — for a column it
    // introspects — so at present-matching it is PROVEN applied: a legitimate leftover after a non-subset
    // update must MOUNT, never refuse.
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL;', [
        {
          kind: 'set-not-null',
          match: 'ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL',
          reason: 'reviewed',
        },
      ]),
      probe(new Set()),
      new Set(['note_artifacts.note']),
    );
    // …and it is carried as CLASSIFY-DERIVED evidence, not as "nothing was measured": for a column the
    // classify INSPECTED, reaching present-matching at all IS the measurement.
    expect(route).toEqual({
      kind: 'mount',
      probed: {
        present: [],
        gone: [],
        renamed: [],
        proven: [`set-not-null ('ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL')`],
      },
    });
  });

  it('…the SAME statement over a column the classify never inspects claims NOTHING', async () => {
    // detectDrift scopes every query to the spec's stores and compares only their DECLARED columns, so a
    // hand-added column is never introspected: "unapplied it would have shown as DRIFT" does not hold
    // there. Zero evidence is the honest reading — never a proof the classify never produced.
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "scratch" ALTER COLUMN "note" SET NOT NULL;', [
        {
          kind: 'set-not-null',
          match: 'ALTER TABLE "scratch" ALTER COLUMN "note" SET NOT NULL',
          reason: 'reviewed',
        },
      ]),
      probe(new Set()),
      new Set(['note_artifacts.note']), // "scratch"."note" is NOT inspected
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('a reviewed RENAME whose OLD name is STILL there → { kind: apply } (it never ran)', async () => {
    // The rename names no CREATE, but it does name what it renames AWAY, and that name is probeable:
    // still there ⇒ the delta has not run. Mounting here would lose the rename and call the env stale.
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "scratch" RENAME TO "scratch_v2";', [
        {
          kind: 'rename-table',
          match: 'ALTER TABLE "scratch" RENAME TO "scratch_v2"',
          reason: 'reviewed',
        },
      ]),
      probe(new Set(['scratch'])),
    );
    expect(route).toEqual({ kind: 'apply', absent: [] });
  });

  it('…and that same RENAME beside an absent CREATE names BOTH sides as UNLANDED, not half landed', async () => {
    // Both statements of a delta that never ran. Reading the rename as landed would refuse a delta that
    // is entirely safe to apply.
    const route = await routePresentMatchingUpdate(
      mig(
        'ALTER TABLE "scratch" RENAME TO "scratch_v2";\n--> statement-breakpoint\n' +
          'CREATE INDEX "scratch_v2_label_idx" ON "scratch_v2" ("label");',
        [
          {
            kind: 'rename-table',
            match: 'ALTER TABLE "scratch" RENAME TO "scratch_v2"',
            reason: 'reviewed',
          },
        ],
      ),
      probe(new Set(['scratch'])),
    );
    expect(route).toEqual({ kind: 'apply', absent: ['index "scratch_v2_label_idx"'] });
  });

  it('a RENAME whose old name is GONE claims nothing either — an object that never existed is gone too', async () => {
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "scratch" RENAME COLUMN "old" TO "new";', [
        {
          kind: 'rename-column',
          match: 'ALTER TABLE "scratch" RENAME COLUMN "old" TO "new"',
          reason: 'reviewed',
        },
      ]),
      probe(new Set()),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('an `ADD COLUMN … NOT NULL` is measured ONCE — by the probe on the column it adds', async () => {
    // It is BOTH a scan finding and an additive statement. Counting the finding as classify-proven while
    // the probe reports the column absent put ONE statement in both piles: refused as "half landed" for
    // having run and not run at once, on a delta that plainly never ran.
    const addNotNull = mig('ALTER TABLE "parts" ADD COLUMN "note" text NOT NULL;', [
      {
        kind: 'add-column-not-null-no-default',
        match: 'ALTER TABLE "parts" ADD COLUMN "note" text NOT NULL',
        reason: 'reviewed',
      },
    ]);
    expect(await routePresentMatchingUpdate(addNotNull, probe(new Set()))).toEqual({
      kind: 'apply',
      absent: ['column "parts"."note"'],
    });
    // …and the landed arm names it exactly once, from the probe that answered for it.
    expect(
      await routePresentMatchingUpdate(
        addNotNull,
        probe(new Set(['parts.note'])),
        new Set(['parts.note']),
      ),
    ).toEqual({
      kind: 'mount',
      probed: { present: ['column "parts"."note"'], gone: [], renamed: [], proven: [] },
    });
  });

  it('an `IF EXISTS` DROP whose target is GONE is NOT evidence — it may never have existed', async () => {
    // An IF EXISTS re-drop raises nothing, so its target's absence cannot prove THIS delta ran. Reading
    // it as landed refused a delta that had not run at all and was entirely safe to apply.
    const route = await routePresentMatchingUpdate(
      mig(
        'DROP TABLE IF EXISTS "gone_already";\n--> statement-breakpoint\n' +
          'CREATE INDEX "parts_label_idx" ON "parts" ("label");',
        [{ kind: 'drop-table', match: 'DROP TABLE IF EXISTS "gone_already"', reason: 'reviewed' }],
      ),
      probe(new Set()),
    );
    expect(route).toEqual({ kind: 'apply', absent: ['index "parts_label_idx"'] });
  });

  it('ACCEPT CONTROL: the same delta with a PLAIN DROP still reads the gone target as landed', async () => {
    // The control that makes the arm above mean something: a non-idempotent DROP whose target is gone IS
    // evidence the delta ran, and beside an absent CREATE that is still a half-landed refusal.
    const route = await routePresentMatchingUpdate(
      mig(
        'DROP TABLE "gone_already";\n--> statement-breakpoint\n' +
          'CREATE INDEX "parts_label_idx" ON "parts" ("label");',
        [{ kind: 'drop-table', match: 'DROP TABLE "gone_already"', reason: 'reviewed' }],
      ),
      probe(new Set()),
    );
    expect(route).toEqual({
      kind: 'refuse-half-landed',
      landed: ['table "gone_already" — a reviewed DROP in the delta names it, and it is GONE'],
      unlanded: ['index "parts_label_idx" — a CREATE in the delta names it, and it is NOT there'],
    });
  });

  it('an `IF EXISTS` DROP whose target is STILL THERE is still UNLANDED (the drop is not lost)', async () => {
    // The other direction of the same rule: idempotence makes ABSENCE meaningless, not presence. This is
    // the shipped `DROP INDEX IF EXISTS "journal_idem_idx"` shape — it must still route to apply.
    const route = await routePresentMatchingUpdate(
      mig('DROP INDEX IF EXISTS "journal_idem_idx";', [
        {
          kind: 'drop-index',
          match: 'DROP INDEX IF EXISTS "journal_idem_idx"',
          reason: 'reviewed',
        },
      ]),
      probe(new Set(['journal_idem_idx'])),
    );
    expect(route).toEqual({ kind: 'apply', absent: [] });
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

/**
 * The objects the DELTA names are the only evidence a drift-clean classify leaves (#440).
 *
 * `detectDrift` introspects the NEW spec's stores/columns/FKs, so an object the spec cannot express —
 * a hand-shaped index is the canonical one — is invisible to it: the classify reads `present-matching`
 * whether the delta ran or not. Deciding "already applied" on that classify alone MOUNTS an UNAPPLIED
 * delta, tells the operator the env is stale, and the change is lost; and the mount log asserted a
 * measurement nobody took ("its additive objects are present"). So the router probes the objects the
 * delta CREATEs as well as the targets it DROPs.
 */
describe('routePresentMatchingUpdate — the objects the delta CREATEs are probed too', () => {
  const mig = (sql: string, allowlist: PlannedMigration['allowlist'] = []): PlannedMigration[] => [
    { name: 'd.sql', sql, allowlist },
  ];
  /**
   * A live-schema fake keyed by the object NAME and blind to the probe's KIND — which is what a live
   * schema is: it answers "is this index here?" the same way whether a DROP targets it or a CREATE
   * names it. Typed structurally so it reads against the probe shape either way.
   */
  const objectProbe =
    (present: ReadonlySet<string>) =>
    async (p: {
      table?: string;
      column?: string;
      index?: string;
      constraint?: string;
    }): Promise<boolean> =>
      present.has(p.index ?? p.constraint ?? p.column ?? p.table ?? '');

  // The reported delta: a DO block whose NOTICE text contains SQL (the literal decoy — a `;` inside a
  // dollar-quoted body is not a statement boundary and `DROP TABLE` inside it is not a DROP), plus one
  // hand-shaped index, exactly the object a `stores` generator cannot express.
  const HAND_INDEX =
    "DO $tag1$ BEGIN PERFORM 1; RAISE NOTICE 'DROP TABLE scratchpad'; END $tag1$;\n" +
    '--> statement-breakpoint\n' +
    'CREATE INDEX "parts_label_idx" ON "parts" USING btree ("label");\n';

  it('the index the delta CREATEs is ABSENT → { kind: apply } NAMING the object it did not find', async () => {
    const route = await routePresentMatchingUpdate(mig(HAND_INDEX), objectProbe(new Set()));
    expect(route.kind).toBe('apply');
    expect((route as { absent: readonly string[] }).absent).toEqual(['index "parts_label_idx"']);
  });

  it('the index the delta CREATEs is PRESENT → { kind: mount }, and the probe was ASKED about it', async () => {
    // The other arm of the same contract: a delta that GENUINELY landed must still mount (re-applying a
    // non-idempotent delta crash-loops the boot). The mount is only allowed to rest on a probe that ran.
    const asked: unknown[] = [];
    const route = await routePresentMatchingUpdate(mig(HAND_INDEX), async (p) => {
      asked.push(p);
      return true;
    });
    expect(route.kind).toBe('mount');
    expect(asked).toEqual([{ kind: 'index', index: 'parts_label_idx' }]);
  });

  it('every additive form the generator emits is probed (table, column, index, constraint)', async () => {
    const asked: unknown[] = [];
    await routePresentMatchingUpdate(
      mig(
        'CREATE TABLE "pinned_moments" (\n"id" uuid\n);\n' +
          '--> statement-breakpoint\n' +
          'ALTER TABLE "note_artifacts" ADD COLUMN "note" text;\n' +
          '--> statement-breakpoint\n' +
          'ALTER TABLE "pinned_moments" ADD CONSTRAINT "pinned_moments_tenant_id_orgs_id_fk" ' +
          'FOREIGN KEY ("tenant_id") REFERENCES "orgs"("id");\n' +
          '--> statement-breakpoint\n' +
          'CREATE INDEX "pinned_moments_tenant_idx" ON "pinned_moments" USING btree ("tenant_id");\n',
      ),
      async (p) => {
        asked.push(p);
        return true;
      },
    );
    expect(asked).toEqual([
      { kind: 'table', table: 'pinned_moments' },
      { kind: 'column', table: 'note_artifacts', column: 'note' },
      {
        kind: 'constraint',
        table: 'pinned_moments',
        constraint: 'pinned_moments_tenant_id_orgs_id_fk',
      },
      { kind: 'index', index: 'pinned_moments_tenant_idx' },
    ]);
  });

  it('SQL inside a literal names NO object (the decoy is not read as a statement)', async () => {
    const asked: unknown[] = [];
    const route = await routePresentMatchingUpdate(
      mig(
        'DO $tag1$ BEGIN RAISE NOTICE \'CREATE INDEX "ghost_idx" ON "parts"\'; END $tag1$;\n' +
          '--> statement-breakpoint\n' +
          'CREATE INDEX "parts_label_idx" ON "parts" USING btree ("label");\n',
      ),
      async (p) => {
        asked.push(p);
        return true;
      },
    );
    expect(route.kind).toBe('mount');
    expect(asked).toEqual([{ kind: 'index', index: 'parts_label_idx' }]); // never "ghost_idx"
  });

  it('SOME objects present and some absent → { kind: refuse-half-landed }, carrying both sides (fail-closed)', async () => {
    // A half-landed delta cannot be re-applied (the object that IS there would raise 42P07) and cannot be
    // called applied either. Refuse, and say what was found and what was not — never guess.
    const route = await routePresentMatchingUpdate(
      mig(
        'CREATE TABLE "pinned_moments" (\n"id" uuid\n);\n' +
          '--> statement-breakpoint\n' +
          'CREATE INDEX "pinned_moments_label_idx" ON "pinned_moments" USING btree ("label");\n',
      ),
      objectProbe(new Set(['pinned_moments'])),
    );
    expect(route).toEqual({
      kind: 'refuse-half-landed',
      landed: ['table "pinned_moments" — a CREATE in the delta names it, and it is THERE'],
      unlanded: [
        'index "pinned_moments_label_idx" — a CREATE in the delta names it, and it is NOT there',
      ],
    });
  });

  it('an `IF NOT EXISTS` object is NOT evidence either way — it is re-appliable, so it is not probed', async () => {
    // `ADD COLUMN IF NOT EXISTS` (the injected-backfill form) is idempotent: its presence does not show
    // THIS delta ran, and re-running it cannot crash. Counting it as "applied" would be another claim
    // the schema never supported.
    const asked: unknown[] = [];
    const route = await routePresentMatchingUpdate(
      mig('ALTER TABLE "note_artifacts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;\n'),
      async (p) => {
        asked.push(p);
        return true;
      },
    );
    expect(route.kind).toBe('mount');
    expect(asked).toEqual([]);
  });
});

/**
 * A name is read the way the CATALOG holds it, or it is not read at all.
 *
 * The extractors here turn a statement into a probe QUESTION, so a name read only PARTLY is worse than
 * no name: the boot then asks the live schema about an object the delta never mentions and believes the
 * answer. A hand-authored delta is exactly the population this path exists for (the generator's own
 * output is quoted and unqualified), so the shapes a human writes — `public.x`, `"a b"`, `UPPER_IDX` —
 * are the ones that must not mis-parse.
 */
describe('the additive extractor reads an identifier WHOLE, folded, or not at all', () => {
  const accept = 'CREATE TABLE "parts_extra" ("id" uuid);'; // the ACCEPT control: generator-shaped

  it('ACCEPT CONTROL: a generator-shaped name is read exactly', () => {
    expect(extractAdditiveObjects(accept)).toEqual([{ kind: 'table', table: 'parts_extra' }]);
  });

  it('a SCHEMA-QUALIFIED name yields NO object — never the schema read as the object', () => {
    // Was: [{ kind: 'table', table: 'public' }] — the probe then asked whether a table called "public"
    // exists, found none, and re-applied a delta that had already landed (42P07, crash-loop).
    expect(extractAdditiveObjects('CREATE TABLE public.audit_log ("id" uuid);')).toEqual([]);
    expect(extractAdditiveObjects('CREATE TABLE "public"."audit_log" ("id" uuid);')).toEqual([]);
    expect(extractAdditiveObjects('CREATE INDEX public.parts_label_idx ON parts (label);')).toEqual(
      [],
    );
    expect(extractAdditiveObjects('ALTER TABLE public.parts ADD COLUMN "note" text;')).toEqual([]);
  });

  it('an UNQUOTED name is FOLDED to lower case, the way the catalog stores it', () => {
    expect(extractAdditiveObjects('CREATE INDEX Parts_Label_Idx ON parts (label);')).toEqual([
      { kind: 'index', index: 'parts_label_idx' },
    ]);
    expect(extractAdditiveObjects('CREATE INDEX PARTS_LABEL_IDX ON parts (label);')).toEqual([
      { kind: 'index', index: 'parts_label_idx' },
    ]);
    expect(extractAdditiveObjects('CREATE TABLE Parts_Extra (id uuid);')).toEqual([
      { kind: 'table', table: 'parts_extra' },
    ]);
  });

  it('a QUOTED name keeps its case and its unusual characters — read to the closing quote', () => {
    // Was: truncated at the first character outside [A-Za-z0-9_$] — `"parts extra"` became `parts`,
    // an object the delta does not create, and a live `parts` MOUNTED a delta that never ran.
    expect(extractAdditiveObjects('CREATE TABLE "parts extra" ("id" uuid);')).toEqual([
      { kind: 'table', table: 'parts extra' },
    ]);
    expect(extractAdditiveObjects('CREATE TABLE "parts-archive" (id uuid);')).toEqual([
      { kind: 'table', table: 'parts-archive' },
    ]);
    expect(extractAdditiveObjects('CREATE INDEX "Parts Label Idx" ON "parts" ("label");')).toEqual([
      { kind: 'index', index: 'Parts Label Idx' },
    ]);
  });

  it('a name that cannot be read whole yields NO object (an unterminated quote, a non-ASCII letter)', () => {
    expect(extractAdditiveObjects('CREATE TABLE "parts_extra (id uuid);')).toEqual([]);
    expect(extractAdditiveObjects('CREATE TABLE café (id uuid);')).toEqual([]);
  });

  it('an object the SAME delta RENAMEs or DROPs away is not required to be present', () => {
    // A landed `CREATE TABLE "t_new"` + `RENAME TO "t"` leaves NO t_new. Demanding one routed a fully
    // applied delta to APPLY, which re-ran a rename that cannot succeed twice.
    expect(
      extractAdditiveObjects(
        'CREATE TABLE "t_new" ("id" uuid);\n--> statement-breakpoint\nALTER TABLE "t_new" RENAME TO "t";',
      ),
    ).toEqual([]);
    expect(
      extractAdditiveObjects(
        'ALTER TABLE "parts" ADD COLUMN "note" text;\n--> statement-breakpoint\n' +
          'ALTER TABLE "parts" RENAME COLUMN "note" TO "label";',
      ),
    ).toEqual([]);
    expect(
      extractAdditiveObjects(
        'CREATE INDEX "tmp_idx" ON "parts" ("label");\n--> statement-breakpoint\nDROP INDEX "tmp_idx";',
      ),
    ).toEqual([]);
    expect(
      extractAdditiveObjects(
        'ALTER TABLE "parts" ADD CONSTRAINT "parts_ck" CHECK ("label" <> \'\');\n' +
          '--> statement-breakpoint\nALTER TABLE "parts" DROP CONSTRAINT "parts_ck";',
      ),
    ).toEqual([]);
    // …and a member of a table the delta renames away goes with it (it is unreachable under that name).
    expect(
      extractAdditiveObjects(
        'CREATE TABLE "t_new" ("id" uuid);\n--> statement-breakpoint\n' +
          'ALTER TABLE "t_new" ADD CONSTRAINT "t_new_pk" PRIMARY KEY ("id");\n' +
          '--> statement-breakpoint\nALTER TABLE "t_new" RENAME TO "t";',
      ),
    ).toEqual([]);
    // An INDEX survives a table rename under its own name, so it stays as evidence.
    expect(
      extractAdditiveObjects(
        'CREATE TABLE "t_new" ("id" uuid);\n--> statement-breakpoint\n' +
          'CREATE INDEX "t_id_idx" ON "t_new" ("id");\n' +
          '--> statement-breakpoint\nALTER TABLE "t_new" RENAME TO "t";',
      ),
    ).toEqual([{ kind: 'index', index: 't_id_idx' }]);
  });

  it('a create-then-rename delta that HAS landed MOUNTS instead of re-applying the rename', async () => {
    const route = await routePresentMatchingUpdate(
      [
        {
          name: 'd.sql',
          sql: 'CREATE TABLE "t_new" ("id" uuid);\n--> statement-breakpoint\nALTER TABLE "t_new" RENAME TO "t";',
          allowlist: [
            {
              kind: 'rename-table',
              match: 'ALTER TABLE "t_new" RENAME TO "t"',
              reason: 'reviewed',
            },
          ],
        },
      ],
      async () => false, // the live schema holds "t", not "t_new" — what an APPLIED delta leaves
    );
    // Nothing here is claimed as proof: `t_new` is gone, which an applied delta leaves behind — and so
    // does a delta that never created it. The mount rests on there being NO un-landed evidence, and the
    // log says exactly that.
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('…and the SAME delta before it ran (the created table is still absent) still APPLIES', async () => {
    // The counterpart that keeps the arm above from resting on an empty tautology: a create-then-rename
    // delta that has NOT run leaves `t_new` absent too, so the rename must not be read as landed — with
    // the index it also creates missing, the whole delta is un-landed and applies.
    const route = await routePresentMatchingUpdate(
      [
        {
          name: 'd.sql',
          sql:
            'CREATE TABLE "t_new" ("id" uuid);\n--> statement-breakpoint\n' +
            'CREATE INDEX "t_id_idx" ON "t_new" ("id");\n--> statement-breakpoint\n' +
            'ALTER TABLE "t_new" RENAME TO "t";',
          allowlist: [
            {
              kind: 'rename-table',
              match: 'ALTER TABLE "t_new" RENAME TO "t"',
              reason: 'reviewed',
            },
          ],
        },
      ],
      async () => false,
    );
    expect(route).toEqual({ kind: 'apply', absent: ['index "t_id_idx"'] });
  });

  it('the DESTRUCTIVE extractor folds an unquoted target too (else a live table reads as GONE)', () => {
    expect(extractDestructiveTarget('drop-table', 'DROP TABLE Highlights')).toEqual({
      kind: 'drop-table',
      table: 'highlights',
    });
    // …and a qualified or unreadable target still REFUSES upstream rather than probing a guess.
    expect(extractDestructiveTarget('drop-table', 'DROP TABLE public.highlights')).toBeUndefined();
    expect(
      extractDestructiveTarget('drop-column', 'ALTER TABLE public.t DROP COLUMN "c"'),
    ).toBeUndefined();
  });
});

/**
 * "A delta found only PARTLY applied is REFUSED" — the sentence shipped in .env.example and the CLI
 * reference — across the WHOLE matrix, not just the additive quadrant. Both halves of a delta are
 * evidence; when they disagree the delta is half landed, and re-applying it raises 42P07 on an object it
 * re-creates or 42P01 on a target it re-drops.
 */
describe('routePresentMatchingUpdate — the four quadrants of a delta with BOTH halves', () => {
  const MIXED: PlannedMigration[] = [
    {
      name: '0007_mixed.sql',
      sql:
        'DROP TABLE "highlights";\n--> statement-breakpoint\n' +
        'CREATE INDEX "parts_label_idx" ON "parts" USING btree ("label");\n',
      allowlist: [{ kind: 'drop-table', match: 'DROP TABLE "highlights"', reason: 'reviewed' }],
    },
  ];
  const live = (names: ReadonlySet<string>) => async (p: SchemaObjectProbe) =>
    names.has(p.kind === 'index' ? p.index : p.kind === 'table' ? p.table : '');

  it('drop target STILL there + index ABSENT (it never ran) → APPLY, naming the index too', async () => {
    const route = await routePresentMatchingUpdate(MIXED, live(new Set(['highlights'])));
    expect(route).toEqual({ kind: 'apply', absent: ['index "parts_label_idx"'] });
  });

  it('drop target GONE + index PRESENT (it fully ran) → MOUNT', async () => {
    const route = await routePresentMatchingUpdate(MIXED, live(new Set(['parts_label_idx'])));
    expect(route).toEqual({
      kind: 'mount',
      probed: {
        present: ['index "parts_label_idx"'],
        gone: ['table "highlights"'],
        renamed: [],
        proven: [],
      },
    });
  });

  it('drop target GONE + index ABSENT (half landed) → REFUSE, not a re-applied DROP (42P01)', async () => {
    const route = await routePresentMatchingUpdate(MIXED, live(new Set()));
    expect(route).toEqual({
      kind: 'refuse-half-landed',
      landed: ['table "highlights" — a reviewed DROP in the delta names it, and it is GONE'],
      unlanded: ['index "parts_label_idx" — a CREATE in the delta names it, and it is NOT there'],
    });
  });

  it('drop target STILL there + index PRESENT (half landed) → REFUSE, not a re-created index (42P07)', async () => {
    const route = await routePresentMatchingUpdate(
      MIXED,
      live(new Set(['highlights', 'parts_label_idx'])),
    );
    expect(route).toEqual({
      kind: 'refuse-half-landed',
      landed: ['index "parts_label_idx" — a CREATE in the delta names it, and it is THERE'],
      unlanded: [
        'table "highlights" — a reviewed DROP in the delta names it, and it is STILL there',
      ],
    });
  });

  it('the REFUSAL the boot raises names both sides', async () => {
    await expect(
      planUpdateBoot(
        'present-matching',
        MIXED,
        '/tmp/acme.product.yaml',
        () => {},
        live(new Set()),
      ),
    ).rejects.toThrow(
      /HALF LANDED[\s\S]*ALREADY landed[\s\S]*highlights[\s\S]*NOT landed[\s\S]*parts_label_idx/,
    );
  });
});

/**
 * A name the SAME delta puts BACK cannot decide whether that delta ran.
 *
 * `ALTER TABLE "parts" RENAME TO "parts_archive"` beside a `CREATE TABLE "parts"` leaves `parts` in the
 * catalog at BOTH ends: before the delta (the table being renamed away) and after it (the table the
 * delta creates in its place). Reading "the old name is still there" as "the rename has not run" was
 * therefore true of a delta that had FULLY landed, which routed it to APPLY — and a rename cannot run
 * twice, so the boot died on 42P07 and, under `Restart=always`, never served. The name the rename GIVES
 * the object is the one that discriminates, and it is the only measurement such a statement gets.
 *
 * Both arms are pinned for every shape below, because fixing one at the cost of the other is exactly how
 * this arrived: an already-applied delta must MOUNT (never re-apply), and one that never ran must APPLY.
 */
describe('routePresentMatchingUpdate — a name the SAME delta re-creates settles nothing', () => {
  const mig = (sql: string, allowlist: PlannedMigration['allowlist'] = []): PlannedMigration[] => [
    { name: 'd.sql', sql, allowlist },
  ];
  const live = (names: ReadonlySet<string>) => async (p: SchemaObjectProbe) =>
    names.has(
      p.kind === 'table'
        ? p.table
        : p.kind === 'column'
          ? `${p.table}.${p.column}`
          : p.kind === 'index'
            ? p.index
            : `${p.table}#${p.constraint}`,
    );

  // RENAME the table away, then CREATE a new one under the freed name.
  const RECYCLED_TABLE = mig(
    'ALTER TABLE "parts" RENAME TO "parts_archive";\n--> statement-breakpoint\n' +
      'CREATE TABLE "parts" ("id" uuid PRIMARY KEY, "label" text);',
    [
      {
        kind: 'rename-table',
        match: 'ALTER TABLE "parts" RENAME TO "parts_archive"',
        reason: 'reviewed',
      },
    ],
  );

  it('FULLY APPLIED (both names live) → MOUNT, naming the name the RENAME gave the table', async () => {
    // The regression, in one reading: `parts` is there because the delta re-created it, and demanding
    // it be gone re-ran `RENAME TO "parts_archive"` — 42P07 on a delta that had entirely landed.
    const route = await routePresentMatchingUpdate(
      RECYCLED_TABLE,
      live(new Set(['parts', 'parts_archive'])),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: ['table "parts_archive"'], proven: [] },
    });
  });

  it('NEVER APPLIED (only the freed name live) → APPLY — the change is not lost either', async () => {
    // The arm the fix above must not buy: `parts` is there because the rename has not run yet, and
    // `parts_archive` is not there at all. Mounting here would call the env stale and lose the rename.
    const route = await routePresentMatchingUpdate(RECYCLED_TABLE, live(new Set(['parts'])));
    expect(route).toEqual({ kind: 'apply', absent: [] });
  });

  it('…and the boot MOUNTS the applied one with ZERO migrations, claiming only what it probed', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      RECYCLED_TABLE,
      '/tmp/acme.product.yaml',
      (m) => logs.push(m),
      live(new Set(['parts', 'parts_archive'])),
    );
    expect(plan.deployMode).toBe('mounted');
    expect(plan.migrations).toEqual([]); // the rename is NOT re-run
    expect(logs[0]).toMatch(/table "parts_archive"/); // the log names the object the probe asked about
    expect(logs[0]).not.toMatch(/nothing in this boot can tell you/); // something WAS measured
  });

  it('…and the boot APPLIES the un-landed one, without calling the env stale', async () => {
    const logs: string[] = [];
    const plan = await planUpdateBoot(
      'present-matching',
      RECYCLED_TABLE,
      '/tmp/acme.product.yaml',
      (m) => logs.push(m),
      live(new Set(['parts'])),
    );
    expect(plan.deployMode).toBe('updated');
    expect(plan.migrations).toBe(RECYCLED_TABLE);
    expect(logs.join('\n')).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
  });

  it('the RENAME COLUMN shape reads the same way, in both directions', async () => {
    const recycledColumn = mig(
      'ALTER TABLE "parts" RENAME COLUMN "note" TO "note_legacy";\n--> statement-breakpoint\n' +
        'ALTER TABLE "parts" ADD COLUMN "note" text;',
      [
        {
          kind: 'rename-column',
          match: 'ALTER TABLE "parts" RENAME COLUMN "note" TO "note_legacy"',
          reason: 'reviewed',
        },
      ],
    );
    expect(
      await routePresentMatchingUpdate(
        recycledColumn,
        live(new Set(['parts.note', 'parts.note_legacy'])),
      ),
    ).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: ['column "parts"."note_legacy"'], proven: [] },
    });
    expect(await routePresentMatchingUpdate(recycledColumn, live(new Set(['parts.note'])))).toEqual(
      { kind: 'apply', absent: [] },
    );
  });

  it('a delta that ROTATES two names measures each rename by the name that decides it', async () => {
    // `a → b` frees `a`, and the second statement puts `a` back — so `a` decides nothing and `b` does.
    // `c` is freed by nobody's re-creation, so it keeps the reading it always had.
    const rotate = mig(
      'ALTER TABLE "a" RENAME TO "b";\n--> statement-breakpoint\n' +
        'ALTER TABLE "c" RENAME TO "a";',
      [
        { kind: 'rename-table', match: 'ALTER TABLE "a" RENAME TO "b"', reason: 'reviewed' },
        { kind: 'rename-table', match: 'ALTER TABLE "c" RENAME TO "a"', reason: 'reviewed' },
      ],
    );
    // Applied: `b` and `a` stand, `c` is gone.
    expect(await routePresentMatchingUpdate(rotate, live(new Set(['a', 'b'])))).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: ['table "b"'], proven: [] },
    });
    // Never ran: `a` and `c` stand, `b` does not — both statements say so.
    expect(await routePresentMatchingUpdate(rotate, live(new Set(['a', 'c'])))).toEqual({
      kind: 'apply',
      absent: [],
    });
  });

  it('a HALF-landed recycled rename REFUSES, naming the new name as landed', async () => {
    // The landed pile is wired, not merely carried: the rename ran (`parts_archive` is there) while the
    // index the same delta creates is not, and re-applying would raise 42P07 on the renamed table.
    const withIndex = mig(
      'ALTER TABLE "parts" RENAME TO "parts_archive";\n--> statement-breakpoint\n' +
        'CREATE TABLE "parts" ("id" uuid PRIMARY KEY);\n--> statement-breakpoint\n' +
        'CREATE INDEX "parts_archive_label_idx" ON "parts_archive" ("label");',
      [
        {
          kind: 'rename-table',
          match: 'ALTER TABLE "parts" RENAME TO "parts_archive"',
          reason: 'reviewed',
        },
      ],
    );
    expect(
      await routePresentMatchingUpdate(withIndex, live(new Set(['parts', 'parts_archive']))),
    ).toEqual({
      kind: 'refuse-half-landed',
      landed: [
        'table "parts_archive" — a reviewed RENAME in the delta renames TO it, and it is THERE',
      ],
      unlanded: [
        'index "parts_archive_label_idx" — a CREATE in the delta names it, and it is NOT there',
      ],
    });
  });

  it('ACCEPT CONTROL: an ORDINARY rename is still measured by the name it renames AWAY', async () => {
    // The delta that does NOT put the freed name back keeps the reading this describe does not touch —
    // the guard is scoped to the recycled shape, not a blanket "renames claim nothing".
    const ordinary = mig(
      'ALTER TABLE "parts" RENAME TO "parts_archive";\n--> statement-breakpoint\n' +
        'CREATE TABLE "widgets" ("id" uuid PRIMARY KEY);',
      [
        {
          kind: 'rename-table',
          match: 'ALTER TABLE "parts" RENAME TO "parts_archive"',
          reason: 'reviewed',
        },
      ],
    );
    expect(await routePresentMatchingUpdate(ordinary, live(new Set(['parts', 'widgets'])))).toEqual(
      {
        kind: 'refuse-half-landed',
        landed: ['table "widgets" — a CREATE in the delta names it, and it is THERE'],
        unlanded: [
          'table "parts" — a reviewed RENAME in the delta renames it away, and it is STILL there',
        ],
      },
    );
  });

  it('a reviewed DROP whose target the SAME delta re-creates claims nothing, and the log says so', async () => {
    // The destructive half of the same reading. `DROP TABLE "parts"` + `CREATE TABLE "parts"` leaves the
    // name standing either way, so nothing here can tell an applied delta from an unapplied one — and
    // "still there ⇒ un-landed" was FALSE of the applied one, which re-ran the DROP over the table the
    // same delta had just re-created. Zero evidence is the honest reading; the mount log says exactly
    // that and does NOT call the env stale.
    const rebuild = mig(
      'DROP TABLE "parts";\n--> statement-breakpoint\nCREATE TABLE "parts" ("id" uuid PRIMARY KEY);',
      [{ kind: 'drop-table', match: 'DROP TABLE "parts"', reason: 'reviewed' }],
    );
    expect(await routePresentMatchingUpdate(rebuild, live(new Set(['parts'])))).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
    const logs: string[] = [];
    await planUpdateBoot(
      'present-matching',
      rebuild,
      '/tmp/acme.product.yaml',
      (m) => logs.push(m),
      live(new Set(['parts'])),
    );
    expect(logs[0]).toMatch(/nothing in this boot can tell you/);
    expect(logs[0]).toMatch(/frees and puts BACK/); // and it says WHY nothing could be measured
  });

  it('ACCEPT CONTROL: a DROP whose target the delta does NOT re-create is still un-landed evidence', async () => {
    const plainDrop = mig('DROP TABLE "parts";', [
      { kind: 'drop-table', match: 'DROP TABLE "parts"', reason: 'reviewed' },
    ]);
    expect(await routePresentMatchingUpdate(plainDrop, live(new Set(['parts'])))).toEqual({
      kind: 'apply',
      absent: [],
    });
  });
});

/**
 * ONE statement may alter SEVERAL columns, and the classify has to have inspected every one of them.
 *
 * `ALTER TABLE "t" ALTER COLUMN "a" TYPE text, ALTER COLUMN "b" SET NOT NULL` is one statement and one
 * finding. Reading only its FIRST clause called the whole statement proven applied on the strength of a
 * column `detectDrift` introspects while `"b"` — which the check may never have looked at — carried the
 * claim: the same "proven by a measurement nobody took" this module exists to close (#440).
 */
describe('routePresentMatchingUpdate — a multi-clause ALTER COLUMN is measured on ALL its columns', () => {
  const MULTI_CLAUSE =
    'ALTER TABLE "note_artifacts" ALTER COLUMN "note" TYPE text, ' +
    'ALTER COLUMN "hand_added" SET NOT NULL';
  const multi = (): PlannedMigration[] => [
    {
      name: 'd.sql',
      sql: `${MULTI_CLAUSE};\n`,
      allowlist: [
        { kind: 'type-change-no-using', match: MULTI_CLAUSE, reason: 'reviewed' },
        { kind: 'set-not-null', match: MULTI_CLAUSE, reason: 'reviewed' },
      ],
    },
  ];
  const nothingLive = async () => false;

  it('claims NOTHING when the classify inspects only the FIRST clause’s column', async () => {
    // `"hand_added"` is not one of the spec's declared columns, so no drift query ever compared it: an
    // unapplied SET NOT NULL on it would have classified drift-clean all the same.
    const route = await routePresentMatchingUpdate(
      multi(),
      nothingLive,
      new Set(['note_artifacts.note']),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('…nor when it inspects only the SECOND', async () => {
    const route = await routePresentMatchingUpdate(
      multi(),
      nothingLive,
      new Set(['note_artifacts.hand_added']),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('ACCEPT CONTROL: with EVERY altered column inspected, the classify IS the measurement', async () => {
    // The control that keeps the two arms above from being "the rule was switched off": the statement is
    // still evidence where the premise actually holds for all of it.
    const route = await routePresentMatchingUpdate(
      multi(),
      nothingLive,
      new Set(['note_artifacts.note', 'note_artifacts.hand_added']),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: {
        present: [],
        gone: [],
        renamed: [],
        // …quoted the way the log truncates a long statement (80 chars + an ellipsis).
        proven: [
          `type-change-no-using ('${MULTI_CLAUSE.slice(0, 80)}…')`,
          `set-not-null ('${MULTI_CLAUSE.slice(0, 80)}…')`,
        ],
      },
    });
  });

  it('a further clause this cannot read WHOLE makes the statement evidence for nothing', async () => {
    // The same whole-or-nothing rule the identifier reader has: an unterminated quote in the second
    // clause is not a licence to fall back on the first one's key.
    const unreadable: PlannedMigration[] = [
      {
        name: 'd.sql',
        sql: 'ALTER TABLE "note_artifacts" ALTER COLUMN "note" TYPE text, ALTER COLUMN "hand_added SET NOT NULL;\n',
        allowlist: [],
      },
    ];
    const route = await routePresentMatchingUpdate(
      unreadable,
      nothingLive,
      new Set(['note_artifacts.note']),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: { present: [], gone: [], renamed: [], proven: [] },
    });
  });

  it('ACCEPT CONTROL: a SINGLE-clause statement is unchanged — one column, one key', async () => {
    const single: PlannedMigration[] = [
      {
        name: 'd.sql',
        sql: 'ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL;\n',
        allowlist: [
          {
            kind: 'set-not-null',
            match: 'ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL',
            reason: 'reviewed',
          },
        ],
      },
    ];
    const route = await routePresentMatchingUpdate(
      single,
      nothingLive,
      new Set(['note_artifacts.note']),
    );
    expect(route).toEqual({
      kind: 'mount',
      probed: {
        present: [],
        gone: [],
        renamed: [],
        proven: [`set-not-null ('ALTER TABLE "note_artifacts" ALTER COLUMN "note" SET NOT NULL')`],
      },
    });
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

// ── inline / hash-pinned extraction prompts ────────────────────────────────────────────────────────

describe('resolveExtractorPromptText — exactly one prompt source, fail-closed', () => {
  type Extractor = ProductSpec['extractors'][number];
  const extractor = (fields: Partial<Extractor>): Extractor =>
    ({ id: 'note_extractor', purpose: 'x', ...fields }) as Extractor;
  const cfg = (promptFile?: string): Parameters<typeof resolveExtractorPromptText>[2] =>
    ({
      agent_id: 'note_extractor',
      backend: 'openai',
      model: 'gpt-5',
      schema_file: 's.json',
      output_schema_name: 's',
      ...(promptFile ? { prompt_file: promptFile } : {}),
    }) as never;
  const HEX64 = 'a'.repeat(64);

  it('returns an inline instructions verbatim', () => {
    expect(
      resolveExtractorPromptText(
        '/x/p.yaml',
        '/x/extraction',
        cfg(),
        extractor({ instructions: 'INLINE PROMPT' }),
      ),
    ).toBe('INLINE PROMPT');
  });

  it('reads + returns a hash-pinned file when the sha256 matches', () => {
    const d = mkdtempSync(join(tmpdir(), 'rayspec-ref-'));
    TMP_DIRS.push(d);
    mkdirSync(join(d, 'prompts'), { recursive: true });
    const body = 'PINNED PROMPT BODY\n';
    writeFileSync(join(d, 'prompts/sys.md'), body);
    const sha = createHash('sha256').update(Buffer.from(body)).digest('hex');
    expect(
      resolveExtractorPromptText(
        join(d, 'product.yaml'),
        join(d, 'extraction'),
        cfg(),
        extractor({ instructions_ref: { file: 'prompts/sys.md', sha256: sha } }),
      ),
    ).toBe(body);
  });

  it('FAIL-CLOSED: a tampered pinned file (sha256 mismatch) throws, naming the extractor', () => {
    const d = mkdtempSync(join(tmpdir(), 'rayspec-ref-'));
    TMP_DIRS.push(d);
    mkdirSync(join(d, 'prompts'), { recursive: true });
    writeFileSync(join(d, 'prompts/sys.md'), 'SWAPPED CONTENT');
    // Pin the hash of DIFFERENT content — the file was changed after it was pinned.
    const stalePin = createHash('sha256').update(Buffer.from('ORIGINAL CONTENT')).digest('hex');
    const call = () =>
      resolveExtractorPromptText(
        join(d, 'product.yaml'),
        join(d, 'extraction'),
        cfg(),
        extractor({ instructions_ref: { file: 'prompts/sys.md', sha256: stalePin } }),
      );
    expect(call).toThrow(ProductBootError);
    expect(call).toThrow(/note_extractor.*does not match its sha256 pin/s);
  });

  it('FAIL-CLOSED: a `..`/absolute instructions_ref.file escapes the spec dir (traversal jail)', () => {
    for (const file of ['../../../../../etc/passwd', '/etc/passwd']) {
      expect(() =>
        resolveExtractorPromptText(
          '/x/deploy/p.yaml',
          '/x/deploy/extraction',
          cfg(),
          extractor({ instructions_ref: { file, sha256: HEX64 } }),
        ),
      ).toThrow(/path-traversal guard/);
    }
  });

  it('FAIL-CLOSED: a missing pinned file throws, naming the extractor', () => {
    const d = mkdtempSync(join(tmpdir(), 'rayspec-ref-'));
    TMP_DIRS.push(d);
    expect(() =>
      resolveExtractorPromptText(
        join(d, 'product.yaml'),
        join(d, 'extraction'),
        cfg(),
        extractor({ instructions_ref: { file: 'prompts/missing.md', sha256: HEX64 } }),
      ),
    ).toThrow(/could not read the pinned instructions_ref file/);
  });

  it('FAIL-CLOSED: an inline instructions AND a sidecar prompt_file is ambiguous', () => {
    expect(() =>
      resolveExtractorPromptText(
        '/x/p.yaml',
        '/x/extraction',
        cfg('p.md'),
        extractor({ instructions: 'INLINE' }),
      ),
    ).toThrow(/exactly ONE source/);
  });

  it('FAIL-CLOSED: an instructions_ref AND a sidecar prompt_file is ambiguous', () => {
    expect(() =>
      resolveExtractorPromptText(
        '/x/p.yaml',
        '/x/extraction',
        cfg('p.md'),
        extractor({ instructions_ref: { file: 'prompts/sys.md', sha256: HEX64 } }),
      ),
    ).toThrow(/exactly ONE source/);
  });

  it('FAIL-CLOSED: neither inline/ref NOR a prompt_file → a prompt source is required', () => {
    expect(() =>
      resolveExtractorPromptText('/x/p.yaml', '/x/extraction', cfg(), extractor({})),
    ).toThrow(/no prompt source/);
  });

  it('legacy: reads the sidecar prompt_file when no inline/ref is declared (unchanged path)', () => {
    const d = mkdtempSync(join(tmpdir(), 'rayspec-legacy-'));
    TMP_DIRS.push(d);
    const ext = join(d, 'extraction');
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, 'note.prompt.md'), 'LEGACY PROMPT');
    expect(
      resolveExtractorPromptText(
        join(d, 'product.yaml'),
        ext,
        cfg('note.prompt.md'),
        extractor({}),
      ),
    ).toBe('LEGACY PROMPT');
  });
});

describe('buildLiveAgent — inline + hash-pinned extraction prompts (end-to-end, fail-closed at boot)', () => {
  const withInline = (inline: string): ProductSpec => {
    const base = acmeSpec();
    return { ...base, extractors: base.extractors.map((e) => ({ ...e, instructions: inline })) };
  };
  const withRef = (ref: { file: string; sha256: string }): ProductSpec => {
    const base = acmeSpec();
    return { ...base, extractors: base.extractors.map((e) => ({ ...e, instructions_ref: ref })) };
  };

  it('boots from an inline instructions (no prompt_file) and composes prompt + declared constraints', () => {
    // A real system prompt carries code-like phrasing — it is admitted at the designated leaf.
    const inline =
      'You extract structured notes. Do not import modules or make an llm call yourself.';
    const spec = withInline(inline);
    const specPath = writeExtractionDir([
      { id: 'note_extractor', backend: 'openai', omitPrompt: true },
    ]);
    const live = buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, spec);
    expect(live.agentIds).toEqual(['note_extractor']);
    expect(
      typeof live.buildNodeForAgent('note_extractor', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
    ).toBe('function');
    // The composed AgentSpec.instructions is the SAME slot prompt_file feeds: assembleExtractionInstructions
    // over the resolved (inline) prompt + the declared constraints — exactly what buildLiveAgent builds.
    const configDir = join(dirname(specPath), 'extraction');
    const cfg = JSON.parse(readFileSync(join(configDir, 'note_extractor.extractor.json'), 'utf8'));
    const ex0 = spec.extractors[0];
    if (!ex0) throw new Error('acme-notes must declare an extractor');
    const constraints = ex0.extraction_constraints ?? [];
    expect(constraints.length).toBeGreaterThan(0); // acme-notes declares constraints (a real append)
    const promptText = resolveExtractorPromptText(specPath, configDir, cfg, ex0);
    expect(promptText).toBe(inline);
    const composed = assembleExtractionInstructions(promptText, constraints);
    expect(composed.startsWith(inline)).toBe(true);
    for (const c of constraints) expect(composed).toContain(`- ${c}`);
  });

  it('boots from a hash-pinned instructions_ref whose sha256 matches (no prompt_file)', () => {
    const specPath = writeExtractionDir([
      { id: 'note_extractor', backend: 'openai', omitPrompt: true },
    ]);
    const d = dirname(specPath);
    mkdirSync(join(d, 'prompts'), { recursive: true });
    const body = 'PINNED SYSTEM PROMPT\n';
    writeFileSync(join(d, 'prompts/sys.md'), body);
    const sha = createHash('sha256').update(Buffer.from(body)).digest('hex');
    const live = buildLiveAgent(
      { OPENAI_API_KEY: 'sk-x' },
      specPath,
      withRef({ file: 'prompts/sys.md', sha256: sha }),
    );
    expect(live.agentIds).toEqual(['note_extractor']);
    expect(
      typeof live.buildNodeForAgent('note_extractor', { tdb: FAKE_TDB, tenantId: LIVE_TENANT }),
    ).toBe('function');
  });

  it('FAIL-CLOSED at boot: a tampered instructions_ref file (sha256 mismatch)', () => {
    const specPath = writeExtractionDir([
      { id: 'note_extractor', backend: 'openai', omitPrompt: true },
    ]);
    const d = dirname(specPath);
    mkdirSync(join(d, 'prompts'), { recursive: true });
    writeFileSync(join(d, 'prompts/sys.md'), 'SWAPPED');
    const stalePin = createHash('sha256').update(Buffer.from('ORIGINAL')).digest('hex');
    expect(() =>
      buildLiveAgent(
        { OPENAI_API_KEY: 'sk-x' },
        specPath,
        withRef({ file: 'prompts/sys.md', sha256: stalePin }),
      ),
    ).toThrow(/does not match its sha256 pin/);
  });

  it('FAIL-CLOSED at boot: an inline instructions AND a sidecar prompt_file (ambiguous source)', () => {
    // The config KEEPS its prompt_file (omitPrompt not set) while the doc declares an inline instructions.
    const specPath = writeExtractionDir([{ id: 'note_extractor', backend: 'openai' }]);
    expect(() =>
      buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, withInline('INLINE PROMPT')),
    ).toThrow(/exactly ONE source/);
  });

  it('FAIL-CLOSED at boot: neither inline/ref NOR a prompt_file (a prompt source is required)', () => {
    const specPath = writeExtractionDir([
      { id: 'note_extractor', backend: 'openai', omitPrompt: true },
    ]);
    expect(() => buildLiveAgent({ OPENAI_API_KEY: 'sk-x' }, specPath, acmeSpec())).toThrow(
      /no prompt source/,
    );
  });
});
