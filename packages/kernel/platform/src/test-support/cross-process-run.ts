/**
 * The SECOND PROCESS for the cross-process cancellation test — and the run shape both sides share.
 *
 * A cancellation that has to cross a process boundary cannot be proven inside one process: the
 * in-process signal registry would reach the run whether or not anything durable did. So this file
 * is BOTH a library and an executable. The test imports {@link runDurableShapeCancellable} and runs
 * one arm with it IN-PROCESS (the control, cancelled through the in-process signal); it also spawns
 * this same file as a REAL child process, which runs the identical function against the identical
 * schema over its own connections. The two arms are therefore the same code reached two ways, which
 * is what lets the test compare their terminal state and journal for equality and mean it.
 *
 * THE SHAPE IS THE DURABLE ONE, because that is the shape the boundary exists in: an enqueue-time
 * `runs` header committed BEFORE the run (the run surface writes it outside the run's transaction,
 * so a run that rolls back still has a header to move), then `runAgent` inside `tdb.transaction()`
 * with a SEPARATE autonomous-commit handle for `taintDb`. The catch mirrors the durable worker: a
 * run that ends by throwing rolled its transaction back, taking any record it made with it, so the
 * cancellation is recorded AFTER the rollback on the autonomous handle — the same guarded,
 * idempotent transition the cancel surface makes.
 *
 * The child prints one JSON object per stdout line: `{"phase":"in-gate"}` once the run is in flight
 * inside its transaction with its journal step already written, then `{"phase":"done",...}` with the
 * outcome. The parent uses the first line as its barrier — never a sleep — and the second as the
 * observation.
 *
 * This lives under `test-support/` deliberately: that directory is excluded from the package build
 * and from `typecheck`, from the tenant-chokepoint gate, and from the Biome ban on `@rayspec/db`'s
 * raw `/testing` subpath — the same carve-out `test-db.ts` beside it already relies on.
 */
import { pathToFileURL } from 'node:url';
import type { AgentSpec, Backend, NeutralTool, RunContext, RunResult } from '@rayspec/core';
import type { TenantDb } from '@rayspec/db';
import { isRunCancelled, recordRunCancelled } from '../run-cancel.js';
import { runAgent } from '../run-core.js';
import { insertEnqueuedRunHeader } from '../run-header.js';
import { forTenant, makeTestDb } from './test-db.js';

/** The agent spec both arms run — no tools by default, so nothing but the run itself is exercised. */
export const CROSS_PROCESS_SPEC: AgentSpec = {
  name: 'extract',
  instructions: 'extract fields',
  model: 'gpt-4.1-mini',
  input: 'a transcript',
  tools: [],
  maxTurns: 8,
};

/** What one arm asks for. Identical fields on both sides; the child receives it as argv[2] JSON. */
export interface CrossProcessRunConfig {
  readonly runId: string;
  readonly tenantId: string;
  /** How long the backend holds the run after journaling its step — the window a cancel must beat. */
  readonly gateMs: number;
  /** Fire a NON-IDEMPOTENT tool before the gate, so the run is quarantined when it is cancelled. */
  readonly fireNonIdempotentTool: boolean;
}

/** What an arm ended as. `cancelled` is the durable worker's own classification of a rejection. */
export interface CrossProcessRunOutcome {
  readonly outcome: 'completed' | 'cancelled' | 'failed';
  /** The rejection's class name when the run ended by throwing, else null. */
  readonly errorName: string | null;
}

/** The side effect a NON-IDEMPOTENT tool has: firing it twice for one run is a real double-charge. */
function nonIdempotentTool(): NeutralTool {
  return {
    spec: {
      name: 'charge_card',
      description: 'Charge the customer (SIDE EFFECT — moves money).',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    handler: (args: unknown) => {
      const { amount } = (args ?? {}) as { amount?: number };
      return { charged: amount ?? 0 };
    },
    timeoutMs: 5000,
    idempotent: false,
  };
}

/**
 * A backend that journals ONE `llm` step and then holds the run for `gateMs`.
 *
 * The step is what makes the difference between the two behaviours legible in the journal rather than
 * only on the clock: it is written INSIDE the run's transaction, so it survives iff that transaction
 * commits. A run that is ended while it is held rolls back and leaves only the cancellation step; a
 * run that is never ended runs the gate out, commits, and leaves both.
 */
export class GatedRunBackend implements Backend {
  readonly id = 'openai' as const;
  /** Fires once the run is in flight with its journal step written — the barrier, never a sleep. */
  onGate?: () => void;
  /** What `ctx.signal` looked like when the run started, and whether it aborted while held. */
  sawAbortedAtEntry?: boolean;
  sawAbort = false;

  constructor(private readonly cfg: CrossProcessRunConfig) {}

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.sawAbortedAtEntry = ctx.signal?.aborted;
    ctx.signal?.addEventListener('abort', () => {
      this.sawAbort = true;
    });
    // The taint marker is written by the dispatch chokepoint, on the AUTONOMOUS handle, BEFORE the
    // handler runs — so it is already committed when the cancellation lands and survives the rollback.
    if (this.cfg.fireNonIdempotentTool && ctx.dispatchTool) {
      await ctx.dispatchTool('charge_card', { amount: 42 }, 'cross-process-call-1');
    }
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: 'llm:cross-process:0',
      inputHash: 'hash:cross-process',
      output: { finalText: 'done' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'gated-run-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    this.onGate?.();
    await new Promise((r) => setTimeout(r, this.cfg.gateMs));
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

/**
 * Run ONE arm in the durable invocation shape and report how it ended.
 *
 * `rawDb` is the raw Drizzle handle the caller owns; the two `forTenant` handles minted from it are
 * the run's transactional one and the autonomous-commit one, exactly as the durable worker mints them.
 * `taintDbOverride` replaces only the autonomous one, so a test can observe or break exactly the
 * handle the poll reads through; the child never passes it.
 */
export async function runDurableShapeCancellable(
  rawDb: Parameters<typeof forTenant>[0],
  cfg: CrossProcessRunConfig,
  backend: GatedRunBackend,
  taintDbOverride?: TenantDb,
): Promise<CrossProcessRunOutcome> {
  const tdb: TenantDb = forTenant(rawDb, cfg.tenantId);
  // The enqueue-time header the run surface commits before the job is handed over. Without it a run
  // that rolls back leaves NO `runs` row at all, and the terminal comparison would compare absences.
  await insertEnqueuedRunHeader(tdb, {
    runId: cfg.runId,
    backend: backend.id,
    agentName: CROSS_PROCESS_SPEC.name,
    model: CROSS_PROCESS_SPEC.model,
  });
  const taintDb: TenantDb = taintDbOverride ?? forTenant(rawDb, cfg.tenantId);
  const tools = cfg.fireNonIdempotentTool ? [nonIdempotentTool()] : undefined;
  try {
    await tdb.transaction((txTdb) =>
      runAgent(txTdb, backend, CROSS_PROCESS_SPEC, {
        runId: cfg.runId,
        taintDb,
        ...(tools ? { tools } : {}),
      }),
    );
    return { outcome: 'completed', errorName: null };
  } catch (err) {
    // The durable worker's contract, reproduced: a run that ends by THROWING rolled its transaction
    // back, so anything run-core wrote inside it — including a cancellation it recorded — is gone.
    // Record it here instead, after the rollback, on the autonomous handle, where the header row is
    // free. A run that failed for its own reasons is reported as the failure it was.
    const errorName = err instanceof Error ? err.name : String(err);
    if (!(await isRunCancelled(taintDb, cfg.runId))) return { outcome: 'failed', errorName };
    await recordRunCancelled(taintDb, cfg.runId);
    return { outcome: 'cancelled', errorName };
  }
}

/** One stdout line, one JSON object — the child's whole protocol with its parent. */
function announce(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error('cross-process-run: missing config argument');
  const cfg = JSON.parse(raw) as CrossProcessRunConfig;
  // The SAME connection factory and the SAME fixed schema the parent suite uses, so both arms read
  // and write one set of tables.
  const db = makeTestDb();
  const backend = new GatedRunBackend(cfg);
  backend.onGate = () => announce({ phase: 'in-gate' });
  try {
    const result = await runDurableShapeCancellable(db, cfg, backend);
    announce({ phase: 'done', ...result, sawAbort: backend.sawAbort });
  } finally {
    await db.$client.end();
  }
}

// Executable ONLY when this file is the process entrypoint; importing it from the suite runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    announce({ phase: 'crashed', message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
