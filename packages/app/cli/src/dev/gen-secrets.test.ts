/**
 * `rayspec dev gen-secrets` — the load-bearing security + idempotency invariants (NO DB; un-skippable).
 *
 * These prove the properties that make the command safe to run against a real `.env`:
 *  (a) IDEMPOTENT / NEVER-CLOBBER — a second run reports every key `already-present` and leaves the file
 *      byte-identical (an existing key is never overwritten); a partial file only gains the missing keys.
 *  (b) NEVER PRINTS A SECRET VALUE — driven END-TO-END through `main(['dev','gen-secrets',…])` with
 *      stdout captured: the emitted JSON contains NONE of the minted values (nor the raw PEM).
 *  (c) chmod 600 — the secret file is owner-only after a write.
 *  (d) the JWT key is a VALID PKCS#8 PEM that round-trips via node:crypto `createPrivateKey` (a real
 *      usable key, not a blob) AND is stored single-line with literal `\n` (the repo `.env` convention).
 *  (e) the pepper + media keys are present and DISTINCT (separate cryptographic chains).
 */
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenSecrets } from './gen-secrets.js';

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-gen-secrets-'));
  target = join(dir, '.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Parse a written `.env` into a key→value map (stripping surrounding quotes, as the loaders do). */
function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

describe('dev gen-secrets — mints the 3 boot secrets', () => {
  it('writes all three on a fresh file; the JWT key is a valid single-line PKCS#8 PEM (c/d/e)', async () => {
    const result = await runGenSecrets(['--out', target]);
    expect(result.ok).toBe(true);
    expect(result.keys).toEqual({
      RAYSPEC_JWT_SIGNING_KEY: 'written',
      RAYSPEC_API_KEY_PEPPER: 'written',
      RAYSPEC_MEDIA_SIGNING_KEY: 'written',
    });

    const content = readFileSync(target, 'utf8');
    const env = parseEnv(content);

    // (d) the JWT line is stored SINGLE-LINE with literal `\n` (no real newline inside the value).
    const jwtLine = content.split('\n').find((l) => l.startsWith('RAYSPEC_JWT_SIGNING_KEY='));
    expect(jwtLine).toBeDefined();
    expect(jwtLine).toContain('\\n'); // literal backslash-n
    expect(env.RAYSPEC_JWT_SIGNING_KEY).not.toContain('\n'); // not a real newline

    // (d) it round-trips to a REAL private key once un-escaped (proves it's usable, not a blob).
    const pem = env.RAYSPEC_JWT_SIGNING_KEY.replace(/\\n/g, '\n');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
    const key = createPrivateKey(pem);
    expect(key.type).toBe('private');
    expect(key.asymmetricKeyType).toBe('rsa');

    // (e) pepper + media present and DISTINCT.
    expect(env.RAYSPEC_API_KEY_PEPPER).toBeTruthy();
    expect(env.RAYSPEC_MEDIA_SIGNING_KEY).toBeTruthy();
    expect(env.RAYSPEC_API_KEY_PEPPER).not.toEqual(env.RAYSPEC_MEDIA_SIGNING_KEY);
    // media key ≥ 32 utf8 bytes (media-token.ts MIN_MEDIA_SECRET_BYTES).
    expect(Buffer.byteLength(env.RAYSPEC_MEDIA_SIGNING_KEY, 'utf8')).toBeGreaterThanOrEqual(32);

    // (c) chmod 600.
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('(a) is idempotent: a 2nd run never overwrites — every key already-present, file byte-identical', async () => {
    await runGenSecrets(['--out', target]);
    const first = readFileSync(target, 'utf8');

    const second = await runGenSecrets(['--out', target]);
    expect(second.keys).toEqual({
      RAYSPEC_JWT_SIGNING_KEY: 'already-present',
      RAYSPEC_API_KEY_PEPPER: 'already-present',
      RAYSPEC_MEDIA_SIGNING_KEY: 'already-present',
    });
    // The existing secrets were NOT clobbered (the file is byte-for-byte the same).
    expect(readFileSync(target, 'utf8')).toBe(first);
  });

  it('(a) a partial file only gains the MISSING keys; the pre-existing one is left untouched', async () => {
    // Seed a file that already carries the pepper (a deliberately recognisable sentinel value).
    const sentinel = 'PRE-EXISTING-PEPPER-DO-NOT-CLOBBER';
    writeFileSync(target, `RAYSPEC_API_KEY_PEPPER=${sentinel}\n`, 'utf8');

    const result = await runGenSecrets(['--out', target]);
    expect(result.keys).toEqual({
      RAYSPEC_JWT_SIGNING_KEY: 'written',
      RAYSPEC_API_KEY_PEPPER: 'already-present',
      RAYSPEC_MEDIA_SIGNING_KEY: 'written',
    });

    const env = parseEnv(readFileSync(target, 'utf8'));
    expect(env.RAYSPEC_API_KEY_PEPPER).toBe(sentinel); // untouched
    expect(env.RAYSPEC_JWT_SIGNING_KEY).toContain('\\n'); // newly minted
    expect(env.RAYSPEC_MEDIA_SIGNING_KEY).toBeTruthy();
  });
});

describe('dev gen-secrets — single-handle write edge branches (no check-then-write race)', () => {
  it('inserts the newline separator when the existing file has NO trailing newline', async () => {
    writeFileSync(target, 'RAYSPEC_API_KEY_PEPPER=SEED', 'utf8'); // deliberately no trailing '\n'
    const result = await runGenSecrets(['--out', target]);
    expect(result.keys.RAYSPEC_API_KEY_PEPPER).toBe('already-present');
    const content = readFileSync(target, 'utf8');
    // The seed stays on its own line — a '\n' was inserted before the appended keys (not glued on).
    expect(content.split('\n')[0]).toBe('RAYSPEC_API_KEY_PEPPER=SEED');
    const env = parseEnv(content);
    expect(env.RAYSPEC_API_KEY_PEPPER).toBe('SEED'); // pre-existing value untouched
    expect(env.RAYSPEC_JWT_SIGNING_KEY).toContain('\\n'); // newly minted
    expect(env.RAYSPEC_MEDIA_SIGNING_KEY).toBeTruthy();
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('a PRE-EXISTING empty file is treated as fresh (single-open a+ cannot distinguish it from absent) and DOES get the header', async () => {
    // The single-open race-free `a+` cycle has no way to tell an empty-but-present file apart from an
    // absent one (both read back as ''), so both take the fresh path and get the header.
    writeFileSync(target, '', 'utf8');
    const result = await runGenSecrets(['--out', target]);
    expect(result.ok).toBe(true);
    const content = readFileSync(target, 'utf8');
    expect(content.startsWith('#')).toBe(true); // header written onto the empty file, same as absent
    expect(parseEnv(content).RAYSPEC_JWT_SIGNING_KEY).toBeTruthy();
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('tightens mode to 600 when appending to a loose-permission partial file', async () => {
    writeFileSync(target, 'RAYSPEC_API_KEY_PEPPER=SEED\n', { mode: 0o644 });
    await runGenSecrets(['--out', target]); // appends JWT + MEDIA → chmods the same handle
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });
});

describe('dev gen-secrets — NEVER echoes a secret value (b) [end-to-end via main]', () => {
  it('the emitted JSON contains NONE of the minted values, nor the raw PEM', async () => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: unknown, cb?: unknown): boolean => {
        outChunks.push(String(chunk));
        if (typeof cb === 'function') (cb as (e?: Error) => void)();
        return true;
      },
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (chunk: unknown, cb?: unknown): boolean => {
        errChunks.push(String(chunk));
        if (typeof cb === 'function') (cb as (e?: Error) => void)();
        return true;
      },
    );

    // Drive the REAL CLI body so we capture what an operator would actually see on stdout.
    const { main } = await import('../index.js');
    const code = await main(['dev', 'gen-secrets', '--out', target]);
    expect(code).toBe(0);

    const stdout = outChunks.join('');
    // It IS a clean JSON summary with the value-free statuses.
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.keys.RAYSPEC_JWT_SIGNING_KEY).toBe('written');

    // Read the ACTUAL minted values from the file and assert NONE of them leaked to stdout.
    const env = parseEnv(readFileSync(target, 'utf8'));
    expect(stdout).not.toContain(env.RAYSPEC_API_KEY_PEPPER);
    expect(stdout).not.toContain(env.RAYSPEC_MEDIA_SIGNING_KEY);
    expect(stdout).not.toContain(env.RAYSPEC_JWT_SIGNING_KEY); // the escaped one-line value
    expect(stdout).not.toContain('BEGIN PRIVATE KEY'); // nor any raw PEM material
    expect(errChunks.join('')).toBe('');
  });
});
