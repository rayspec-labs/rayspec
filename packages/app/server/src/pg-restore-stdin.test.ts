/**
 * `pg_restore`'s standard input failing: a write the tool no longer takes (`EPIPE`) is the tool's
 * choice and its exit code decides, while any other failure of the pipe means the tool may have read
 * something other than the dump, so a run that exits 0 after it is refused. The failure is injected
 * on the real child's input stream, which a real pipe cannot be made to produce on demand.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      const code = injected.code;
      if (code !== null) {
        setImmediate(() => {
          child.stdin?.emit('error', Object.assign(new Error(`write ${code}`), { code }));
        });
      }
      return child;
    },
  };
});

const { PgDumpError } = await import('./pg-dump.js');
const { listDump } = await import('./pg-restore.js');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(code: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-pg-restore-stdin-'));
  dirs.push(dir);
  const tool = join(dir, 'pg_restore');
  writeFileSync(
    tool,
    `#!${process.execPath}\n` +
      "const fs = require('node:fs'); const b = Buffer.alloc(65536);\n" +
      'for (;;) { const r = fs.readSync(0, b, 0, b.length, null); if (r === 0) break; }\n' +
      "process.stdout.write('6; 2615 1 SCHEMA - drizzle app\\n');\n",
  );
  chmodSync(tool, 0o755);
  const archive = join(dir, 'archive');
  writeFileSync(archive, randomBytes(4096));
  const handle = await open(archive, 'r');
  injected.code = code;
  try {
    return await listDump({ command: tool }, { handle, offset: 0, size: 4096 });
  } finally {
    injected.code = null;
    await handle.close();
  }
}

describe("pg_restore's standard input", () => {
  it('takes EPIPE as the tool stopping to read, and its exit code decides', async () => {
    await expect(run('EPIPE')).resolves.toMatchObject({
      lines: ['6; 2615 1 SCHEMA - drizzle app'],
    });
  });

  it('refuses a run that exits 0 after its input failed in any other way', async () => {
    for (const code of ['ECONNRESET', 'EIO']) {
      await expect(run(code), code).rejects.toBeInstanceOf(PgDumpError);
      await expect(run(code), code).rejects.toThrow(`input failed (${code})`);
    }
    await expect(run(null)).resolves.toMatchObject({ lines: ['6; 2615 1 SCHEMA - drizzle app'] });
  });
});
