/**
 * `rayspec deploy` — WHAT AN OPERATOR SEES when the port is already taken.
 *
 * This is a boot failure the CLI could not refuse: `serve()` returns while the bind is still
 * pending (immediately after the call `server.listening` is false and `server.address()` is null), so
 * `serveDeployment` resolves, the caller believes the deployment is served, and the EADDRINUSE lands
 * afterwards as an unhandled `'error'` event — a raw `node:events` stack, after the boot has already
 * connected to the database and applied migrations.
 *
 * So this suite binds for real. `@hono/node-server` is NOT stubbed here (the sibling deploy suites
 * stub it precisely so nothing binds); a `net` server occupies a loopback port first and stays open
 * for the whole case, and the deploy boots against exactly that port. Only `assembleServer` is
 * replaced — running it for real would need a database — and, unlike the boot-refusal suite next
 * door, it RETURNS: the failure under test happens after a successful assemble, not instead of one.
 *
 * The refusal WORDING belongs to @rayspec/server (bind-refusal.ts) and is pinned there by equality;
 * what this file proves is that the deploy path reaches it at all, on a real collision, and exits 1.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@rayspec/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/server')>();
  // Everything else stays REAL — the static-profile detection, both config loaders, the static boot
  // and `attachBindRefusal` itself. Only the DB-requiring assemble step is replaced, and it returns a
  // booted-looking server so the deploy reaches its listener.
  return {
    ...actual,
    assembleServer: async () => ({
      app: { fetch: () => new Response('ok') },
      close: async () => {},
    }),
  };
});
// Only the SEAL is stubbed: sealing the store chokepoint for real would shut it for the whole worker.
vi.mock('@rayspec/db/composition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rayspec/db/composition')>()),
  sealProductStores: () => {},
}));

import { serveDeployment } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
/** A committed PRODUCT document — the shape that takes the normal (secret-requiring) boot. */
const ACME_SPEC = join(repoRoot, 'examples/acme-notes/acme-notes.product.yaml');

/** Dummy boot secrets: `loadServerConfig` shape-checks them; the stubbed assemble never uses them. */
const DUMMY_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
};

/**
 * The refusal `rayspec deploy` prints for a taken port, written out here rather than imported from
 * the helper that builds it — an assertion that leans on the code under test proves nothing about the
 * wording. Names the CLI's own knobs: `rayspec deploy --port` writes PORT and `--host` writes
 * RAYSPEC_HOST, so both spellings are actionable on this entrypoint.
 */
const refusalLine = (port: number): string =>
  `[rayspec deploy] Boot aborted — 127.0.0.1:${port} is already in use. Another process is ` +
  'listening on that address, so this boot cannot bind it: find the holder with ' +
  `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` (macOS/Linux) and stop it, or serve on a free port with ` +
  '--port <n> or PORT=<n> (--host <addr> or RAYSPEC_HOST=<addr> moves the bind to another address). ' +
  'Fail-closed.\n';

/** A frontend-only project, so the STATIC boot path (no database, no auth surface) can be driven too. */
let staticRoot = '';
beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'rayspec-cli-bind-refusal-'));
  mkdirSync(join(staticRoot, 'web', 'dist'), { recursive: true });
  writeFileSync(join(staticRoot, 'web', 'dist', 'index.html'), '<!doctype html><title>ui</title>');
  writeFileSync(
    join(staticRoot, 'rayspec.yaml'),
    "version: '1.0'\nmetadata:\n  name: bind-refusal-ui\nfrontend:\n  - { route: /, dir: web/dist, spa: true }\n",
    'utf8',
  );
});
afterAll(() => {
  if (staticRoot) rmSync(staticRoot, { recursive: true, force: true });
});

const TOUCHED = [...Object.keys(DUMMY_ENV), 'RAYSPEC_SPEC_PATH', 'PORT', 'RAYSPEC_HOST'];
let saved: Record<string, string | undefined>;
let signalsBefore: { SIGINT: number; SIGTERM: number };

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  for (const [k, v] of Object.entries(DUMMY_ENV)) process.env[k] = v;
  signalsBefore = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // A boot that got as far as its listener also installed shutdown handlers; drop the ones this case
  // added so the suite leaves the process as it found it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const added = process.listeners(signal).slice(signalsBefore[signal]);
    for (const listener of added) process.removeListener(signal, listener as () => void);
  }
});

/** Occupy a loopback port and keep it open — the collision the boot below must refuse. */
async function occupyLoopbackPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const squatter = net.createServer();
  await new Promise<void>((ready) => {
    squatter.listen(0, '127.0.0.1', ready);
  });
  const { port } = squatter.address() as net.AddressInfo;
  return {
    port,
    release: () =>
      new Promise<void>((done) => {
        squatter.close(() => done());
      }),
  };
}

/**
 * Boot `spec` against `port` and return the stderr + exit code the collision produced.
 *
 * The wait is the point: `serveDeployment` RESOLVES before the bind has failed, so awaiting it proves
 * nothing. We await the stubbed `process.exit` instead, bounded — a boot that never refuses fails
 * here with a named timeout rather than hanging the suite.
 */
async function bindRefusal(
  spec: string,
  port: number,
): Promise<{ stderr: string; exitCode: number | undefined }> {
  const written: string[] = [];
  // console.error formats its arguments exactly like this and appends the newline — reassembling both
  // is what makes the equality below an assertion about the operator's stderr rather than a substring.
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    written.push(`${format(...args)}\n`);
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let exitCode: number | undefined;
  let exited: () => void = () => {};
  const refused = new Promise<void>((r) => {
    exited = r;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    exited();
  }) as never);
  let timer: NodeJS.Timeout | undefined;
  try {
    await serveDeployment(spec, String(port));
    await Promise.race([
      refused,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no bind refusal arrived within 10s')), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    errSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stderr: written.join(''), exitCode };
}

describe('rayspec deploy — a port already in use refuses the boot instead of crashing', () => {
  it('the normal boot names the address, the holder lookup and the knob, and exits 1', async () => {
    const { port, release } = await occupyLoopbackPort();
    try {
      const { stderr, exitCode } = await bindRefusal(ACME_SPEC, port);
      expect(stderr).toBe(refusalLine(port));
      expect(exitCode).toBe(1);
      // Restated as the operator reads it: one line, no frames, and no raw syscall vocabulary.
      // Implied by the equality above; spelled out so a weakened equality still REDs.
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(stderr).not.toContain('EADDRINUSE');
      expect(stderr).not.toContain("Unhandled 'error' event");
    } finally {
      await release();
    }
  });

  it('the static-profile boot refuses identically (it binds before any secret is read)', async () => {
    const { port, release } = await occupyLoopbackPort();
    try {
      const { stderr, exitCode } = await bindRefusal(join(staticRoot, 'rayspec.yaml'), port);
      expect(stderr).toBe(refusalLine(port));
      expect(exitCode).toBe(1);
    } finally {
      await release();
    }
  });
});

// A source-level guard for the WIRING, in the shape deploy.test.ts already uses on this file. The two
// cases above drive both of deploy.ts's listeners today; this keeps a THIRD one from being added
// without a refusal — a successful bind emits no `'error'`, so no boot test can notice the omission.
describe('deploy.ts — every listener it creates carries the bind refusal', () => {
  const src = readFileSync(join(here, 'deploy.ts'), 'utf8');
  // Strip comments so the counts read the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('attaches one attachBindRefusal per serve() call, on both boot paths', () => {
    const listeners = code.match(/=\s*serve\(/g) ?? [];
    const refusals = code.match(/attachBindRefusal\(/g) ?? [];
    expect(listeners).toHaveLength(2); // the static-profile boot + the normal boot
    expect(refusals).toHaveLength(listeners.length);
  });
});
