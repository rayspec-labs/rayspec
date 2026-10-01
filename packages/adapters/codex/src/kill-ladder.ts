/**
 * The codex child's kill ladder: a SIGTERM that is ignored is followed by a SIGKILL.
 *
 * `@openai/codex-sdk` spawns the `codex` binary with `spawn(path, args, { env, signal })` and nothing
 * else: aborting the signal sends ONE SIGTERM, never escalates, and the SDK keeps reading the child's
 * stdout until it closes. A child that ignores SIGTERM therefore keeps the turn — and `run()` — open
 * for good. The SDK exposes neither the child nor a kill signal, so the escalation cannot be added
 * around the SDK; it is added UNDER it: the SDK is pointed (through its `codexPathOverride` option) at
 * a small launcher that starts the real binary as ITS child, in a process group of its own, relays
 * stdin, stdout and stderr, and on SIGTERM or SIGINT forwards the signal to that whole group and arms
 * a SIGKILL of the group for `grace` milliseconds later.
 *
 * The launcher's exit is what closes the stdout the SDK reads, so it does not wait for the relayed
 * pipe to end: a process the binary started can hold that pipe open after the binary itself is gone.
 * Once the binary has exited after a stop, the launcher kills what is left of the group at once; and
 * whenever the binary has exited, the launcher exits at the latest `grace` milliseconds later, the
 * group killed first, whether or not the relayed output has ended; what is left of the group when
 * the launcher exits is killed. So `run()` settles shortly after the grace whatever the binary or its
 * children do with SIGTERM.
 *
 * The launcher is written once per process into a private temp directory (mode 0700, file 0700) with
 * this process's own `node` as its interpreter. It receives the binary to start and the grace through
 * two variables of the curated child env, and removes both before it starts the binary.
 *
 * WHAT IT DOES NOT COVER: a process the binary starts that leaves the group (a new session of its own)
 * is not signalled, and a SIGKILL of the launcher itself — which nothing here sends — would orphan
 * the group. On Windows there are no process groups to signal; only the binary is.
 */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The child-env variable naming the binary the launcher starts. */
export const LAUNCHER_TARGET_ENV = 'RAYSPEC_CODEX_EXECUTABLE';
/** The child-env variable carrying the grace between SIGTERM and SIGKILL, in milliseconds. */
export const LAUNCHER_GRACE_ENV = 'RAYSPEC_CODEX_KILL_GRACE_MS';

/** The launcher's source. CommonJS: it is written without an extension into a directory of its own. */
function launcherSource(interpreter: string): string {
  return [
    `#!${interpreter}`,
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    `const target = process.env.${LAUNCHER_TARGET_ENV};`,
    `const grace = Number(process.env.${LAUNCHER_GRACE_ENV});`,
    'const graceMs = Number.isFinite(grace) && grace > 0 ? grace : 5000;',
    'const env = { ...process.env };',
    `delete env.${LAUNCHER_TARGET_ENV};`,
    `delete env.${LAUNCHER_GRACE_ENV};`,
    "if (!target) { process.stderr.write('codex launcher: no executable given\\n'); process.exit(127); }",
    "const grouped = process.platform !== 'win32';",
    "const child = spawn(target, process.argv.slice(2), { env, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });",
    'process.stdin.pipe(child.stdin);',
    "child.stdin.on('error', () => {});",
    'child.stdout.pipe(process.stdout);',
    'child.stderr.pipe(process.stderr);',
    // Signal the binary's whole group (a negative pid), or the binary alone where there is none.
    'const signalGroup = (signal) => {',
    '  try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }',
    '  catch { try { child.kill(signal); } catch {} }',
    '};',
    'let stopping = false;',
    'let forced;',
    'let exited = false;',
    'const stop = (signal) => {',
    '  stopping = true;',
    "  if (exited) { signalGroup('SIGKILL'); return; }",
    '  signalGroup(signal);',
    "  if (forced === undefined) forced = setTimeout(() => signalGroup('SIGKILL'), graceMs);",
    '};',
    "process.on('SIGTERM', () => stop('SIGTERM'));",
    "process.on('SIGINT', () => stop('SIGINT'));",
    // Whatever the binary left in its group does not outlive the launcher.
    "process.on('exit', () => { if (exited) signalGroup('SIGKILL'); });",
    "child.on('error', (err) => { process.stderr.write(`codex launcher: ${err.message}\\n`); process.exit(127); });",
    "child.on('exit', (code, signal) => {",
    '  exited = true;',
    '  if (forced !== undefined) clearTimeout(forced);',
    '  process.exitCode = code ?? (signal ? 1 : 0);',
    '  if (signal) process.stderr.write(`codex exited on ${signal}\\n`);',
    // After a stop nothing of the group is wanted: end what holds the relayed pipe open.
    "  if (stopping) signalGroup('SIGKILL');",
    // Never wait on the relayed pipe beyond the grace: end the group, then leave.
    "  setTimeout(() => { signalGroup('SIGKILL'); process.exit(); }, stopping ? Math.min(graceMs, 200) : graceMs).unref();",
    '});',
    '',
  ].join('\n');
}

let launcherPath: string | null | undefined;

/**
 * The launcher's path, written on first use. Undefined when it cannot be written, or when this
 * process's interpreter path cannot stand in a `#!` line (it contains whitespace): the adapter then
 * runs the binary directly, without the escalation, and says so in its run record.
 */
export function killLadderLauncher(): string | undefined {
  if (launcherPath !== undefined) return launcherPath ?? undefined;
  try {
    if (/\s/.test(process.execPath)) {
      launcherPath = null;
      return undefined;
    }
    const dir = mkdtempSync(join(tmpdir(), 'rayspec-codex-launcher-'));
    const path = join(dir, 'codex');
    writeFileSync(path, launcherSource(process.execPath), { mode: 0o700, flag: 'wx' });
    launcherPath = path;
    return path;
  } catch {
    launcherPath = null;
    return undefined;
  }
}

const TRIPLE: Record<string, Record<string, string>> = {
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  android: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
};

const PLATFORM_PACKAGE: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `codex` binary the SDK would start by itself, and the directories it would put on PATH for it —
 * the same lookup the pinned SDK makes (its platform package's `vendor/<target>` layout). Undefined
 * when it cannot be found; the adapter then leaves the lookup to the SDK and runs without the ladder.
 */
export function resolveBundledCodex(): { executablePath: string; pathDirs: string[] } | undefined {
  try {
    const triple = TRIPLE[process.platform]?.[process.arch];
    const platformPackage = triple === undefined ? undefined : PLATFORM_PACKAGE[triple];
    if (triple === undefined || platformPackage === undefined) return undefined;
    const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
    const codexPackageJson = createRequire(sdkEntry).resolve('@openai/codex/package.json');
    const platformPackageJson = createRequire(codexPackageJson).resolve(
      `${platformPackage}/package.json`,
    );
    const root = join(dirname(platformPackageJson), 'vendor', triple);
    const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const current = join(root, 'bin', binary);
    if (isFile(current) && isFile(join(root, 'codex-package.json'))) {
      const pathDir = join(root, 'codex-path');
      return { executablePath: current, pathDirs: isDirectory(pathDir) ? [pathDir] : [] };
    }
    const legacy = join(root, 'codex', binary);
    if (isFile(legacy)) {
      const pathDir = join(root, 'path');
      return { executablePath: legacy, pathDirs: isDirectory(pathDir) ? [pathDir] : [] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
