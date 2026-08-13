/**
 * The boot's ENVIRONMENT DEMANDS as a single source of truth — the two properties that make the
 * extraction worth having, asserted separately because they fail separately.
 *
 * 1. BEHAVIOUR-NEUTRALITY (the accept control). The refusals that are now COMPOSED from the catalogue
 *    rather than restating it must be byte-identical to the ones they replaced. Each is pinned as a
 *    whole literal string, per refusal, so an edit to a `what` clause ONE OF THEM COMPOSES FROM reds a
 *    suite instead of silently rewording a boot abort — and so the two wordings the CLI matches on to
 *    append its searched-`.env`-paths diagnostic (`required env var(s) missing: …` and `<VAR> is required
 *    (…)`) cannot be normalized away. The rule is per RECORD: a record a boot site consumes composes
 *    that site's refusal, and every such record is pinned as a whole literal string. The ones reachable
 *    WITHOUT a database are pinned here; the two raised only from inside `deployProductYamlSpec` —
 *    `RAYSPEC_PRODUCT_TENANT_ID` and `RAYSPEC_EXTRACTION_MODE` — are pinned in
 *    `product-boot-conditional-env.db.test.ts`, through a real boot, because that is the only place
 *    they can be provoked. Measured by replacing each `what` in turn with a marker: 16 of the 24
 *    records red one of the two files — 14 here, 2 there.
 *
 *    THE REMAINING EIGHT COMPOSE NO REFUSAL, and nothing pins them. `RAYSPEC_BLOB_ROOT`,
 *    `RAYSPEC_MEDIA_SIGNING_KEY`, `RAYSPEC_CRON_TENANT_ID`, `CLAUDE_CODE_OAUTH_TOKEN`,
 *    `ANTHROPIC_API_KEY`, `RAYSPEC_ANTHROPIC_REUSE_LOGIN`, `TTS_PROVIDER` and `RAYSPEC_FS_SOURCE_ROOT`
 *    are imported by no boot site: their guards say more than a `what` clause can — the anthropic
 *    credential's "neither is set" names a CHOICE of two, the deploy guards spend a sentence each on
 *    what a stream route or a cron trigger is — so those refusals keep their own wording. What those
 *    eight records then do SPLITS, and only half of them do anything with `what` at all: measured, the
 *    single reader is `RequirementSet.demand`, so `RAYSPEC_BLOB_ROOT`, `RAYSPEC_MEDIA_SIGNING_KEY`,
 *    `RAYSPEC_CRON_TENANT_ID` and `CLAUDE_CODE_OAUTH_TOKEN` (as the `anyOf` primary) give the report its
 *    `because` clause, and editing one of those four moves that clause. The other four reach the verdict
 *    only as an `optional` row or an `anyOf` sibling, and neither shape reads `what` — theirs is inert
 *    text. Wire any of the eight into a refusal and it needs a pin here too.
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
import {
  buildRecordNormalizer,
  buildSttAdapter,
  buildTurnResponder,
  makeExtractionBackend,
} from './product-boot.js';
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

  it('the product executors keep their "<VAR> is required (…)" wording too', () => {
    // The product profile's three ENV-SELECTED executors. Each demands its variable as the FIRST
    // statement of its builder, so an empty env reaches the refusal without a db, a spec or a blob
    // store — and the `what` clause each names is the catalogue's, pinned whole here so editing it
    // reds this suite rather than rewording a shipped abort.
    expect(() => buildSttAdapter({}, undefined as never, undefined)).toThrow(
      "Boot aborted (Product-YAML) — STT_PROVIDER is required (the STT provider: 'deepgram' | " +
        "'fake'). Fail-closed.",
    );
    expect(() =>
      buildTurnResponder({}, '/s.yaml', undefined as never, undefined as never, {}),
    ).toThrow(
      'Boot aborted (Product-YAML) — RAYSPEC_RESPONDER_MODE is required (the conversation reply ' +
        "executor: 'live' (real runAgent) | 'deterministic' (injected Backend, dev/CI)). Fail-closed.",
    );
    expect(() =>
      buildRecordNormalizer(
        {},
        '/s.yaml',
        undefined as never,
        undefined as never,
        {},
        undefined as never,
      ),
    ).toThrow(
      'Boot aborted (Product-YAML) — RAYSPEC_NORMALIZE_MODE is required (the record input-normalize ' +
        "executor: 'live' (real runAgent) | 'deterministic' (injected Backend, dev/CI)). Fail-closed.",
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
    expect(bad.errors[0]).toContain('RAYSPEC_ANTHROPIC_REUSE_LOGIN is set to an unsupported value');
  });

  it('an unrecognised RAYSPEC_ANTHROPIC_REUSE_LOGIN is NOT a refusal without an anthropic backend', async () => {
    // The boot reads that variable in ONE place: the anthropic backend's construction. A document
    // whose agents select `openai` never reaches it, and a document with NO agents builds no factory
    // at all — so reporting a refusal for either would invent one the boot does not raise, which is
    // the failure direction this whole module exists to close.
    const openaiOnly = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'openai' }), {
      ...OK3,
      OPENAI_API_KEY: 'k',
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe',
    });
    expect(openaiOnly.errors).toEqual([]);
    expect(openaiOnly.ok).toBe(true);
    const noAgents = await checkBootEnv('/s.yaml', backendSpec(), {
      ...OK3,
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe',
    });
    expect(noAgents.errors).toEqual([]);
    expect(noAgents.ok).toBe(true);
    // …and the variable is not reported as optional there either — the verdict says nothing about a
    // variable this document's boot never reads.
    expect(noAgents.optional.map((o) => o.name)).not.toContain('RAYSPEC_ANTHROPIC_REUSE_LOGIN');
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

describe('checkBootEnv — a pack-BEARING document is never a silent green', () => {
  /** The shipped pack example: a THIN deployment doc whose whole route surface arrives from a pack. */
  const STREAM_PACK_EXAMPLE = join(repoRoot, 'examples/stream-backend/rayspec.yaml');

  it('names the packs it declares, and states that their routes ADD demands it cannot see', async () => {
    const report = await checkBootEnv(
      STREAM_PACK_EXAMPLE,
      readFileSync(STREAM_PACK_EXAMPLE, 'utf8'),
      { ...OK3 },
    );
    // The honest answer for THIS document is the three secrets: its own `api` is empty, and the boot
    // guards run on the POST-merge document this check must not produce (loading the pack is exactly
    // the socket/database/credential access the command promises not to perform). A real boot of this
    // file demands RAYSPEC_BLOB_ROOT + RAYSPEC_MEDIA_SIGNING_KEY as well — stream-pack.db.test.ts sets
    // both to boot it — so the verdict has to SAY that rather than read as a clean bill of health.
    expect(report.required.map((r) => r.name)).toEqual([
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
    ]);
    const notChecked = report.notChecked.join(' ');
    expect(notChecked).toContain('declares 1 extension pack(s)');
    expect(notChecked).toContain('stream_pack');
    // BOTH adding directions are named, not just the agent one.
    expect(notChecked).toContain('pack-contributed api route adds the RAYSPEC_BLOB_ROOT demand');
    expect(notChecked).toContain('RAYSPEC_MEDIA_SIGNING_KEY demand');
    expect(notChecked).toContain('REMOVE one');
  });

  it('says nothing about packs for a document that declares none', async () => {
    const report = await checkBootEnv('/s.yaml', backendSpec(), { ...OK3 });
    expect(report.notChecked.join(' ')).not.toContain('extension pack(s)');
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
   * AGREEMENT WITH THE BOOT, on EVERY document whose demanded set a real boot already pins.
   * product-boot-conditional-env.db.test.ts drives all five of these through `deployProductYamlSpec`
   * and asserts what it refuses on; this asserts the report names the same set — without a database,
   * which is the whole point. A predicate that drifted in either direction reds one of the two suites.
   * The fixture list is the DB suite's, complete: dropping one here would let a predicate disagree
   * with the boot on the one document nobody compared.
   */
  it.each([
    // a NON-audio doc that DECLARES an agent demands the extraction mode ALONE (not blob/media/stt)
    ['__fixtures__/non-audio-agent.product.yaml', ['RAYSPEC_EXTRACTION_MODE']],
    // a FILE-only doc demands the blob root, and NOT the media key (no file download in v1)
    ['__fixtures__/file-ingest.product.yaml', ['RAYSPEC_BLOB_ROOT']],
    // a non-audio, zero-agent, no-stt doc demands NONE of the four
    ['__fixtures__/non-audio-intake.product.yaml', []],
    // an stt.* step WITHOUT audio demands NOTHING — the boot refuses it on its SHAPE (below)
    ['__fixtures__/stt-no-audio.product.yaml', []],
  ])('%s demands exactly %j beyond the tenant + the three', async (rel, expected) => {
    const path = join(here, rel);
    const report = await checkBootEnv(path, readFileSync(path, 'utf8'), {
      ...OK3,
      RAYSPEC_PRODUCT_TENANT_ID: '00000000-0000-4000-8000-000000000000',
    });
    expect(missingOf(report)).toEqual(expected);
  });

  it('an stt.* step WITHOUT audio is reported as the SHAPE refusal it is, never as an STT_PROVIDER demand', async () => {
    // The boot's stt guard is `usesStt && withAudio`: the transcription resolver reads the audio
    // capability's blob-backed chunks, so a doc declaring stt without audio is refused on its shape
    // BEFORE STT_PROVIDER is read (product-boot-conditional-env.db.test.ts boots this same fixture and
    // pins that refusal). Demanding the selector here would send an operator to set a variable that
    // changes nothing and be refused anyway — the report and the boot disagreeing, in the one
    // direction that wastes the operator's time.
    const path = join(here, '__fixtures__/stt-no-audio.product.yaml');
    const report = await checkBootEnv(path, readFileSync(path, 'utf8'), {
      ...OK3,
      RAYSPEC_PRODUCT_TENANT_ID: '00000000-0000-4000-8000-000000000000',
    });
    expect(report.required.map((r) => r.name)).not.toContain('STT_PROVIDER');
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain('Declare the audio capability or remove the stt step');
    // …and setting the selector does NOT turn it green: the refusal is not about the environment.
    const selected = await checkBootEnv(path, readFileSync(path, 'utf8'), {
      ...OK3,
      RAYSPEC_PRODUCT_TENANT_ID: '00000000-0000-4000-8000-000000000000',
      STT_PROVIDER: 'fake',
    });
    expect(selected.ok).toBe(false);
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

  it('not even on the one path that REPORTS a value as wrong', async () => {
    // The posture flag is the only variable whose VALUE the report judges, so it is the only place a
    // value could reach the verdict — and an unrecognised one is exactly the case that judges it. The
    // refusal names the variable and states the wired vocabulary; it never quotes what was set. (The
    // BOOT's own refusal for this does quote it — unchanged, byte for byte. This report is the surface
    // that promises not to, so the promise is pinned HERE.)
    const secret = 'S3CR3T-sentinel-value';
    const report = await checkBootEnv('/s.yaml', backendSpec({ agentBackend: 'anthropic' }), {
      ...OK3,
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/roots',
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: secret,
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
