/**
 * `RAYSPEC_FS_SINK_ROOT` — the env → config → factory chain, and the boot refusal at the end of it.
 *
 * WHY THIS SUITE EXISTS. The read twin `RAYSPEC_FS_SOURCE_ROOT` has a full boot-refusal suite and 17
 * lines of `.env.example`; the write twin shipped with **zero** of either. That asymmetry is backwards:
 * this is the ONE directory a model's output can reach the filesystem through, so a misconfigured root
 * is a worse outcome here than for a read-only source, and it is exactly the variable an operator is
 * most likely to point somewhere careless.
 *
 * Deliberately NOT a `.db.test.ts`. The read twin's suite boots a real server per arm (180s timeouts,
 * ten arms) because it is also proving WHICH boot profile performs the check. That question is already
 * answered and shared: both roots are gated on their `config.*Root` alone, at the same two build sites.
 * What is unproven for the sink is narrower and cheaper — that the variable is read at all, that it is
 * resolved to an absolute path, and that an unusable value produces the house refusal naming the
 * variable. All three run in the no-DB lane in milliseconds.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { FsSinkConfigError, makeFsSinkFactory } from '@rayspec/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadServerConfig } from './composition-root.js';

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'rayspec-sink-cfg-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * `loadServerConfig` reads `process.env`; these arms drive it with an explicit record instead, so the
 * suite is hermetic. The three boot secrets are required before it will return at all — supplied here
 * as syntactically valid throwaways so the arms can reach the fs-sink question they are actually about.
 * The key is generated per run, never committed.
 */
const THROWAWAY_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://rayspec:rayspec@127.0.0.1:5999/rayspec',
  RAYSPEC_JWT_SIGNING_KEY: THROWAWAY_KEY,
  RAYSPEC_API_KEY_PEPPER: 'fs-sink-config-suite-pepper-0000000000',
  ...extra,
});

describe('RAYSPEC_FS_SINK_ROOT — env → config', () => {
  it('is READ into config, and resolved to an ABSOLUTE path', () => {
    const root = join(sandbox, 'out');
    mkdirSync(root, { recursive: true });
    const config = loadServerConfig(envWith({ RAYSPEC_FS_SINK_ROOT: root }));
    expect(config.fsSinkRoot).toBeDefined();
    expect(isAbsolute(config.fsSinkRoot as string)).toBe(true);
  });

  it('resolves a RELATIVE value rather than passing it through — a relative jail root is a trap', () => {
    const config = loadServerConfig(envWith({ RAYSPEC_FS_SINK_ROOT: './generated' }));
    expect(config.fsSinkRoot).toBeDefined();
    expect(isAbsolute(config.fsSinkRoot as string)).toBe(true);
    expect(config.fsSinkRoot).not.toBe('./generated');
  });

  it('is ABSENT when the variable is unset — unset means no capability, never a default root', () => {
    // The failure this forbids is a default: silently wiring some directory would give every declared
    // tool a writable root the operator never chose.
    expect(loadServerConfig(envWith({})).fsSinkRoot).toBeUndefined();
  });

  it('treats a WHITESPACE-ONLY value as unset rather than resolving it to the process cwd', () => {
    // `resolve('')` is the CWD. Without the trim this would silently jail the sink to wherever the
    // server happened to be started from — the worst possible default for a write capability.
    expect(loadServerConfig(envWith({ RAYSPEC_FS_SINK_ROOT: '   ' })).fsSinkRoot).toBeUndefined();
  });
});

describe('RAYSPEC_FS_SINK_ROOT — the refusal an operator actually reads', () => {
  // The composition root re-raises `FsSinkConfigError` as a `BootConfigError` naming the VARIABLE.
  // These arms pin the underlying refusal and its wording; the re-raise is a two-line catch in
  // composition-root.ts that quotes `err.message`, so pinning the message pins what reaches the boot.

  it('REFUSES a root that does not exist, and does NOT create it', () => {
    const missing = join(sandbox, 'nope');
    expect(() => makeFsSinkFactory(missing)).toThrow(FsSinkConfigError);
    expect(() => makeFsSinkFactory(missing)).toThrow(/does not exist or is not a directory/);
    // FAIL-CLOSED: refusing must not materialise the directory it refused.
    expect(() => loadServerConfig(envWith({ RAYSPEC_FS_SINK_ROOT: missing }))).not.toThrow();
    expect(() => makeFsSinkFactory(missing)).toThrow(FsSinkConfigError);
  });

  it('REFUSES a root naming a regular FILE', () => {
    const asFile = join(sandbox, 'a-file');
    writeFileSync(asFile, 'x', 'utf8');
    expect(() => makeFsSinkFactory(asFile)).toThrow(FsSinkConfigError);
  });

  it('the refusal names the ROOT it refused — an operator must not have to guess which path', () => {
    const missing = join(sandbox, 'also-missing');
    try {
      makeFsSinkFactory(missing);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).toContain(missing);
      expect((e as Error).message).toContain('fail-closed');
    }
  });

  it('REFUSES a non-positive bound — a 0 budget is a misconfiguration, never "unlimited"', () => {
    const root = join(sandbox, 'out2');
    mkdirSync(root, { recursive: true });
    expect(() => makeFsSinkFactory(root, { maxFiles: 0 })).toThrow(FsSinkConfigError);
    expect(() => makeFsSinkFactory(root, { maxTotalBytes: -1 })).toThrow(FsSinkConfigError);
  });
});
