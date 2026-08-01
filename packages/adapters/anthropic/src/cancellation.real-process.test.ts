/**
 * Anthropic adapter — REAL-PROCESS cancellation. No network, no DB, needs no credentials.
 *
 * Every other test in this package mocks `@anthropic-ai/claude-agent-sdk` wholesale, so it can only
 * prove that a boolean flipped on an `AbortController`. That is not the claim this adapter makes.
 * The claim is that cancelling a run TEARS DOWN THE CHILD PROCESS, and the only way to prove it is
 * to hold a real pid and watch it disappear. This file therefore drives the REAL SDK — it does NOT
 * mock it — and asserts against `process.kill(pid, 0)`.
 *
 * How it runs without credentials: the SDK chooses native-vs-interpreted for
 * `Options.pathToClaudeCodeExecutable` by FILE EXTENSION (`[".js",".mjs",".tsx",".ts",".jsx"]` are
 * spawned under the SDK's default executable — `node`, or `bun` when the host itself runs under
 * Bun — anything else is spawned directly; verified in the pinned sdk.mjs), so pointing that option
 * at a `.mjs` file written into a temp dir at test time makes the SDK spawn a child we control.
 * `pathToClaudeCodeExecutable` is an already-shipped constructor option of this adapter; production
 * never passes it (`packages/app/server/src/product-boot.ts` constructs
 * `new AnthropicAdapter({ configRoot })`), so exercising it here changes nothing in production. The
 * stand-in child never speaks the CLI protocol — it writes its pid, stamps the moment its stdin is
 * ended, and blocks — which is exactly the state under test: a run in flight with a live child.
 *
 * WHAT THIS PROVES: the real SDK's teardown, driven by the real controller this adapter links
 * `ctx.signal` to, ends a real child process, rung by rung. WHAT IT DOES NOT PROVE: anything about
 * the vendor `claude` binary's own shutdown behaviour beyond what the process-level ladder forces
 * on it — the child here is a stand-in, and the ladder signals its pid, never a process group.
 *
 * This file waits on real timers and costs roughly 18s of wall clock, about 7s of which is the
 * forced-kill rung and about 8s the no-signal arm sitting out the whole window. That is the test
 * working, not a hang.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, AuthMode, RunContext, StepReport } from '@rayspec/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter } from './index.js';

/**
 * The SDK's teardown ladder for an aborted query, read out of the pinned sdk.mjs (0.3.185) and
 * re-measured by the arms below: stdin is ended immediately; if the child is still alive after a
 * 2000 ms grace it is sent SIGTERM; if it is STILL alive 5000 ms after that it is sent SIGKILL. Both
 * escalation timers are `unref()`ed. So the worst case is a little over seven seconds, and every
 * bound in this file is set generously above the rung it is waiting for rather than pinned to a
 * latency — a slow machine must not turn a passing invariant into a flake.
 */
const GRACE_THEN_TERMINATE_MS = 2_000;
const FORCED_KILL_MS = 7_000;

/** Ample headroom over the rung being waited for; the assertion is "gone", never "gone at exactly". */
const WAIT_FOR_TERMINATE_MS = 20_000;
const WAIT_FOR_FORCED_KILL_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every stand-in child this file creates, and every temp dir it creates. Registered BEFORE the
 * child can be spawned, not after its pid has been read back: an arm that fails between the spawn
 * and the read-back would otherwise leave a live `node` process behind for good — the SDK's own
 * process-exit hook does not reclaim it when a vitest worker goes away.
 */
const children: { pidPath: string }[] = [];
const tempDirs: string[] = [];

/** The pid the stand-in child published, if it has published one yet. */
function readPid(pidPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  for (const child of children) {
    // Writing the pid is the child's first statement, so a short poll is enough to catch one that a
    // failing arm spawned but never read back. On every normal path the file is already there.
    let pid = readPid(child.pidPath);
    for (let i = 0; pid === undefined && i < 40; i++) {
      await sleep(50);
      pid = readPid(child.pidPath);
    }
    if (pid === undefined) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone — the normal case */
    }
  }
  children.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the pid is gone, or give up after `budgetMs`. Returns the elapsed time either way. */
async function waitUntilGone(pid: number, budgetMs: number): Promise<number> {
  const started = Date.now();
  while (alive(pid) && Date.now() - started < budgetMs) await sleep(25);
  return Date.now() - started;
}

/**
 * Write a stand-in `claude` executable that records its pid, stamps the wall-clock moment its stdin
 * is ended, and then blocks forever. `ignoreTerminate` installs a no-op SIGTERM/SIGINT handler,
 * which is how the FORCED-kill rung of the ladder is reached. The `.mjs` extension is what makes
 * the SDK spawn it under an interpreter; no executable bit is set or relied on.
 */
function writeFakeChild(opts: { ignoreTerminate: boolean }): {
  exePath: string;
  pidPath: string;
  stdinEofPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-anth-child-'));
  tempDirs.push(dir);
  const pidPath = join(dir, 'child.pid');
  const stdinEofPath = join(dir, 'stdin-eof.at');
  const exePath = join(dir, 'fake-claude.mjs');
  // Registered before the file exists, let alone before it is spawned: nothing between here and the
  // pid read-back may leak a process.
  children.push({ pidPath });
  writeFileSync(
    exePath,
    [
      `import { writeFileSync } from 'node:fs';`,
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      // Keep stdin open, and stamp the instant the SDK ends it — that is the ladder's first rung,
      // and stamping it is the only way an arm can observe the rung rather than assume it.
      `process.stdin.on('end', () => writeFileSync(${JSON.stringify(stdinEofPath)}, String(Date.now())));`,
      `process.stdin.resume();`,
      opts.ignoreTerminate ? `process.on('SIGTERM', () => {});` : '',
      opts.ignoreTerminate ? `process.on('SIGINT', () => {});` : '',
      `setInterval(() => {}, 1000);`,
      '',
    ].join('\n'),
  );
  return { exePath, pidPath, stdinEofPath };
}

/** Wait for the child to publish its pid. */
async function awaitChildPid(pidPath: string): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const pid = readPid(pidPath);
    if (pid !== undefined) return pid;
    await sleep(25);
  }
  throw new Error(`the stand-in child never wrote its pid to ${pidPath}`);
}

/** The wall-clock stamp the child wrote when its stdin was ended, or undefined if it never was. */
function readStdinEofAt(stdinEofPath: string): number | undefined {
  if (!existsSync(stdinEofPath)) return undefined;
  const at = Number(readFileSync(stdinEofPath, 'utf8'));
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

class NoopJournal {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(): Promise<{ output: unknown } | null> {
    return null;
  }
  async lookupToolCache(): Promise<{ output: unknown } | null> {
    return null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
}

const spec: AgentSpec = {
  name: 'cancellation-probe',
  instructions: 'You are a probe.',
  model: 'claude-haiku-4-5',
  input: 'block until cancelled',
  maxTurns: 2,
  tools: [],
};

function makeCtx(journal: NoopJournal, signal?: AbortSignal): RunContext {
  return {
    runId: 'run-anth-real-1',
    tenantId: 't1',
    journal,
    replay: false,
    tools: [],
    onEvent: async () => {},
    ...(signal ? { signal } : {}),
  };
}

/** Start a run against a stand-in child and return once that child is live. */
async function startRunWithLiveChild(opts: { ignoreTerminate: boolean; signal?: AbortSignal }) {
  const { exePath, pidPath, stdinEofPath } = writeFakeChild({
    ignoreTerminate: opts.ignoreTerminate,
  });
  const configRoot = mkdtempSync(join(tmpdir(), 'rayspec-anth-real-'));
  tempDirs.push(configRoot);
  const adapter = new AnthropicAdapter({ configRoot, pathToClaudeCodeExecutable: exePath });

  const run = adapter.run(spec, makeCtx(new NoopJournal(), opts.signal));
  // Subscribe now so the eventual settle is never an unhandled rejection, and stamp WHEN it settles
  // — an arm has to be able to say whether the caller got its answer before or after the child died.
  const settled = run.then(
    (res) => ({ ok: true as const, res, at: Date.now() }),
    (err: unknown) => ({ ok: false as const, err, at: Date.now() }),
  );

  const pid = await awaitChildPid(pidPath);
  return { pid, settled, stdinEofAt: () => readStdinEofAt(stdinEofPath) };
}

describe('Anthropic adapter: cancelling a run kills the real child process it drives', () => {
  it(
    'the child is alive in flight, and aborting ctx.signal makes that pid GONE and settles run()',
    { timeout: 60_000 },
    async () => {
      const controller = new AbortController();
      const { pid, settled, stdinEofAt } = await startRunWithLiveChild({
        ignoreTerminate: false,
        signal: controller.signal,
      });

      // A real, live child — the state a cancel request has to act on. Its stdin is still OPEN:
      // the first rung has not fired, so what the arm measures next is caused by the abort.
      expect(alive(pid)).toBe(true);
      expect(stdinEofAt()).toBeUndefined();

      const abortedAt = Date.now();
      controller.abort();

      // THE assertion: the pid the SDK spawned is gone. Polled, not timed — the ladder's grace is
      // seconds long and a bound tighter than the rung would be a flake, not a proof.
      const goneAfterMs = await waitUntilGone(pid, WAIT_FOR_TERMINATE_MS);
      expect(alive(pid)).toBe(false);
      // It is the ABORT that ended it, not the run finishing on its own: the ladder cannot beat its
      // own grace timer, and it must not need the forced-kill rung for a child that honours SIGTERM.
      expect(goneAfterMs).toBeGreaterThanOrEqual(GRACE_THEN_TERMINATE_MS - 250);
      expect(goneAfterMs).toBeLessThan(FORCED_KILL_MS);

      // Rung one, observed rather than assumed: the child's stdin was ended by the abort, and well
      // before the grace expired. The bound is the rung it must beat, not the latency measured.
      const stdinEofAfterAbortMs = (stdinEofAt() ?? Number.NaN) - abortedAt;
      expect(stdinEofAfterAbortMs).toBeGreaterThanOrEqual(0);
      expect(stdinEofAfterAbortMs).toBeLessThan(GRACE_THEN_TERMINATE_MS);

      // And the adapter's own promise SETTLES. A run() left pending forever would keep this run's
      // async work and its resources alive behind a caller that has already stopped waiting.
      const outcome = await settled;
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.res.status).toBe('error');
      // The caller is not made to wait for the last rung.
      expect(outcome.at - abortedAt).toBeLessThan(FORCED_KILL_MS);
    },
  );

  it(
    'a child that IGNORES the terminate signal is still killed — the ladder escalates to a forced kill',
    { timeout: 60_000 },
    async () => {
      const controller = new AbortController();
      const { pid, settled } = await startRunWithLiveChild({
        ignoreTerminate: true,
        signal: controller.signal,
      });
      expect(alive(pid)).toBe(true);

      const abortedAt = Date.now();
      controller.abort();

      const goneAfterMs = await waitUntilGone(pid, WAIT_FOR_FORCED_KILL_MS);
      const goneAt = Date.now();
      expect(alive(pid)).toBe(false);
      // It survived the terminate rung — so what ended it was the forced kill, the last rung.
      expect(goneAfterMs).toBeGreaterThanOrEqual(FORCED_KILL_MS - 250);

      // The documented cost of that: the caller already had its answer while this child was still
      // running. This is the arm behind the README's "the child can outlive the answer by seconds".
      const outcome = await settled;
      expect(outcome.at).toBeLessThan(goneAt);
      expect(outcome.at - abortedAt).toBeLessThan(FORCED_KILL_MS - 250);
    },
  );
});

describe('Anthropic adapter: with no cancellation signal the child is not touched', () => {
  it(
    'no ctx.signal ⇒ the child stays alive across the whole ladder window; nothing tears it down early',
    { timeout: 60_000 },
    async () => {
      // The no-signal arm with teeth for THIS adapter. The controller is handed to the SDK
      // unconditionally, so pinning the option key set would assert nothing; what an unconditional
      // abort or a mis-linked signal WOULD change is observable here — the child would die.
      const { pid, settled, stdinEofAt } = await startRunWithLiveChild({ ignoreTerminate: false });
      expect(alive(pid)).toBe(true);

      // Sit out the ENTIRE ladder — past the terminate rung and past the forced-kill rung that
      // follows it. Nothing has been cancelled, so no rung may fire: not the last one, and not the
      // first one either, which is why the child's stdin is still open at the end of the window.
      await sleep(FORCED_KILL_MS + 1_000);
      expect(alive(pid)).toBe(true);
      expect(stdinEofAt()).toBeUndefined();

      // End the run the only other way it can end — the child exits — and confirm the adapter still
      // returns a RunResult rather than hanging.
      process.kill(pid, 'SIGKILL');
      const outcome = await settled;
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.res.runId).toBe('run-anth-real-1');
    },
  );
});
