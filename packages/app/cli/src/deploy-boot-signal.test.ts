/**
 * `rayspec deploy` — a signal that lands DURING the boot must end the process.
 *
 * The same defect `packages/app/server/src/serve-boot-signal.test.ts` pins for `rayspec-serve`, on the
 * surface an operator actually runs. `deploy.ts` reaches `@rayspec/server` through a DYNAMIC import,
 * and that import installs two SIGTERM handlers it does not own — `@openai/agents-core`'s trace
 * provider and `signal-exit` — each of which acts ONLY when it is the sole listener. With both loaded
 * and no handler of the CLI's own, they defer to each other and the signal becomes a no-op. Measured:
 * `await import('@rayspec/server')` alone takes `process.listeners('SIGTERM').length` from 0 to 2.
 * Everything from that import to the shutdown registration — config load, assemble, the committed
 * migration chain, the product boot — was unkillable by SIGTERM, which under a process manager is a
 * container that hangs until SIGKILL.
 *
 * HERMETIC, NO DATABASE. `DATABASE_URL` points at a local TCP server that ACCEPTS the connection and
 * never answers, so the boot parks inside the database connect for as long as the case needs and
 * leaves nothing behind. Two facts are asserted before the signal so it cannot pass vacuously: the
 * child printed the pre-assemble progress line (it is inside `serveDeployment`, past the point where
 * the handlers are claimed), and nothing answers on its port (the boot has NOT completed).
 *
 * Moving the registration back below the assemble REDs both cases — the child then outlives the whole
 * budget and has to be SIGKILLed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The BUILT bin, spawned with the spec directory as cwd — the shape `deploy-apply-migration.db.test.ts`
 * established, and the only one that works here: `resolveSpecPath` jails the spec inside the process's
 * working directory, so the child has to run FROM the spec's directory, which in turn rules out
 * `--import tsx` (tsx would no longer resolve from that tmp cwd). Requires `pnpm build`, like the other
 * CLI acceptance suites.
 */
const CLI_DIST = resolve(here, '..', 'dist', 'index.js');

/** How long the child gets to be gone after the signal. A working abort takes milliseconds. */
const EXIT_BUDGET_MS = 20_000;
/** How long to wait for the child to reach the pre-assemble progress line. */
const BOOTING_BUDGET_MS = 90_000;

/** A minimal AGENT-FREE backend: one store, one read route. Enough to reach the database connect. */
const SPEC = `version: '1.0'
metadata:
  name: boot-signal-backend
  description: A minimal agent-free backend for the boot-signal acceptance.
stores:
  - name: parts
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/parts', action: { kind: store, store: parts, op: list } }
`;

/** A TCP server that accepts and never replies — the boot's database connect parks on it forever. */
function stallServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    // Held open and answered with nothing. A reset would let the client fail fast, which is the
    // opposite of the window this case needs.
    sockets.push(socket);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        fail(new Error('the stall server did not bind a TCP port'));
        return;
      }
      done({ server, port: addr.port, sockets });
    });
  });
}

/** A free loopback port for the child's HTTP listener (which it must never reach). */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        fail(new Error('could not reserve a loopback port'));
        return;
      }
      const { port } = addr;
      probe.close(() => done(port));
    });
  });
}

let stall: Awaited<ReturnType<typeof stallServer>>;
let specDir = '';
let specFile = '';
let jwtKey = '';

beforeAll(async () => {
  stall = await stallServer();
  specDir = mkdtempSync(join(tmpdir(), 'rayspec-boot-signal-'));
  specFile = resolve(specDir, 'rayspec.yaml');
  writeFileSync(specFile, SPEC, 'utf8');
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  jwtKey = await exportPKCS8(privateKey);
}, 60_000);

afterAll(async () => {
  for (const socket of stall.sockets) socket.destroy();
  await new Promise((done) => stall.server.close(done));
  if (specDir) rmSync(specDir, { recursive: true, force: true });
});

interface BootedChild {
  readonly child: ChildProcess;
  readonly port: number;
  output(): string;
  exitCode(): number | null | undefined;
}

/** Spawn the real CLI against the stall server and wait until it is inside the boot. */
async function spawnMidBoot(): Promise<BootedChild> {
  const port = await freePort();
  // `node <dist>` directly, never the `rayspec` bin wrapper: a wrapper process does not forward
  // SIGTERM to the node process it spawns, so `child.kill()` would signal the wrapper and prove
  // nothing about deploy.ts.
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', 'rayspec.yaml'], {
    cwd: specDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RAYSPEC_SKIP_DOTENV: '1',
      DATABASE_URL: `postgres://stall:stall@127.0.0.1:${stall.port}/stall`,
      RAYSPEC_API_KEY_PEPPER: 'boot-signal-suite-pepper-not-a-secret',
      RAYSPEC_JWT_SIGNING_KEY: jwtKey,
      // Well above the budget below: the boot timeout must NEVER be what ends this child, or the
      // case would pass on a mechanism that has nothing to do with the signal.
      RAYSPEC_BOOT_TIMEOUT_MS: '600000',
      PORT: String(port),
    },
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => {
    output += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    output += d.toString();
  });
  let exited: number | null | undefined;
  child.on('exit', (code) => {
    exited = code;
  });

  const marker = '[rayspec deploy] booting';
  const deadline = Date.now() + BOOTING_BUDGET_MS;
  while (Date.now() < deadline && exited === undefined && !output.includes(marker)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!output.includes(marker)) {
    child.kill('SIGKILL');
    throw new Error(
      `the CLI never reached its boot phase (exit=${String(exited)}):\n${output.slice(-4000)}`,
    );
  }
  return { child, port, output: () => output, exitCode: () => exited };
}

/** Signal the child and resolve with its exit code, or `-1` if it outlived the budget. */
async function signalAndAwaitExit(
  child: ChildProcess,
  signal: 'SIGINT' | 'SIGTERM',
): Promise<number | null> {
  child.kill(signal);
  const code = await Promise.race([
    new Promise<number | null>((done) => child.on('exit', (c) => done(c))),
    new Promise<number | null>((done) => setTimeout(() => done(-1), EXIT_BUDGET_MS)),
  ]);
  if (code === -1) {
    child.kill('SIGKILL');
    await new Promise((done) => child.on('exit', done));
  }
  return code;
}

describe('rayspec deploy — a signal during the boot window still ends the process', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} aborts a deploy boot that has not started listening`, async () => {
      const booted = await spawnMidBoot();

      // The window is REAL, not assumed: the child is inside the boot (its progress line is out) and
      // its port answers nothing, so the assemble step has not returned.
      expect(booted.exitCode(), 'the child is still running when it is signalled').toBeUndefined();
      await expect(fetch(`http://127.0.0.1:${booted.port}/health`)).rejects.toThrow();

      const code = await signalAndAwaitExit(booted.child, signal);
      expect(
        code,
        `${signal} during the boot window left the process alive (-1 means it outlived ${EXIT_BUDGET_MS}ms and was SIGKILLed):\n${booted.output().slice(-2000)}`,
      ).toBe(0);
      expect(booted.output()).toContain(
        `[rayspec deploy] ${signal} received during boot — aborting before the server listens.`,
      );
    }, 180_000);
  }
});
