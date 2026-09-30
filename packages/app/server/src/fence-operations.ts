/**
 * `quiesce`, `resume` and `health` of the runtime-control adapter.
 *
 * QUIESCE takes the environment's source fence and reports, honestly, how far it got:
 *
 *  1. Under the operation lease (`operation-lease.ts`, with its receipts), one transaction sets the
 *     fence to `fenced`, increases `fence_epoch` and the environment revision, and records who and
 *     why. A second quiesce while fenced keeps the epoch it finds.
 *  2. It waits, until the deadline, for every live runtime process to report (its heartbeat in
 *     `runtime_control_processes`) that it observed the new epoch, stopped its producers and drained
 *     its in-flight work (`runtime-fence.ts`). Status `fenced` means every live process did; anything
 *     else is `timed-out`, returned with `ok: false` and `RAY_SOURCE_NOT_QUIESCENT`. The fence stays
 *     held either way — only `resume` releases it.
 *  3. After a complete drain it takes the database write barrier (`write-barrier.ts`): the runtime
 *     role's write privileges revoked when role separation is configured, else the stopped-source
 *     check when the caller attests the source is stopped, else nothing, reported as
 *     `database-write-role: unavailable`. `object-writes` is held once every process has drained (a
 *     drained process refuses object writes). The barriers are recorded with the fence.
 *
 * RESUME releases the fence only at exactly the epoch it is held at (`RAY_FENCE_MISMATCH` otherwise),
 * grants back exactly the privileges the barrier recorded, and increases the environment revision, in
 * one transaction. Every process sees the fence open within one poll and restarts its producers.
 * Resuming a fence that is already open at that epoch changes nothing and says so (`released: false`).
 *
 * HEALTH answers liveness (always true: this code is running) and readiness from the probes in
 * `health.ts`: the database and the schema from here, and whatever the in-process server adds
 * (bindings, assets, the durable worker and its system database).
 */
import {
  type BundleError,
  type BundleWarning,
  bundleError,
  CONTRACT_VERSION,
  digestOf,
  type HealthData,
  type HealthRequest,
  parseTimestamp,
  type QuiesceData,
  type QuiesceRequest,
  type ResultEnvelope,
  type ResultOperation,
  type ResumeData,
  type ResumeRequest,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import { databaseProbe, type ReadinessProbe, runReadiness, schemaProbe } from './health.js';
import {
  acquireOperationLease,
  type LeaseTx,
  MAX_LEASE_TTL_MS,
  type OperationLease,
  OperationLeaseError,
} from './operation-lease.js';
import { PROCESS_LIVE_WINDOW_MS, type ProducerState } from './runtime-fence.js';
import type { CatalogQuery } from './schema-head.js';
import {
  BarrierUnavailableError,
  otherSessions,
  type RecordedGrant,
  readRecordedGrants,
  restoreWrites,
  revokeWrites,
} from './write-barrier.js';

export interface FenceOperationOptions {
  /** The environment's application database (the snapshot reader's connection). */
  db: Db;
  /**
   * The role runtime processes connect as, when role separation is configured. With it, the database
   * barrier is `database-write-role`: that role's write privileges are revoked until resume.
   */
  runtimeRole?: string;
  /** A control connection to the workflow system database, so the role barrier covers it too. */
  workflowSystemDb?: Db;
  /**
   * The workflow system database's name, for the stopped-source session check and to learn whether
   * one exists. Default: the application database's name plus `_dbos_sys`, as the runtime derives it.
   */
  workflowSystemDatabaseName?: string;
  /** How often quiesce re-reads the process heartbeats while it waits. Default 200 ms. */
  quiescePollMs?: number;
  /**
   * The operation lease's lifetime between renewals while quiesce runs. Default 60 s; quiesce renews
   * it every third of that until it ends, however far away its deadline is.
   */
  quiesceLeaseTtlMs?: number;
  /** The readiness probes the in-process server adds to `health()`. */
  readiness?: readonly ReadinessProbe[];
}

function envelope<T>(
  operation: ResultOperation,
  operationId: string,
  data: T | null,
  errors: BundleError[] = [],
  warnings: BundleWarning[] = [],
): ResultEnvelope<T> {
  const base = {
    contractVersion: CONTRACT_VERSION as typeof CONTRACT_VERSION,
    operation,
    operationId,
    data,
    warnings,
  };
  const [first, ...rest] = errors;
  return first === undefined
    ? { ...base, ok: true, errors: [] }
    : { ...base, ok: false, errors: [first, ...rest] };
}

function infraUnavailable(): BundleError {
  return bundleError(
    'RAY_INFRA_UNAVAILABLE',
    'the environment database could not be read or written; check that it is reachable and retry',
  );
}

function leaseRefusal(err: unknown): BundleError | undefined {
  if (!(err instanceof OperationLeaseError)) return undefined;
  return bundleError(err.code, err.message);
}

async function rows<T>(tx: LeaseTx, text: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.unsafe(text, params)) as T[];
}

// ─── the barrier record ────────────────────────────────────────────────────────────────────────

type DatabaseBarrier = 'database-write-role' | 'database-stopped-source';

interface BarrierRecord {
  database: {
    barrier: DatabaseBarrier;
    state: 'held' | 'unavailable';
    role?: string;
    grants?: RecordedGrant[];
    workflowSystemGrants?: RecordedGrant[];
  };
  objects: { barrier: 'object-writes'; state: 'held' | 'unavailable' };
}

function readBarrierRecord(value: unknown): BarrierRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const db = v.database as Record<string, unknown> | undefined;
  const objects = v.objects as Record<string, unknown> | undefined;
  if (typeof db !== 'object' || db === null || typeof objects !== 'object' || objects === null) {
    return null;
  }
  const barrier =
    db.barrier === 'database-stopped-source' ? 'database-stopped-source' : 'database-write-role';
  return {
    database: {
      barrier,
      state: db.state === 'held' ? 'held' : 'unavailable',
      ...(typeof db.role === 'string' ? { role: db.role } : {}),
      grants: readRecordedGrants(db.grants),
      workflowSystemGrants: readRecordedGrants(db.workflowSystemGrants),
    },
    objects: { barrier: 'object-writes', state: objects.state === 'held' ? 'held' : 'unavailable' },
  };
}

function reportedBarriers(record: BarrierRecord): QuiesceData['barriers'] {
  return [
    { barrier: record.database.barrier, state: record.database.state },
    { barrier: 'object-writes', state: record.objects.state },
  ];
}

// ─── quiesce ───────────────────────────────────────────────────────────────────────────────────

/** The quiesce lease's lifetime between renewals. */
export const DEFAULT_QUIESCE_LEASE_TTL_MS = 60_000;

const PRODUCER_RANK: Record<ProducerState, number> = { stopped: 0, drained: 1, 'still-running': 2 };

interface DrainOutcome {
  drained: boolean;
  producers: QuiesceData['producers'];
  unfencedExternal: string[];
}

interface ProcessRow {
  fence_epoch: string;
  phase: string;
  producers: unknown;
  unfenced_external: unknown;
}

function aggregate(processes: readonly ProcessRow[], epoch: number): DrainOutcome {
  const worst = new Map<string, ProducerState>();
  const external = new Set<string>();
  let drained = true;
  for (const p of processes) {
    const observed = Number(p.fence_epoch) === epoch && p.phase !== 'open';
    if (!observed || p.phase !== 'fenced') drained = false;
    if (!observed) {
      // A live process that has not seen this fence yet: nothing of it is known to be stopped.
      worst.set('runtime-process', 'still-running');
    }
    if (Array.isArray(p.producers)) {
      for (const entry of p.producers) {
        const e = entry as { producer?: unknown; state?: unknown };
        if (typeof e.producer !== 'string') continue;
        const state: ProducerState =
          e.state === 'stopped' || e.state === 'drained' || e.state === 'still-running'
            ? e.state
            : 'still-running';
        const prior = worst.get(e.producer);
        if (prior === undefined || PRODUCER_RANK[state] > PRODUCER_RANK[prior]) {
          worst.set(e.producer, state);
        }
      }
    }
    if (Array.isArray(p.unfenced_external)) {
      for (const name of p.unfenced_external) if (typeof name === 'string') external.add(name);
    }
  }
  return {
    drained,
    producers: [...worst.entries()]
      .map(([producer, state]) => ({ producer, state }))
      .sort((a, b) => (a.producer < b.producer ? -1 : a.producer > b.producer ? 1 : 0)),
    unfencedExternal: [...external].sort(),
  };
}

async function waitForDrain(
  db: Db,
  epoch: number,
  deadline: Date,
  pollMs: number,
): Promise<DrainOutcome> {
  for (;;) {
    const live = (await db.$client.unsafe(
      `SELECT fence_epoch::text AS fence_epoch, phase, producers, unfenced_external
         FROM runtime_control_processes
        WHERE seen_at > clock_timestamp() - make_interval(secs => $1::float8 / 1000)`,
      [PROCESS_LIVE_WINDOW_MS],
    )) as unknown as ProcessRow[];
    const outcome = aggregate(live, epoch);
    if (outcome.drained || Date.now() >= deadline.getTime()) return outcome;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, deadline.getTime() - Date.now())));
  }
}

async function workflowSystemDatabaseExists(db: Db, name: string | undefined): Promise<string> {
  const rowsFound = (await db.$client.unsafe(
    `SELECT coalesce($1::text, current_database() || '_dbos_sys') AS name,
            EXISTS (SELECT 1 FROM pg_database
                     WHERE datname = coalesce($1::text, current_database() || '_dbos_sys')) AS present`,
    [name ?? null],
  )) as unknown as { name: string; present: boolean }[];
  const row = rowsFound[0];
  return row?.present === true ? row.name : '';
}

/** Take the database barrier after a complete drain. Never throws for an unavailable barrier. */
async function takeDatabaseBarrier(
  lease: OperationLease,
  request: QuiesceRequest,
  options: FenceOperationOptions,
): Promise<BarrierRecord['database']> {
  const unavailable: BarrierRecord['database'] = {
    barrier: 'database-write-role',
    state: 'unavailable',
  };
  const sysName = await workflowSystemDatabaseExists(
    options.db,
    options.workflowSystemDatabaseName,
  );

  if (options.runtimeRole !== undefined) {
    const role = options.runtimeRole;
    // A workflow system database the runtime writes to must be fenced too; without a handle to it,
    // the barrier cannot be held.
    if (sysName !== '' && options.workflowSystemDb === undefined) return unavailable;
    let workflowSystemGrants: RecordedGrant[] = [];
    if (options.workflowSystemDb !== undefined) {
      try {
        await options.workflowSystemDb.$client.begin(async (tx) => {
          workflowSystemGrants = await revokeWrites(tx, role);
        });
      } catch (err) {
        if (err instanceof BarrierUnavailableError) return unavailable;
        throw err;
      }
    }
    try {
      const { result } = await lease.mutate(async (tx) => ({
        barrier: 'database-write-role' as const,
        state: 'held' as const,
        role,
        grants: await revokeWrites(tx, role),
        workflowSystemGrants,
      }));
      return result;
    } catch (err) {
      // The application database refused: give the workflow system database its privileges back.
      if (options.workflowSystemDb !== undefined && workflowSystemGrants.length > 0) {
        await options.workflowSystemDb.$client.begin((tx) =>
          restoreWrites(tx, role, workflowSystemGrants),
        );
      }
      if (err instanceof BarrierUnavailableError) return unavailable;
      throw err;
    }
  }

  if (request.sourceStopped) {
    const databases = (
      (await options.db.$client.unsafe('SELECT current_database() AS name')) as unknown as {
        name: string;
      }[]
    ).map((r) => r.name);
    if (sysName !== '') databases.push(sysName);
    const others = await otherSessions(options.db.$client, databases);
    if (others === 0) return { barrier: 'database-stopped-source', state: 'held' };
  }
  return unavailable;
}

export async function quiesceOperation(
  request: QuiesceRequest,
  operationId: string,
  options: FenceOperationOptions,
): Promise<ResultEnvelope<QuiesceData>> {
  const operation = 'runtime.quiesce';
  const deadline = parseTimestamp(request.deadline) as Date;
  // A lease of fixed lifetime, renewed while quiesce runs: the drain may wait for a deadline further
  // away than one lease may last, and a holder that died stops renewing and lets it expire.
  const ttlMs = Math.min(
    MAX_LEASE_TTL_MS,
    options.quiesceLeaseTtlMs ?? DEFAULT_QUIESCE_LEASE_TTL_MS,
  );
  let lease: OperationLease;
  try {
    lease = await acquireOperationLease(
      options.db,
      {
        operationId,
        actor: request.actor,
        kind: operation,
        inputsDigest: digestOf({
          reason: request.reason,
          deadline: request.deadline,
          sourceStopped: request.sourceStopped,
        }),
      },
      { ttlMs },
    );
  } catch (err) {
    return envelope(operation, operationId, null, [leaseRefusal(err) ?? infraUnavailable()]);
  }

  const renewal = setInterval(
    () => {
      lease.renew(ttlMs).catch(() => {});
    },
    Math.max(100, Math.floor(ttlMs / 3)),
  );
  renewal.unref();
  try {
    // 1. The fence.
    const fence = await lease.step('take-fence', async (l) => {
      const { result } = await l.mutate(async (tx) => {
        const [row] = await rows<{
          fence_state: string;
          fence_epoch: string;
          fence_barriers: unknown;
        }>(
          tx,
          `SELECT fence_state, fence_epoch::text AS fence_epoch, fence_barriers
             FROM runtime_control_state WHERE id = 1`,
        );
        if (row?.fence_state === 'fenced') {
          return {
            epoch: Number(row.fence_epoch),
            taken: false,
            recorded: readBarrierRecord(row.fence_barriers),
          };
        }
        const [updated] = await rows<{ fence_epoch: string }>(
          tx,
          `UPDATE runtime_control_state
              SET fence_state = 'fenced', fence_epoch = fence_epoch + 1, fence_actor = $1,
                  fence_reason = $2, fenced_at = clock_timestamp(), fence_barriers = NULL,
                  environment_revision = environment_revision + 1, updated_at = now()
            WHERE id = 1 RETURNING fence_epoch::text AS fence_epoch`,
          [request.actor, request.reason],
        );
        return { epoch: Number(updated?.fence_epoch), taken: true, recorded: null };
      });
      return { value: result };
    });

    // 2. The drain.
    const drain = await lease.step('drain', async () => ({
      value: await waitForDrain(options.db, fence.epoch, deadline, options.quiescePollMs ?? 200),
    }));

    // 3. The barriers. A database barrier already held by an earlier quiesce of this fence is kept as
    // recorded: revoking again would record nothing and lose what resume must grant back.
    const record = await lease.step('barriers', async (l) => {
      const earlier = fence.recorded;
      let database: BarrierRecord['database'];
      if (earlier !== null && earlier.database.state === 'held') {
        database = earlier.database;
      } else if (drain.drained) {
        database = await takeDatabaseBarrier(l, request, options);
      } else {
        database = { barrier: 'database-write-role', state: 'unavailable' };
      }
      const next: BarrierRecord = {
        database,
        objects: { barrier: 'object-writes', state: drain.drained ? 'held' : 'unavailable' },
      };
      await l.mutate(async (tx) => {
        await tx.unsafe(
          `UPDATE runtime_control_state SET fence_barriers = $1::text::jsonb, updated_at = now() WHERE id = 1`,
          [JSON.stringify(next)],
        );
      });
      return { value: next };
    });

    const data: QuiesceData = {
      fenceEpoch: fence.epoch,
      status: drain.drained ? 'fenced' : 'timed-out',
      producers: drain.producers,
      barriers: reportedBarriers(record),
      unfencedExternal: drain.unfencedExternal,
    };
    await lease.release(drain.drained ? 'succeeded' : 'failed', {
      fenceEpoch: fence.epoch,
      status: data.status,
    });
    const warnings: BundleWarning[] =
      data.unfencedExternal.length === 0
        ? []
        : [
            {
              code: 'RAY_W_EXTERNAL_EFFECTS_UNFENCED',
              message: `no fence reaches these external services: ${data.unfencedExternal.join(', ')}`,
            },
          ];
    if (!drain.drained) {
      return envelope(
        operation,
        operationId,
        data,
        [
          bundleError(
            'RAY_SOURCE_NOT_QUIESCENT',
            `the source did not drain before the deadline; the fence stays held at epoch ${fence.epoch}: ` +
              'retry quiesce, or release it with resume at that epoch',
          ),
        ],
        warnings,
      );
    }
    return envelope(operation, operationId, data, [], warnings);
  } catch (err) {
    await lease.release('failed').catch(() => {});
    return envelope(operation, operationId, null, [leaseRefusal(err) ?? infraUnavailable()]);
  } finally {
    clearInterval(renewal);
  }
}

// ─── resume ────────────────────────────────────────────────────────────────────────────────────

class FenceMismatch extends Error {}

export async function resumeOperation(
  request: ResumeRequest,
  operationId: string,
  options: FenceOperationOptions,
): Promise<ResultEnvelope<ResumeData>> {
  const operation = 'runtime.resume';
  let lease: OperationLease;
  try {
    lease = await acquireOperationLease(
      options.db,
      {
        operationId,
        actor: request.actor,
        kind: operation,
        inputsDigest: digestOf({ fenceEpoch: request.fenceEpoch }),
      },
      { ttlMs: 60_000 },
    );
  } catch (err) {
    return envelope(operation, operationId, null, [leaseRefusal(err) ?? infraUnavailable()]);
  }
  try {
    // The workflow system database first: were its grants restored after the application database
    // released the fence and then failed, the fence would be open with the worker unable to write.
    // This order leaves the fence held instead, and a retried resume grants again (GRANT is
    // idempotent).
    const [current] = (await options.db.$client.unsafe(
      `SELECT fence_state, fence_epoch::text AS fence_epoch, fence_barriers
         FROM runtime_control_state WHERE id = 1`,
    )) as unknown as { fence_state: string; fence_epoch: string; fence_barriers: unknown }[];
    const recorded = readBarrierRecord(current?.fence_barriers);
    if (
      current?.fence_state === 'fenced' &&
      Number(current.fence_epoch) === request.fenceEpoch &&
      recorded?.database.state === 'held' &&
      recorded.database.role !== undefined &&
      (recorded.database.workflowSystemGrants?.length ?? 0) > 0
    ) {
      if (options.workflowSystemDb === undefined) {
        throw new Error('the workflow system database must be reachable to restore its privileges');
      }
      const role = recorded.database.role;
      const grants = recorded.database.workflowSystemGrants ?? [];
      await options.workflowSystemDb.$client.begin((tx) => restoreWrites(tx, role, grants));
    }

    const result = await lease.step('release-fence', async (l) => {
      const { result: value } = await l.mutate(async (tx) => {
        const [row] = await rows<{
          fence_state: string;
          fence_epoch: string;
          fence_barriers: unknown;
          environment_revision: string;
        }>(
          tx,
          `SELECT fence_state, fence_epoch::text AS fence_epoch, fence_barriers,
                  environment_revision::text AS environment_revision
             FROM runtime_control_state WHERE id = 1`,
        );
        const epoch = Number(row?.fence_epoch ?? 0);
        if (row === undefined || epoch !== request.fenceEpoch) throw new FenceMismatch();
        if (row.fence_state !== 'fenced') {
          return {
            fenceEpoch: epoch,
            released: false,
            environmentRevision: Number(row.environment_revision),
          };
        }
        const barriers = readBarrierRecord(row.fence_barriers);
        if (barriers?.database.state === 'held' && barriers.database.role !== undefined) {
          await restoreWrites(tx, barriers.database.role, barriers.database.grants ?? []);
        }
        const [updated] = await rows<{ environment_revision: string }>(
          tx,
          `UPDATE runtime_control_state
              SET fence_state = 'open', fence_barriers = NULL,
                  environment_revision = environment_revision + 1, updated_at = now()
            WHERE id = 1 RETURNING environment_revision::text AS environment_revision`,
        );
        return {
          fenceEpoch: epoch,
          released: true,
          environmentRevision: Number(updated?.environment_revision),
        };
      });
      return { value };
    });
    await lease.release('succeeded', { fenceEpoch: result.fenceEpoch, released: result.released });
    return envelope(operation, operationId, result);
  } catch (err) {
    if (err instanceof FenceMismatch) {
      await lease.release('refused').catch(() => {});
      return envelope<ResumeData>(operation, operationId, null, [
        bundleError(
          'RAY_FENCE_MISMATCH',
          'the fence is not held at that epoch; resume only with the epoch quiesce returned',
          { path: '/fenceEpoch' },
        ),
      ]);
    }
    await lease.release('failed').catch(() => {});
    return envelope(operation, operationId, null, [leaseRefusal(err) ?? infraUnavailable()]);
  }
}

// ─── health ────────────────────────────────────────────────────────────────────────────────────

export async function healthOperation(
  _request: HealthRequest,
  operationId: string,
  options: FenceOperationOptions,
): Promise<ResultEnvelope<HealthData>> {
  const query: CatalogQuery = async (sql, params = []) =>
    (await options.db.$client.unsafe(sql, params as never[])) as unknown as Record<
      string,
      unknown
    >[];
  const checks = await runReadiness([
    databaseProbe(() => options.db.$client`select 1`),
    schemaProbe(query),
    ...(options.readiness ?? []),
  ]);
  return envelope('runtime.health', operationId, {
    live: true,
    ready: checks.every((c) => c.ok),
    checks,
  });
}
