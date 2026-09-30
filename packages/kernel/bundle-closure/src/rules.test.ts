import { describe, expect, it } from 'vitest';
import { excludedFile, excludedWalkedFile, isDatabaseDump } from './rules.js';
import { PG_DUMP_OUTPUT } from './test-support/app.js';

const text = (value: string) => Buffer.from(value, 'latin1');

describe('isDatabaseDump', () => {
  it('knows the plain-text output of the dump tools', () => {
    expect(isDatabaseDump(text(PG_DUMP_OUTPUT))).toBe(true);
    for (const banner of [
      '--\n-- PostgreSQL database cluster dump\n--\n',
      '-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)\n',
      '/*M!999999\\- enable the sandbox mode */\n-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB\n',
    ]) {
      expect(isDatabaseDump(text(banner))).toBe(true);
    }
  });

  it('knows a pg_dump archive and an SQLite database by their magic', () => {
    expect(isDatabaseDump(text('PGDMP\u0001\u000f\u0000'))).toBe(true);
    expect(isDatabaseDump(text('SQLite format 3\u0000\u0010\u0000'))).toBe(true);
    expect(isDatabaseDump(text('SQLite format 3 is a phrase'))).toBe(false);
    expect(isDatabaseDump(text('xPGDMP'))).toBe(false);
  });

  it('looks at the start of lines in the first bytes only', () => {
    expect(isDatabaseDump(text('CREATE TABLE t (id int);\n'))).toBe(false);
    expect(isDatabaseDump(text('see: -- PostgreSQL database dump\n'))).toBe(false);
    expect(isDatabaseDump(text(`${' '.repeat(4096)}\n-- PostgreSQL database dump\n`))).toBe(false);
    expect(isDatabaseDump(new Uint8Array())).toBe(false);
  });

  it('reads a view into a larger buffer from its own offset', () => {
    const buffer = text(`xxxx${PG_DUMP_OUTPUT}`);
    expect(isDatabaseDump(buffer.subarray(4))).toBe(true);
    expect(isDatabaseDump(text('xxxxPGDMP').subarray(4))).toBe(true);
  });
});

describe('excludedWalkedFile', () => {
  it('adds SQL files, in any letter case, to the classes a named file has', () => {
    expect(excludedWalkedFile('backup.sql', false)).toBe('a database dump');
    expect(excludedWalkedFile('Backup.SQL', false)).toBe('a database dump');
    expect(excludedFile('backup.sql', false)).toBeUndefined();
    expect(excludedWalkedFile('.env', false)).toBe('an environment file');
    expect(excludedWalkedFile('sql.js', false)).toBeUndefined();
    expect(excludedWalkedFile('index.html', false)).toBeUndefined();
  });
});
