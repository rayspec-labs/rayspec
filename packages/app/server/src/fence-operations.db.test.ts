/**
 * `quiesce`, `resume` and `health` of the runtime-control adapter, on GROUND TRUTH against a
 * throwaway database (the booted-server half is `runtime-fence-boot.db.test.ts`).
 *
 * WHAT THESE ARMS PROVE.
 *  - quiesce takes the fence in one transaction (epoch and environment revision up by one), writes
 *    its receipts, and a second quiesce keeps the epoch; resume releases only the matching epoch,
 *    refuses a stale or foreign one, and says so when there is nothing to release.
 *  - quiesce reports `fenced` only when every LIVE process heartbeat has drained at the new epoch;
 *    otherwise it waits until the deadline and returns `timed-out` with `ok: false` and
 *    RAY_SOURCE_NOT_QUIESCENT, the fence still held. A stale heartbeat is not a live process.
 *  - the database barrier is never assumed: with role separation the runtime role's write privileges
 *    are revoked (the snapshot reader keeps its access) and resume grants back exactly what was held,
 *    in both databases; a role that could grant itself back is refused; without role separation the
 *    stopped-source barrier holds only when no other session is connected to either database.
 *  - a quiesce in progress holds the operation lease, so a concurrent one is refused, retryable.
 *  - health reports liveness and readiness, with a failing dependency's cause and no topology.
 * Every envelope validates against the contract's envelope schema.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  formatTimestamp,
  type QuiesceRequest,
  type ResultEnvelope,
  schemaValidator,
} from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';
import { readOperationReceipts } from './operation-lease.js';
import { createRuntimeControl, type RuntimeControlOptions } from './runtime-control.js';
import { RuntimeFence } from './runtime-fence.js';
import { openControlDatabase } from './write-barrier.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'fence-operations.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}

const SUITE_DB = `rayspec_fence_ops_${process.pid}`;
const SYS_DB = `${SUITE_DB}_dbos_sys`;
const ROLE = `rayspec_fence_rt_${process.pid}`;
const OWNER_ROLE = `rayspec_fence_owner_${process.pid}`;
const WRITER_ROLE = `rayspec_fence_writer_${process.pid}`;
const MEMBER_ROLE = `rayspec_fence_member_${process.pid}`;
const CREATOR_ROLE = `rayspec_fence_creator_${process.pid}`;
const ROLE_PASSWORD = randomBytes(18).toString('hex');

const validEnvelope = schemaValidator('resultEnvelope');
function expectValidEnvelope(envelope: ResultEnvelope<unknown>): void {
  const ok = validEnvelope(JSON.parse(JSON.stringify(envelope)));
  expect(ok, JSON.stringify(validEnvelope.errors)).toBe(true);
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function asRole(url: string, role: string): string {
  const u = new URL(url);
  u.username = role;
  u.password = ROLE_PASSWORD;
  return u.toString();
}

function base() {
  return {
    contractVersion: '1.0.0-rc.2' as const,
    operationId: randomUUID(),
    actor: 'operator:fence-suite',
  };
}

function quiesceRequest(overrides: Partial<QuiesceRequest> = {}): QuiesceRequest {
  return {
    ...base(),
    reason: 'export before a host move',
    deadline: formatTimestamp(new Date(Date.now() + 5_000)),
    sourceStopped: false,
    ...overrides,
  };
}

describe.skipIf(!baseUrl)('quiesce, resume and health', () => {
  let dbUrl = '';
  let sysUrl = '';
  let control: Db;
  let admin: postgres.Sql;
  let appOwner: postgres.Sql;

  function adapter(extra: Partial<RuntimeControlOptions> = {}) {
    return createRuntimeControl({ db: control, quiescePollMs: 50, ...extra });
  }

  async function fenceRow(): Promise<{
    fence_state: string;
    fence_epoch: string;
    environment_revision: string;
    fence_barriers: unknown;
  }> {
    const [row] = await control.$client.unsafe(
      `SELECT fence_state, fence_epoch::text AS fence_epoch,
              environment_revision::text AS environment_revision, fence_barriers
         FROM runtime_control_state WHERE id = 1`,
    );
    return row as never;
  }

  async function heartbeat(row: {
    epoch: number;
    phase: 'open' | 'draining' | 'fenced';
    producers?: unknown[];
    external?: string[];
    ageSeconds?: number;
  }): Promise<string> {
    const id = randomUUID();
    await appOwner.unsafe(
      `INSERT INTO runtime_control_processes
         (process_id, fence_epoch, phase, producers, unfenced_external, seen_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, clock_timestamp() - make_interval(secs => $6))`,
      [
        id,
        row.epoch,
        row.phase,
        JSON.stringify(row.producers ?? []),
        JSON.stringify(row.external ?? []),
        row.ageSeconds ?? 0,
      ],
    );
    return id;
  }

  async function resumeCurrent(): Promise<void> {
    const row = await fenceRow();
    if (row.fence_state === 'fenced') {
      const r = await adapter().resume({ ...base(), fenceEpoch: Number(row.fence_epoch) });
      expect(r.ok).toBe(true);
    }
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    sysUrl = withDbName(baseUrl, SYS_DB);
    admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    for (const role of [ROLE, OWNER_ROLE, MEMBER_ROLE, WRITER_ROLE, CREATOR_ROLE]) {
      await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    for (const role of [ROLE, OWNER_ROLE]) {
      await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${ROLE_PASSWORD}'`);
    }
    // A runtime role that does not inherit its memberships, a role holding writes it can switch to,
    // and a role that may create roles.
    await admin.unsafe(`CREATE ROLE "${MEMBER_ROLE}" LOGIN NOINHERIT PASSWORD '${ROLE_PASSWORD}'`);
    await admin.unsafe(`CREATE ROLE "${WRITER_ROLE}" NOLOGIN`);
    await admin.unsafe(
      `CREATE ROLE "${CREATOR_ROLE}" LOGIN CREATEROLE PASSWORD '${ROLE_PASSWORD}'`,
    );
    const migrator = makeDb(dbUrl);
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.$client.end();
    }
    control = openControlDatabase(dbUrl);
    appOwner = postgres(dbUrl, {
      max: 1,
      connection: { application_name: 'rayspec-control-suiteowner' },
    });
  }, 120_000);

  afterAll(async () => {
    await control?.$client.end().catch(() => {});
    await appOwner?.end().catch(() => {});
    if (!baseUrl) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    for (const role of [MEMBER_ROLE, CREATOR_ROLE, ROLE, OWNER_ROLE, WRITER_ROLE]) {
      await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
    await admin.end();
  }, 60_000);

  it('takes the fence with no running process: fenced at epoch 1, revision up, receipts written', async () => {
    const request = quiesceRequest();
    const result = await adapter().quiesce(request);
    expectValidEnvelope(result);
    expect(result.ok).toBe(true);
    expect(result.operationId).toBe(request.operationId);
    expect(result.data).toEqual({
      fenceEpoch: 1,
      status: 'fenced',
      producers: [],
      barriers: [
        { barrier: 'database-write-role', state: 'unavailable' },
        { barrier: 'object-writes', state: 'held' },
      ],
      unfencedExternal: [],
    });
    const row = await fenceRow();
    expect(row).toMatchObject({
      fence_state: 'fenced',
      fence_epoch: '1',
      environment_revision: '2',
    });
    expect(row.fence_barriers).toEqual({
      database: { barrier: 'database-write-role', state: 'unavailable' },
      objects: { barrier: 'object-writes', state: 'held' },
    });

    const inspected = await adapter().inspect(base());
    expect(inspected.data?.fence).toEqual({ state: 'fenced', fenceEpoch: 1 });

    const receipts = await readOperationReceipts(control, request.operationId);
    expect(receipts.map((r) => [r.event, r.step, r.outcome])).toEqual([
      ['intent', null, null],
      ['step-started', 'take-fence', null],
      ['step-finished', 'take-fence', null],
      ['step-started', 'drain', null],
      ['step-finished', 'drain', null],
      ['step-started', 'barriers', null],
      ['step-finished', 'barriers', null],
      ['outcome', null, 'succeeded'],
    ]);
    expect(receipts.every((r) => r.operationKind === 'runtime.quiesce')).toBe(true);
    expect(receipts.every((r) => r.actor === 'operator:fence-suite')).toBe(true);
  });

  it('a second quiesce while fenced keeps the epoch and the revision', async () => {
    const result = await adapter().quiesce(quiesceRequest());
    expect(result.ok).toBe(true);
    expect(result.data?.fenceEpoch).toBe(1);
    expect(await fenceRow()).toMatchObject({ fence_epoch: '1', environment_revision: '2' });
  });

  it('resume refuses a stale or foreign epoch, releases the matching one once, then changes nothing', async () => {
    for (const fenceEpoch of [0, 2, 99]) {
      const refused = await adapter().resume({ ...base(), fenceEpoch });
      expectValidEnvelope(refused);
      expect(refused.ok).toBe(false);
      expect(refused.errors[0]).toMatchObject({
        code: 'RAY_FENCE_MISMATCH',
        path: '/fenceEpoch',
        retryable: false,
      });
      expect(refused.data).toBeNull();
    }
    expect(await fenceRow()).toMatchObject({ fence_state: 'fenced', fence_epoch: '1' });

    const request = { ...base(), fenceEpoch: 1 };
    const released = await adapter().resume(request);
    expectValidEnvelope(released);
    expect(released.ok).toBe(true);
    expect(released.data).toEqual({ fenceEpoch: 1, released: true, environmentRevision: 3 });
    expect(await fenceRow()).toMatchObject({ fence_state: 'open', fence_epoch: '1' });
    const receipts = await readOperationReceipts(control, request.operationId);
    expect(receipts.at(-1)).toMatchObject({ event: 'outcome', outcome: 'succeeded' });
    // Stored as JSON objects, not as a JSON string holding the text of one.
    expect(receipts.at(-1)?.detail).toEqual({ fenceEpoch: 1, released: true });
    const [typed] = await control.$client.unsafe(
      `SELECT jsonb_typeof(detail) AS detail FROM runtime_control_receipts
        WHERE operation_id = $1 AND event = 'outcome'`,
      [request.operationId],
    );
    expect(typed).toEqual({ detail: 'object' });

    const again = await adapter().resume({ ...base(), fenceEpoch: 1 });
    expect(again.data).toEqual({ fenceEpoch: 1, released: false, environmentRevision: 3 });
    // An open fence resumed at an epoch it never had is still a mismatch.
    const foreign = await adapter().resume({ ...base(), fenceEpoch: 0 });
    expect(foreign.errors[0]?.code).toBe('RAY_FENCE_MISMATCH');
  });

  it('times out while a live process has not drained, keeps the fence, and never reports it consistent', async () => {
    // A live process that has not observed the new fence yet.
    const pid = await heartbeat({ epoch: 1, phase: 'open' });
    const request = quiesceRequest({ deadline: formatTimestamp(new Date(Date.now() + 2_000)) });
    const started = Date.now();
    const result = await adapter().quiesce(request);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expectValidEnvelope(result);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: 'RAY_SOURCE_NOT_QUIESCENT', retryable: true });
    expect(result.data).toMatchObject({
      fenceEpoch: 2,
      status: 'timed-out',
      producers: [{ producer: 'runtime-process', state: 'still-running' }],
      barriers: [
        { barrier: 'database-write-role', state: 'unavailable' },
        { barrier: 'object-writes', state: 'unavailable' },
      ],
    });
    expect(await fenceRow()).toMatchObject({ fence_state: 'fenced', fence_epoch: '2' });
    const receipts = await readOperationReceipts(control, request.operationId);
    expect(receipts.at(-1)).toMatchObject({ event: 'outcome', outcome: 'failed' });

    // The process drains, still reporting a queue job — the second quiesce waits for that too.
    await appOwner.unsafe(
      `UPDATE runtime_control_processes SET fence_epoch = 2, phase = 'draining', producers = $2::text::jsonb
        WHERE process_id = $1`,
      [pid, JSON.stringify([{ producer: 'run-queue', state: 'still-running' }])],
    );
    const stillDraining = await adapter().quiesce(
      quiesceRequest({ deadline: formatTimestamp(new Date(Date.now() + 1_000)) }),
    );
    expect(stillDraining.data?.status).toBe('timed-out');
    expect(stillDraining.data?.producers).toEqual([
      { producer: 'run-queue', state: 'still-running' },
    ]);

    await appOwner.unsafe(
      `UPDATE runtime_control_processes
          SET phase = 'fenced', producers = $2::text::jsonb, unfenced_external = $3::text::jsonb
        WHERE process_id = $1`,
      [
        pid,
        JSON.stringify([
          { producer: 'run-queue', state: 'drained' },
          { producer: 'streams', state: 'stopped' },
        ]),
        JSON.stringify(['agent-backend-openai']),
      ],
    );
    const fenced = await adapter().quiesce(quiesceRequest());
    expectValidEnvelope(fenced);
    expect(fenced.ok).toBe(true);
    expect(fenced.data).toMatchObject({
      fenceEpoch: 2,
      status: 'fenced',
      producers: [
        { producer: 'run-queue', state: 'drained' },
        { producer: 'streams', state: 'stopped' },
      ],
      unfencedExternal: ['agent-backend-openai'],
    });
    expect(fenced.warnings).toEqual([
      expect.objectContaining({ code: 'RAY_W_EXTERNAL_EFFECTS_UNFENCED' }),
    ]);
    await appOwner.unsafe('DELETE FROM runtime_control_processes');
    await resumeCurrent();
  });

  it('does not report fenced while a process is booting: it is live from load(), before start()', async () => {
    // A runtime process between reading the fence and serving: its producers are still being wired
    // and its queues are about to launch. It has written its heartbeat but not observed any fence.
    const booting = new RuntimeFence({ db: control, pollIntervalMs: 60_000 });
    await booting.load();
    try {
      const request = quiesceRequest({ deadline: formatTimestamp(new Date(Date.now() + 1_500)) });
      const result = await adapter().quiesce(request);
      expectValidEnvelope(result);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('RAY_SOURCE_NOT_QUIESCENT');
      expect(result.data).toMatchObject({
        status: 'timed-out',
        producers: [{ producer: 'runtime-process', state: 'still-running' }],
        barriers: [
          { barrier: 'database-write-role', state: 'unavailable' },
          { barrier: 'object-writes', state: 'unavailable' },
        ],
      });

      // Once it observes the fence (its first poll after start) and has nothing running, it drains.
      await booting.start();
      const fenced = await adapter().quiesce(quiesceRequest());
      expect(fenced.data?.status).toBe('fenced');
    } finally {
      await booting.stop();
    }
    await resumeCurrent();
  });

  it('renews its lease while it waits: a deadline longer than one lease still ends in timed-out', async () => {
    const pid = await heartbeat({ epoch: 0, phase: 'open' });
    try {
      // The lease lives 600 ms between renewals; the drain waits 2 s for a process that never drains.
      const result = await adapter({ quiesceLeaseTtlMs: 600 }).quiesce(
        quiesceRequest({ deadline: formatTimestamp(new Date(Date.now() + 2_000)) }),
      );
      expectValidEnvelope(result);
      expect(result.errors[0]?.code).toBe('RAY_SOURCE_NOT_QUIESCENT');
      expect(result.data?.status).toBe('timed-out');
      expect(result.data?.fenceEpoch).toBe(Number((await fenceRow()).fence_epoch));
      const receipts = await readOperationReceipts(control, result.operationId);
      expect(receipts.at(-1)).toMatchObject({ event: 'outcome', outcome: 'failed' });
    } finally {
      await appOwner.unsafe('DELETE FROM runtime_control_processes WHERE process_id = $1', [pid]);
    }
    await resumeCurrent();
  });

  it('does not count a stale heartbeat as a live process', async () => {
    await heartbeat({ epoch: 0, phase: 'open', ageSeconds: 120 });
    const result = await adapter().quiesce(quiesceRequest());
    expect(result.data?.status).toBe('fenced');
    await appOwner.unsafe('DELETE FROM runtime_control_processes');
    await resumeCurrent();
  });

  it('refuses a concurrent quiesce while one holds the lease, retryable', async () => {
    await heartbeat({ epoch: 0, phase: 'open' });
    const slow = adapter().quiesce(
      quiesceRequest({ deadline: formatTimestamp(new Date(Date.now() + 3_000)) }),
    );
    await new Promise((r) => setTimeout(r, 500));
    const second = await adapter().quiesce(quiesceRequest());
    expect(second.ok).toBe(false);
    expect(second.errors[0]).toMatchObject({ code: 'RAY_LOCK_TIMEOUT', retryable: true });
    const resume = await adapter().resume({ ...base(), fenceEpoch: 3 });
    expect(resume.errors[0]?.code).toBe('RAY_LOCK_TIMEOUT');
    expect((await slow).data?.status).toBe('timed-out');
    await appOwner.unsafe('DELETE FROM runtime_control_processes');
    await resumeCurrent();
  });

  it('holds the stopped-source barrier only when no other session is connected to either database', async () => {
    // The suite's own owner connection is someone else's session to the barrier: close it first.
    await appOwner.end();
    const held = await adapter().quiesce(quiesceRequest({ sourceStopped: true }));
    expect(held.data?.barriers).toEqual([
      { barrier: 'database-stopped-source', state: 'held' },
      { barrier: 'object-writes', state: 'held' },
    ]);
    await resumeCurrent();
    appOwner = postgres(dbUrl, { max: 1 });

    // A session that is not the caller's own, on the application database.
    const stranger = postgres(dbUrl, { max: 1 });
    try {
      await stranger`select 1`;
      const refused = await adapter().quiesce(quiesceRequest({ sourceStopped: true }));
      expect(refused.ok).toBe(true);
      expect(refused.data?.barriers[0]).toEqual({
        barrier: 'database-write-role',
        state: 'unavailable',
      });
      await resumeCurrent();
    } finally {
      await stranger.end();
    }

    // A session on the workflow system database counts too.
    await admin.unsafe(`CREATE DATABASE "${SYS_DB}"`);
    const worker = postgres(sysUrl, { max: 1 });
    try {
      await worker`select 1`;
      const refused = await adapter().quiesce(quiesceRequest({ sourceStopped: true }));
      expect(refused.data?.barriers[0]).toEqual({
        barrier: 'database-write-role',
        state: 'unavailable',
      });
      await resumeCurrent();
    } finally {
      await worker.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    }

    // Without the operator's attestation there is no stopped-source barrier at all.
    const unattested = await adapter().quiesce(quiesceRequest({ sourceStopped: false }));
    expect(unattested.data?.barriers[0]).toEqual({
      barrier: 'database-write-role',
      state: 'unavailable',
    });
    await resumeCurrent();
  });

  it('with role separation, revokes the runtime role writes until resume and grants back exactly what it held', async () => {
    await appOwner.unsafe('CREATE TABLE fence_items (id serial PRIMARY KEY, body text)');
    await appOwner.unsafe('CREATE TABLE fence_audit (id serial PRIMARY KEY, body text)');
    await appOwner.unsafe(`GRANT CONNECT ON DATABASE "${SUITE_DB}" TO "${ROLE}"`);
    await appOwner.unsafe(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
    await appOwner.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON fence_items, runtime_control_processes TO "${ROLE}"`,
    );
    await appOwner.unsafe(`GRANT SELECT ON runtime_control_state TO "${ROLE}"`);
    // The audit table only takes inserts: resume must not grant it more than that.
    await appOwner.unsafe(`GRANT SELECT, INSERT ON fence_audit TO "${ROLE}"`);
    await appOwner.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`);
    const runtime = postgres(asRole(dbUrl, ROLE), { max: 1 });
    try {
      await runtime`INSERT INTO fence_items (body) VALUES ('before')`;

      const result = await adapter({ runtimeRole: ROLE }).quiesce(quiesceRequest());
      expectValidEnvelope(result);
      expect(result.data?.barriers).toEqual([
        { barrier: 'database-write-role', state: 'held' },
        { barrier: 'object-writes', state: 'held' },
      ]);
      // Blocked AT THE DATABASE for the runtime role, which cannot undo it.
      await expect(runtime`INSERT INTO fence_items (body) VALUES ('during')`).rejects.toMatchObject(
        {
          code: '42501',
        },
      );
      await expect(runtime`UPDATE fence_items SET body = 'x'`).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtime`INSERT INTO fence_audit (body) VALUES ('during')`).rejects.toMatchObject(
        {
          code: '42501',
        },
      );
      // The runtime role cannot grant itself back: Postgres grants nothing (a warning, not an error).
      await runtime.unsafe(`GRANT INSERT ON fence_items TO "${ROLE}"`);
      await expect(
        runtime`INSERT INTO fence_items (body) VALUES ('regrant')`,
      ).rejects.toMatchObject({
        code: '42501',
      });
      // Reads continue, for the runtime and for the snapshot reader; the heartbeat stays writable.
      expect((await runtime`SELECT count(*)::int AS n FROM fence_items`)[0]?.n).toBe(1);
      expect((await appOwner`SELECT count(*)::int AS n FROM fence_items`)[0]?.n).toBe(1);
      await runtime`DELETE FROM runtime_control_processes WHERE false`;

      // A second quiesce of the same fence keeps what the first recorded.
      const again = await adapter({ runtimeRole: ROLE }).quiesce(quiesceRequest());
      expect(again.data?.barriers[0]).toEqual({ barrier: 'database-write-role', state: 'held' });

      const row = await fenceRow();
      const resumed = await adapter({ runtimeRole: ROLE }).resume({
        ...base(),
        fenceEpoch: Number(row.fence_epoch),
      });
      expect(resumed.data?.released).toBe(true);
      await runtime`INSERT INTO fence_items (body) VALUES ('after')`;
      await runtime`INSERT INTO fence_audit (body) VALUES ('after')`;
      const [privileges] = await appOwner.unsafe(
        `SELECT has_table_privilege($1, 'fence_audit', 'UPDATE') AS audit_update,
                has_table_privilege($1, 'fence_items', 'UPDATE') AS items_update`,
        [ROLE],
      );
      expect(privileges).toEqual({ audit_update: false, items_update: true });
    } finally {
      await runtime.end();
    }
  });

  it('covers the workflow system database too, and refuses the role barrier without a handle to it', async () => {
    await admin.unsafe(`CREATE DATABASE "${SYS_DB}"`);
    const sysOwner = postgres(sysUrl, { max: 1 });
    const sysControl = openControlDatabase(sysUrl, 1);
    const sysRuntime = postgres(asRole(sysUrl, ROLE), { max: 1 });
    const runtime = postgres(asRole(dbUrl, ROLE), { max: 1 });
    try {
      await sysOwner.unsafe('CREATE TABLE workflow_status (id text PRIMARY KEY)');
      await sysOwner.unsafe(`GRANT CONNECT ON DATABASE "${SYS_DB}" TO "${ROLE}"`);
      await sysOwner.unsafe(`GRANT SELECT, INSERT ON workflow_status TO "${ROLE}"`);

      // No handle to the workflow system database: the barrier cannot be held, and nothing is revoked.
      const refused = await adapter({ runtimeRole: ROLE }).quiesce(quiesceRequest());
      expect(refused.data?.barriers[0]).toEqual({
        barrier: 'database-write-role',
        state: 'unavailable',
      });
      await runtime`INSERT INTO fence_items (body) VALUES ('still writable')`;
      await resumeCurrent();

      const both = adapter({ runtimeRole: ROLE, workflowSystemDb: sysControl });
      const held = await both.quiesce(quiesceRequest());
      expect(held.data?.barriers[0]).toEqual({ barrier: 'database-write-role', state: 'held' });
      await expect(sysRuntime`INSERT INTO workflow_status VALUES ('a')`).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtime`INSERT INTO fence_items (body) VALUES ('x')`).rejects.toMatchObject({
        code: '42501',
      });
      const row = await fenceRow();
      const resumed = await both.resume({ ...base(), fenceEpoch: Number(row.fence_epoch) });
      expect(resumed.data?.released).toBe(true);
      await sysRuntime`INSERT INTO workflow_status VALUES ('b')`;
      await runtime`INSERT INTO fence_items (body) VALUES ('y')`;
    } finally {
      await sysRuntime.end();
      await runtime.end();
      await sysControl.$client.end();
      await sysOwner.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    }
  });

  it('refuses the role barrier for a role that owns a table, and revokes nothing', async () => {
    await appOwner.unsafe(`GRANT CREATE ON SCHEMA public TO "${OWNER_ROLE}"`);
    await appOwner.unsafe(`GRANT CONNECT ON DATABASE "${SUITE_DB}" TO "${OWNER_ROLE}"`);
    const owner = postgres(asRole(dbUrl, OWNER_ROLE), { max: 1 });
    try {
      await owner.unsafe('CREATE TABLE owned_by_runtime (id int)');
      const result = await adapter({ runtimeRole: OWNER_ROLE }).quiesce(quiesceRequest());
      expect(result.data?.barriers[0]).toEqual({
        barrier: 'database-write-role',
        state: 'unavailable',
      });
      await owner`INSERT INTO owned_by_runtime VALUES (1)`;
      await resumeCurrent();
      const missing = await adapter({ runtimeRole: 'no_such_role_anywhere' }).quiesce(
        quiesceRequest(),
      );
      expect(missing.data?.barriers[0]?.state).toBe('unavailable');
      await resumeCurrent();
    } finally {
      await owner.unsafe('DROP TABLE IF EXISTS owned_by_runtime');
      await owner.end();
    }
  });

  it('refuses the role barrier for a role that can switch to a writer or an owner, or create roles', async () => {
    await appOwner.unsafe(
      `GRANT CONNECT ON DATABASE "${SUITE_DB}" TO "${MEMBER_ROLE}", "${CREATOR_ROLE}"`,
    );
    await appOwner.unsafe(`GRANT USAGE ON SCHEMA public TO "${MEMBER_ROLE}", "${WRITER_ROLE}"`);
    await appOwner.unsafe(`GRANT SELECT, INSERT ON fence_items TO "${WRITER_ROLE}"`);
    await appOwner.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${WRITER_ROLE}"`);
    await admin.unsafe(`GRANT "${WRITER_ROLE}" TO "${MEMBER_ROLE}"`);
    const member = postgres(asRole(dbUrl, MEMBER_ROLE), { max: 1 });
    try {
      // The threat: without inheriting anything, the member still writes by switching role.
      const [direct] = await appOwner.unsafe(
        `SELECT has_table_privilege($1, 'fence_items', 'INSERT') AS insert`,
        [MEMBER_ROLE],
      );
      expect(direct).toEqual({ insert: false });
      await member.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE "${WRITER_ROLE}"`);
        await tx.unsafe(`INSERT INTO fence_items (body) VALUES ('switched')`);
      });

      const writer = await adapter({ runtimeRole: MEMBER_ROLE }).quiesce(quiesceRequest());
      expect(writer.data?.barriers[0]).toEqual({
        barrier: 'database-write-role',
        state: 'unavailable',
      });
      await resumeCurrent();

      // A member of a table's owner, by the same switch.
      await admin.unsafe(`REVOKE "${WRITER_ROLE}" FROM "${MEMBER_ROLE}"`);
      await admin.unsafe(`GRANT "${OWNER_ROLE}" TO "${MEMBER_ROLE}"`);
      await appOwner.unsafe(`GRANT CREATE ON SCHEMA public TO "${OWNER_ROLE}"`);
      await appOwner.unsafe(`GRANT CONNECT ON DATABASE "${SUITE_DB}" TO "${OWNER_ROLE}"`);
      const owner = postgres(asRole(dbUrl, OWNER_ROLE), { max: 1 });
      try {
        // The owner even gives up its own writes: only ownership lets it grant them back.
        await owner.unsafe('CREATE TABLE owned_by_other (id int)');
        await owner.unsafe(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON owned_by_other FROM "${OWNER_ROLE}"`,
        );
        const ownerMember = await adapter({ runtimeRole: MEMBER_ROLE }).quiesce(quiesceRequest());
        expect(ownerMember.data?.barriers[0]?.state).toBe('unavailable');
        await resumeCurrent();
        await owner.unsafe('DROP TABLE owned_by_other');
      } finally {
        await owner.end();
      }
      await admin.unsafe(`REVOKE "${OWNER_ROLE}" FROM "${MEMBER_ROLE}"`);

      // With no such membership left, the same role holds the barrier.
      const held = await adapter({ runtimeRole: MEMBER_ROLE }).quiesce(quiesceRequest());
      expect(held.data?.barriers[0]).toEqual({ barrier: 'database-write-role', state: 'held' });
      await resumeCurrent();

      // A role that may create roles could grant itself back into one.
      const creator = await adapter({ runtimeRole: CREATOR_ROLE }).quiesce(quiesceRequest());
      expect(creator.data?.barriers[0]?.state).toBe('unavailable');
      await resumeCurrent();
    } finally {
      await member.end();
    }
  });

  it('refuses a malformed request with RAY_USAGE before touching the database', async () => {
    const bad = await adapter().quiesce({ ...quiesceRequest(), deadline: 'tomorrow' });
    expectValidEnvelope(bad);
    expect(bad.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/deadline' });
    const badResume = await adapter().resume({ ...base(), fenceEpoch: -1 });
    expect(badResume.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/fenceEpoch' });
    const badHealth = await adapter().health({ ...base(), actor: '' });
    expect(badHealth.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/actor' });
  });

  it('health: live and ready, then not ready for a newer schema or a failing probe, still live, no topology', async () => {
    const ready = await adapter().health(base());
    expectValidEnvelope(ready);
    expect(ready.data).toEqual({
      live: true,
      ready: true,
      checks: [
        { name: 'database', ok: true, detail: null },
        { name: 'schema', ok: true, detail: null },
      ],
    });

    await appOwner.unsafe(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('from-a-newer-runtime', 9999999999999)`,
    );
    try {
      const newer = await adapter({
        readiness: [{ name: 'worker', check: async () => 'the durable worker is not running' }],
      }).health(base());
      expectValidEnvelope(newer);
      expect(newer.data?.live).toBe(true);
      expect(newer.data?.ready).toBe(false);
      expect(newer.data?.checks).toEqual([
        { name: 'database', ok: true, detail: null },
        {
          name: 'schema',
          ok: false,
          detail: 'the database was migrated by a newer runtime than this one',
        },
        { name: 'worker', ok: false, detail: 'the durable worker is not running' },
      ]);
      const text = JSON.stringify(newer);
      const u = new URL(dbUrl);
      for (const topology of [u.hostname, u.port, SUITE_DB, u.username]) {
        expect(text).not.toContain(topology);
      }
    } finally {
      await appOwner.unsafe(
        `DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'from-a-newer-runtime'`,
      );
    }
  });
});
