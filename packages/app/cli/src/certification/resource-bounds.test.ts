/**
 * Execution stays bounded under a parallel workload whose model provider never answers, on a
 * deployment served by the real built CLI in the hardened posture (test-support/posture-deployment.ts).
 *
 * The workload, all at once: more in-request agent runs than the process admits, more queued runs
 * than the queue admits, a run cancelled while it waits, and ordinary store writes and reads beside
 * them. The provider holds every request open. Sampled throughout, from outside the process: the
 * database sessions of the runtime role on both databases (pg_stat_activity), the served process's
 * resident memory (ps), and the provider's open requests.
 *
 * What must hold: admission refuses what is over its bounds with `429` and `queue-full` before
 * anything is recorded; the database sessions never exceed the pools the server opens; store traffic
 * keeps being served while every run waits on the provider (no connection is held across a model
 * call); every admitted run ends — the in-request ones within the wall time plus the stated tail,
 * the queued ones as the worker reaches them, the cancelled one as cancelled — so no run is left
 * running and nothing is left queued; the provider's requests are all closed; memory returns near
 * where it started.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTemporaryDirectories } from '../../../../kernel/bundle-closure/src/test-support/app.js';
import {
  asAdmin,
  PASSWORD,
  type PostureDeployment,
  request,
  startPostureDeployment,
} from '../test-support/posture-deployment.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error('resource-bounds: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS)');
}

const ARMS = 1;
let armsRan = 0;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The bounds the deployment runs with. */
const BOUNDS = {
  syncRunsMax: 4,
  queueMax: 6,
  workerConcurrency: 2,
  runMaxMs: 3_000,
  requestTimeoutMs: 1_000,
  killGraceMs: 200,
};
/**
 * The connections the server opens on the application database: the serving pool (4), the worker's
 * pool (its concurrency plus one), and the event bus's one listening connection.
 */
const SERVING_POOL = 4;
const WORKER_POOL = BOUNDS.workerConcurrency + 1;
const EVENT_LISTENER = 1;
/** The tail a run's end may take past its wall time: kill grace, settle margin, record budget. */
const END_TAIL_MS = BOUNDS.killGraceMs + 1_000 + 5_000;

/** The resident memory of a process in KiB, read from outside it. */
function rssKiB(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

describe.skipIf(!baseUrl)(
  'bounded execution under a parallel workload with a hanging provider',
  () => {
    let d: PostureDeployment;

    beforeAll(async () => {
      if (!baseUrl) return;
      d = await startPostureDeployment(baseUrl, `rayspec_cert_load_${process.pid}`, {
        env: {
          RAYSPEC_AGENT_SYNC_RUNS_MAX: String(BOUNDS.syncRunsMax),
          RAYSPEC_AGENT_QUEUE_MAX: String(BOUNDS.queueMax),
          RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT: String(BOUNDS.queueMax),
          RAYSPEC_AGENT_WORKER_CONCURRENCY: String(BOUNDS.workerConcurrency),
          RAYSPEC_AGENT_RUN_MAX_MS: String(BOUNDS.runMaxMs),
          RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: String(BOUNDS.requestTimeoutMs),
          RAYSPEC_AGENT_KILL_GRACE_MS: String(BOUNDS.killGraceMs),
        },
      });
    }, 600_000);

    afterAll(async () => {
      await d?.dispose();
      removeTemporaryDirectories();
      if (dbRequired) expect(armsRan).toBe(ARMS);
    }, 120_000);

    it('admits runs only up to the queue and in-request bounds, ends every admitted run, and keeps database sessions, memory and the queue bounded', async () => {
      const owner = await request(d.base, '/v1/auth/register', {
        body: { email: 'owner@load.example', password: PASSWORD, orgName: 'Load' },
      });
      expect(owner.status, owner.text).toBe(201);
      const token = owner.body.accessToken as string;
      const pid = d.servingPid() as number;
      expect(pid).toBeGreaterThan(0);
      const runtimeRole = decodeURIComponent(new URL(d.roles.app.runtime).username);
      const sysRuntimeRole = decodeURIComponent(new URL(d.roles.sys.runtime).username);
      // Warm the process, then take the baseline.
      for (let i = 0; i < 5; i++) {
        await request(d.base, '/notes', { token, body: { body: `warm ${i}` } });
      }
      const baselineKiB = rssKiB(pid);

      // Sample sessions and memory throughout.
      const samples = {
        app: [] as number[],
        sys: [] as number[],
        rss: [] as number[],
        open: [] as number[],
      };
      let sampling = true;
      let peakSessions: string[] = [];
      const sampler = (async () => {
        while (sampling) {
          const appSessions = (await asAdmin(baseUrl as string, d.db, (sql) =>
            sql.unsafe(
              `SELECT application_name, state, left(query, 50) AS query FROM pg_stat_activity
              WHERE datname = $1 AND usename = $2`,
              [d.db, runtimeRole],
            ),
          )) as unknown as { application_name: string; state: string; query: string }[];
          const app = { n: appSessions.length };
          if (app.n > (samples.app.length === 0 ? -1 : Math.max(...samples.app))) {
            peakSessions = appSessions.map((x) => `${x.application_name}|${x.state}|${x.query}`);
          }
          const [sys] = (await asAdmin(baseUrl as string, d.db, (sql) =>
            sql.unsafe(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2`,
              [d.sysDb, sysRuntimeRole],
            ),
          )) as unknown as [{ n: number }];
          samples.app.push(app.n);
          samples.sys.push(sys.n);
          samples.rss.push(rssKiB(pid));
          samples.open.push(d.provider.open);
          await pause(200);
        }
      })();

      d.provider.mode = 'hold';
      const started = Date.now();
      // In-request runs, all at once: five times what one process admits.
      const sync = Array.from({ length: BOUNDS.syncRunsMax * 5 }, (_, i) =>
        request(d.base, '/v1/agents/echo/runs', { token, body: { input: `sync ${i}` } }).then(
          (res) => ({ ...res, endedAfter: Date.now() - started }),
        ),
      );
      // Queued runs, all at once: three times what the queue admits.
      const queued = await Promise.all(
        Array.from({ length: BOUNDS.queueMax * 3 }, (_, i) =>
          request(d.base, '/v1/agents/echo/runs', {
            token,
            body: { input: `queued ${i}`, async: true },
          }),
        ),
      );
      // Store traffic beside it, while every admitted run waits on the provider.
      const store = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? request(d.base, '/notes', { token, body: { body: `beside ${i}` } })
            : request(d.base, '/notes', { token }),
        ),
      );
      expect(store.map((r) => r.status).filter((s) => s !== 200 && s !== 201)).toEqual([]);
      // One queued run is cancelled while it waits.
      const accepted = queued.filter((r) => r.status === 202).map((r) => r.body.runId as string);
      const cancelled = accepted.at(-1) as string;
      const cancel = await request(d.base, `/v1/runs/${cancelled}/cancel`, { token, body: {} });
      expect([200, 202], cancel.text).toContain(cancel.status);

      const syncResults = await Promise.all(sync);

      // Admission: in-request runs beyond the process bound and queued runs beyond the queue bound are
      // refused with 429 and the queue-full reason, and only those.
      const syncRefused = syncResults.filter((r) => r.status === 429);
      const syncAdmitted = syncResults.filter((r) => r.status !== 429);
      expect(syncRefused.length).toBeGreaterThanOrEqual(
        syncResults.length - BOUNDS.syncRunsMax * 2,
      );
      for (const r of syncRefused) {
        expect(r.body.error?.details?.reason).toBe('queue-full');
        expect(r.headers.get('retry-after')).not.toBeNull();
      }
      expect(accepted.length).toBeLessThanOrEqual(BOUNDS.queueMax);
      expect(accepted.length).toBeGreaterThan(0);
      for (const r of queued.filter((x) => x.status !== 202)) {
        expect(r.status, r.text).toBe(429);
        expect(r.body.error?.details?.reason).toBe('queue-full');
      }
      // Every admitted in-request run ended with the timeout class within its wall time plus the tail.
      for (const r of syncAdmitted) {
        expect(r.status, r.text).toBeGreaterThanOrEqual(400);
        expect(r.endedAfter).toBeLessThan(BOUNDS.runMaxMs * 2 + END_TAIL_MS + 5_000);
      }

      // Every queued run ends: none is left running or waiting.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const [open] = (await d.admin((sql) =>
          sql.unsafe(`SELECT count(*)::int AS n FROM runs WHERE status IN ('enqueued', 'running')`),
        )) as unknown as [{ n: number }];
        if (open.n === 0) break;
        if (Date.now() > deadline) throw new Error(`${open.n} runs never ended\n${d.output()}`);
        await pause(500);
      }
      for (const runId of accepted) {
        const run = await request(d.base, `/v1/runs/${runId}`, { token });
        expect(run.status, run.text).toBe(200);
        expect(run.body).toMatchObject({
          status: 'error',
          errorClass: runId === cancelled ? 'cancelled' : 'timeout',
        });
      }
      // The provider holds nothing open once the runs have ended.
      const closedBy = Date.now() + 15_000;
      while (d.provider.open > 0 && Date.now() < closedBy) await pause(200);
      expect(d.provider.open).toBe(0);
      sampling = false;
      await sampler;

      // Database sessions never exceeded the pools the server opens on the application database.
      const maxApp = Math.max(...samples.app);
      const maxSys = Math.max(...samples.sys);
      process.stderr.write(
        `resource bounds: sessions at the peak\n  ${peakSessions.join('\n  ')}\n`,
      );
      expect(maxApp).toBeLessThanOrEqual(SERVING_POOL + WORKER_POOL + EVENT_LISTENER);
      expect(maxSys).toBeGreaterThan(0);
      // Memory: the peak stays within a fixed allowance over the baseline, and after the runs ended the
      // process is back near it (no request, run or provider call is retained).
      const peakKiB = Math.max(...samples.rss);
      const afterKiB = rssKiB(pid);
      expect(peakKiB - baselineKiB).toBeLessThan(300 * 1024);
      expect(afterKiB - baselineKiB).toBeLessThan(150 * 1024);
      // The provider never had more requests open than the runs that could be waiting on it.
      expect(Math.max(...samples.open)).toBeLessThanOrEqual(
        BOUNDS.syncRunsMax + BOUNDS.workerConcurrency,
      );
      process.stderr.write(
        `resource bounds: ${syncResults.length} in-request runs (${syncAdmitted.length} admitted, ` +
          `${syncRefused.length} refused), ${queued.length} queued (${accepted.length} admitted), ` +
          `app sessions max ${maxApp} (bound ${SERVING_POOL + WORKER_POOL + EVENT_LISTENER}), ` +
          `workflow sessions max ` +
          `${maxSys}, rss baseline ${baselineKiB} KiB peak ${peakKiB} KiB after ${afterKiB} KiB, ` +
          `provider requests ${d.provider.requests.length}, open max ${Math.max(...samples.open)}\n`,
      );
      armsRan += 1;
    }, 600_000);
  },
);
