import { createHash } from 'node:crypto';
import type { AgentSpec, Backend, NeutralTool, RunResult } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  CapabilityNodeHandler,
} from '@rayspec/foundation';
import { isRunTainted, runAgent } from '@rayspec/platform';
import { eq } from 'drizzle-orm';
import { AGENT_RERUN_HAZARD_CODE } from '../engine.js';

/** A declared agent resolved for a workflow AGENT node — the base spec + backend + optional tools. */
export interface ResolvedAgentNode {
  readonly backend: Backend;
  /** The base neutral spec (instructions/model/outputSchema/maxTurns); `input` is set per node run. */
  readonly spec: AgentSpec;
  /** Static neutral tools; prefer `toolFactory` when a per-run tenant-bound factory is available. */
  readonly tools?: NeutralTool[];
  /** Build the run's tenant-bound tools (a declared agent's per-run factory). */
  readonly toolFactory?: (tdb: TenantDb) => NeutralTool[];
}

export interface AgentNodeDeps {
  /** The run's tenant-scoped db — `runAgent` journals the agent sub-run under it (tenant-scoped). */
  readonly tenantDb: TenantDb;
  /** Resolve an agent id (`agent.<id>` node → `<id>`) against the deployed registry. */
  readonly resolve: (agentId: string) => ResolvedAgentNode | undefined;
}

/**
 * Build the AGENT-node handler: a workflow `agent.<id>` node runs through
 * the EXISTING provider-agnostic `runAgent` path — NOT a new SDK integration. The neutral `Backend`
 * interface stays untouched; this only ADAPTS a workflow node onto `runAgent`:
 *  - the agent id is the node's `operation` (the bridge compiles `use: agent.<id>` → operation `<id>`);
 *  - the run's INPUT is the node's input + its upstream artifacts, serialized deterministically (so the
 *    same node input yields the same agent run — stable idempotency + a stable sub-run id);
 *  - the agent SUB-RUN id is deterministic from `(workflowRunId, nodeId)`, so a resumed workflow that
 *    re-runs an un-completed agent node reconciles to the same `runs`/journal rows;
 *  - a completed run's structured `output` becomes a typed artifact_ref the downstream nodes consume;
 *  - a TRANSIENT error (`rate_limited`/`upstream_5xx`/`timeout`) maps to `retryable_failure` (the node
 *    retry policy may re-attempt); any other error is a `terminal_failure` (the node failure policy
 *    then decides drop/quarantine/repair/fail).
 *
 * CRASH-RESUME SAFETY. The deterministic sub-run id lets a resumed node RECONCILE to the
 * prior run, but `runAgent` does NOT itself dedup a FRESH (`replay=false`) invocation — it re-invokes the
 * model and RE-FIRES any non-idempotent tool. So BEFORE (re-)invoking `runAgent` the handler consults the
 * sub-run's DURABLE state (the platform's own exactly-once primitives, no new surface — "guard at
 * the scope of the entity that owns the write"):
 *   1. ATTACH — a prior invocation already COMPLETED this exact sub-run (its `runs` header is terminal
 *      'completed'): reconstruct the completed artifact FROM THE HEADER and return it, never re-running.
 *      This covers the exact hazard window (crash AFTER the agent completed but BEFORE the engine journaled
 *      the node 'completed') — a re-run there would double-fire a side effect the completed run already ran.
 *   2. QUARANTINE (fail-closed) — a prior invocation fired a NON-idempotent tool (the `run_taint` marker,
 *      written by dispatch on its own connection BEFORE the side effect, survives the crash) but did NOT
 *      complete (no 'completed' header to attach to): attaching is impossible and re-running would DOUBLE-
 *      fire, so surface an `agent_rerun_hazard` the engine PARKS (quarantine, manual review) — never a
 *      silent re-fire. This mirrors `run-taint.ts`'s quarantine posture for automated re-runs.
 *   3. RUN — no completed sub-run + no non-idempotent side effect fired yet: safe to (re-)run fresh.
 * (The `runs` header is read through the same tenant-scoped chokepoint `runAgent` writes it through, so
 * the reconciliation can never cross tenants.)
 */
export function makeAgentNodeHandler(deps: AgentNodeDeps): CapabilityNodeHandler {
  return async (context: CapabilityInvocationContext): Promise<CapabilityInvocationResult> => {
    const agentId = context.step.operation;
    const resolved = deps.resolve(agentId);
    if (!resolved) {
      return {
        status: 'terminal_failure',
        error: {
          code: 'unknown_agent',
          message: `agent node '${context.step.id}' references undeclared agent '${agentId}'.`,
          retryable: false,
        },
      };
    }

    const input = buildAgentInput(context);
    const spec: AgentSpec = { ...resolved.spec, input };
    // Seed the deterministic agent SUB-RUN id from the PARENT workflow run id (on the context journal)
    // + this node — so a resumed workflow that re-runs an un-completed agent node reconciles to the
    // same runs/journal rows. The engine sets `journal.workflow_run_id` = the durable workflow run id.
    const runId = agentSubRunId(context.journal.workflow_run_id, context.step.id);

    // ── CRASH-RESUME SAFETY ─────────────────────────────────────────────────────────────────────────
    // 1. ATTACH: this exact sub-run already completed — reuse it, never re-run (also never re-fires a
    //    side effect the completed run already ran).
    const attached = await loadCompletedSubRun(deps.tenantDb, runId, agentId, context.step.id);
    if (attached) return attached;
    // 2. QUARANTINE (fail-closed): a prior invocation fired a non-idempotent tool but did not complete —
    //    re-running would double-fire, and there is no terminal output to attach to. Park it.
    if (await isRunTainted(deps.tenantDb, runId)) {
      return {
        status: 'terminal_failure',
        error: {
          code: AGENT_RERUN_HAZARD_CODE,
          message:
            `agent node '${context.step.id}' (sub-run ${runId}) already fired a non-idempotent tool but ` +
            'did not complete; re-running would double-fire the side effect. Quarantined for manual review.',
          retryable: false,
        },
      };
    }

    const tools = resolved.toolFactory ? resolved.toolFactory(deps.tenantDb) : resolved.tools;

    let result: RunResult;
    try {
      result = await runAgent(deps.tenantDb, resolved.backend, spec, {
        runId,
        ...(tools ? { tools } : {}),
      });
    } catch (e) {
      return {
        status: 'terminal_failure',
        error: {
          code: 'agent_run_exception',
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        },
      };
    }

    if (result.status === 'completed') {
      const artifact: ArtifactRef = {
        id: `${context.step.id}:agent_output`,
        kind: `agent.${agentId}.output`,
        source_node_id: context.step.id,
        value: { runId: result.runId, output: result.output, finalText: result.finalText },
      };
      return {
        status: 'completed',
        artifact_refs: [artifact],
        output: { runId: result.runId, output: result.output, finalText: result.finalText },
      };
    }

    const retryable = isTransientErrorClass(result.errorClass);
    return {
      status: retryable ? 'retryable_failure' : 'terminal_failure',
      error: {
        code: `agent_${result.errorClass ?? 'error'}`,
        message: result.error ?? `agent run failed (${result.errorClass ?? 'unknown'})`,
        retryable,
      },
    };
  };
}

/**
 * Serialize the node's input + upstream artifacts into the agent run's `input` string. Deterministic
 * (stable key order via JSON.stringify of a plain object with a fixed shape) so the same node input
 * always produces the same agent run (stable idempotency + a stable sub-run id). The agent's declared
 * instructions drive it; this is the DATA context it reads.
 */
function buildAgentInput(context: CapabilityInvocationContext): string {
  const payload = {
    input: context.input,
    artifacts: (context.artifacts ?? []).map((a) => ({ id: a.id, kind: a.kind, value: a.value })),
  };
  const serialized = JSON.stringify(payload);
  // AgentSpec.input is z.string().min(1); a non-empty JSON blob always satisfies it.
  return serialized.length > 0 ? serialized : '{}';
}

/**
 * ATTACH: read the deterministic sub-run's `runs` header (tenant-scoped chokepoint) and, IFF it is
 * terminal 'completed', reconstruct the node's completed result WITHOUT re-running the agent. Returns
 * undefined when there is no header, or the header is not 'completed' (a non-completed header is not
 * attach-worthy — its output is not a settled artifact; the taint gate then decides re-run vs quarantine).
 * The reconstructed artifact/output shape is byte-identical to the live-completed path below (same
 * `{ runId, output, finalText }`), so a downstream node cannot tell an attached resume from a fresh run.
 */
async function loadCompletedSubRun(
  tdb: TenantDb,
  runId: string,
  agentId: string,
  nodeId: string,
): Promise<CapabilityInvocationResult | undefined> {
  const rows = (await tdb
    .select(schema.runs, {
      status: schema.runs.status,
      output: schema.runs.output,
      finalText: schema.runs.finalText,
    })
    .where(eq(schema.runs.runId, runId))
    .limit(1)) as Array<{ status: string; output: unknown; finalText: string | null }>;
  const row = rows[0];
  if (row?.status !== 'completed') return undefined;
  const value = { runId, output: row.output ?? null, finalText: row.finalText ?? '' };
  const artifact: ArtifactRef = {
    id: `${nodeId}:agent_output`,
    kind: `agent.${agentId}.output`,
    source_node_id: nodeId,
    value,
  };
  return { status: 'completed', artifact_refs: [artifact], output: value };
}

/** A deterministic, tenant-disjoint-by-parent agent sub-run id (UUID-shaped) from the workflow run + node. */
function agentSubRunId(workflowRunId: string, nodeId: string): string {
  const h = createHash('sha256').update(`agent-node:${workflowRunId}:${nodeId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The transient error classes a node should treat as retryable (align with the run surface). */
function isTransientErrorClass(errorClass: RunResult['errorClass']): boolean {
  return errorClass === 'rate_limited' || errorClass === 'upstream_5xx' || errorClass === 'timeout';
}
