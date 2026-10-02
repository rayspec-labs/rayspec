/**
 * The child processes a suite spawns, and the ports they listen on.
 *
 * A port is one the operating system hands out for the moment (`listen(0)`), never one derived from
 * the process id: two runs, or a server left over from an earlier run, can hold a derived port, and a
 * child that cannot bind it fails in a way that looks like the behaviour under test.
 *
 * Every child a suite starts is handed to a {@link SpawnedProcesses}, and the suite stops them all
 * after each test, whatever the test's outcome: a test that fails half way must not leave a server
 * running past the suite (one found holding its port a day later broke a later run).
 */
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** A TCP port on 127.0.0.1 that nothing listens on at the moment of the call. */
export async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  return port as number;
}

/**
 * `count` different TCP ports on 127.0.0.1 that nothing listens on at the moment of the call. All of
 * them are held at once before any is released, so no two are the same port: two separate
 * {@link freePort} calls may be handed the same one back.
 */
export async function freePorts(count: number): Promise<number[]> {
  const probes = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(
      probes.map(
        (probe) =>
          new Promise<number>((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => {
              const address = probe.address();
              const port = typeof address === 'object' && address !== null ? address.port : 0;
              if (port > 0) resolve(port);
              else reject(new Error('no port was assigned'));
            });
          }),
      ),
    );
  } finally {
    await Promise.all(
      probes.map(
        (probe) =>
          new Promise<void>((resolve) =>
            probe.listening ? probe.close(() => resolve()) : resolve(),
          ),
      ),
    );
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exited(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** The children a suite started, stopped together. */
export class SpawnedProcesses {
  readonly #children = new Set<ChildProcess>();

  /** Hold `child` until it exits or {@link stopAll} stops it. Returns it, for chaining. */
  track(child: ChildProcess): ChildProcess {
    this.#children.add(child);
    child.once('exit', () => this.#children.delete(child));
    return child;
  }

  /** How many tracked children have not exited. */
  get running(): number {
    return [...this.#children].filter((child) => !hasExited(child)).length;
  }

  /**
   * Stop every tracked child: SIGTERM, then SIGKILL for one still running after `graceMs`. Resolves
   * once every one of them has exited.
   */
  async stopAll(graceMs = 5_000): Promise<void> {
    const live = [...this.#children].filter((child) => !hasExited(child));
    for (const child of live) child.kill('SIGTERM');
    await Promise.all(
      live.map(async (child) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const killed = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!hasExited(child)) child.kill('SIGKILL');
            resolve();
          }, graceMs);
        });
        await Promise.race([exited(child), killed]);
        if (timer !== undefined) clearTimeout(timer);
        await exited(child);
      }),
    );
    this.#children.clear();
  }
}
