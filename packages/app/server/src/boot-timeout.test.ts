/**
 * Boot-timeout guard — unit tests (no DB, no listen).
 *
 * Proves the guard turns a hung boot into a diagnosed failure while leaving the happy path untouched:
 *   - a boot that never resolves + a short timeout ⇒ rejects with the meaningful diagnostic;
 *   - a boot that resolves quickly ⇒ resolves with its value AND the deadline timer is cleared;
 *   - a boot that rejects ⇒ propagates its own error (not a timeout) AND clears the timer.
 * Plus a source-level guard WITH TEETH that the serve entrypoint actually wires the timeout + the
 * early progress line (a boot test cannot catch a dropped wrapper — it would just hang).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BootTimeoutError,
  bootTimeoutMessage,
  DEFAULT_BOOT_TIMEOUT_MS,
  resolveBootTimeoutMs,
  withBootTimeout,
} from './boot-timeout.js';

describe('resolveBootTimeoutMs', () => {
  it('defaults to 60s when RAYSPEC_BOOT_TIMEOUT_MS is unset', () => {
    expect(DEFAULT_BOOT_TIMEOUT_MS).toBe(60_000);
    expect(resolveBootTimeoutMs({} as NodeJS.ProcessEnv)).toBe(60_000);
  });

  it('honors a valid positive override', () => {
    expect(resolveBootTimeoutMs({ RAYSPEC_BOOT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(
      5000,
    );
  });

  it('falls back to the default on a non-numeric / non-positive / blank value', () => {
    for (const v of ['', '   ', 'abc', '0', '-1', 'NaN']) {
      expect(resolveBootTimeoutMs({ RAYSPEC_BOOT_TIMEOUT_MS: v } as NodeJS.ProcessEnv)).toBe(
        DEFAULT_BOOT_TIMEOUT_MS,
      );
    }
  });
});

describe('bootTimeoutMessage', () => {
  it('names the phases in flight and the likely causes', () => {
    const msg = bootTimeoutMessage(1234);
    expect(msg).toContain('1234ms');
    expect(msg).toContain('database');
    expect(msg).toContain('migration');
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('RAYSPEC_BOOT_TIMEOUT_MS');
  });
});

describe('withBootTimeout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects with a meaningful BootTimeoutError when the boot never resolves', async () => {
    const neverResolves = new Promise<never>(() => {});
    const err = await withBootTimeout(neverResolves, 25).catch((e) => e);
    expect(err).toBeInstanceOf(BootTimeoutError);
    expect(err.message).toContain('timed out after 25ms');
    expect(err.message).toContain('database');
    expect(err.message).toContain('RAYSPEC_BOOT_TIMEOUT_MS');
  });

  it('resolves with the boot value and clears the deadline timer on the happy path', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    // A generous timeout that must NOT fire: the boot resolves immediately.
    await expect(withBootTimeout(Promise.resolve('ready'), 60_000)).resolves.toBe('ready');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // And nothing rejects later — wait past a (hypothetical) short deadline to be sure the race settled.
    await new Promise((r) => setTimeout(r, 30));
  });

  it("propagates the boot's own rejection (not a timeout) and still clears the timer", async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const boom = new Error('assemble failed: bad config');
    const err = await withBootTimeout(Promise.reject(boom), 60_000).catch((e) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(BootTimeoutError);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

// Source-level guard WITH TEETH: the unit tests above prove the helper; this proves the ENTRYPOINT
// actually uses it. A boot smoke test cannot catch a dropped timeout wrapper (it would simply hang),
// so assert against serve.ts source that it (a) prints the early progress line before assembling and
// (b) wraps assembleServer(...) in withBootTimeout(..., resolveBootTimeoutMs()). Dropping either REDs
// a case here.
describe('serve.ts — wires the boot timeout and the early progress line', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'serve.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('prints a progress line before the assemble step', () => {
    expect(code).toMatch(/\[rayspec-serve\] booting —/);
  });

  it('wraps assembleServer in withBootTimeout with the resolved timeout', () => {
    expect(code).toMatch(/withBootTimeout\(\s*[\s\S]*assembleServer\(/);
    expect(code).toMatch(/resolveBootTimeoutMs\(\)/);
  });
});
