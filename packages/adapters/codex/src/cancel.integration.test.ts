/**
 * Codex adapter — cancellation against a REAL child process, through the REAL `@openai/codex-sdk`.
 *
 * The rest of the suite mocks `@openai/codex-sdk`, so it can only show that a boolean flipped on the
 * controller the adapter hands to `runStreamed`. This file deliberately does NOT mock the SDK: the
 * real `Codex` class runs, the real `CodexExec` spawns a real child with `spawn(..., { signal })`,
 * and the assertions are made against that child's REAL pid.
 *
 * The child is a fake `codex` executable this file WRITES into a temp dir at test time (so the
 * executable bit is set here rather than depended on from the repository) and points the adapter at
 * through `CodexAdapterOptions.codexPathOverride`. It emits nothing and never exits on its own, which
 * is what makes the turn genuinely in flight. Consequences worth being exact about:
 *   - no credential file is read and no network is touched — the real `codex` CLI is never executed,
 *     so nothing here says anything about how the real CLI reacts to being signalled. (`codexHome`
 *     points at the credential-free temp dir, and `vitest.setup.ts` drops `CODEX_HOME` from the env
 *     because `resolveCodexHome()` lets that ambient variable OVERRIDE the constructor option.);
 *   - what IS proven is the adapter's own contract: the run's signal reaches a real spawned process,
 *     that process ends, and `adapter.run()` settles instead of hanging.
 *
 * The second test pins the OTHER side of that contract — the residual limit the README states. The
 * SDK signals with a plain SIGTERM and never escalates, so a child that ignores it survives; and
 * because the SDK drives the turn with a readline loop over that child's stdout, run() then does not
 * settle at all and its teardown (the tool bridge included) never runs. That is measured here rather
 * than assumed, so the README cannot quietly drift into claiming more than the adapter delivers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthMode, JournalSink, RunContext, StepReport } from '@rayspec/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './index.js';

/** Fake in-memory JournalSink (this file never touches Postgres). */
class FakeJournal implements JournalSink {
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

const baseSpec = {
  name: 'agent',
  instructions: 'You are concise.',
  model: 'gpt-5.5',
  input: 'Say ok.',
  tools: [],
  maxTurns: 8,
} as const;

/** How long a bounded wait is given before the test calls the thing it waited for stuck. */
const BUDGET_MS = 10_000;
/**
 * How long the LIMIT test waits before calling run() unsettled. It is a lower bound, not a proof of
 * "never": what makes it "never" is the mechanism (the SDK's readline loop over a stdout that stays
 * open), and the contrast is that the working path above settles in milliseconds once the child dies.
 */
const UNSETTLED_BUDGET_MS = 2_000;
const POLL_MS = 25;

/**
 * Write the fake `codex` executable. It publishes its own pid (atomically, via a rename, so the test
 * can never read a half-written file) and then stays alive: the SDK reads its stdout line by line, so
 * a child that writes nothing keeps the streamed turn open until something ends the process.
 *
 * `ignoresSigterm` installs an empty SIGTERM handler — the stand-in for the residual limit that the
 * SDK signals and never escalates.
 */
function writeFakeCodexBinary(
  dir: string,
  pidFile: string,
  opts: { ignoresSigterm?: boolean } = {},
): string {
  const bin = join(dir, 'codex');
  const pid = JSON.stringify(pidFile);
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const { writeFileSync, renameSync } = require('node:fs');",
      `writeFileSync(${pid} + '.tmp', String(process.pid));`,
      `renameSync(${pid} + '.tmp', ${pid});`,
      ...(opts.ignoresSigterm ? ["process.on('SIGTERM', () => {});"] : []),
      // Self-destruct. `afterEach` kills this child on every ordinary path, but if the runner itself
      // is killed without running hooks the child is reparented to init and would otherwise live
      // forever — it never exits on its own.
      'setTimeout(() => process.exit(0), 60000);',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

/** True while the process exists (a signal of 0 only probes; ESRCH means it is gone). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` until it holds or the budget runs out; returns whether it held. */
async function waitFor(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(POLL_MS);
  }
  return check();
}

describe('Codex adapter: cancelling a run ends the REAL spawned child and run() settles', () => {
  let dir: string;
  let pidFile: string;
  let codexPathOverride: string;
  let leakedPid: number | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-cancel-'));
    pidFile = join(dir, 'child.pid');
    codexPathOverride = writeFakeCodexBinary(dir, pidFile);
    leakedPid = undefined;
  });

  afterEach(() => {
    // Never leave a process behind, whatever the assertions did. `leakedPid` is only set once a test
    // has read the pid file, so fall back to the file itself: a test that failed BEFORE reading it
    // would otherwise orphan a child that never exits on its own.
    const pid =
      leakedPid ?? (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined);
    if (pid !== undefined && Number.isInteger(pid) && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('the child is spawned, ctx.signal ends it, and run() resolves to a neutral error result', async () => {
    const journal = new FakeJournal();
    const controller = new AbortController();
    const ctx: RunContext = {
      runId: 'run-codex-cancel',
      tenantId: 'tenant-test',
      journal,
      replay: false,
      authMode: 'codex-subscription-oauth',
      tools: [],
      signal: controller.signal,
    };
    // `codexHome` points at the (credential-free) temp dir: this run neither reads nor needs an
    // auth.json, which is the point of driving the SDK against a fake executable. That holds only
    // because `vitest.setup.ts` drops `CODEX_HOME` — `resolveCodexHome()` prefers the ambient
    // variable over this option, and so does the curated child env.
    expect(process.env.CODEX_HOME).toBeUndefined();
    const adapter = new CodexAdapter({ codexPathOverride, codexHome: dir });

    const run = adapter.run({ ...baseSpec }, ctx);

    // A REAL child exists and is running.
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leakedPid = pid;
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).not.toBe(process.pid);
    expect(isAlive(pid)).toBe(true);

    // Cancel the run the way the platform does: abort the signal on the RunContext.
    controller.abort();

    // Both halves of the claim: the process ends, AND the adapter stops holding its caller.
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    const settled = await Promise.race([
      run.then(() => 'settled' as const),
      delay(BUDGET_MS, 'still pending' as const),
    ]);
    expect(settled).toBe('settled');

    // A cancelled turn is reported as a neutral error result — the adapter never throws out of run(),
    // and the terminal `cancelled` state is the platform's to journal, not this adapter's.
    const res = await run;
    expect(res.status).toBe('error');
    expect(res.backend).toBe('codex');
    expect(typeof res.error).toBe('string');
    expect(res.errorClass).not.toBeNull();
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });

  it('LIMIT: a child that IGNORES SIGTERM survives, and run() then does NOT settle', async () => {
    // The residual limit, measured rather than asserted. `@openai/codex-sdk` spawns with
    // `spawn(this.executablePath, commandArgs, { env, signal: args.signal })` — no `killSignal`, no
    // escalation — so aborting the signal sends one SIGTERM. It then drives the turn with
    // `for await (const line of rl)` over the child's stdout and only afterwards awaits the exit. A
    // child that ignores SIGTERM keeps that stdout open, so the loop never ends, run() never returns,
    // and its `finally` — `unlinkCancel()`, `abort.abort()` and the MCP bridge teardown — never runs
    // at all. Cancellation therefore bounds the bridge teardown only once the turn ends; it cannot
    // rescue a run whose child refuses to die. This test exists so that limit stays stated honestly
    // in the README and in `docs/spec-reference.md`.
    //
    // What this test does NOT distinguish, said plainly: 'still pending' + a live child is also what
    // a completely broken cancellation produces, so those two assertions alone do not show the signal
    // reached the child. The test above is what shows that (roll `linkAbort` back and it reddens
    // while this one stays green); the SIGKILL at the end is what shows the hang was the child's
    // survival rather than anything else in the adapter. If this test ever fails because run() DID
    // settle, the limit was fixed — say so in the README and in the per-backend table, and do not
    // relax the budget to make it pass again.
    expect(process.env.CODEX_HOME).toBeUndefined();
    codexPathOverride = writeFakeCodexBinary(dir, pidFile, { ignoresSigterm: true });

    const journal = new FakeJournal();
    const controller = new AbortController();
    const ctx: RunContext = {
      runId: 'run-codex-cancel-limit',
      tenantId: 'tenant-test',
      journal,
      replay: false,
      authMode: 'codex-subscription-oauth',
      tools: [],
      signal: controller.signal,
    };
    const adapter = new CodexAdapter({ codexPathOverride, codexHome: dir });

    const run = adapter.run({ ...baseSpec }, ctx);

    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leakedPid = pid;

    controller.abort();

    const outcome = await Promise.race([
      run.then(() => 'settled' as const),
      delay(UNSETTLED_BUDGET_MS, 'still pending' as const),
    ]);
    // The test above settles in milliseconds once its child dies; this one is still pending, and the
    // child is still there. Both halves are the limit.
    expect(outcome).toBe('still pending');
    expect(isAlive(pid)).toBe(true);

    // SIGKILL cannot be ignored: the stdout closes, the turn ends, and run() settles the ordinary
    // way — which also proves the hang was the child's survival and nothing else in the adapter.
    process.kill(pid, 'SIGKILL');
    const res = await run;
    expect(res.status).toBe('error');
    expect(res.backend).toBe('codex');
  });
});
