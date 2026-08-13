/**
 * The boot's ENVIRONMENT DEMANDS as a single source of truth — the two properties that make the
 * extraction worth having, asserted separately because they fail separately.
 *
 * 1. BEHAVIOUR-NEUTRALITY (the accept control). The refusals that are now COMPOSED from the catalogue
 *    rather than restating it must be byte-identical to the ones they replaced. Each is pinned here as
 *    a whole literal string, per refusal, so a `what` clause edited in the catalogue REDS this suite
 *    instead of silently rewording a boot abort — and so the two wordings the CLI matches on to append
 *    its searched-`.env`-paths diagnostic (`required env var(s) missing: …` and `<VAR> is required
 *    (…)`) cannot be normalized away.
 *
 * 2. The REPORT agrees with the boot. `checkBootEnv` is not allowed to answer a question the boot would
 *    answer differently, so the cases below drive the distinctions that were easiest to get wrong: the
 *    static profile requires NONE of the three secrets; an unset speech SELECTOR is never a demand
 *    while a selected provider's credential always is; the anthropic credential is a CHOICE of two that
 *    `RAYSPEC_ANTHROPIC_REUSE_LOGIN` removes entirely; and a `<VAR>_FILE` mount satisfies a demand
 *    WITHOUT the file ever being opened.
 *
 * No DB, no network, no credential: every case runs against an explicit env object.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_BACKEND_DEMANDS,
  anthropicReuseLogin,
  type BootEnvReport,
  checkBootEnv,
  declaredAgentBackends,
  declaresPlaybackRoute,
  declaresStreamRoute,
  fireableTriggers,
  isStaticProfile,
  PROVISION_BOOT_SECRETS,
  SERVER_BOOT_SECRETS,
} from './boot-env-demands.js';
import { loadServerConfig, loadTenantProvisionSecrets } from './composition-root.js';
import { makeExtractionBackend } from './product-boot.js';
import { buildSttCapability } from './stt-capability.js';
import { buildTtsCapability } from './tts-capability.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** A three-secret env that satisfies the unconditional set (values are shape-checked, never used). */
const OK3 = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RAYSPEC_JWT_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
  RAYSPEC_API_KEY_PEPPER: 'pepper',
} as const;

/** A backend document with the knobs each conditional demand keys off, switchable per case. */
function backendSpec(
  opts: { stream?: boolean; playback?: boolean; cron?: boolean; agentBackend?: string } = {},
): string {
  const api = [
    "  - { method: GET, path: '/notes', action: { kind: store, store: notes, op: list } }",
    opts.stream && !opts.playback
      ? "  - { method: PUT, path: '/notes/{id}/up', action: { kind: stream, handler: h1, mode: ingest } }"
      : '',
    opts.playback
      ? "  - { method: GET, path: '/notes/{id}/media', action: { kind: stream, handler: h1, mode: playback } }"
      : '',
    opts.agentBackend
      ? "  - { method: POST, path: '/notes/write', action: { kind: agent, agent: a1 } }"
      : '',
  ].filter(Boolean);
  return [
    "version: '1.0'",
    'metadata: { name: t, description: d }',
    'stores:',
    '  - name: notes',
    '    columns: [{ name: title, type: text }]',
    'api:',
    ...api,
    ...(opts.agentBackend
      ? [
          'agents:',
          `  - { id: a1, name: a1, backend: ${opts.agentBackend}, model: m, instructions: hi }`,
        ]
      : []),
    ...(opts.cron
      ? [
          'triggers:',
          '  - name: nightly',
          '    kind: cron',
          "    schedule: '0 2 * * *'",
          '    action: { kind: handler, handler: h2 }',
        ]
      : []),
    'handlers:',
    '  - { id: h1, module: handlers/a.js, export: a, kind: route }',
    ...(opts.cron ? ['  - { id: h2, module: handlers/b.js, export: b, kind: trigger }'] : []),
    ...(opts.cron ? ['deployment:', '  durableWorker: true'] : []),
    '',
  ].join('\n');
}

/** A frontend-only document — the one profile that requires NONE of the three platform secrets. */
const STATIC_SPEC = [
  "version: '1.0'",
  'metadata: { name: t, description: d }',
  'frontend:',
  "  - { route: '/', dir: 'web' }",
  '',
].join('\n');

/** The names of every unmet demand, for a compact assertion. */
const missingOf = (report: BootEnvReport): readonly string[] => report.missing;
/** One requirement row by variable name. */
const req = (report: BootEnvReport, name: string) =>
  report.required.find((entry) => entry.name === name);

describe('the refusals composed from the catalogue are byte-identical', () => {
  it('loadServerConfig names all three, their clauses and their <VAR>_FILE variants', () => {
    expect(() => loadServerConfig({}, () => {})).toThrow(
      'Boot aborted — required env var(s) missing: DATABASE_URL, RAYSPEC_JWT_SIGNING_KEY, ' +
        'RAYSPEC_API_KEY_PEPPER. DATABASE_URL is the Postgres connection string; ' +
        'RAYSPEC_JWT_SIGNING_KEY is the RS256 PKCS#8 PEM; RAYSPEC_API_KEY_PEPPER is the api-key ' +
        'pepper. These live in env / a secret manager only (never DB/git). Each also accepts a ' +
        '<VAR>_FILE variant — DATABASE_URL_FILE, RAYSPEC_JWT_SIGNING_KEY_FILE, ' +
        'RAYSPEC_API_KEY_PEPPER_FILE — naming a file to read the value from, which TAKES PRECEDENCE ' +
        'over the plain variable when set. Refusing to start (fail-closed).',
    );
  });

  it('loadServerConfig lists ONLY the variables that are actually missing, in catalogue order', () => {
    expect(() => loadServerConfig({ RAYSPEC_JWT_SIGNING_KEY: 'k' }, () => {})).toThrow(
      /^Boot aborted — required env var\(s\) missing: DATABASE_URL, RAYSPEC_API_KEY_PEPPER\./,
    );
    expect(() => loadServerConfig({ ...OK3, RAYSPEC_API_KEY_PEPPER: '   ' }, () => {})).toThrow(
      /^Boot aborted — required env var\(s\) missing: RAYSPEC_API_KEY_PEPPER\./,
    );
  });

  it('loadTenantProvisionSecrets keeps its OWN wording and omits the JWT key', () => {
    expect(() => loadTenantProvisionSecrets({}, () => {})).toThrow(
      'Refusing to provision — required env var(s) missing: DATABASE_URL, RAYSPEC_API_KEY_PEPPER. ' +
        'DATABASE_URL is the Postgres connection string of the database to provision; ' +
        'RAYSPEC_API_KEY_PEPPER is the api-key pepper the invite token is hashed with, and it must ' +
        'be the SAME value the target deployment runs with or the invite can never be redeemed. ' +
        'Each also accepts a <VAR>_FILE variant — DATABASE_URL_FILE, RAYSPEC_API_KEY_PEPPER_FILE — ' +
        'naming a file to read the value from, which TAKES PRECEDENCE over the plain variable when ' +
        'set. Fail-closed.',
    );
    // The deliberate omission is a property of the list, not of the call site.
    expect(PROVISION_BOOT_SECRETS.map((s) => s.name)).toEqual([
      'DATABASE_URL',
      'RAYSPEC_API_KEY_PEPPER',
    ]);
    expect(SERVER_BOOT_SECRETS.map((s) => s.name)).toEqual([
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
    ]);
  });

  it('each agent backend keeps its "<VAR> is required (…)" wording — the phrasing the CLI matches on', () => {
    expect(() => makeExtractionBackend({}, 'openai')).toThrow(
      'Boot aborted (Product-YAML) — OPENAI_API_KEY is required (the OpenAI API key (extraction ' +
        "backend 'openai')). Fail-closed.",
    );
    expect(() => makeExtractionBackend({}, 'pi')).toThrow(
      'Boot aborted (Product-YAML) — OPENAI_API_KEY is required (the OpenAI API key — Pi runs on it ' +
        "(extraction backend 'pi')). Fail-closed.",
    );
    expect(() => makeExtractionBackend({}, 'codex')).toThrow(
      'Boot aborted (Product-YAML) — CODEX_HOME is required (the codex home dir holding the ' +
        "ChatGPT-OAuth auth.json (extraction backend 'codex')). Fail-closed.",
    );
    expect(() => makeExtractionBackend({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'anthropic')).toThrow(
      'Boot aborted (Product-YAML) — RAYSPEC_ANTHROPIC_CONFIG_ROOT is required (the per-tenant ' +
        "CLAUDE_CONFIG_DIR root dir (extraction backend 'anthropic')). Fail-closed.",
    );
  });

  it('the two speech credential refusals keep their exact text', () => {
    expect(() => buildSttCapability({ sttProvider: 'deepgram' })).toThrow(
      'Boot aborted — DEEPGRAM_API_KEY is required (the Deepgram API key (STT_PROVIDER=deepgram)). ' +
        'Fail-closed. Set the key, select STT_PROVIDER=fake for an offline dev/CI boot, or unset ' +
        'STT_PROVIDER to boot without the transcription capability.',
    );
    expect(() => buildTtsCapability({ ttsProvider: 'openai' })).toThrow(
      'Boot aborted — OPENAI_API_KEY is required (the OpenAI API key for TTS_PROVIDER=openai). ' +
        'Fail-closed. Set the key, select TTS_PROVIDER=fake for an offline dev/CI boot, or unset ' +
        'TTS_PROVIDER to boot without the speech-synthesis capability.',
    );
  });

  it('anthropicReuseLogin ANSWERS; the fail-closed disposition stays at the boot site', () => {
    expect(anthropicReuseLogin({})).toBe(false);
    expect(anthropicReuseLogin({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'on' })).toBe(true);
    expect(anthropicReuseLogin({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: '0' })).toBe(false);
    expect(anthropicReuseLogin({ RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe' })).toBe('unsupported');
  });
});

describe('the shared predicates are the questions the boot gates ask', () => {
  it('classifies stream / playback routes', () => {
    expect(declaresStreamRoute([{ action: { kind: 'store' } }])).toBe(false);
    expect(declaresStreamRoute([{ action: { kind: 'stream' } }])).toBe(true);
    expect(declaresPlaybackRoute([{ action: { kind: 'stream', mode: 'ingest' } }])).toBe(false);
    expect(declaresPlaybackRoute([{ action: { kind: 'stream', mode: 'playback' } }])).toBe(true);
  });

  it('FIREABLE is cron + manual; webhook/event demand nothing', () => {
    const triggers = [{ kind: 'cron' }, { kind: 'manual' }, { kind: 'webhook' }, { kind: 'event' }];
    expect(fireableTriggers(triggers).map((t) => t.kind)).toEqual(['cron', 'manual']);
  });

  it('groups agents by the backend they select', () => {
    const grouped = declaredAgentBackends([
      { id: 'a', backend: 'openai' },
      { id: 'b', backend: 'anthropic' },
      { id: 'c', backend: 'openai' },
    ]);
    expect([...grouped]).toEqual([
      ['openai', ['a', 'c']],
      ['anthropic', ['b']],
    ]);
  });

  it('every wired extraction backend has a catalogue entry', () => {
    expect(Object.keys(AGENT_BACKEND_DEMANDS).sort()).toEqual([
      'anthropic',
      'codex',
      'openai',
      'pi',
    ]);
  });
});

describe('checkBootEnv — the backend profile', () => {
  it('demands the three unconditionally and nothing else for a plain document', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), {});
    expect(report.profile).toBe('rayspec');
    expect(report.required.map((r) => r.name)).toEqual([
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
    ]);
    expect(report.ok).toBe(false);
    expect(missingOf(report)).toHaveLength(3);
  });

  it('is ok when the environment meets every demand', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), { ...OK3 });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('adds the blob root for a stream route and the media key only for a PLAYBACK one', async () => {
    const ingest = await checkBootEnv('/s.yaml', backendSpec({ stream: true }), { ...OK3 });
    expect(missingOf(ingest)).toEqual(['RAYSPEC_BLOB_ROOT']);
    const playback = await checkBootEnv('/s.yaml', backendSpec({ playback: true }), { ...OK3 });
    expect(missingOf(playback)).toEqual(['RAYSPEC_BLOB_ROOT', 'RAYSPEC_MEDIA_SIGNING_KEY']);
  });

  it('adds the cron tenant for a declared cron trigger, and says how many raised it', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec({ cron: true }), { ...OK3 });
    expect(missingOf(report)).toEqual(['RAYSPEC_CRON_TENANT_ID']);
    expect(req(report, 'RAYSPEC_CRON_TENANT_ID')?.because[0]).toContain(
      'the document declares 1 cron/manual trigger(s)',
    );
  });

  it("names the agent(s) that selected a backend, in the boot's own vocabulary", async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'openai' }), {
      ...OK3,
    });
    expect(missingOf(report)).toEqual(['OPENAI_API_KEY']);
    expect(req(report, 'OPENAI_API_KEY')?.because[0]).toBe(
      "declared agent(s) [a1] select backend 'openai' — the OpenAI API key (extraction backend " +
        "'openai')",
    );
  });

  it('reports the anthropic credential as ONE demand satisfied by EITHER token', async () => {
    const spec = backendSpec({ agentBackend: 'anthropic' });
    const neither = await checkBootEnv('/s.yaml', spec, { ...OK3 });
    expect(missingOf(neither)).toEqual([
      'RAYSPEC_ANTHROPIC_CONFIG_ROOT',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(req(neither, 'CLAUDE_CODE_OAUTH_TOKEN')?.orAnyOf).toEqual([
      { name: 'ANTHROPIC_API_KEY', set: false },
    ]);
    // The API key alone closes it — the boot demands one OR the other, never both.
    const withApiKey = await checkBootEnv('/s.yaml', spec, {
      ...OK3,
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/roots',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(withApiKey.ok).toBe(true);
  });

  it('RAYSPEC_ANTHROPIC_REUSE_LOGIN removes the token demand, exactly as it does at boot', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'anthropic' }), {
      ...OK3,
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/roots',
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true',
    });
    expect(report.ok).toBe(true);
    expect(report.required.map((r) => r.name)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // …and an unrecognised value is reported as the refusal it will be, not silently treated as off.
    const bad = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'anthropic' }), {
      ...OK3,
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/roots',
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe',
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain("RAYSPEC_ANTHROPIC_REUSE_LOGIN 'maybe' is not supported");
  });
});

describe('checkBootEnv — the ENV-ONLY demands no document could predict', () => {
  it('an UNSET speech selector is never a demand — it is reported as optional', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), { ...OK3 });
    expect(report.ok).toBe(true);
    expect(report.required.map((r) => r.name)).not.toContain('DEEPGRAM_API_KEY');
    expect(report.required.map((r) => r.name)).not.toContain('STT_PROVIDER');
    expect(report.required.map((r) => r.name)).not.toContain('TTS_PROVIDER');
    const selectors = report.optional.filter((o) => o.name.endsWith('_PROVIDER'));
    expect(selectors.map((o) => o.name)).toEqual(['STT_PROVIDER', 'TTS_PROVIDER']);
    for (const selector of selectors) expect(selector.note).toContain('NOT a boot demand');
  });

  it('a SELECTED provider makes its credential a demand, with the selection as the reason', async () => {
    const stt = await checkBootEnv('/s.yaml', backendSpec(), {
      ...OK3,
      STT_PROVIDER: 'deepgram',
    });
    expect(missingOf(stt)).toEqual(['DEEPGRAM_API_KEY']);
    expect(req(stt, 'DEEPGRAM_API_KEY')?.because[0]).toBe(
      "STT_PROVIDER='deepgram' is selected in the environment — the Deepgram API key " +
        '(STT_PROVIDER=deepgram)',
    );
    const tts = await checkBootEnv('/s.yaml', backendSpec(), { ...OK3, TTS_PROVIDER: 'openai' });
    expect(missingOf(tts)).toEqual(['OPENAI_API_KEY']);
  });

  it('`fake` selects an offline provider and demands nothing', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), {
      ...OK3,
      STT_PROVIDER: 'fake',
      TTS_PROVIDER: 'fake',
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('one variable two things need is reported ONCE, carrying both reasons', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'openai' }), {
      ...OK3,
      TTS_PROVIDER: 'openai',
    });
    const openai = report.required.filter((r) => r.name === 'OPENAI_API_KEY');
    expect(openai).toHaveLength(1);
    expect(openai[0]?.because).toHaveLength(2);
  });
});

describe('checkBootEnv — the static profile is exempt from the three', () => {
  it('requires nothing and says why', async () => {
    expect(isStaticProfile(STATIC_SPEC)).toBe(true);
    const report = await checkBootEnv('/s.yaml', STATIC_SPEC, {});
    expect(report.profile).toBe('static');
    expect(report.required).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.notChecked.join(' ')).toContain('reads NONE of the three platform secrets');
  });
});

describe('checkBootEnv — the <VAR>_FILE mount is honoured without opening the file', () => {
  it('a set mount satisfies the demand; the path is never read', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), {
      DATABASE_URL_FILE: '/definitely/not/a/real/path/db.txt',
      RAYSPEC_JWT_SIGNING_KEY_FILE: '/definitely/not/a/real/path/jwt.pem',
      RAYSPEC_API_KEY_PEPPER_FILE: '/definitely/not/a/real/path/pepper.txt',
    });
    // Nothing threw, and nothing was opened — a boot would ABORT on these paths, which is exactly the
    // boundary the verdict states rather than pretending to have checked.
    expect(report.ok).toBe(true);
    expect(req(report, 'DATABASE_URL')?.fileVariant).toBe('DATABASE_URL_FILE');
    expect(report.notChecked.join(' ')).toContain('the file is never opened');
  });
});

describe('checkBootEnv — the product profile has its OWN demand set', () => {
  /** The shipped audio+stt+agents acceptance product — the doc that demands all four conditionals. */
  const ACME = join(repoRoot, 'examples/acme-notes/acme-notes.product.yaml');
  /** The shipped conversation product — the one that adds the responder mode. */
  const CHAT = join(repoRoot, 'examples/support-intake-chat/support-intake-chat.product.yaml');

  it('adds the product tenant plus the capability-conditional demands acme-notes declares', async () => {
    const report = await checkBootEnv(ACME, readFileSync(ACME, 'utf8'), { ...OK3 });
    expect(report.profile).toBe('product');
    expect(missingOf(report)).toEqual([
      'RAYSPEC_PRODUCT_TENANT_ID',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
      'RAYSPEC_EXTRACTION_MODE',
      'STT_PROVIDER',
    ]);
    // The one place a provider SELECTOR is itself a demand — and it is still DOCUMENT-conditional.
    expect(req(report, 'STT_PROVIDER')?.because[0]).toContain(
      'the document declares an stt.* workflow step',
    );
    // …and selecting it then makes the credential a demand too, exactly as the product boot does.
    const selected = await checkBootEnv(ACME, readFileSync(ACME, 'utf8'), {
      ...OK3,
      STT_PROVIDER: 'deepgram',
    });
    expect(missingOf(selected)).toContain('DEEPGRAM_API_KEY');
  });

  it('adds the responder mode for a conversation document', async () => {
    const report = await checkBootEnv(CHAT, readFileSync(CHAT, 'utf8'), { ...OK3 });
    expect(missingOf(report)).toContain('RAYSPEC_RESPONDER_MODE');
  });

  it('states that the extraction sidecars — where a product names its backends — were not opened', async () => {
    const report = await checkBootEnv(ACME, readFileSync(ACME, 'utf8'), { ...OK3 });
    expect(report.notChecked.join(' ')).toContain('extraction sidecar files beside it');
  });

  /**
   * AGREEMENT WITH THE BOOT, on the documents whose demanded set a real boot already pins.
   * product-boot-conditional-env.db.test.ts drives each of these through `deployProductYamlSpec` and
   * asserts which variable it refuses on; this asserts the report names the same set — without a
   * database, which is the whole point. A predicate that drifted in either direction reds one of the
   * two suites.
   */
  it.each([
    // a NON-audio doc that DECLARES an agent demands the extraction mode ALONE (not blob/media/stt)
    ['__fixtures__/non-audio-agent.product.yaml', ['RAYSPEC_EXTRACTION_MODE']],
    // a FILE-only doc demands the blob root, and NOT the media key (no file download in v1)
    ['__fixtures__/file-ingest.product.yaml', ['RAYSPEC_BLOB_ROOT']],
    // a non-audio, zero-agent, no-stt doc demands NONE of the four
    ['__fixtures__/non-audio-intake.product.yaml', []],
  ])('%s demands exactly %j beyond the tenant + the three', async (rel, expected) => {
    const path = join(here, rel);
    const report = await checkBootEnv(path, readFileSync(path, 'utf8'), {
      ...OK3,
      RAYSPEC_PRODUCT_TENANT_ID: '00000000-0000-4000-8000-000000000000',
    });
    expect(missingOf(report)).toEqual(expected);
  });

  it('names file_input — not audio — as what made a file-only doc demand the blob root', async () => {
    const path = join(here, '__fixtures__/file-ingest.product.yaml');
    const report = await checkBootEnv(path, readFileSync(path, 'utf8'), { ...OK3 });
    expect(req(report, 'RAYSPEC_BLOB_ROOT')?.because[0]).toContain(
      'the document declares the file_input capability',
    );
  });
});

describe('checkBootEnv — an unparseable document produces errors, never a green verdict', () => {
  it('reports the parse errors and stays not-ok', async () => {
    const report = await checkBootEnv('/s.yaml', 'version: nope\n', { ...OK3 });
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.required).toEqual([]);
  });
});

describe('checkBootEnv reads no value out of the environment', () => {
  it('reports set/unset only — no secret reaches the verdict', async () => {
    const secret = 'S3CR3T-sentinel-value';
    const report = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'openai' }), {
      DATABASE_URL: `postgresql://u:${secret}@localhost:5432/db`,
      RAYSPEC_JWT_SIGNING_KEY: secret,
      RAYSPEC_API_KEY_PEPPER: secret,
      OPENAI_API_KEY: secret,
    });
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
