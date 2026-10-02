/**
 * The process registry the spawning suites stop their children through, against real child
 * processes: a child that ends on SIGTERM, one that ignores it, and a port from `freePort` that a
 * server can bind. The last check holds every spawning suite of the package, and the repository's
 * upgrade script, to ports the operating system hands out.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, freePorts, SpawnedProcesses } from './processes.js';

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

describe('freePorts', () => {
  it('hands out as many different ports as asked for, each one a server can bind', async () => {
    const ports = await freePorts(5);
    expect(ports).toHaveLength(5);
    expect(new Set(ports).size).toBe(5);
    const servers = ports.map(() => createServer());
    try {
      await Promise.all(
        servers.map(
          (server, i) =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(ports[i], '127.0.0.1', () => resolve());
            }),
        ),
      );
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) =>
              server.listening ? server.close(() => resolve()) : resolve(),
            ),
        ),
      );
    }
  });
});

describe('ports of the spawning suites', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = resolve(here, '..');
  const repoRoot = resolve(here, '../../../../..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
    });
  }

  // A port computed from the process id: `18080 + (process.pid % 2000)` and its variants.
  const derivedPort = /\d[\d_]*\s*\+\s*\(+\s*process\.pid\b|process\.pid\s*[%+]\s*\d/;

  it('no suite of this package, and no repository script, derives a port from the process id', () => {
    // This file is left out: it spells the forms out to test the check itself.
    const self = fileURLToPath(import.meta.url);
    const files = [
      ...sources(sourceRoot).filter((file) => file !== self),
      join(repoRoot, 'scripts', 'upgrade-with-data.mjs'),
    ];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((file) => derivedPort.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it('the check recognizes the forms it guards against', () => {
    for (const form of [
      'const PORT = 18080 + (process.pid % 2000);',
      'const PORT = 18080 + ((process.pid + 733) % 2000);',
      'const PORT = 19_100 + (process.pid % 1500);',
      'Number(flags.port ?? 18_600 + (process.pid % 900))',
    ]) {
      expect(derivedPort.test(form), form).toBe(true);
    }
    // A database name that carries the process id is not a port.
    expect(
      derivedPort.test(['const SUITE_DB = `rayspec_cli_deploy_$', '{process.pid}`;'].join('')),
    ).toBe(false);
  });
});
