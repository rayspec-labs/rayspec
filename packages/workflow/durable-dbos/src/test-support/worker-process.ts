/**
 * A REAL second worker process for the cross-process cancellation test: it launches its own DBOS
 * engine (the real `DbosDurableExecutor`), enqueues one agent run, executes it, and reports how the
 * run's workflow ended. Its backend journals one step and then holds the provider call until the run's
 * signal aborts it — the way a provider SDK honours its signal — so a cancellation that reaches this
 * process ends the call at once.
 *
 * The parent never signals this process: it writes the cancellation record on its own connection, as
 * the cancel surface of another process does. Whatever ends the run here has to come through the
 * database.
 *
 * Protocol: one JSON object per stdout line — `{"phase":"in-call"}` once the provider call is held,
 * then `{"phase":"done","status":…,"sawAbort":…}`. Excluded from the package build.
 */
import { pathToFileURL } from 'node:url';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { insertEnqueuedRunHeader, type RunJob } from '@rayspec/platform';
import { DbosDurableExecutor, type ResolvedRun } from '../executor.js';

export interface WorkerProcessConfig {
  readonly appUrl: string;
  readonly appSchema: string;
  readonly systemDatabaseUrl: string;
  readonly name: string;
  readonly tenantId: string;
  readonly runId: string;
}

export const WORKER_SPEC: AgentSpec = {
  name: 'held',
  instructions: 'hold',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 2,
};

function announce(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Journals one step, then holds the call until the run's signal aborts it (at most a minute). */
class HeldCallBackend implements Backend {
  readonly id = 'openai' as const;
  sawAbort = false;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: 'llm:held:0',
      inputHash: 'hash:held',
      output: { finalText: 'partial' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'held-call-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    announce({ phase: 'in-call' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      const onAbort = () => {
        this.sawAbort = true;
        clearTimeout(timer);
        const err = new Error('the provider call was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error('worker-process: missing config argument');
  const cfg = JSON.parse(raw) as WorkerProcessConfig;
  const db = makeDbWithSchema(cfg.appUrl, cfg.appSchema);
  const backend = new HeldCallBackend();
  const executor = new DbosDurableExecutor(
    {
      db,
      resolveRun: (): ResolvedRun => ({ backend, spec: WORKER_SPEC }),
    },
    { name: cfg.name, systemDatabaseUrl: cfg.systemDatabaseUrl, workerConcurrency: 1 },
  );
  try {
    await executor.start();
    await insertEnqueuedRunHeader(forTenant(db, cfg.tenantId), {
      runId: cfg.runId,
      backend: backend.id,
      agentName: WORKER_SPEC.name,
      model: WORKER_SPEC.model,
    });
    const job: RunJob = {
      runId: cfg.runId,
      tenantId: cfg.tenantId,
      agentId: 'held-agent',
      input: 'hold',
    };
    await executor.enqueue(cfg.tenantId, job);
    let status = await executor.status(cfg.runId);
    while (status === 'enqueued' || status === 'running' || status === 'unknown') {
      await new Promise((r) => setTimeout(r, 50));
      status = await executor.status(cfg.runId);
    }
    announce({ phase: 'done', status, sawAbort: backend.sawAbort });
  } finally {
    await executor.shutdown().catch(() => {});
    await db.$client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    announce({ phase: 'crashed', message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
