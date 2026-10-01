/**
 * Running `pg_restore` for an import, against stand-in tools that record what they were given:
 *  - the dump reaches the tool on its standard input, read from a range of a larger file; every byte
 *    of the range is hashed, also when the tool stops reading early, and the write the tool no longer
 *    takes (`EPIPE`) is the tool's choice, judged by its exit code — not an uncaught error;
 *  - the listing drops the header comments; a tool that fails is an error;
 *  - a restore runs with the options that keep the dump's owner, privileges, comments and
 *    tablespaces out, the list file and the database name on its command line, and the connection
 *    (password included) only in the libpq environment;
 *  - a stop request ends the tool.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PgDumpError } from './pg-dump.js';
import { listDump, PgRestoreAborted, RESTORE_OPTIONS, restoreDump } from './pg-restore.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-pg-restore-'));
  dirs.push(dir);
  return dir;
}

/** A stand-in tool: a Node script run with this Node, given as an absolute executable path. */
function tool(dir: string, name: string, body: string): { command: string } {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return { command: path };
}

/** A file with `before` bytes, the dump range, then `after` bytes. */
async function rangeOf(dir: string, size: number) {
  const before = randomBytes(1000);
  const dump = randomBytes(size);
  const path = join(dir, 'archive.zip');
  writeFileSync(path, Buffer.concat([before, dump, randomBytes(500)]));
  const handle = await open(path, 'r');
  return {
    source: { handle, offset: before.length, size: dump.length },
    sha256: createHash('sha256').update(dump).digest('hex'),
  };
}

describe('listDump', () => {
  it('hashes the whole range although the tool stops reading early, and returns its listing', async () => {
    const dir = workDir();
    // Far more than a pipe holds, so the writes after the tool exits fail with EPIPE.
    const { source, sha256 } = await rangeOf(dir, 4 * 1024 * 1024);
    const early = tool(
      dir,
      'pg_restore-early',
      [
        "const fs = require('node:fs');",
        'const b = Buffer.alloc(16); fs.readSync(0, b, 0, 16, null);',
        "process.stdout.write(';\\n; Archive created at now\\n;\\n6; 2615 1 SCHEMA - drizzle app\\n\\n7; 0 0 ACL - SCHEMA drizzle app\\n');",
        'process.exit(0);',
      ].join('\n'),
    );
    try {
      const listed = await listDump(early, source);
      expect(listed.lines).toEqual([
        '6; 2615 1 SCHEMA - drizzle app',
        '7; 0 0 ACL - SCHEMA drizzle app',
      ]);
      expect(listed.sourceSha256).toBe(sha256);
    } finally {
      await source.handle.close();
    }
  });

  it('is an error when the tool fails', async () => {
    const dir = workDir();
    const { source } = await rangeOf(dir, 1000);
    const failing = tool(
      dir,
      'pg_restore-fails',
      "process.stderr.write('pg_restore: error: input file is not a valid archive\\n'); process.exit(1);",
    );
    try {
      await expect(listDump(failing, source)).rejects.toBeInstanceOf(PgDumpError);
    } finally {
      await source.handle.close();
    }
  });
});

describe('restoreDump', () => {
  it('runs with the import options, the list file and the database name, and the connection in the environment only', async () => {
    const dir = workDir();
    const { source, sha256 } = await rangeOf(dir, 300_000);
    const record = join(dir, 'record.json');
    const recording = tool(
      dir,
      'pg_restore-records',
      [
        "const fs = require('node:fs');",
        'let n = 0; const b = Buffer.alloc(65536);',
        'for (;;) { const r = fs.readSync(0, b, 0, b.length, null); if (r === 0) break; n += r; }',
        `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), read: n, env: { host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, password: process.env.PGPASSWORD, db: process.env.PGDATABASE, app: process.env.PGAPPNAME } }));`,
      ].join('\n'),
    );
    const password = ['pw', randomBytes(6).toString('hex')].join('-');
    try {
      const restored = await restoreDump(
        recording,
        `postgres://migrator:${password}@db.internal:6543/target_app`,
        join(dir, 'application.list'),
        source,
      );
      expect(restored.sourceSha256).toBe(sha256);
      const seen = JSON.parse(readFileSync(record, 'utf8')) as {
        args: string[];
        read: number;
        env: Record<string, string>;
      };
      expect(seen.read).toBe(300_000);
      expect(seen.args).toEqual([
        ...RESTORE_OPTIONS,
        `--use-list=${join(dir, 'application.list')}`,
        '--dbname=target_app',
      ]);
      for (const option of [
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '--exit-on-error',
      ]) {
        expect(seen.args).toContain(option);
      }
      expect(seen.args.join(' ')).not.toContain(password);
      expect(seen.env).toEqual({
        host: 'db.internal',
        port: '6543',
        user: 'migrator',
        password,
        db: 'target_app',
        app: 'rayspec-import',
      });
    } finally {
      await source.handle.close();
    }
  });

  it('reports a restore that failed as rolled back, and ends the tool when stopped', async () => {
    const dir = workDir();
    const { source } = await rangeOf(dir, 1000);
    const failing = tool(
      dir,
      'pg_restore-fails',
      "process.stderr.write('pg_restore: error: could not execute query\\n'); process.exit(1);",
    );
    const hanging = tool(dir, 'pg_restore-hangs', 'setInterval(() => {}, 1000);');
    try {
      await expect(
        restoreDump(failing, 'postgres://u@h/db', join(dir, 'l'), source),
      ).rejects.toThrow(/rolled back/);
      const controller = new AbortController();
      const running = restoreDump(
        hanging,
        'postgres://u@h/db',
        join(dir, 'l'),
        source,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 200);
      await expect(running).rejects.toBeInstanceOf(PgRestoreAborted);
    } finally {
      await source.handle.close();
    }
  });
});
