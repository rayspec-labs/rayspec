/**
 * `TurnDispatch` — the ONE sanctioned way a pack schedules a durable agent turn.
 *
 * Every REACTIVE contribution a pack makes is called BY the platform and must not turn around and
 * drive an agent itself: a tool handler structurally cannot, and that stays true. A `services`
 * contribution is the one kind the platform BOOTS rather than calls, so it is the one kind with work
 * of its own to schedule — a reconcile at boot, a drained queue, a follow-up turn. This is the
 * capability it gets, and it is handed to SERVICES ONLY. `scripts/check-contribution-dispatch-
 * boundary.mjs` proves the negative half of that (a module reachable from a pack's `handlers/`
 * subtree, or from a tooling contribution, that so much as NAMES `TurnDispatch` fails the build);
 * the positive half — that a service receives it and that what it schedules is tenant-correct — is
 * proved by `extensions/pack-services.test.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TENANCY IS ENFORCED BY CORE, NOT BY THE CALLER.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * There is NO `tenantId` on the request object. A service has no request and therefore no ambient
 * caller-derived tenant, so the composition root binds the capability to the DEPLOYMENT tenant it
 * already resolves for off-request work (`RAYSPEC_CRON_TENANT_ID` — the same single-deployment posture
 * a cron/manual trigger fires under) and closes over it here. A pack can no more name a tenant through
 * this seam than a route handler can through `init.enqueue`: the closure has no path to one. A
 * deployment that bound no tenant, or wired no durable worker, gets NO capability at all — the slot on
 * the service context is ABSENT, and a service that needs it fail-closes loudly on `undefined` rather
 * than scheduling into nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT ADDS NO SECOND RUN PATH.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It writes the SAME enqueue-time run header the HTTP `async:true` path writes and enqueues the SAME
 * neutral `RunJob` onto the SAME `DurableExecutor`, so a turn a service schedules is read, streamed,
 * cancelled and journaled by the surfaces that already exist. `agentId` is resolved against the
 * DEPLOYED agent registry: an undeclared id is fail-closed here, never a silent, dangling enqueue.
 * The header write is advisory, and it carries the SAME COMPENSATION the other two enqueue-with-header
 * paths carry (`routes/runs.ts`, `cron-scheduler.ts`): when the enqueue throws, the engine is probed
 * and the header this call wrote is removed ONLY for a job that is provably absent — so a runId that
 * will never run does not read back as `enqueued` for ever, and a job that may be live keeps its
 * header. That pairing is what makes "best-effort" safe rather than merely cheap.
 *
 * HONEST LIMIT (stated, not silently accepted): this seam mints a FRESH runId per call and promises
 * no exactly-once key. A service that must reconcile a crash-retry to one run keys that in its own
 * table — the run-level `Idempotency-Key` reserve belongs to the request surface that has a caller to
 * attribute a key to, and inventing one here would promise a de-duplication this seam does not do.
 */
import { randomUUID } from 'node:crypto';
import type { TenantDb } from '@rayspec/db';
import type { DurableExecutor } from './durable/types.js';
import {
  deleteEnqueuedRunHeader,
  insertEnqueuedRunHeader,
  type RunHeaderIdentity,
} from './run-header.js';

/** What a service asks for when it schedules one durable agent turn. */
export interface TurnDispatchRequest {
  /** The declared agent to run — resolved against the deployed registry (undeclared → fail-closed). */
  readonly agentId: string;
  /** The agent's run input (the per-run task value). DATA. */
  readonly input: string;
  /** Optional per-run override of the agent's declared instructions. */
  readonly instructions?: string;
  /** Optional per-run override of the agent's declared maxTurns. */
  readonly maxTurns?: number;
}

/** The scheduled turn's durable identity — the runId the existing run-read surfaces resolve. */
export interface TurnDispatchResult {
  /** The durable run id (also the durable workflow id). Poll or stream it via `GET /v1/runs/{id}`. */
  readonly runId: string;
}

/**
 * The typed capability a service receives. ONE method, and no tenant parameter anywhere on it — the
 * tenant is bound by the composition root when the capability is built.
 */
export interface TurnDispatch {
  /** Schedule ONE durable agent turn for the tenant this capability is bound to. */
  schedule(request: TurnDispatchRequest): Promise<TurnDispatchResult>;
}

/** What the composition root supplies to build one bound `TurnDispatch`. */
export interface TurnDispatchDeps {
  /** The DEPLOYMENT tenant every turn scheduled through this capability runs under (core-bound). */
  readonly tenantId: string;
  /** The tenant-scoped handle the enqueue-time run header is written through (the chokepoint). */
  readonly tdb: TenantDb;
  /** The neutral durable executor the job is enqueued onto (the same one the HTTP async path uses). */
  readonly executor: DurableExecutor;
  /** Resolve a declared agent's run-header identity; `undefined` for an id the deployment never declared. */
  readonly resolveAgent: (agentId: string) => Omit<RunHeaderIdentity, 'runId'> | undefined;
}

/**
 * A refused dispatch — an id the deployment does not declare, or a malformed request. Its own class so
 * a service can branch on it, and so a refusal reads as a refusal rather than as an infrastructure fault.
 */
export class TurnDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnDispatchError';
  }
}

/**
 * Build the bound capability. The returned object closes over the tenant and the executor; nothing on
 * the request object can reach either.
 */
export function makeTurnDispatch(deps: TurnDispatchDeps): TurnDispatch {
  return {
    async schedule(request: TurnDispatchRequest): Promise<TurnDispatchResult> {
      // A service ships as a compiled module, where the declared parameter type above is the CONTRACT
      // rather than a runtime guarantee — re-read the argument before trusting it, exactly as the
      // route-handler enqueue capability does, so a positional mis-call names itself.
      const arg: unknown = request;
      if (
        typeof arg !== 'object' ||
        arg === null ||
        typeof (arg as { agentId?: unknown }).agentId !== 'string' ||
        typeof (arg as { input?: unknown }).input !== 'string'
      ) {
        throw new TurnDispatchError(
          'TurnDispatch.schedule takes ONE request object `{ agentId, input }` whose `agentId` and ' +
            '`input` are strings — it is NOT positional (fail-closed).',
        );
      }

      // REGISTRY-BOUND: only an agent the DEPLOYED document declares can be scheduled. An unknown id
      // is refused here rather than enqueued to fail later on a worker that cannot resolve it.
      const identity = deps.resolveAgent(request.agentId);
      if (identity === undefined) {
        throw new TurnDispatchError(
          `TurnDispatch.schedule: agent '${request.agentId}' is not declared on this deployment, so ` +
            'there is nothing to run. A service may only schedule an agent the deployed document ' +
            'declares (fail-closed).',
        );
      }

      const runId = randomUUID();

      // The header FIRST, so the runId this call hands back resolves on the run-read routes for the
      // whole run instead of 404ing until the worker finishes it. BEST-EFFORT and advisory, exactly as
      // on the HTTP async path: a failing header write must not cost a service the enqueue it could
      // have had, and the run re-persists its own header when it starts. `headerCreated` records
      // whether THIS call created the row, so the enqueue-failure path below can remove it again for a
      // job that provably never existed — the other half of what makes best-effort safe here.
      let headerCreated = false;
      try {
        headerCreated = await insertEnqueuedRunHeader(deps.tdb, { runId, ...identity });
      } catch (err) {
        console.error(`[platform] turn-dispatch run header write failed runId=${runId}`, err);
      }

      try {
        await deps.executor.enqueue(deps.tenantId, {
          runId,
          // The tenant CORE bound — never a value that came in on the request (there is no such field).
          tenantId: deps.tenantId,
          agentId: request.agentId,
          input: request.input,
          ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
          ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
        });
      } catch (err) {
        // The enqueue THREW — mirror `runs.ts` / `cron-scheduler.ts`, the two enqueue-with-header paths
        // this one shares its header write with. The throw does NOT prove the job was never created:
        // the durable engine persists the workflow status BEFORE `enqueue` resolves, so a throw after
        // that persist means the job WILL still run. Probe the engine and remove the header ONLY when
        // the job is provably ABSENT (status 'unknown') AND this call created the row — otherwise a
        // runId that will never run reads back as `enqueued` for ever on every run-read surface. The
        // status read is fail-CLOSED: unreadable ⇒ the job may be live ⇒ KEEP the header. The delete is
        // best-effort, so a failure here cannot mask the original error, which is always rethrown.
        if (headerCreated) {
          let jobAbsent = false;
          try {
            jobAbsent = (await deps.executor.status(runId)) === 'unknown';
          } catch {
            jobAbsent = false;
          }
          if (jobAbsent) await deleteEnqueuedRunHeader(deps.tdb, runId).catch(() => {});
        }
        throw err;
      }

      return { runId };
    },
  };
}
