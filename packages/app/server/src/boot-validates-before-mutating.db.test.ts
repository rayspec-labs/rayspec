/**
 * A boot that is going to refuse leaves the database exactly as it found it.
 *
 * WHAT THESE ARMS PROVE. The boot used to apply the platform migration chain first and only then
 * parse the injected spec and the signing key, so pointing a broken deploy at an EMPTY database
 * still created every platform table before the refusal. Each arm here points one kind of invalid
 * input — a backend spec that does not lint, a Product-YAML document that does not parse, one that
 * parses but fails the boot-scope gate, a malformed signing key — at an empty database, checks the
 * refusal is the one the deploy path always gave, and then checks the database still holds no
 * relation and no `drizzle` schema. The same holds for a backend document whose CONFIGURATION the
 * environment does not satisfy — a stream route without a blob root, a playback route without a
 * media signing key, an unsupported speech provider, a frontend mount with nothing to serve — and for
 * a Product-YAML document whose deployment tenant is unset, malformed or names no org, or whose
 * document needs a blob root, an audio capability, a responder or a normalizer the deployment lacks.
 * And it holds for every refusal the deploy itself makes from the configuration and the document —
 * a cron trigger no durable worker would fire or whose schedule does not parse, an agent on a backend
 * the deployment does not supply, a handler module that is not there, a route under a reserved
 * prefix, a store no registrar admitted — which the preflight now makes by rehearsing the deploy.
 * The valid-spec arm boots a valid spec on the same database, so the reordering changes nothing for
 * a deployment that validates.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AssembleServerOptions,
  assembleServer,
  BootConfigError,
  loadServerConfig,
} from './composition-root.js';
import { ProductBootError } from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_boot_validates_${process.pid}`;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const VALID_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: a valid backend spec with one store
stores:
  - name: first_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/first-notes', action: { kind: store, store: first_notes, op: create } }
`;

// Lints red: the route names a store the document does not declare.
const INVALID_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: a route over an undeclared store
stores:
  - name: first_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/elsewhere', action: { kind: store, store: missing_store, op: create } }
`;

// A Product-YAML document (it has a product section) that does not parse: no contracts, no id.
const INVALID_PRODUCT_SPEC = `
version: "1.0"
product: { name: Broken }
`;

// A cron trigger on a handler, fired by the durable worker the document declares.
const CRON_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: a cron trigger fired by the durable worker
deployment:
  durableWorker: true
handlers:
  - { id: tick_handler, module: handlers/tick.mjs, export: tick, kind: trigger }
triggers:
  - name: every-minute
    kind: cron
    schedule: '* * * * *'
    action: { kind: handler, handler: tick_handler }
`;

// An agent on a backend the deployment's factory does not build.
const OTHER_BACKEND_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: an agent on a backend the deployment does not supply
agents:
  - id: helper
    name: helper-agent
    backend: anthropic
    model: claude-sonnet-4-5
    instructions: Help.
    maxTurns: 2
`;

/** A network-free backend, the only one the deployment supplies. */
class OpenAiOnly implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: '',
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    };
  }
}

const withOpenAi: AssembleServerOptions = {
  registerProductTables: (tables) => registerScopedTables([...tables.values()]),
  agentBackendsFactory: () => new Map<BackendId, Backend>([['openai', new OpenAiOnly()]]),
};

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('the boot validates before it mutates', () => {
  let dbUrl = '';
  let dir = '';
  let validKey = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
    'STT_PROVIDER',
    'RAYSPEC_PRODUCT_TENANT_ID',
    'RAYSPEC_CRON_TENANT_ID',
    'RAYSPEC_RESPONDER_MODE',
    'RAYSPEC_NORMALIZE_MODE',
    'RAYSPEC_HOSTING_POSTURE',
    'RAYSPEC_AGENT_QUEUE_MAX',
  ] as const;

  /** Every relation outside the system schemas, plus whether a `drizzle` schema exists. */
  async function footprint(): Promise<{ relations: number; drizzle: boolean }> {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const [row] = (await sql.unsafe(`
        SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) AS relations,
               EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') AS drizzle`)) as unknown as {
        relations: number;
        drizzle: boolean;
      }[];
      return row as { relations: number; drizzle: boolean };
    } finally {
      await sql.end();
    }
  }

  function specFile(name: string, text: string): string {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    return path;
  }

  const registrar: AssembleServerOptions = {
    registerProductTables: (tables) => registerScopedTables([...tables.values()]),
  };

  async function bootWith(
    specPath: string | undefined,
    jwtKey = validKey,
    opts: AssembleServerOptions = registrar,
  ) {
    process.env.RAYSPEC_JWT_SIGNING_KEY = jwtKey;
    if (specPath === undefined) delete process.env.RAYSPEC_SPEC_PATH;
    else process.env.RAYSPEC_SPEC_PATH = specPath;
    return assembleServer(loadServerConfig(), opts);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    dir = mkdtempSync(join(tmpdir(), 'rayspec-validates-first-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    validKey = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'validates-first-pepper';
    process.env.DATABASE_URL = dbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8814';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_PRODUCT_TENANT_ID;
    delete process.env.RAYSPEC_CRON_TENANT_ID;
    delete process.env.RAYSPEC_RESPONDER_MODE;
    delete process.env.RAYSPEC_NORMALIZE_MODE;
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
  }, 60_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('an invalid backend spec is refused as before and the empty database stays empty', async () => {
    const path = specFile('invalid.yaml', INVALID_SPEC);
    const refused = await bootWith(path).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BootConfigError);
    expect((refused as Error).message).toContain(`injected spec at ${path} is invalid`);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a Product-YAML document that does not parse is refused and the database stays empty', async () => {
    const path = specFile('broken.product.yaml', INVALID_PRODUCT_SPEC);
    const refused = await bootWith(path).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProductBootError);
    expect((refused as Error).message).toContain(`the Product-YAML spec at ${path} is invalid`);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a Product-YAML document outside the boot scope is refused and the database stays empty', async () => {
    const refused = await bootWith(join(FIXTURES, 'out-of-scope-multiscope.product.yaml')).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ProductBootError);
    expect((refused as Error).message).toMatch(/multi-scope/);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a malformed signing key is refused and the database stays empty', async () => {
    const refused = await bootWith(undefined, 'not-a-pem').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BootConfigError);
    expect((refused as Error).message).toContain('RAYSPEC_JWT_SIGNING_KEY is not a PKCS#8 PEM');
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a Product-YAML document whose deployment tenant is unset, malformed or absent is refused, database untouched', async () => {
    const path = join(FIXTURES, 'non-audio-intake.product.yaml');
    const cases: { tenant?: string; message: RegExp }[] = [
      { message: /RAYSPEC_PRODUCT_TENANT_ID is required/ },
      {
        tenant: 'not-an-org',
        message: /RAYSPEC_PRODUCT_TENANT_ID='not-an-org' is not a valid org UUID/,
      },
      {
        tenant: '5b0c43de-2f55-4f4e-9d0a-0c4f3f1b8a11',
        message: /RAYSPEC_PRODUCT_TENANT_ID='5b0c43de-[0-9a-f-]+' does not name a live org/,
      },
    ];
    for (const c of cases) {
      if (c.tenant === undefined) delete process.env.RAYSPEC_PRODUCT_TENANT_ID;
      else process.env.RAYSPEC_PRODUCT_TENANT_ID = c.tenant;
      try {
        const refused = await bootWith(path).catch((e: unknown) => e);
        expect(refused, c.tenant).toBeInstanceOf(ProductBootError);
        expect((refused as Error).message, c.tenant).toMatch(c.message);
        expect(await footprint(), c.tenant).toEqual({ relations: 0, drizzle: false });
      } finally {
        delete process.env.RAYSPEC_PRODUCT_TENANT_ID;
      }
    }
    armsRan += 1;
  }, 90_000);

  it('a Product-YAML document whose other environment demands are unmet is refused before the platform chain', async () => {
    // A live org, and nothing else: the tenant check passes, so what refuses is the document's own
    // demand, and the platform chain has not run when it does.
    const orgId = '0d7e9a52-6c1b-4f0e-a7f3-2b9d8c4e5f60';
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await sql.unsafe('CREATE TABLE orgs (id uuid PRIMARY KEY, deleted_at timestamptz)');
      await sql.unsafe('INSERT INTO orgs (id) VALUES ($1)', [orgId]);
      const before = await footprint();
      process.env.RAYSPEC_PRODUCT_TENANT_ID = orgId;
      const cases: { fixture: string; env?: Record<string, string>; message: RegExp }[] = [
        {
          fixture: 'file-ingest.product.yaml',
          message: /the file_input capability moves binary bytes .* RAYSPEC_BLOB_ROOT is unset/,
        },
        {
          fixture: 'stt-no-audio.product.yaml',
          message: /declares an 'stt\.\*' workflow step.* but no audio capability/,
        },
        // The responder and the normalizer are built from the environment and their sidecar
        // configurations; both used to be built after the platform chain.
        {
          fixture: 'conversation-intake.product.yaml',
          message: /RAYSPEC_RESPONDER_MODE is required/,
        },
        {
          fixture: 'conversation-intake.product.yaml',
          env: { RAYSPEC_RESPONDER_MODE: 'deterministic' },
          message:
            /RAYSPEC_RESPONDER_MODE=deterministic requires an injected deterministic reply Backend/,
        },
        {
          fixture: join('record-normalize', 'record-normalize.product.yaml'),
          message: /RAYSPEC_NORMALIZE_MODE is required/,
        },
      ];
      for (const c of cases) {
        for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
        try {
          const refused = await bootWith(join(FIXTURES, c.fixture)).catch((e: unknown) => e);
          expect(refused, c.fixture).toBeInstanceOf(ProductBootError);
          expect((refused as Error).message, c.fixture).toMatch(c.message);
          expect(await footprint(), c.fixture).toEqual(before);
        } finally {
          for (const k of Object.keys(c.env ?? {})) delete process.env[k];
        }
      }
      expect(before.drizzle).toBe(false);
    } finally {
      delete process.env.RAYSPEC_PRODUCT_TENANT_ID;
      await sql.unsafe('DROP TABLE IF EXISTS orgs');
      await sql.end();
    }
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 90_000);

  it('a backend document whose configuration the environment does not satisfy is refused, database untouched', async () => {
    const handler = `
handlers:
  - { id: bytes_handler, module: handlers/bytes.mjs, export: bytes, kind: route }
`;
    const cases: { name: string; spec: string; env?: Record<string, string>; message: RegExp }[] = [
      {
        name: 'stream.yaml',
        spec: `${VALID_SPEC}  - method: POST
    path: /uploads/{id}
    action: { kind: stream, handler: bytes_handler, mode: ingest }
${handler}`,
        message: /declares a 'stream' route but no blob backend is configured/,
      },
      {
        name: 'playback.yaml',
        spec: `${VALID_SPEC}  - method: GET
    path: /media/{id}
    action: { kind: stream, handler: bytes_handler, mode: playback }
${handler}`,
        env: { RAYSPEC_BLOB_ROOT: dir },
        message: /stream PLAYBACK route but no media signing key is configured/,
      },
      {
        name: 'stt.yaml',
        spec: VALID_SPEC,
        env: { STT_PROVIDER: 'no-such-provider' },
        message: /STT_PROVIDER 'no-such-provider' is not supported/,
      },
      {
        name: 'frontend.yaml',
        spec: `${VALID_SPEC}frontend:
  - { route: /, dir: ./no-such-build, spa: true }
`,
        message: /static directory '\.\/no-such-build' .* is missing or unreadable/,
      },
    ];
    for (const c of cases) {
      for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
      try {
        const refused = await bootWith(specFile(c.name, c.spec)).catch((e: unknown) => e);
        expect(refused, c.name).toBeInstanceOf(BootConfigError);
        expect((refused as Error).message, c.name).toMatch(c.message);
        expect(await footprint(), c.name).toEqual({ relations: 0, drizzle: false });
      } finally {
        for (const k of Object.keys(c.env ?? {})) delete process.env[k];
      }
    }
    armsRan += 1;
  }, 90_000);

  it('a backend document the deploy itself would refuse from its configuration is refused before anything is written', async () => {
    // Each of these used to be raised by the deploy after the platform chain (and, for a document
    // with stores, after its product DDL): the preflight now makes it, or rehearses the deploy that
    // makes it, with nothing written.
    mkdirSync(join(dir, 'handlers'), { recursive: true });
    writeFileSync(join(dir, 'handlers', 'tick.mjs'), 'export async function tick() {}\n', 'utf8');
    const cases: {
      name: string;
      spec: string;
      opts?: AssembleServerOptions;
      env?: Record<string, string>;
      message: RegExp;
    }[] = [
      {
        // No agent backends, so no durable worker to fire the cron trigger.
        name: 'no-worker.yaml',
        spec: CRON_SPEC,
        env: { RAYSPEC_CRON_TENANT_ID: '0d7e9a52-6c1b-4f0e-a7f3-2b9d8c4e5f60' },
        message: /declares 1 cron\/manual trigger\(s\) but no durable worker is wired/,
      },
      {
        name: 'bad-schedule.yaml',
        spec: CRON_SPEC.replace("schedule: '* * * * *'", "schedule: 'every day'"),
        opts: withOpenAi,
        env: { RAYSPEC_CRON_TENANT_ID: '0d7e9a52-6c1b-4f0e-a7f3-2b9d8c4e5f60' },
        message:
          /cron trigger 'every-minute' has the schedule 'every day', which the scheduler does not accept: it has 2 fields;/,
      },
      {
        name: 'bad-schedule-field.yaml',
        spec: CRON_SPEC.replace("schedule: '* * * * *'", "schedule: '0 25 * * *'"),
        opts: withOpenAi,
        env: { RAYSPEC_CRON_TENANT_ID: '0d7e9a52-6c1b-4f0e-a7f3-2b9d8c4e5f60' },
        message:
          /cron trigger 'every-minute' has the schedule '0 25 \* \* \*', which the scheduler does not accept: its hour field '25' is not a value the scheduler accepts\./,
      },
      {
        name: 'other-backend.yaml',
        spec: OTHER_BACKEND_SPEC,
        opts: withOpenAi,
        message:
          /agent 'helper' selects backend 'anthropic' which is not in the injected agentBackends map/,
      },
      {
        // The managed posture runs only the backends of its supported-backend matrix.
        name: 'managed-other-backend.yaml',
        spec: OTHER_BACKEND_SPEC,
        opts: withOpenAi,
        env: { RAYSPEC_HOSTING_POSTURE: 'managed' },
        message:
          /RAYSPEC_HOSTING_POSTURE=managed does not support the agent backend 'anthropic' \(declared by agent 'helper'\): its capability 'agent-backend-anthropic' is self-host-only.*Supported under the managed posture: openai/,
      },
      {
        name: 'managed-fake-stt.yaml',
        spec: VALID_SPEC,
        env: { RAYSPEC_HOSTING_POSTURE: 'managed', STT_PROVIDER: 'fake' },
        message:
          /does not support the speech-to-text provider \(STT_PROVIDER\) 'fake' \(STT_PROVIDER\): its capability 'stt-fake' is test-only/,
      },
      {
        // A bound the execution policy cannot use refuses the boot (a variable the policy adds is
        // refused in either posture).
        name: 'bad-policy.yaml',
        spec: VALID_SPEC,
        env: { RAYSPEC_AGENT_QUEUE_MAX: 'lots' },
        message: /RAYSPEC_AGENT_QUEUE_MAX='lots' must be a whole number from 1 to 2147483647/,
      },
      {
        name: 'missing-handler.yaml',
        spec: `${VALID_SPEC}  - method: GET
    path: /absent
    action: { kind: handler, handler: absent_handler }
handlers:
  - { id: absent_handler, module: handlers/absent.mjs, export: absent, kind: route }
`,
        message: /deploy aborted at \[roll out\]: handler load failed/,
      },
      {
        name: 'reserved-route.yaml',
        spec: VALID_SPEC.replace("path: '/first-notes'", "path: '/v1/first-notes'"),
        message: /route POST \/v1\/first-notes is under a RESERVED platform prefix/,
      },
      {
        // A handler asking for a right this deployment does not grant: no STT_PROVIDER.
        name: 'right-not-granted.yaml',
        spec: `${VALID_SPEC}  - method: GET
    path: /transcribe
    action: { kind: handler, handler: speech_handler }
handlers:
  - { id: speech_handler, module: handlers/tick.mjs, export: tick, kind: route, uses: [stt, emit] }
`,
        message:
          /handler 'speech_handler' asks for the right 'stt', which this deployment does not grant: STT_PROVIDER is not set; handler 'speech_handler' asks for the right 'emit', which this deployment does not grant: the spec does not enable deployment\.eventBus/,
      },
      {
        // Under the managed posture every handler states its rights.
        name: 'managed-undeclared-rights.yaml',
        spec: `${VALID_SPEC}  - method: GET
    path: /tick
    action: { kind: handler, handler: tick_handler }
handlers:
  - { id: tick_handler, module: handlers/tick.mjs, export: tick, kind: route }
`,
        env: { RAYSPEC_HOSTING_POSTURE: 'managed' },
        message:
          /handler 'tick_handler' declares no rights; under RAYSPEC_HOSTING_POSTURE=managed every handler lists the capabilities it uses/,
      },
      {
        // No registrar: the product table never reaches the chokepoint.
        name: 'no-registrar.yaml',
        spec: VALID_SPEC,
        opts: {},
        message: /store 'first_notes' is declared in the spec but its table is NOT registered/,
      },
    ];
    for (const c of cases) {
      for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
      try {
        const refused = await bootWith(
          specFile(c.name, c.spec),
          validKey,
          c.opts ?? registrar,
        ).catch((e: unknown) => e);
        expect(refused, c.name).toBeInstanceOf(Error);
        expect((refused as Error).message, c.name).toMatch(c.message);
        expect((refused as Error).message, c.name).not.toContain('ALREADY COMMITTED');
        expect(await footprint(), c.name).toEqual({ relations: 0, drizzle: false });
      } finally {
        for (const k of Object.keys(c.env ?? {})) delete process.env[k];
      }
    }
    armsRan += 1;
  }, 120_000);

  it('a valid spec on the same empty database boots exactly as before', async () => {
    const server = await bootWith(specFile('valid.yaml', VALID_SPEC));
    try {
      expect(server.deployMode).toBe('materialized');
      const after = await footprint();
      expect(after.drizzle).toBe(true);
      expect(after.relations).toBeGreaterThan(0);
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);
    } finally {
      await server.close();
    }
    armsRan += 1;
  }, 90_000);

  it('a boot refused after it read the source fence leaves no heartbeat behind', async () => {
    // The previous arm materialized the store; take a column away so the next boot refuses on drift,
    // after the platform chain and after it announced itself to the fence.
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await sql.unsafe('ALTER TABLE first_notes DROP COLUMN body');
      const refused = await bootWith(specFile('valid.yaml', VALID_SPEC)).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BootConfigError);
      expect((refused as Error).message).toMatch(/DRIFTED/);
      // Not a live, undrained process to the next quiesce.
      const [row] = await sql.unsafe('SELECT count(*)::int AS n FROM runtime_control_processes');
      expect(row).toEqual({ n: 0 });
    } finally {
      await sql.end();
    }
    armsRan += 1;
  }, 90_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(10);
  else expect(true).toBe(true);
});
