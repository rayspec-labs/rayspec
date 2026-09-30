/**
 * Liveness and readiness, without a database: the probes of `health.ts` and the two routes a boot
 * registers through `registerHealthRoute`.
 *
 *  - `/livez` answers 200 whatever the dependencies say; `/health` answers 503 as soon as one check
 *    fails and names each check with its boolean — never its cause.
 *  - The static profile, really assembled: a mount that cannot be served makes `/health` 503 with
 *    `checks.assets` false while `/livez` stays 200.
 *  - The mounted-secret check reads nothing but the file's presence; the worker checks report a
 *    stopped worker and an unreachable system database; a probe that hangs counts as failed after the
 *    bound instead of hanging the probe.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleStaticServer,
  loadStaticServerConfig,
  registerHealthRoute,
} from './composition-root.js';
import {
  bindingsProbe,
  durableWorkerReadiness,
  type ReadinessProbe,
  runReadiness,
  staticProbe,
} from './health.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-health-'));
  mkdirSync(join(root, 'no-index'), { recursive: true });
  writeFileSync(join(root, 'no-index', 'app.js'), 'export {};', 'utf8');
  writeFileSync(join(root, 'secret'), 'a-secret-value', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function get(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

describe('the routes', () => {
  it('reports every check by name and boolean, 200 when all pass', async () => {
    const app = new Hono();
    registerHealthRoute(app, async () => {}, undefined, [
      staticProbe('schema', null),
      staticProbe('worker', null),
    ]);
    expect(await get(app, '/health')).toEqual({
      status: 200,
      body: {
        status: 'ok',
        db: 'ok',
        live: true,
        ready: true,
        checks: { database: true, schema: true, worker: true },
      },
    });
    expect(await get(app, '/livez')).toEqual({ status: 200, body: { live: true } });
  });

  it('answers 503 for one failing check, without its cause, while liveness stays 200', async () => {
    const app = new Hono();
    registerHealthRoute(app, async () => {}, undefined, [
      staticProbe('schema', null),
      staticProbe('bindings', 'a mounted secret is no longer readable: SOME_FILE'),
    ]);
    const health = await get(app, '/health');
    expect(health.status).toBe(503);
    expect(health.body).toEqual({
      status: 'degraded',
      db: 'ok',
      live: true,
      ready: false,
      checks: { database: true, schema: true, bindings: false },
    });
    expect(JSON.stringify(health.body)).not.toContain('SOME_FILE');
    expect((await get(app, '/livez')).status).toBe(200);
  });

  it('keeps liveness 200 when the database is down', async () => {
    const app = new Hono();
    registerHealthRoute(
      app,
      async () => {
        throw new Error('connection refused');
      },
      undefined,
    );
    expect((await get(app, '/health')).body).toMatchObject({
      db: 'unreachable',
      ready: false,
      checks: { database: false },
    });
    expect((await get(app, '/livez')).status).toBe(200);
  });

  it('a static boot with an unservable mount is not ready, and is live', async () => {
    const app = assembleStaticServer(loadStaticServerConfig({}), {
      specPath: join(root, 'rayspec.yaml'),
      frontend: [{ route: '/', dir: 'no-index', spa: true, cleanUrls: false }],
    }).app;
    const health = await get(app, '/health');
    expect(health.status).toBe(503);
    expect(health.body).toEqual({
      status: 'degraded',
      frontend: 'unavailable',
      live: true,
      ready: false,
      checks: { assets: false },
    });
    expect(await get(app, '/livez')).toEqual({ status: 200, body: { live: true } });
  });
});

describe('the probes', () => {
  it('bindings: fine while each mounted secret is a readable file, names the variable when not', async () => {
    const present = bindingsProbe([{ variable: 'X_FILE', path: join(root, 'secret') }]);
    expect(await present.check()).toBeNull();
    const gone = bindingsProbe([
      { variable: 'B_FILE', path: join(root, 'missing') },
      { variable: 'A_FILE', path: join(root, 'no-index') },
      { variable: 'X_FILE', path: join(root, 'secret') },
    ]);
    const detail = await gone.check();
    expect(detail).toBe('a mounted secret is no longer readable: A_FILE, B_FILE');
    expect(detail).not.toContain(root);
  });

  it('worker: a stopped worker and an unreachable system database fail their checks', async () => {
    const stopped = durableWorkerReadiness({
      running: false,
      status: async () => {
        throw new Error('ECONNREFUSED 10.0.0.7:5432');
      },
    });
    const checks = await runReadiness(stopped);
    expect(checks).toEqual([
      { name: 'worker', ok: false, detail: 'the durable worker is not running' },
      {
        name: 'workflow-system-database',
        ok: false,
        detail: 'the workflow system database could not be reached',
      },
    ]);
    const running = await runReadiness(
      durableWorkerReadiness({ running: true, status: async () => 'unknown' }),
    );
    expect(running.every((c) => c.ok)).toBe(true);
  });

  it('a probe that hangs fails after the bound; one that throws fails without its message', async () => {
    const hanging: ReadinessProbe = { name: 'worker', check: () => new Promise(() => {}) };
    const throwing: ReadinessProbe = {
      name: 'schema',
      check: async () => {
        throw new Error('password=hunter2');
      },
    };
    const started = Date.now();
    const checks = await runReadiness([hanging, throwing], 100);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(checks).toEqual([
      { name: 'worker', ok: false, detail: 'the check did not answer in time' },
      { name: 'schema', ok: false, detail: 'the check failed' },
    ]);
  });
});
