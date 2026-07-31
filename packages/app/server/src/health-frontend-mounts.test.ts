/**
 * `/health` covers the declared frontend mounts — pure-unit proofs. No DB, no network, no secrets.
 *
 * Two probes are covered, both through the code the boots actually register:
 *   - the FULL platform's probe, via the shared registrar `registerHealthRoute` (the database
 *     round-trip is injected here as a resolving/rejecting stub, so the suite needs no Postgres);
 *   - the STATIC profile's probe, via the real `assembleStaticServer` over an mkdtemp fixture.
 *
 * Mount readiness is computed ONCE at boot (`frontendMountsReadiness`) and the probe answers from that
 * cached value, so a load balancer polling every second causes no filesystem work. That is asserted
 * twice: by counting every `node:fs` call made during repeated probe requests (must be zero), and
 * behaviourally, by deleting the mount directory after boot and observing the answer not change.
 *
 * The `node:fs` mock below wraps the REAL implementation (it only records the call name), so every
 * fixture write and every boot-time read behaves exactly as unmocked.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrontendSpec } from '@rayspec/spec';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assembleStaticServer,
  loadStaticServerConfig,
  registerHealthRoute,
} from './composition-root.js';
import { frontendMountsReadiness } from './serve-static.js';

/** Every `node:fs` call made through the mocked module, in order, by name. */
const fsCalls: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const recorded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    recorded[name] =
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            fsCalls.push(name);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return { ...recorded, default: recorded };
});

let root = ''; // the fixture root; each mount's `dir` is resolved relative to it

/** A servable spa mount: a readable directory that carries a readable `index.html`. */
const SPA_OK: FrontendSpec = { route: '/', dir: 'servable', spa: true };
/** A NON-servable spa mount: the directory is readable, but it carries no `index.html`. */
const SPA_NO_INDEX: FrontendSpec = { route: '/', dir: 'no-index', spa: true };
/** A plain (non-spa) mount over the same index-less directory — servable, it needs no `index.html`. */
const PLAIN_NO_INDEX: FrontendSpec = { route: '/', dir: 'no-index', spa: false };
/** A mount whose directory does not exist at all. */
const MISSING_DIR: FrontendSpec = { route: '/', dir: 'absent', spa: false };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-health-mounts-'));
  mkdirSync(join(root, 'servable'), { recursive: true });
  writeFileSync(join(root, 'servable', 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
  mkdirSync(join(root, 'no-index'), { recursive: true });
  writeFileSync(join(root, 'no-index', 'app.js'), 'export {};', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A database round-trip stub that succeeds — stands in for a reachable `select 1`. */
const dbReachable = async (): Promise<void> => {};
/** A database round-trip stub that throws — stands in for an unreachable database. */
const dbUnreachable = async (): Promise<void> => {
  throw new Error('connection refused');
};

/** A bare app carrying ONLY the shared `/health` registrar, as the full platform wires it. */
function fullPlatformApp(
  probeDatabase: () => Promise<void>,
  frontend: 'ok' | 'unavailable' | undefined,
): Hono {
  const app = new Hono();
  registerHealthRoute(app, probeDatabase, frontend);
  return app;
}

/** A real static boot over the fixture root, serving `mounts`. */
function staticApp(mounts: readonly FrontendSpec[]): Hono {
  return assembleStaticServer(loadStaticServerConfig({}), {
    specPath: join(root, 'rayspec.yaml'),
    frontend: mounts,
  }).app;
}

/** GET /health against `app`, returning the status code and the parsed body. */
async function probe(app: Hono): Promise<{ status: number; body: unknown }> {
  const res = await app.request('/health');
  return { status: res.status, body: await res.json() };
}

describe('frontendMountsReadiness — what "servable" means for a mount', () => {
  it("a readable directory whose index.html is readable is 'ok' for an spa mount", () => {
    expect(frontendMountsReadiness([SPA_OK], root)).toBe('ok');
  });

  it("an spa mount whose directory carries no index.html is 'unavailable'", () => {
    expect(frontendMountsReadiness([SPA_NO_INDEX], root)).toBe('unavailable');
  });

  it("a plain (non-spa) mount needs no index.html — the same directory is 'ok'", () => {
    expect(frontendMountsReadiness([PLAIN_NO_INDEX], root)).toBe('ok');
  });

  it("a mount whose directory does not exist is 'unavailable'", () => {
    expect(frontendMountsReadiness([MISSING_DIR], root)).toBe('unavailable');
  });

  it("an unreadable directory is 'unavailable' (stat alone would pass it)", (ctx) => {
    const dir = join(root, 'unreadable');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    // A process running as root traverses a mode-000 directory happily, which would make this arm
    // vacuous.
    if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip();
    try {
      expect(frontendMountsReadiness([{ route: '/', dir: 'unreadable', spa: false }], root)).toBe(
        'unavailable',
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("ONE non-servable mount among servable ones makes the whole set 'unavailable'", () => {
    expect(frontendMountsReadiness([SPA_OK, { ...SPA_NO_INDEX, route: '/admin' }], root)).toBe(
      'unavailable',
    );
  });

  it("an empty mount list is 'ok' (nothing declared, nothing to fail)", () => {
    expect(frontendMountsReadiness([], root)).toBe('ok');
  });
});

describe('the full platform probe — the database cases are unchanged', () => {
  it('a reachable database with NO declared mounts answers exactly 200 {status:ok, db:ok}', async () => {
    const { status, body } = await probe(fullPlatformApp(dbReachable, undefined));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('an unreachable database with NO declared mounts answers exactly 503 {status:degraded, db:unreachable}', async () => {
    const { status, body } = await probe(fullPlatformApp(dbUnreachable, undefined));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'unreachable' });
  });

  it('an unreachable database stays 503 {status:degraded, db:unreachable} when the mounts ARE servable', async () => {
    const { status, body } = await probe(fullPlatformApp(dbUnreachable, 'ok'));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'unreachable', frontend: 'ok' });
  });
});

describe('the full platform probe — a non-servable mount is reported', () => {
  it('servable mounts add frontend:ok and keep the 200', async () => {
    const { status, body } = await probe(fullPlatformApp(dbReachable, 'ok'));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'ok', frontend: 'ok' });
  });

  it('a non-servable mount answers 503, NOT 200, even though the database is reachable', async () => {
    const { status, body } = await probe(fullPlatformApp(dbReachable, 'unavailable'));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'ok', frontend: 'unavailable' });
  });

  it('a non-servable mount AND an unreachable database report both', async () => {
    const { status, body } = await probe(fullPlatformApp(dbUnreachable, 'unavailable'));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'unreachable', frontend: 'unavailable' });
  });
});

describe('the static profile probe', () => {
  it('a servable mount answers 200 {status:ok, frontend:ok} — still no db field', async () => {
    const { status, body } = await probe(staticApp([SPA_OK]));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', frontend: 'ok' });
  });

  it('a non-servable mount answers 503, NOT 200', async () => {
    const { status, body } = await probe(staticApp([SPA_NO_INDEX]));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', frontend: 'unavailable' });
  });

  it('the frontend mounts still serve — /health is not the only route', async () => {
    const res = await staticApp([SPA_OK]).request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });
});

describe('the probe performs no filesystem access per call', () => {
  // POSITIVE CONTROL for the two counts below: the counter really does observe the filesystem calls
  // this code makes, so an empty count there means "none were made", not "none were instrumented".
  it('the counter records the boot-time readiness check', () => {
    fsCalls.length = 0;
    expect(frontendMountsReadiness([SPA_OK], root)).toBe('ok');
    expect(fsCalls.length).toBeGreaterThan(0);
  });

  it('a static boot makes ZERO node:fs calls across 50 probe requests', async () => {
    const app = staticApp([SPA_OK]); // boot-time readiness + mount setup happen here
    fsCalls.length = 0;
    for (let i = 0; i < 50; i++) await probe(app);
    expect(fsCalls).toEqual([]);
  });

  it('the full platform probe makes ZERO node:fs calls across 50 probe requests', async () => {
    const app = fullPlatformApp(dbReachable, 'ok');
    fsCalls.length = 0;
    for (let i = 0; i < 50; i++) await probe(app);
    expect(fsCalls).toEqual([]);
  });

  it('the boot-time readiness is CACHED — deleting the mount directory does not change the answer', async () => {
    const doomedRoot = mkdtempSync(join(tmpdir(), 'rayspec-health-cached-'));
    mkdirSync(join(doomedRoot, 'servable'), { recursive: true });
    writeFileSync(join(doomedRoot, 'servable', 'index.html'), '<!doctype html>', 'utf8');
    const app = assembleStaticServer(loadStaticServerConfig({}), {
      specPath: join(doomedRoot, 'rayspec.yaml'),
      frontend: [SPA_OK],
    }).app;
    expect(await probe(app)).toEqual({ status: 200, body: { status: 'ok', frontend: 'ok' } });
    rmSync(doomedRoot, { recursive: true, force: true });
    expect(await probe(app)).toEqual({ status: 200, body: { status: 'ok', frontend: 'ok' } });
  });
});
