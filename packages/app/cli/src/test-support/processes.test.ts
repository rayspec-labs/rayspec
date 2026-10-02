/**
 * The process registry the spawning suites stop their children through, against real child
 * processes: a child that ends on SIGTERM, one that ignores it, and a port from `freePort` that a
 * server can bind.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, SpawnedProcesses } from './processes.js';

const processes = new SpawnedProcesses();
afterEach(() => processes.stopAll(1_000));

/** A node child that prints `ready` once its SIGTERM handling is in place, then idles. */
function idle(ignoreSigterm: boolean) {
  const code = `${ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
setInterval(() => {}, 1000); process.stdout.write('ready');`;
  const child = processes.track(spawn(process.execPath, ['-e', code], { stdio: 'pipe' }));
  const ready = new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  return { child, ready };
}

describe('SpawnedProcesses', () => {
  it('stops a child that ends on SIGTERM', async () => {
    const { child, ready } = idle(false);
    await ready;
    expect(processes.running).toBe(1);
    await processes.stopAll(5_000);
    expect(child.signalCode).toBe('SIGTERM');
    expect(processes.running).toBe(0);
  });

  it('kills a child that ignores SIGTERM once the grace has passed', async () => {
    const { child, ready } = idle(true);
    await ready;
    const started = Date.now();
    await processes.stopAll(300);
    expect(child.signalCode).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(processes.running).toBe(0);
  });

  it('forgets a child that exited on its own', async () => {
    const child = processes.track(spawn(process.execPath, ['-e', 'process.exit(0)']));
    await new Promise((resolve) => child.once('exit', resolve));
    expect(processes.running).toBe(0);
    await processes.stopAll(100);
  });
});

describe('freePort', () => {
  it('hands out a port a server can bind, and a different one per call while it is held', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    try {
      expect(await freePort()).not.toBe(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
