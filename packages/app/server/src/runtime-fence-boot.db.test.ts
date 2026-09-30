/**
 * The source fence against REALLY BOOTED servers: each server is its own process (the shipped
 * composition root, a real listener, the bounded shutdown — `__fixtures__/fence-boot/boot.mts`), and
 * quiesce and resume run from this process through the runtime-control adapter, the way a CLI or a
 * supervisor reaches a running server: only through the database.
 *
 * WHAT THESE ARMS PROVE, on ground truth (rows, files, log lines, sockets):
 *  1. Every producer runs before the fence: cron ticks, the on-demand trigger fire route, the system
 *     cleanup, async runs on the run queue, event-bus writes, uploads and event streams.
 *  2. While fenced each of them is stopped — an open event stream is closed, and a write attempted
 *     through EVERY mutation route the app serves is refused with 503 SERVICE_UNAVAILABLE — while
 *     reads keep answering; after resume every one of them works again, in the same process.
 *  3. Work in flight is drained, not cut: a quiesce whose deadline passes while runs are held in
 *     flight reports `timed-out` (ok: false, RAY_SOURCE_NOT_QUIESCENT) and keeps the fence; once they
 *     finish it reports `fenced`; a job queued before the fence is not dequeued until resume.
 *  4. The fence survives a restart: a server booted under a held fence starts fenced.
 *  5. Readiness goes false for a missing dependency — the database, the workflow system database,
 *     the schema, a mounted secret — while liveness stays true, and recovers with it.
 *  6. Shutdown is bounded: a connection that never finishes its request is closed after the drain.
 *     (That server runs the managed hosting posture, which disables the public `/recovery-scope`.)
 *  7. A database migrated by a newer runtime is refused at boot, and left unchanged.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimestamp } from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, SchemaNewerThanRuntimeError } from './composition-root.js';
import { createRuntimeControl } from './runtime-control.js';
import { openControlDatabase } from './write-barrier.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(here, '..');
const FIXTURE_DIR = join(here, '__fixtures__', 'fence-boot');
const BOOT_SCRIPT = join(FIXTURE_DIR, 'boot.mts');
const SPEC_PATH = join(FIXTURE_DIR, 'fence-boot.rayspec.yaml');

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'runtime-fence-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed suite.',
  );
}

const SUITE_DB = `rayspec_fence_boot_${process.pid}`;
const SYS_DB = `${SUITE_DB}_dbos_sys`;
const TENANT = '00000000-0000-4000-8000-00000000f3c1';
const EXIT_BUDGET_MS = 15_000;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => res(port));
    });
  });
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  budgetMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${budgetMs} ms; last: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
    last = await read();
  }
  return last;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  child: ChildProcess;
  port: number;
  out(): string;
}

describe.skipIf(!baseUrl)('the source fence on a really booted server', () => {
  let dbUrl = '';
  let dir = '';
  let keyFile = '';
  let pepperFile = '';
  let routesFile = '';
  let holdFile = '';
  let blobRoot = '';
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let control: Db;
  let server: Booted | undefined;
  let token = '';
  let armsRan = 0;

  function adapter() {
    return createRuntimeControl({ db: control, quiescePollMs: 100 });
  }
  function base() {
    return {
      contractVersion: '1.0.0-draft.2' as const,
      operationId: randomUUID(),
      actor: 'operator:fence-boot',
    };
  }
  function quiesce(deadlineMs = 20_000) {
    return adapter().quiesce({
      ...base(),
      reason: 'fence boot suite',
      deadline: formatTimestamp(new Date(Date.now() + deadlineMs)),
      sourceStopped: false,
    });
  }
  async function resumeAt(fenceEpoch: number) {
    return adapter().resume({ ...base(), fenceEpoch });
  }

  async function boot(extraEnv: Record<string, string> = {}): Promise<Booted> {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: dbUrl,
        RAYSPEC_JWT_SIGNING_KEY_FILE: keyFile,
        RAYSPEC_API_KEY_PEPPER_FILE: pepperFile,
        PORT: String(port),
        RAYSPEC_SPEC_PATH: SPEC_PATH,
        RAYSPEC_CRON_TENANT_ID: TENANT,
        RAYSPEC_BLOB_ROOT: blobRoot,
        RAYSPEC_CLEANUP_SCHEDULE: '* * * * * *',
        FENCE_ROUTES_FILE: routesFile,
        FENCE_HOLD_FILE: holdFile,
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    const booted: Booted = { child, port, out: () => out };
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`the server exited while booting (code ${child.exitCode}):\n${out}`);
      }
      try {
        if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) return booted;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the server did not come up:\n${out}`);
      await pause(250);
    }
  }

  async function stop(booted: Booted | undefined): Promise<number | null> {
    if (!booted || booted.child.exitCode !== null || booted.child.signalCode !== null) {
      return booted?.child.exitCode ?? null;
    }
    const exited = new Promise<number | null>((r) => booted.child.once('exit', (code) => r(code)));
    booted.child.kill('SIGTERM');
    const code = await Promise.race([exited, pause(EXIT_BUDGET_MS).then(() => 'late' as const)]);
    if (code === 'late') {
      booted.child.kill('SIGKILL');
      throw new Error(`the server did not stop within ${EXIT_BUDGET_MS} ms:\n${booted.out()}`);
    }
    return code;
  }

  function http(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return fetch(`http://127.0.0.1:${server?.port}${path}`, { ...init, headers });
  }
  function post(path: string, body: unknown): Promise<Response> {
    return http(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function count(table: string): Promise<number> {
    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
    return (rows[0] as { n: number }).n;
  }
  function blobFiles(): number {
    if (!existsSync(blobRoot)) return 0;
    return readdirSync(blobRoot, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      .length;
  }
  function lines(marker: string): number {
    return (server?.out() ?? '').split('\n').filter((l) => l.includes(marker)).length;
  }
  async function fenceEpoch(): Promise<number> {
    const rows = await sql`SELECT fence_epoch::int AS e FROM runtime_control_state WHERE id = 1`;
    return (rows[0] as { e: number } | undefined)?.e ?? 0;
  }

  /** Open an event stream and report when it ends (or that it is still open after `ms`). */
  async function openStream(): Promise<{
    status: number;
    ended: (ms: number) => Promise<boolean>;
  }> {
    const res = await http('/v1/subscribe', { headers: { accept: 'text/event-stream' } });
    const reader = res.body?.getReader();
    let done = false;
    const pump = (async () => {
      if (!reader) return;
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true }));
        if (chunk.done) {
          done = true;
          return;
        }
      }
    })();
    return {
      status: res.status,
      ended: async (ms: number) => {
        await Promise.race([pump, pause(ms)]);
        // Read before cancelling: the cancel itself ends the pump.
        const endedByServer = done;
        if (!endedByServer) await reader?.cancel().catch(() => {});
        return endedByServer;
      },
    };
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);

    dir = mkdtempSync(join(tmpdir(), 'rayspec-fence-boot-'));
    keyFile = join(dir, 'jwt.pem');
    pepperFile = join(dir, 'pepper');
    routesFile = join(dir, 'routes.json');
    holdFile = join(dir, 'hold');
    blobRoot = join(dir, 'blobs');
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    writeFileSync(keyFile, await exportPKCS8(privateKey), { mode: 0o600 });
    writeFileSync(pepperFile, `fence-boot-pepper-${randomUUID()}`, { mode: 0o600 });

    server = await boot();
    sql = postgres(dbUrl, { max: 2 });
    control = openControlDatabase(dbUrl);

    // A user who is owner of the cron tenant's org, and a token scoped to it.
    await sql`INSERT INTO orgs (id, name, slug) VALUES (${TENANT}, 'Fence Co', 'fence-co')`;
    const email = `fence-${randomUUID()}@example.test`;
    const reg = await post('/v1/auth/register', {
      email,
      password: 'correct-horse-battery-staple-9',
    });
    expect(reg.status).toBe(201);
    token = (await reg.json()).accessToken as string;
    const [user] = await sql`SELECT id FROM users WHERE lower(email) = lower(${email})`;
    await sql`INSERT INTO memberships (org_id, user_id, role) VALUES (${TENANT}, ${user?.id}, 'owner')`;
    const switched = await http(`/v1/orgs/${TENANT}/switch`, { method: 'POST' });
    expect(switched.status).toBe(200);
    token = (await switched.json()).accessToken as string;
  }, 150_000);

  afterAll(async () => {
    await stop(server).catch(() => {});
    await control?.$client.end().catch(() => {});
    await sql?.end().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    await admin.end();
    if (dbRequired && armsRan === 0) throw new Error('no fence boot arm ran');
  }, 60_000);

  it('runs every producer before the fence', async () => {
    armsRan += 1;
    const ticks = await count('fence_ticks');
    await eventually(
      () => count('fence_ticks'),
      (n) => n >= ticks + 2,
    );
    await eventually(
      async () => lines('[cleanup] oidc:'),
      (n) => n >= 2,
    );
    expect((await post('/fence-notes', { body: 'before' })).status).toBe(201);
    expect((await http('/v1/triggers/by-hand/fire', { method: 'POST' })).status).toBe(202);
    const run = await post('/v1/agents/echo/runs', { input: 'before', async: true });
    expect(run.status).toBe(202);
    const events = await count('tenant_events');
    expect((await http('/emit-on-read')).status).toBe(200);
    expect(await count('tenant_events')).toBe(events + 1);
    const upload = await http('/uploads/before', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(200);
    expect(blobFiles()).toBe(1);
    const stream = await openStream();
    expect(stream.status).toBe(200);
    expect(await stream.ended(1_000)).toBe(false);
    // The local posture keeps the public live-executor probe.
    expect((await http('/recovery-scope')).status).toBe(200);
    // Nothing is fenced: the heartbeat says so.
    const [heartbeat] = await sql`SELECT phase FROM runtime_control_processes`;
    expect(heartbeat).toEqual({ phase: 'open' });
  }, 60_000);

  it('stops every producer while fenced, refusing every mutation route, and restarts them all on resume', async () => {
    armsRan += 1;
    const stream = await openStream();
    expect(stream.status).toBe(200);

    const result = await quiesce();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const epoch = result.data?.fenceEpoch ?? -1;
    expect(epoch).toBe(1);
    expect(result.data?.status).toBe('fenced');
    const producers = Object.fromEntries(
      (result.data?.producers ?? []).map((p) => [p.producer, p.state]),
    );
    expect(producers).toEqual({
      'cron-triggers': 'drained',
      'event-bus-writes': 'stopped',
      'http-mutations': 'drained',
      'run-queue': 'drained',
      streams: 'stopped',
      'system-cleanup': 'drained',
    });
    expect(result.data?.barriers).toEqual([
      { barrier: 'database-write-role', state: 'unavailable' },
      { barrier: 'object-writes', state: 'held' },
    ]);
    expect(result.data?.unfencedExternal).toEqual(['agent-backend-openai']);

    // Streams: the open one was closed, and a new one is refused.
    expect(await stream.ended(3_000)).toBe(true);
    const refusedStream = await http('/v1/subscribe', { headers: { accept: 'text/event-stream' } });
    expect(refusedStream.status).toBe(503);

    // Scheduled workflows and the system cleanup: no tick, no cleanup run, while fenced.
    const ticks = await count('fence_ticks');
    const cleanups = lines('[cleanup] oidc:');
    await pause(3_000);
    expect(await count('fence_ticks')).toBe(ticks);
    expect(lines('[cleanup] oidc:')).toBe(cleanups);
    expect(lines('[cleanup] PAUSED')).toBeGreaterThan(0);
    expect(lines('[cron] PAUSED')).toBeGreaterThan(0);

    // HTTP mutations, the trigger fire route, async runs and uploads: 503 with Retry-After.
    const notes = await count('fence_notes');
    const runs = await count('runs');
    for (const res of [
      await post('/fence-notes', { body: 'during' }),
      await http('/v1/triggers/by-hand/fire', { method: 'POST' }),
      await post('/v1/agents/echo/runs', { input: 'during', async: true }),
      await http('/uploads/during', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([4]),
      }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect((await res.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    }
    expect(await count('fence_notes')).toBe(notes);
    expect(await count('runs')).toBe(runs);
    expect(blobFiles()).toBe(1);

    // Event-bus writes: refused even from a READ route once the runtime has drained.
    const events = await count('tenant_events');
    const emit = await http('/emit-on-read');
    expect(emit.status).toBe(503);
    expect((await emit.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await count('tenant_events')).toBe(events);

    // EVERY mutation route the app serves refuses — the list comes from the booted app itself.
    const routes = JSON.parse(readFileSync(routesFile, 'utf8')) as {
      method: string;
      path: string;
    }[];
    const mutations = routes.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
    expect(mutations.length).toBeGreaterThan(15);
    const users = await count('users');
    const orgs = await count('orgs');
    for (const route of mutations) {
      const path = route.path.replace(/:[A-Za-z_]+/g, 'x').replace(/\*/g, 'x');
      const res = await http(path, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(503);
      expect((await res.json()).error.code, `${route.method} ${route.path}`).toBe(
        'SERVICE_UNAVAILABLE',
      );
    }
    expect(await count('users')).toBe(users);
    expect(await count('orgs')).toBe(orgs);
    expect(await count('fence_notes')).toBe(notes);

    // Reads continue.
    expect((await http('/fence-notes')).status).toBe(200);
    expect((await http('/health')).status).toBe(200);

    // A resume at the wrong epoch changes nothing.
    for (const wrong of [0, epoch + 1]) {
      const refused = await resumeAt(wrong);
      expect(refused.errors[0]?.code).toBe('RAY_FENCE_MISMATCH');
    }
    expect((await post('/fence-notes', { body: 'still fenced' })).status).toBe(503);

    // Resume: every producer works again, in the same process, within about one poll.
    const resumed = await resumeAt(epoch);
    expect(resumed.data?.released).toBe(true);
    await eventually(
      async () => (await post('/fence-notes', { body: 'after' })).status,
      (s) => s === 201,
      5_000,
    );
    await eventually(
      () => count('fence_ticks'),
      (n) => n >= ticks + 2,
    );
    await eventually(
      async () => lines('[cleanup] oidc:'),
      (n) => n > cleanups,
    );
    expect((await http('/v1/triggers/by-hand/fire', { method: 'POST' })).status).toBe(202);
    const run = await post('/v1/agents/echo/runs', { input: 'after', async: true });
    expect(run.status).toBe(202);
    const runId = (await run.json()).runId as string;
    await eventually(
      async () => (await (await http(`/v1/runs/${runId}`)).json()).status as string,
      (s) => s !== 'enqueued' && s !== 'running',
    );
    expect((await http('/emit-on-read')).status).toBe(200);
    expect(await count('tenant_events')).toBe(events + 1);
    const upload = await http('/uploads/after', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([5]),
    });
    expect(upload.status).toBe(200);
    expect(blobFiles()).toBe(2);
    const reopened = await openStream();
    expect(reopened.status).toBe(200);
    expect(await reopened.ended(1_000)).toBe(false);
  }, 120_000);

  it('drains runs in flight before it reports fenced, times out while they run, and holds queued jobs until resume', async () => {
    armsRan += 1;
    writeFileSync(holdFile, 'hold');
    const runIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post('/v1/agents/echo/runs', { input: `held ${i}`, async: true });
      expect(res.status).toBe(202);
      runIds.push((await res.json()).runId as string);
    }
    const status = async (id: string) =>
      (await (await http(`/v1/runs/${id}`)).json()).status as string;
    const entered = () =>
      readdirSync(dir)
        .filter((f) => f.startsWith('hold.entered.'))
        .map((f) => f.slice(13));
    // Four run (the worker concurrency) and are held; the fifth waits in the queue.
    await eventually(
      async () => entered().length,
      (n) => n === 4,
      20_000,
    );
    await pause(1_500);
    expect(entered()).toHaveLength(4);
    const waiting = runIds.find((id) => !entered().includes(id)) as string;
    expect(waiting).toBeDefined();
    expect(await status(waiting)).toBe('enqueued');

    const timedOut = await quiesce(4_000);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.errors[0]?.code).toBe('RAY_SOURCE_NOT_QUIESCENT');
    expect(timedOut.data?.status).toBe('timed-out');
    expect(timedOut.data?.producers).toContainEqual({
      producer: 'run-queue',
      state: 'still-running',
    });
    expect(timedOut.data?.barriers).toContainEqual({
      barrier: 'object-writes',
      state: 'unavailable',
    });
    const epoch = timedOut.data?.fenceEpoch ?? -1;
    expect(await fenceEpoch()).toBe(epoch);
    // Held, not released: the fence is still up.
    expect((await post('/fence-notes', { body: 'x' })).status).toBe(503);

    rmSync(holdFile);
    const fenced = await quiesce();
    expect(fenced.ok, JSON.stringify(fenced)).toBe(true);
    expect(fenced.data).toMatchObject({ fenceEpoch: epoch, status: 'fenced' });
    // The held runs finished; the queued one was not dequeued while fenced.
    for (const id of runIds.filter((r) => r !== waiting)) {
      expect(['running', 'enqueued']).not.toContain(await status(id));
    }
    await pause(4_000);
    expect(await status(waiting)).toBe('enqueued');

    expect((await resumeAt(epoch)).data?.released).toBe(true);
    await eventually(
      () => status(waiting),
      (s) => s !== 'enqueued' && s !== 'running',
    );
  }, 120_000);

  it('keeps the fence across a restart: a server booted under it starts fenced', async () => {
    armsRan += 1;
    const result = await quiesce();
    expect(result.ok).toBe(true);
    const epoch = result.data?.fenceEpoch ?? -1;
    expect(await stop(server)).toBe(0);

    server = await boot();
    expect((await post('/fence-notes', { body: 'after restart' })).status).toBe(503);
    const ticks = await count('fence_ticks');
    await pause(3_000);
    expect(await count('fence_ticks')).toBe(ticks);
    expect(lines('[cron] PAUSED')).toBeGreaterThan(0);
    // The restarted process reports itself drained at the held epoch.
    await eventually(
      async () =>
        (await sql`SELECT fence_epoch::int AS e, phase FROM runtime_control_processes`)[0],
      (row) => row?.e === epoch && row?.phase === 'fenced',
    );

    expect((await resumeAt(epoch)).data?.released).toBe(true);
    await eventually(
      async () => (await post('/fence-notes', { body: 'resumed' })).status,
      (s) => s === 201,
      5_000,
    );
    await eventually(
      () => count('fence_ticks'),
      (n) => n >= ticks + 2,
    );
  }, 150_000);

  it('answers not ready for each missing dependency while liveness stays true', async () => {
    armsRan += 1;
    const health = async () => {
      const res = await http('/health');
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const live = async () => (await fetch(`http://127.0.0.1:${server?.port}/livez`)).status;

    const ready = await health();
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: 'ok',
      db: 'ok',
      live: true,
      ready: true,
      checks: {
        database: true,
        schema: true,
        bindings: true,
        worker: true,
        'workflow-system-database': true,
      },
    });
    // The public body names no topology and no secret.
    const text = JSON.stringify(ready.body);
    for (const leak of [SUITE_DB, SYS_DB, dir, new URL(dbUrl).port])
      expect(text).not.toContain(leak);

    // The schema: a ledger row this runtime does not ship (a newer runtime migrated the database).
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('newer', 9999999999999)`;
    const newer = await health();
    expect(newer.status).toBe(503);
    expect(newer.body).toMatchObject({ ready: false, checks: { schema: false, database: true } });
    expect(await live()).toBe(200);
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'newer'`;
    expect((await health()).status).toBe(200);

    // A mounted secret that is no longer there.
    renameSync(pepperFile, `${pepperFile}.moved`);
    const secret = await health();
    expect(secret.status).toBe(503);
    expect(secret.body).toMatchObject({ checks: { bindings: false } });
    expect(await live()).toBe(200);
    renameSync(`${pepperFile}.moved`, pepperFile);
    expect((await health()).status).toBe(200);

    // The application database refuses connections.
    for (const [database, check] of [
      [SUITE_DB, 'database'],
      [SYS_DB, 'workflow-system-database'],
    ] as const) {
      await admin.unsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`);
      await admin.unsafe(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database],
      );
      try {
        const down = await eventually(health, (h) => h.status === 503, 20_000);
        expect((down.body.checks as Record<string, boolean>)[check]).toBe(false);
        expect(await live()).toBe(200);
      } finally {
        await admin.unsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`);
      }
      await eventually(health, (h) => h.status === 200, 30_000);
    }
    // The suite's own pools were cut too: reconnect them.
    await sql.end().catch(() => {});
    sql = postgres(dbUrl, { max: 2 });
  }, 150_000);

  it('bounds the shutdown: a connection that never finishes its request is closed after the drain', async () => {
    armsRan += 1;
    expect(await stop(server)).toBe(0);
    server = await boot({ RAYSPEC_SHUTDOWN_DRAIN_MS: '1000', RAYSPEC_HOSTING_POSTURE: 'managed' });
    // The managed posture disables the public live-executor probe; the rest serves as before.
    expect((await fetch(`http://127.0.0.1:${server.port}/recovery-scope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    // The request below must reach its handler and wait there, so the fence must be open.
    expect((await sql`SELECT fence_state FROM runtime_control_state`)[0]).toEqual({
      fence_state: 'open',
    });
    const socket = createConnection({ host: '127.0.0.1', port: server.port });
    let socketClosed = false;
    socket.on('close', () => {
      socketClosed = true;
    });
    socket.on('error', () => {});
    await new Promise<void>((r) => socket.once('connect', () => r()));
    // Headers promising a body that never comes: the request stays in flight.
    socket.write(
      'POST /fence-notes HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 100\r\n\r\n{',
    );
    await pause(500);
    const started = Date.now();
    const code = await stop(server);
    const took = Date.now() - started;
    expect(code).toBe(0);
    expect(took).toBeLessThan(EXIT_BUDGET_MS);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(server.out()).toContain('connections were still open after the 1000 ms drain');
    expect(server.out()).toContain('STOPPED {"forcedConnections":true');
    expect(socketClosed).toBe(true);
    server = undefined;
  }, 120_000);

  it('refuses to serve a database migrated by a newer runtime, and changes nothing', async () => {
    armsRan += 1;
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('newer', 9999999999999)`;
    const before = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    try {
      const port = await freePort();
      const child = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
        cwd: PACKAGE_DIR,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          DATABASE_URL: dbUrl,
          RAYSPEC_JWT_SIGNING_KEY_FILE: keyFile,
          RAYSPEC_API_KEY_PEPPER_FILE: pepperFile,
          PORT: String(port),
          RAYSPEC_SPEC_PATH: SPEC_PATH,
          RAYSPEC_CRON_TENANT_ID: TENANT,
          RAYSPEC_BLOB_ROOT: blobRoot,
        },
      });
      let out = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.stderr?.on('data', (d) => {
        out += String(d);
      });
      const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      expect(code).not.toBe(0);
      expect(out).toContain('a newer runtime migrated it');
      expect(out).not.toContain('READY');
      expect(await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual(
        before,
      );

      // The same refusal in process, as the class both entrypoints print message-only.
      const db = makeDb(dbUrl);
      try {
        await expect(applyMigrations(db)).rejects.toBeInstanceOf(SchemaNewerThanRuntimeError);
      } finally {
        await db.$client.end();
      }
    } finally {
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'newer'`;
    }
  }, 120_000);
});
