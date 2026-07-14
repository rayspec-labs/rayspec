/**
 * Fail-the-fix tests for the .env quote-stripping loader (see dotenv.ts). Reverting the dequote step
 * turns the `"quoted"` → `quoted` assertions RED, which is exactly the papercut that made a
 * double-quoted repo-root `DATABASE_URL="postgres://…"` throw `Invalid URL` in the DB-backed suites.
 */
import { describe, expect, it } from 'vitest';
import { dequoteEnvValue, parseDotenv } from './dotenv.js';

describe('dequoteEnvValue', () => {
  it('strips a matching double-quote pair', () => {
    expect(dequoteEnvValue('"quoted"')).toBe('quoted');
  });

  it('strips a matching single-quote pair', () => {
    expect(dequoteEnvValue("'single'")).toBe('single');
  });

  it('leaves a bare value unchanged', () => {
    expect(dequoteEnvValue('bare')).toBe('bare');
  });

  it('leaves an unterminated quote unchanged', () => {
    expect(dequoteEnvValue('"unterminated')).toBe('"unterminated');
    expect(dequoteEnvValue("'unterminated")).toBe("'unterminated");
  });

  it('leaves a lone quote and a mismatched pair unchanged', () => {
    expect(dequoteEnvValue('"')).toBe('"');
    expect(dequoteEnvValue(`"a'`)).toBe(`"a'`);
  });

  it('dequotes an empty quoted value to the empty string', () => {
    expect(dequoteEnvValue('""')).toBe('');
  });
});

describe('parseDotenv', () => {
  it('parses KEY=VALUE, dequoting values and skipping blank/comment/malformed lines', () => {
    const content = [
      '# a comment',
      '',
      'DATABASE_URL="postgres://user:pass@localhost:5433/db"',
      "PEPPER='dev-pepper'",
      'BARE=plain',
      'noequalsline',
      '=novalueforkey',
    ].join('\n');
    expect(parseDotenv(content)).toEqual([
      ['DATABASE_URL', 'postgres://user:pass@localhost:5433/db'],
      ['PEPPER', 'dev-pepper'],
      ['BARE', 'plain'],
    ]);
  });
});
