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
 * The second test is the kill ladder: the SDK signals with a plain SIGTERM and never escalates, so a
 * child that ignores it would survive and — because the SDK drives the turn with a readline loop over
 * that child's stdout — keep run() open for good. The adapter starts the binary through a launcher
 * that forwards the SIGTERM and sends SIGKILL after the run's kill grace, so the child is gone and
 * run() settles within the grace. The third test is the provider-call timeout: a child that never says
 * anything is ended by the silence window alone, with nothing cancelling the run.
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
/** The kill grace the ladder tests run with: SIGKILL follows an ignored SIGTERM after this long. */
const KILL_GRACE_MS = 300;
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
  opts: { ignoresSigterm?: boolean; grandchildPidFile?: string } = {},
): string {
  const bin = join(dir, 'codex');
  const pid = JSON.stringify(pidFile);
  // A grandchild that inherits the binary's stdout, ignores SIGTERM and lives 20 s: it holds the pipe
  // the launcher relays open after the binary itself is gone.
  const grandchild =
    opts.grandchildPidFile === undefined
      ? []
      : [
          "const { spawn } = require('node:child_process');",
          `const gc = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(
            "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);",
          )}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
          `writeFileSync(${JSON.stringify(opts.grandchildPidFile)}, String(gc.pid));`,
        ];
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const { writeFileSync, renameSync } = require('node:fs');",
      ...grandchild,
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

  it('a child that IGNORES SIGTERM is killed after the kill grace, and run() settles', async () => {
    // The SDK spawns with `spawn(path, args, { env, signal })` — no `killSignal`, no escalation — so
    // aborting sends one SIGTERM, and a child that ignores it would keep the SDK's stdout loop (and
    // run()) open for good. The kill ladder forwards that SIGTERM and follows it with a SIGKILL after
    // the run's kill grace. If this test ever fails because the child survived, the ladder is broken:
    // do not relax the budget to make it pass.
    expect(process.env.CODEX_HOME).toBeUndefined();
    codexPathOverride = writeFakeCodexBinary(dir, pidFile, { ignoresSigterm: true });

    const journal = new FakeJournal();
    const controller = new AbortController();
    const ctx: RunContext = {
      runId: 'run-codex-cancel-ladder',
      tenantId: 'tenant-test',
      journal,
      replay: false,
      authMode: 'codex-subscription-oauth',
      tools: [],
      signal: controller.signal,
      limits: { killGraceMs: KILL_GRACE_MS },
    };
    const adapter = new CodexAdapter({ codexPathOverride, codexHome: dir });

    const run = adapter.run({ ...baseSpec }, ctx);

    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leakedPid = pid;
    expect(isAlive(pid)).toBe(true);

    const abortedAt = Date.now();
    controller.abort();

    // The child ignored the SIGTERM, so for the grace it is still there…
    await delay(KILL_GRACE_MS / 3);
    expect(isAlive(pid)).toBe(true);
    // …and then the SIGKILL ends it, and run() settles.
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    const goneAfterMs = Date.now() - abortedAt;
    expect(goneAfterMs).toBeGreaterThanOrEqual(KILL_GRACE_MS - 50);
    const outcome = await Promise.race([
      run.then(() => 'settled' as const),
      delay(BUDGET_MS, 'still pending' as const),
    ]);
    expect(outcome).toBe('settled');
    const res = await run;
    expect(res.status).toBe('error');
    expect(res.backend).toBe('codex');
  });

  it('a child whose own child holds its stdout: the whole group is killed and run() settles', async () => {
    // The binary ignores SIGTERM and has started a process that inherited its stdout. Killing the
    // binary alone would leave that process holding the pipe the launcher relays, and run() open
    // until it exits by itself (20 s here). The launcher signals the binary's whole process group and
    // never waits on the relayed pipe beyond the grace.
    expect(process.env.CODEX_HOME).toBeUndefined();
    const grandchildPidFile = join(dir, 'grandchild.pid');
    codexPathOverride = writeFakeCodexBinary(dir, pidFile, {
      ignoresSigterm: true,
      grandchildPidFile,
    });
    const controller = new AbortController();
    const ctx: RunContext = {
      runId: 'run-codex-cancel-group',
      tenantId: 'tenant-test',
      journal: new FakeJournal(),
      replay: false,
      authMode: 'codex-subscription-oauth',
      tools: [],
      signal: controller.signal,
      limits: { killGraceMs: KILL_GRACE_MS },
    };
    const adapter = new CodexAdapter({ codexPathOverride, codexHome: dir });
    const run = adapter.run({ ...baseSpec }, ctx);

    expect(await waitFor(() => existsSync(pidFile) && existsSync(grandchildPidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const grandchild = Number(readFileSync(grandchildPidFile, 'utf8'));
    leakedPid = pid;
    try {
      expect(isAlive(grandchild)).toBe(true);
      const abortedAt = Date.now();
      controller.abort();
      const outcome = await Promise.race([
        run.then(() => 'settled' as const),
        delay(5_000, 'still pending' as const),
      ]);
      expect(outcome).toBe('settled');
      expect(Date.now() - abortedAt).toBeLessThan(KILL_GRACE_MS + 3_000);
      expect(await waitFor(() => !isAlive(pid) && !isAlive(grandchild))).toBe(true);
    } finally {
      if (isAlive(grandchild)) process.kill(grandchild, 'SIGKILL');
    }
  });

  it('a child that says NOTHING is ended by the provider-call timeout, with no cancellation', async () => {
    expect(process.env.CODEX_HOME).toBeUndefined();
    codexPathOverride = writeFakeCodexBinary(dir, pidFile, { ignoresSigterm: true });
    const journal = new FakeJournal();
    const ctx: RunContext = {
      runId: 'run-codex-timeout',
      tenantId: 'tenant-test',
      journal,
      replay: false,
      authMode: 'codex-subscription-oauth',
      tools: [],
      limits: { providerCallTimeoutMs: 300, killGraceMs: KILL_GRACE_MS },
    };
    const adapter = new CodexAdapter({ codexPathOverride, codexHome: dir });
    const startedAt = Date.now();
    const run = adapter.run({ ...baseSpec }, ctx);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    leakedPid = pid;

    const res = await Promise.race([run, delay(BUDGET_MS, undefined)]);
    expect(res).toBeDefined();
    expect(res?.status).toBe('error');
    expect(res?.errorClass).toBe('timeout');
    expect(res?.error).toContain('RAYSPEC_AGENT_REQUEST_TIMEOUT_MS');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    // The child ignored the SIGTERM the timeout led to; the ladder killed it.
    expect(isAlive(pid)).toBe(false);
  });
});
