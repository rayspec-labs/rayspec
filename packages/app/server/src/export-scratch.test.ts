/**
 * The scratch space of an export: one export at a time per deployment, and what a killed export left
 * — its capture directory with the plaintext in it — removed by the next one, which learns whose it
 * was. A lock whose process still runs is never broken.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  openStateDirectory,
  type StateDirectory,
  StateDirectoryError,
} from './deployment-state.js';
import {
  clearInterruptedExportScratch,
  EXPORT_LOCK_NAME,
  takeExportScratch,
} from './export-scratch.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function stateDir(): Promise<StateDirectory> {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-export-scratch-'));
  dirs.push(root);
  const dir = await openStateDirectory(join(root, 'state'), { create: true });
  if (dir === null) throw new Error('no state directory');
  return dir;
}

/** The pid of a process that has exited, so its lock is stale. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(child.stdout);
}

describe('takeExportScratch', () => {
  it('creates scratch/ with mode 0700, holds the lock, and leaves nothing once released', async () => {
    const dir = await stateDir();
    const scratch = await takeExportScratch(dir, randomUUID());
    expect(scratch.dir).toBe(join(dir.root, 'scratch'));
    expect(statSync(scratch.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(scratch.dir, EXPORT_LOCK_NAME)).mode & 0o777).toBe(0o600);
    expect(scratch.cleanedUpAfter).toBeNull();
    mkdirSync(join(scratch.dir, 'rayspec-snapshot-abc'), { mode: 0o700 });
    writeFileSync(join(scratch.dir, 'rayspec-snapshot-abc', 'snapshot.zip'), 'plaintext');
    await scratch.release();
    expect(readdirSync(scratch.dir)).toEqual([]);
  });

  it('refuses a second export while the first one runs', async () => {
    const dir = await stateDir();
    const first = await takeExportScratch(dir, randomUUID());
    // The lock of another live process: a child that waits until it is killed.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      writeFileSync(
        join(first.dir, EXPORT_LOCK_NAME),
        JSON.stringify({ pid: child.pid, operationId: randomUUID() }),
      );
      const refused = await takeExportScratch(dir, randomUUID()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(StateDirectoryError);
      expect((refused as StateDirectoryError).error.code).toBe('RAY_LOCK_TIMEOUT');
      expect(readdirSync(first.dir)).toEqual([EXPORT_LOCK_NAME]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('removes what a killed export left and names it, then holds the lock itself', async () => {
    const dir = await stateDir();
    const scratchDir = await dir.scratchDirectory();
    const killed = randomUUID();
    writeFileSync(
      join(scratchDir, EXPORT_LOCK_NAME),
      JSON.stringify({ pid: deadPid(), operationId: killed }),
    );
    mkdirSync(join(scratchDir, 'rayspec-snapshot-left'), { mode: 0o700 });
    writeFileSync(join(scratchDir, 'rayspec-snapshot-left', 'database.dump'), 'rows');
    // A directory the owner cannot write is removed too, with the plaintext inside it.
    const sealed = join(scratchDir, 'rayspec-snapshot-left', 'sealed');
    mkdirSync(sealed, { mode: 0o700 });
    writeFileSync(join(sealed, 'objects.bin'), 'bytes of an upload');
    chmodSync(sealed, 0o500);

    const mine = randomUUID();
    const scratch = await takeExportScratch(dir, mine);
    expect(scratch.cleanedUpAfter).toBe(killed);
    expect(scratch.removedEntries).toBe(1);
    expect(readdirSync(scratchDir)).toEqual([EXPORT_LOCK_NAME]);
    await scratch.release();
    expect(readdirSync(scratchDir)).toEqual([]);
  });
});

describe('clearInterruptedExportScratch', () => {
  it('removes what a killed export left, names it, and holds no lock afterwards', async () => {
    const dir = await stateDir();
    const scratchDir = await dir.scratchDirectory();
    const killed = randomUUID();
    writeFileSync(
      join(scratchDir, EXPORT_LOCK_NAME),
      JSON.stringify({ pid: deadPid(), operationId: killed }),
    );
    mkdirSync(join(scratchDir, 'rayspec-snapshot-left'), { mode: 0o700 });
    writeFileSync(join(scratchDir, 'rayspec-snapshot-left', 'objects.bin'), 'bytes of an upload');

    const cleared = await clearInterruptedExportScratch(dir, randomUUID());
    expect(cleared).toEqual({ cleanedUpAfter: killed, removedEntries: 1, exportRunning: false });
    expect(readdirSync(scratchDir)).toEqual([]);
    // A later export takes the scratch space without finding anything to clean up.
    const next = await takeExportScratch(dir, randomUUID());
    expect(next.cleanedUpAfter).toBeNull();
    await next.release();
  });

  it('leaves the scratch directory of a running export alone', async () => {
    const dir = await stateDir();
    const scratchDir = await dir.scratchDirectory();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const running = randomUUID();
      writeFileSync(
        join(scratchDir, EXPORT_LOCK_NAME),
        JSON.stringify({ pid: child.pid, operationId: running }),
      );
      mkdirSync(join(scratchDir, 'rayspec-snapshot-live'), { mode: 0o700 });
      const cleared = await clearInterruptedExportScratch(dir, randomUUID());
      expect(cleared).toEqual({ cleanedUpAfter: null, removedEntries: 0, exportRunning: true });
      expect(readdirSync(scratchDir).sort()).toEqual([EXPORT_LOCK_NAME, 'rayspec-snapshot-live']);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('creates no scratch directory where there was none', async () => {
    const dir = await stateDir();
    expect(await clearInterruptedExportScratch(dir, randomUUID())).toEqual({
      cleanedUpAfter: null,
      removedEntries: 0,
      exportRunning: false,
    });
    expect(existsSync(join(dir.root, 'scratch'))).toBe(false);
  });
});
