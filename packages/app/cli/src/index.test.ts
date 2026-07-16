/**
 * `rayspec` CLI entrypoint — exit-code + argv contract + drain-safe stdout.
 *
 * `main(args)` is the testable CLI body: it RETURNS a numeric exit code (0 ok · 1 not-ok spec/plan)
 * and THROWS a `CliError` for a usage/argument problem (which the top-level maps to exit 2). We drive
 * it in-process with an EXPLICIT arg vector and capture stdout/stderr:
 *  - a valid spec → 0, the ok:true JSON on stdout (not stderr);
 *  - an invalid spec → 1, the ok:false JSON on STDOUT (it is the command's normal output, exit 1);
 *  - a missing command → throws CliError (exit 2), nothing on stdout;
 *  - an unknown command → throws CliError (exit 2);
 *  - an unknown `--flag` → throws CliError (exit 2) (strict parseArgs).
 *
 * emit uses a drain callback, so a large payload is flushed before exit — we assert the JSON is
 * COMPLETE (parses + closing brace present), not truncated.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, run } from './index.js';

const VALID_SPEC = `
version: '1.0'
metadata:
  name: index-test
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

let dir: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-index-'));
  writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
  writeFileSync(join(dir, 'bad.yaml'), "version: '1.0'\nmetadata: { name: x }\nbogus: 1\n", 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

let outChunks: string[];
let errChunks: string[];

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  // Capture stdout/stderr. Our writes use the (string, callback) form (drain-safe) — invoke the cb.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main — exit codes + stream routing', () => {
  it('valid spec (doctor) → 0, complete JSON on stdout, nothing on stderr', async () => {
    const code = await main(['doctor', 'rayspec.yaml']);
    expect(code).toBe(0);
    const out = outChunks.join('');
    expect(errChunks.join('')).toBe('');
    // Complete (not truncated) JSON.
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });

  it('valid spec (plan, no shadow) → 0', async () => {
    // Force no-shadow by DELETING the env for this call (the run path reads process.env; assigning
    // `undefined` would set the literal string "undefined"). A no-shadow plan needs no DB.
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      const code = await main(['plan', 'rayspec.yaml']);
      expect(code).toBe(0);
      expect(JSON.parse(outChunks.join('')).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });

  it('invalid spec → 1, the ok:false JSON on STDOUT (not stderr)', async () => {
    const code = await main(['doctor', 'bad.yaml']);
    expect(code).toBe(1);
    const parsed = JSON.parse(outChunks.join(''));
    expect(parsed.ok).toBe(false);
    expect(errChunks.join('')).toBe('');
  });

  it('missing command → throws CliError (→ exit 2), nothing on stdout', async () => {
    await expect(main([])).rejects.toThrow(/missing command/i);
    expect(outChunks.join('')).toBe('');
  });

  it('unknown command → throws CliError (→ exit 2)', async () => {
    await expect(main(['frobnicate', 'rayspec.yaml'])).rejects.toThrow(/unknown command/i);
    expect(outChunks.join('')).toBe('');
  });

  it('unknown --flag → throws CliError (→ exit 2)', async () => {
    await expect(main(['doctor', '--nope', 'rayspec.yaml'])).rejects.toThrow(/invalid arguments/i);
    expect(outChunks.join('')).toBe('');
  });
});

describe('run — CliError → exit 2 mapping (IDX-EXIT2-1)', () => {
  // `run()` is the top-level runner: it sets process.exitCode (2 for a CliError, else main's 0/1) and
  // routes the error to stderr. Save/restore exitCode so an assertion never leaks into the runner.
  let prevExit: number | string | undefined;
  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = prevExit;
  });

  it('a missing command → exit 2, the cliError JSON on STDERR (not stdout)', async () => {
    await run([]);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    const err = errChunks.join('');
    expect(JSON.parse(err.split('\n')[0] as string).ok).toBe(false);
    expect(err).toMatch(/missing command/i);
  });

  it('an unknown command → exit 2', async () => {
    await run(['frobnicate', 'rayspec.yaml']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    expect(errChunks.join('')).toMatch(/unknown command/i);
  });

  it('an unknown --flag → exit 2', async () => {
    await run(['doctor', '--nope', 'rayspec.yaml']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toMatch(/^$/);
    expect(errChunks.join('')).toMatch(/invalid arguments/i);
  });

  it('a valid spec → exit 0 via run()', async () => {
    await run(['doctor', 'rayspec.yaml']);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(outChunks.join('')).ok).toBe(true);
  });

  it('a not-ok spec → exit 1 via run() (the ok:false JSON on stdout)', async () => {
    await run(['doctor', 'bad.yaml']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(outChunks.join('')).ok).toBe(false);
    expect(errChunks.join('')).toBe('');
  });
});

describe('main — plan update-mode flags (--against / --allowlist) through the real arg parser', () => {
  const OLD = `
version: '1.0'
metadata: { name: index-update }
stores:
  - name: things
    columns:
      - { name: title, type: text }
      - { name: note, type: text }
`;
  const NEW_DROP = `
version: '1.0'
metadata: { name: index-update }
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

  beforeAll(() => {
    writeFileSync(join(dir, 'upd-old.yaml'), OLD, 'utf8');
    writeFileSync(join(dir, 'upd-new.yaml'), NEW_DROP, 'utf8');
  });

  it('a destructive --against delta is BLOCKED (exit 1); feeding --allowlist the proposal makes it pass (exit 0)', async () => {
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL; // no shadow ⇒ no DB needed
    try {
      // 1) BLOCKED without an allowlist — the flags parsed + dispatched to update mode.
      const blocked = await main(['plan', 'upd-new.yaml', '--against', 'upd-old.yaml']);
      expect(blocked).toBe(1);
      const blockedJson = JSON.parse(outChunks.join(''));
      expect(blockedJson.ok).toBe(false);
      expect(blockedJson.updateMode).toBe(true);
      expect(blockedJson.breakingChangeBlocked).toBe(true);

      // 2) Write the machine-proposed allowlist to a file, feed it via --allowlist → PASSES (exit 0).
      writeFileSync(join(dir, 'al.json'), JSON.stringify(blockedJson.proposedAllowlist), 'utf8');
      outChunks.length = 0;
      const passed = await main([
        'plan',
        'upd-new.yaml',
        '--against',
        'upd-old.yaml',
        '--allowlist',
        'al.json',
      ]);
      expect(passed).toBe(0);
      expect(JSON.parse(outChunks.join('')).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });

  it('an unknown flag on plan is still a strict usage error (exit 2 via CliError)', async () => {
    await expect(main(['plan', 'upd-new.yaml', '--bogus'])).rejects.toThrow(/invalid arguments/i);
  });
});

describe('main — drain-safe stdout (no truncation)', () => {
  it('emits a complete, parseable JSON payload (closing brace present)', async () => {
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      await main(['plan', 'rayspec.yaml']);
      const out = outChunks.join('');
      expect(out.trimEnd().endsWith('}')).toBe(true);
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });
});
