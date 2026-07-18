/**
 * The `rayspec` launcher is behaviorally IDENTICAL to the `@rayspec/cli` bin it re-exposes.
 *
 * The load-bearing (fail-the-fix) assertion spawns BOTH built bins as child processes and compares
 * their full observable behavior — exit code, stdout, stderr — for representative commands:
 *   - `init <dir>`  a happy-path command that emits a stable JSON envelope (paths are CWD-relative, so
 *                   two runs in two fresh temp dirs produce byte-identical output) AND has a side
 *                   effect we assert positively (the starter `rayspec.yaml` is written), proving the
 *                   launcher really drives the CLI rather than merely matching an empty result.
 *   - `--help`      the usage/error path: a leading flag with no subcommand exits 2 and prints the
 *                   shared USAGE block to stderr.
 *
 * If the shim ever diverges from the CLI (wrong argv forwarding, not invoking `run`, swallowing the
 * exit code, ...), the launcher's output stops matching the CLI's and this test goes RED.
 *
 * These bins are DIST artifacts, so `pnpm build` must precede this suite (it does in the gate/CI:
 * build runs before test). If a dist is missing we fail LOUDLY with a build hint rather than skip —
 * a silent skip would be a false green.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/app/rayspec/src -> packages/app
const APP_DIR = resolve(HERE, '..', '..');
const META_BIN = join(APP_DIR, 'rayspec', 'dist', 'bin.js');
const CLI_BIN = join(APP_DIR, 'cli', 'dist', 'index.js');

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn `node <bin> <...args>` in `cwd` and capture the full observable result. */
function runBin(bin: string, args: readonly string[], cwd: string): RunResult {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const tmpDirs: string[] = [];
function freshCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'rayspec-equiv-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  for (const [name, bin] of [
    ['rayspec (launcher)', META_BIN],
    ['@rayspec/cli', CLI_BIN],
  ] as const) {
    if (!existsSync(bin)) {
      throw new Error(`${name} bin not built: ${bin} — run \`pnpm build\` before this suite`);
    }
  }
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('rayspec launcher ≡ @rayspec/cli bin', () => {
  it('`init <dir>` produces identical output AND the launcher actually scaffolds the starter', () => {
    const metaCwd = freshCwd();
    const cliCwd = freshCwd();
    const meta = runBin(META_BIN, ['init'], metaCwd);
    const cli = runBin(CLI_BIN, ['init'], cliCwd);

    // Byte-identical observable behavior (CWD-relative paths → identical across the two temp dirs).
    expect(meta).toEqual(cli);

    // Positive proof the launcher drove the CLI end-to-end (not just an empty match).
    expect(meta.code).toBe(0);
    const parsed = JSON.parse(meta.stdout) as { ok: boolean; created: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.created).toEqual(['rayspec.yaml']);
    expect(existsSync(join(metaCwd, 'rayspec.yaml'))).toBe(true);
    // The launcher's scaffold is byte-identical to the CLI's.
    expect(readFileSync(join(metaCwd, 'rayspec.yaml'), 'utf8')).toBe(
      readFileSync(join(cliCwd, 'rayspec.yaml'), 'utf8'),
    );
  });

  it('`--help` (usage/error path) is identical: exit 2 with the shared USAGE on stderr', () => {
    const meta = runBin(META_BIN, ['--help'], freshCwd());
    const cli = runBin(CLI_BIN, ['--help'], freshCwd());
    expect(meta).toEqual(cli);
    expect(meta.code).toBe(2);
    expect(meta.stdout).toBe('');
    expect(meta.stderr).toContain('rayspec — RaySpec CLI');
  });
});
