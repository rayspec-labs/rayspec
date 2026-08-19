/**
 * A SIGTERM that lands DURING the boot must end the process — the pod-killed-mid-boot case.
 *
 * WHY THIS NEEDS A REAL PROCESS. Node's default action for SIGINT/SIGTERM is to terminate, so an
 * entrypoint that registers nothing looks safe. It is not, and cannot be reasoned about from
 * `serve.ts` alone: by the time `main()` runs, two TRANSITIVE dependencies have already registered
 * handlers of their own, and they mutually defer —
 *
 *   - `@openai/agents-core`'s trace provider (dist/tracing/provider.mjs) flushes and then exits ONLY
 *     `if (!hasOtherListenersForSignals('SIGTERM'))` — i.e. only when it is the sole listener;
 *   - `signal-exit`'s listener removes itself and re-raises the signal ONLY when it is the sole
 *     listener.
 *
 * Two listeners, each waiting for the other to act, and the signal is a NO-OP. Measured: a probe
 * importing exactly `serve.ts`'s top-level graph shows `process.listeners('SIGTERM').length` going
 * 0 -> 2 the instant `composition-root.js` finishes evaluating; signalled before that it exits 143
 * (the default), after it the process survives to SIGKILL. `example-dev-boot-shutdown.db.test.ts`
 * records the same mutual deference from the `examples/<slug>/dev-boot.mjs` side.
 *
 * So the property under test is exactly: BEFORE the server is listening, a termination signal still
 * ends the process. Moving `serve.ts`'s registration back below the awaited assemble step REDs both
 * cases here — the child then survives the whole budget and is SIGKILLed.
 *
 * THE ARMING IS HERMETIC AND NEEDS NO DATABASE. `DATABASE_URL` points at a local TCP server that
 * ACCEPTS the connection and never answers, so the boot parks inside `assembleServer`'s database
 * connect for as long as the test needs, with nothing to clean up afterwards. Two facts are asserted
 * before the signal so the case can never pass vacuously: the child printed its pre-assemble
 * progress line (it is inside `main()`), and nothing is listening on its PORT (the boot has NOT
 * completed).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SERVE = join(here, 'serve.ts');

/** How long the child gets to be gone after the signal. A working abort takes milliseconds. */
const EXIT_BUDGET_MS = 20_000;
/** How long to wait for the child to reach `main()`'s progress line. */
const BOOTING_BUDGET_MS = 60_000;

/** A TCP server that accepts and never replies — the boot's database connect parks on it forever. */
function stallServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    // Hold the socket open and say nothing. Never destroy it: a reset would let the client fail
    // fast, which is the opposite of the window this test needs.
    sockets.push(socket);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('the stall server did not bind a TCP port'));
        return;
      }
      resolve({ server, port: addr.port, sockets });
    });
  });
}

/** A free loopback port for the child's HTTP listener (which it must never reach). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not reserve a loopback port'));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

let stall: Awaited<ReturnType<typeof stallServer>>;
let jwtKey = '';

beforeAll(async () => {
  stall = await stallServer();
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  jwtKey = await exportPKCS8(privateKey);
}, 60_000);

afterAll(async () => {
  for (const socket of stall.sockets) socket.destroy();
  await new Promise((resolve) => stall.server.close(resolve));
});

interface BootedChild {
  readonly child: ChildProcess;
  readonly port: number;
  output(): string;
  exitCode(): number | null | undefined;
}

/** Spawn the shipped entrypoint against the stall server and wait until it is inside `main()`. */
async function spawnMidBoot(): Promise<BootedChild> {
  const port = await freePort();
  // `node --import tsx <file>` and NOT the `tsx` bin: the bin is a wrapper process that does not
  // forward SIGTERM to the node process it spawns, so `child.kill()` would signal the wrapper and
  // prove nothing about serve.ts. (The same reason serve-workforce-flag.db.test.ts spawns this way.)
  const child = spawn(process.execPath, ['--import', 'tsx', SERVE], {
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

  const deadline = Date.now() + BOOTING_BUDGET_MS;
  while (
    Date.now() < deadline &&
    exited === undefined &&
    !output.includes('[rayspec-serve] booting')
  )
    await new Promise((r) => setTimeout(r, 100));
  if (!output.includes('[rayspec-serve] booting')) {
    child.kill('SIGKILL');
    throw new Error(
      `the child never reached main() (exit=${String(exited)}):\n${output.slice(-4000)}`,
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
    new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c))),
    new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), EXIT_BUDGET_MS)),
  ]);
  if (code === -1) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  }
  return code;
}

describe('rayspec-serve — a signal during the boot window still ends the process', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} aborts a boot that has not started listening`, async () => {
      const booted = await spawnMidBoot();

      // The window is REAL, not assumed: the child is inside main() (its progress line is out) and
      // its HTTP port answers nothing, so the assemble step has not returned.
      expect(booted.exitCode(), 'the child is still running when it is signalled').toBeUndefined();
      await expect(fetch(`http://127.0.0.1:${booted.port}/health`)).rejects.toThrow();

      const code = await signalAndAwaitExit(booted.child, signal);
      expect(
        code,
        `${signal} during the boot window left the process alive (-1 means it outlived ${EXIT_BUDGET_MS}ms and was SIGKILLed):\n${booted.output().slice(-2000)}`,
      ).toBe(0);
      expect(booted.output()).toContain(
        `[rayspec-serve] ${signal} received during boot — aborting before the server listens.`,
      );
    }, 120_000);
  }
});
