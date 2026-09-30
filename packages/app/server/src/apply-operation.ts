/**
 * APPLY — run a list of steps against an environment under the operation lease, with a receipt before
 * and after every step, and reconcile whatever an earlier apply left unfinished before running any.
 *
 * WHAT A CALLER GIVES. The request members every apply carries (`planDigest`,
 * `expectedEnvironmentRevision`, `idempotencyKey`, `operationId`, `actor`), a way to RECOMPUTE the plan
 * digest from live state, and the steps. The legacy YAML deploy is one caller
 * (`deploy-apply.ts`); a bundle deploy supplies its own steps the same way. No plan is stored: the
 * digest is recomputed, and a digest that no longer matches the live state is a stale plan.
 *
 * ORDER, as the contract fixes it:
 *  1. Idempotency lookup. A key already recorded with ANOTHER plan digest is `RAY_IDEMPOTENCY_CONFLICT`.
 *     With the same digest: a succeeded operation answers `already-applied` with its original receipts
 *     and runs nothing; a failed one answers its recorded failure; one still running is
 *     `RAY_LOCK_TIMEOUT`; one that was refused (it changed nothing) or interrupted is continued under
 *     its own operation id, through the checks below — the steps it finished are not run again. An
 *     operation another apply's reconciliation (or an operator) closed as interrupted counts as
 *     interrupted, not as failed: its recorded outcome says `interrupted`, and a retry under its key
 *     continues it. Two retries at once cannot both continue it: the lease is taken over only once
 *     it has expired, under the state row's lock.
 *  2. Plan freshness and revision, read-only: the expected environment revision must be the live one,
 *     the plan must not have expired, and the recomputed digest must equal `planDigest`, else
 *     `RAY_PLAN_STALE`. A stale plan writes nothing.
 *  3. No blockers (`RAY_POLICY_DENIED` `plan-has-blockers`); the source fence open (`RAY_POLICY_DENIED`
 *     `fenced`) whenever there is a step to run.
 *  4. The operation lease, with the intent receipt (`operation-lease.ts`). Another live holder is
 *     `RAY_LOCK_TIMEOUT`, after an optional bounded wait.
 *  5. Reconciliation (below). A step whose outcome cannot be established blocks the apply with
 *     `RAY_RECONCILIATION_REQUIRED` (exit class 6).
 *  6. The freshness checks again, now under the lease, so nothing can change between them and the
 *     steps.
 *  7. The steps. A schema-changing step takes the shared schema lock (`schema-lock.ts`) in its own
 *     transaction. Every step gets `step-started` before and `step-finished` after, or `step-skipped`
 *     when it has nothing to do.
 *  8. The outcome receipt; when any step ran, the environment revision increases in the same
 *     transaction.
 *
 * CRASH SAFETY. A step says how its effect can be checked afterwards:
 *  - a `transaction` step runs inside the lease-checked transaction that also writes its finish
 *    receipt, so the effect and the receipt commit together. A start without a finish therefore
 *    proves the effect was rolled back — whatever point the process died at, including between two
 *    statements of the same DDL.
 *  - an `effect` step runs on its own connections or outside the database. Its `step-started` receipt
 *    records the observer that reads the step's state, the state it read before, and the state it
 *    expects after. Reconciliation reads the state again: the expected state means the step took
 *    effect (it is closed as finished), the earlier state means it did not (closed as skipped), and
 *    anything else — or a step with no observer — is UNKNOWN. A step declared re-runnable may be run
 *    again even without an observer.
 * An unknown step is never replayed and never reversed: the operation stays blocked until an operator
 * establishes what the step did and records it (`resolveInterruptedStep`). Schema changes are never
 * rolled back automatically.
 *
 * Reconciliation receipts are written to the INTERRUPTED operation's own record, naming the operation
 * that settled it, and an interrupted operation whose steps are all settled gets an outcome `failed`
 * with `interrupted: true`. No receipt carries a secret, a binding value or a connection string.
 */
import { randomUUID } from 'node:crypto';
import {
  type ApplyData,
  type BundleError,
  bundleError,
  CONTRACT_VERSION,
  checkApplyControl,
  digestOf,
  formatTimestamp,
  isBundleErrorCode,
  isUuidV4,
  type ResultEnvelope,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import {
  acquireOperationLease,
  findIntentByIdempotencyKey,
  type LeaseTx,
  type OperationIdentity,
  type OperationLease,
  OperationLeaseError,
  type OperationReceipt,
  readOperationReceipts,
} from './operation-lease.js';
import { lockSchemaInTransaction, SchemaLockTimeoutError } from './schema-lock.js';

const OPERATION = 'runtime.apply';

/** The longest step name a receipt reports (the contract's `receipts[].step` limit). */
export const MAX_STEP_NAME_LENGTH = 128;

/** How long an apply's lease lives between renewals, unless the caller says otherwise. */
export const DEFAULT_APPLY_LEASE_TTL_MS = 60_000;

/** What a step is told when it runs. */
export interface StepContext {
  /** The operation running the step: the request's, or the one it continues. */
  operationId: string;
}

/**
 * A step's refusal: the step found, before changing anything, that it must not run. The apply
 * reports the step's own error instead of `RAY_INTERNAL`.
 */
export class ApplyStepRefusal extends Error {
  readonly error: BundleError;
  constructor(error: BundleError) {
    super(error.message);
    this.name = 'ApplyStepRefusal';
    this.error = error;
  }
}

/** What a step reports when it finishes. */
export interface StepEffect {
  /** SHA-256 of what the step produced, when it has one; reported in the step's receipt. */
  digest?: string | null;
}

interface StepBase {
  /** 1 to 128 characters; unique within one apply. */
  name: string;
  /** The key of the observer (in `ApplyOptions.observers`) that reads this step's state. */
  observer?: string;
  /** The state the observer reads once this step has taken effect, when it is known in advance. */
  expectedAfter?: string;
  /** Whether running the step again after an unknown outcome is safe. */
  rerunnable?: boolean;
  /** Whether there is anything to do; a step that answers false is recorded as skipped. */
  pending?: () => Promise<boolean>;
}

/**
 * One step of an apply. A `transaction` step's effect commits with its finish receipt; an `effect`
 * step's does not, so its outcome after a crash is known only through its observer.
 */
export type ApplyStep =
  | (StepBase & {
      kind: 'transaction';
      /** Take the shared schema lock first, in the same transaction. */
      schemaChange: boolean;
      run: (tx: LeaseTx, context: StepContext) => Promise<StepEffect | undefined>;
    })
  | (StepBase & {
      kind: 'effect';
      run: (context: StepContext) => Promise<StepEffect | undefined>;
    });

/** Readers of the state a step changes, keyed by the name a step's receipt records. */
export type StateObservers = Readonly<Record<string, () => Promise<string>>>;

/** The members of an apply request that every apply carries. */
export interface ApplyControl {
  contractVersion: typeof CONTRACT_VERSION;
  operationId: string;
  actor: string;
  planDigest: string;
  expectedEnvironmentRevision: number;
  idempotencyKey: string;
}

/** How an apply checks that its plan still describes the live environment. */
export interface ApplyPlanCheck {
  /** Recompute the plan digest from the live state; it must equal the request's `planDigest`. */
  recompute(): Promise<string>;
  /** Whether the plan's lifetime is over. */
  expired?: () => boolean;
  /** The plan's blockers; a plan with any is refused. */
  blockers?: readonly BundleError[];
}

/** The points an apply passes where a crash leaves a distinct record; see `onCheckpoint`. */
export type ApplyCheckpoint = 'after-intent' | 'after-step-started' | 'after-step-effect';

/** How reconciliation found one step an earlier operation left unfinished. */
export type ObservedOutcome = 'applied' | 'not-applied' | 'unknown';

/** One interrupted or unsettled operation, as reconciliation found and settled it. */
export interface ReconciledOperation {
  operationId: string;
  steps: { step: string; observed: ObservedOutcome; state: string | null }[];
  /** Whether every step of it is now settled. */
  settled: boolean;
}

export interface ApplyOptions {
  /** The environment's application database. */
  db: Db;
  request: ApplyControl;
  plan: ApplyPlanCheck;
  steps: readonly ApplyStep[];
  observers?: StateObservers;
  /** The bounded wait for the shared schema lock in a schema-changing step. */
  lockTimeoutMs?: number;
  /** The lease lifetime between renewals. Default 60 s; the lease is renewed while the apply runs. */
  leaseTtlMs?: number;
  /** How long to wait for another holder's lease before `RAY_LOCK_TIMEOUT`. Default: not at all. */
  leaseWaitMs?: number;
  /**
   * Rethrow a step's own error after its receipts are written, instead of reporting it as
   * `RAY_INTERNAL`: for a caller whose callers already handle that error. A step's refusal
   * (`ApplyStepRefusal`) is always reported as its own error, never rethrown.
   */
  rethrowStepErrors?: boolean;
  /** Told about every operation reconciliation settled or found blocked. */
  onReconciled?: (operations: readonly ReconciledOperation[]) => void;
  /**
   * Called at each point where a crash leaves a distinct record. Crash tests hold a real child
   * process there and kill it; production callers pass nothing.
   */
  onCheckpoint?: (point: ApplyCheckpoint, step?: string) => Promise<void>;
}

// ─── envelopes ─────────────────────────────────────────────────────────────────────────────────

function envelope(
  operationId: string,
  data: ApplyData | null,
  errors: BundleError[] = [],
): ResultEnvelope<ApplyData> {
  const base = {
    contractVersion: CONTRACT_VERSION as typeof CONTRACT_VERSION,
    operation: OPERATION as typeof OPERATION,
    operationId,
    data,
    warnings: [],
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

function stale(message: string): BundleError {
  return bundleError('RAY_PLAN_STALE', message, { path: '/planDigest' });
}

// ─── live state ────────────────────────────────────────────────────────────────────────────────

interface LiveState {
  environmentRevision: number;
  fenced: boolean;
}

async function readLiveState(query: (sql: string) => PromiseLike<unknown>): Promise<LiveState> {
  const rows = (await query(
    'SELECT environment_revision::text AS revision, fence_state FROM runtime_control_state WHERE id = 1',
  )) as { revision: string; fence_state: string }[];
  const row = rows[0];
  // An environment no operation has touched yet: revision 1, fence open.
  if (row === undefined) return { environmentRevision: 1, fenced: false };
  return { environmentRevision: Number(row.revision), fenced: row.fence_state === 'fenced' };
}

/** The freshness and policy checks, in the contract's order; the first failure, or null. */
async function freshnessRefusal(
  request: ApplyControl,
  plan: ApplyPlanCheck,
  live: LiveState,
  hasSteps: boolean,
): Promise<BundleError | null> {
  if (live.environmentRevision !== request.expectedEnvironmentRevision) {
    return stale(
      `the environment is at revision ${live.environmentRevision}, not the expected ` +
        `${request.expectedEnvironmentRevision}; prepare a new plan`,
    );
  }
  if (plan.expired?.() === true) return stale('the plan has expired; prepare a new plan');
  if ((await plan.recompute()) !== request.planDigest) {
    return stale('the plan no longer matches the live environment; prepare a new plan');
  }
  if ((plan.blockers?.length ?? 0) > 0) {
    return bundleError(
      'RAY_POLICY_DENIED',
      'the plan has blockers; resolve them and prepare again',
      {
        reason: 'plan-has-blockers',
      },
    );
  }
  if (hasSteps && live.fenced) {
    return bundleError(
      'RAY_POLICY_DENIED',
      'the environment is fenced; resume it with its fence epoch before applying',
      { reason: 'fenced' },
    );
  }
  return null;
}

// ─── receipts to results ───────────────────────────────────────────────────────────────────────

type ApplyReceipt = ApplyData['receipts'][number];

/** The receipts an apply reports: each step's latest start with its finish, or its skip. */
function reportedReceipts(receipts: readonly OperationReceipt[]): ApplyReceipt[] {
  const out: ApplyReceipt[] = [];
  const started = new Map<string, OperationReceipt>();
  for (const r of receipts) {
    if (r.step === null) continue;
    if (r.event === 'step-started') started.set(r.step, r);
    if (r.event === 'step-finished') {
      const start = started.get(r.step) ?? r;
      out.push({
        step: r.step,
        state: 'done',
        startedAt: formatTimestamp(start.recordedAt),
        finishedAt: formatTimestamp(r.recordedAt),
        digest: r.digest,
      });
      started.delete(r.step);
    }
    // A skip that settles an earlier start is reconciliation, not a step this apply reports.
    if (r.event === 'step-skipped' && !started.has(r.step)) {
      out.push({
        step: r.step,
        state: 'skipped',
        startedAt: formatTimestamp(r.recordedAt),
        finishedAt: formatTimestamp(r.recordedAt),
        digest: null,
      });
    }
    if (r.event === 'step-skipped') started.delete(r.step);
  }
  return out;
}

/** The receipts written since the operation's latest intent. */
function sinceLastIntent(receipts: readonly OperationReceipt[]): OperationReceipt[] {
  let from = 0;
  receipts.forEach((r, i) => {
    if (r.event === 'intent') from = i;
  });
  return receipts.slice(from);
}

// ─── reconciliation ────────────────────────────────────────────────────────────────────────────

interface OpenStep {
  operationId: string;
  step: string;
}

/**
 * Every apply operation that needs settling: one with a step started and neither finished nor
 * skipped, or one whose latest intent has no outcome after it.
 */
async function unsettledOperations(
  query: (sql: string) => PromiseLike<unknown>,
): Promise<{ open: OpenStep[]; interrupted: string[] }> {
  const open = (await query(
    `SELECT s.operation_id::text AS "operationId", s.step
       FROM runtime_control_receipts s
      WHERE s.operation_kind = '${OPERATION}' AND s.event = 'step-started'
      GROUP BY s.operation_id, s.step
     HAVING max(s.id) > coalesce((
              SELECT max(e.id) FROM runtime_control_receipts e
               WHERE e.operation_id = s.operation_id AND e.step = s.step
                 AND e.event IN ('step-finished', 'step-skipped')), 0)
      ORDER BY min(s.id)`,
  )) as OpenStep[];
  const interrupted = (
    (await query(
      `SELECT operation_id::text AS "operationId"
         FROM runtime_control_receipts
        WHERE operation_kind = '${OPERATION}'
        GROUP BY operation_id
       HAVING coalesce(max(id) FILTER (WHERE event = 'intent'), 0)
            > coalesce(max(id) FILTER (WHERE event = 'outcome'), 0)
        ORDER BY min(id)`,
    )) as { operationId: string }[]
  ).map((r) => r.operationId);
  return { open, interrupted };
}

/**
 * Whether any apply operation needs settling. Read-only: a boot asks this first, and takes the lease
 * to reconcile only when the answer is yes. False when the receipts table does not exist yet.
 */
export async function hasUnsettledApplies(db: Db): Promise<boolean> {
  const present = (await db.$client.unsafe(
    "SELECT to_regclass('public.runtime_control_receipts') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (present[0]?.present !== true) return false;
  const found = await unsettledOperations((sql) => db.$client.unsafe(sql));
  return found.open.length > 0 || found.interrupted.length > 0;
}

function stepDetail(started: OperationReceipt | undefined): {
  observer: string | null;
  before: string | null;
  after: string | null;
  atomic: boolean;
  rerunnable: boolean;
} {
  const d = started?.detail ?? {};
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    observer: text(d.observer),
    before: text(d.before),
    after: text(d.after),
    atomic: d.atomic === true,
    rerunnable: d.rerunnable === true,
  };
}

/** How one unfinished step turned out, from its start receipt and the state read now. */
async function observeStep(
  started: OperationReceipt | undefined,
  observers: StateObservers,
): Promise<{ observed: ObservedOutcome; state: string | null }> {
  const d = stepDetail(started);
  const read = d.observer === null ? undefined : observers[d.observer];
  let state: string | null = null;
  if (read !== undefined) {
    try {
      state = await read();
    } catch {
      state = null;
    }
  }
  // The effect and the finish receipt commit together: no finish, no effect.
  if (d.atomic) return { observed: 'not-applied', state };
  if (state !== null && d.after !== null && state === d.after)
    return { observed: 'applied', state };
  if (state !== null && d.before !== null && state === d.before) {
    return { observed: 'not-applied', state };
  }
  if (d.rerunnable) return { observed: 'not-applied', state };
  return { observed: 'unknown', state };
}

function latestStart(receipts: readonly OperationReceipt[], step: string) {
  return [...receipts].reverse().find((r) => r.event === 'step-started' && r.step === step);
}

/** What reconciliation finds for one unsettled operation, before it records anything. */
interface Settlement {
  target: { operationId: string; kind: string; inputsDigest: string };
  entry: ReconciledOperation;
  /** Every step is settled and the operation has no outcome: it is closed as interrupted. */
  closes: boolean;
}

/**
 * Read every unsettled apply operation and observe its open steps, writing nothing. `own` is the
 * operation holding the lease, if any, which is unsettled only through steps it left open itself.
 */
async function surveyUnsettled(
  db: Db,
  observers: StateObservers,
  own: string | undefined,
): Promise<Settlement[]> {
  const found = await unsettledOperations((sql) => db.$client.unsafe(sql));
  const ids = [...new Set([...found.open.map((o) => o.operationId), ...found.interrupted])];
  const settlements: Settlement[] = [];
  for (const operationId of ids) {
    if (operationId === own && !found.open.some((o) => o.operationId === own)) continue;
    const receipts = await readOperationReceipts(db, operationId);
    const first = receipts[0];
    if (first === undefined) continue;
    const entry: ReconciledOperation = { operationId, steps: [], settled: true };
    for (const open of found.open.filter((o) => o.operationId === operationId)) {
      const { observed, state } = await observeStep(latestStart(receipts, open.step), observers);
      entry.steps.push({ step: open.step, observed, state });
      if (observed === 'unknown') entry.settled = false;
    }
    settlements.push({
      target: { operationId, kind: first.operationKind, inputsDigest: first.inputsDigest },
      entry,
      closes: entry.settled && operationId !== own && found.interrupted.includes(operationId),
    });
  }
  return settlements;
}

/**
 * Settle every unsettled apply operation under `lease`. A step observed applied is closed with a
 * finish receipt, one observed not applied with a skip receipt; an unknown step is left open and
 * reported. An interrupted operation whose steps are all settled gets its outcome; the operation that
 * holds the lease (continuing itself) does not.
 */
export async function reconcileUnsettled(
  db: Db,
  lease: OperationLease,
  observers: StateObservers,
): Promise<ReconciledOperation[]> {
  const reconciledBy = lease.identity.operationId;
  const settlements = await surveyUnsettled(db, observers, reconciledBy);
  for (const { target, entry, closes } of settlements) {
    for (const { step, observed, state } of entry.steps) {
      const detail = { reconciledBy, observed, state };
      if (observed === 'applied') {
        await lease.recordFor(target, { event: 'step-finished', step, detail });
      } else if (observed === 'not-applied') {
        await lease.recordFor(target, { event: 'step-skipped', step, detail });
      }
    }
    if (closes) {
      await lease.recordFor(target, {
        event: 'outcome',
        outcome: 'failed',
        detail: { interrupted: true, reconciledBy },
      });
    }
  }
  return settlements.map((s) => s.entry);
}

/**
 * What reconciling now would do, read-only: whether it would record anything (settle a step or close
 * an interrupted operation), and the refusal for the steps whose outcome it cannot establish. A boot
 * with nothing to change asks this, and takes the lease only when there is something to settle.
 */
export async function previewReconciliation(
  db: Db,
  observers: StateObservers,
): Promise<{ settles: boolean; blocked: BundleError | null }> {
  const settlements = await surveyUnsettled(db, observers, undefined);
  return {
    settles: settlements.some(
      (s) => s.closes || s.entry.steps.some((step) => step.observed !== 'unknown'),
    ),
    blocked: blockedError(settlements.map((s) => s.entry)),
  };
}

function blockedError(report: readonly ReconciledOperation[]): BundleError | null {
  const blocked = report.flatMap((op) =>
    op.steps
      .filter((s) => s.observed === 'unknown')
      .map((s) => `step ${s.step} of operation ${op.operationId}`),
  );
  if (blocked.length === 0) return null;
  return bundleError(
    'RAY_RECONCILIATION_REQUIRED',
    `an earlier apply was interrupted and the outcome of ${blocked.join(', ')} cannot be ` +
      'established from its receipts and the live state; nothing was replayed. Inspect the ' +
      "operation's receipts and the environment, then record what the step did with " +
      'resolveInterruptedStep before applying again',
  );
}

// ─── apply ─────────────────────────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '23505';
}

function checkSteps(steps: readonly ApplyStep[]): void {
  const names = new Set<string>();
  for (const step of steps) {
    if (step.name.length === 0 || step.name.length > MAX_STEP_NAME_LENGTH) {
      throw new RangeError(`a step name is 1 to ${MAX_STEP_NAME_LENGTH} characters`);
    }
    if (names.has(step.name)) throw new RangeError(`the step ${step.name} is listed twice`);
    names.add(step.name);
  }
}

async function acquireWithin(
  db: Db,
  identity: OperationIdentity,
  ttlMs: number,
  waitMs: number,
): Promise<OperationLease> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireOperationLease(db, identity, { ttlMs });
    } catch (err) {
      const busy = err instanceof OperationLeaseError && err.code === 'RAY_LOCK_TIMEOUT';
      if (!busy || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }
}

/** Whether `operationId` holds the environment's lease and the lease has not expired. */
async function holdsLiveLease(db: Db, operationId: string): Promise<boolean> {
  const rows = (await db.$client.unsafe(
    `SELECT lease_operation_id::text = $1 AND lease_expires_at > clock_timestamp() AS live
       FROM runtime_control_state WHERE id = 1`,
    [operationId],
  )) as unknown as { live: boolean | null }[];
  return rows[0]?.live === true;
}

/** The recorded outcome of an operation's latest attempt, or null while it has none. */
function latestOutcome(receipts: readonly OperationReceipt[]): OperationReceipt | null {
  const since = sinceLastIntent(receipts);
  return since.find((r) => r.event === 'outcome') ?? null;
}

/** A recorded failure, as the error it reported. */
function recordedError(outcome: OperationReceipt): BundleError {
  const d = outcome.detail ?? {};
  const code = typeof d.code === 'string' && isBundleErrorCode(d.code) ? d.code : 'RAY_INTERNAL';
  const message =
    typeof d.message === 'string'
      ? d.message
      : 'the operation under this idempotency key failed; its receipts record where';
  return bundleError(code, message);
}

/**
 * Run an apply. Every result is the contract's `runtime.apply` envelope and echoes the request's
 * operation id; a step error is rethrown instead only with `rethrowStepErrors`.
 */
export async function runApply(options: ApplyOptions): Promise<ResultEnvelope<ApplyData>> {
  const { db, request, plan } = options;
  const replyId = isUuidV4(request.operationId) ? request.operationId : randomUUID();
  const usage = checkApplyControl(request);
  if (usage.length > 0) return envelope(replyId, null, usage);
  checkSteps(options.steps);
  const observers = options.observers ?? {};
  const ttlMs = options.leaseTtlMs ?? DEFAULT_APPLY_LEASE_TTL_MS;
  const query = (sql: string) => db.$client.unsafe(sql);

  for (let attempt = 0; ; attempt++) {
    // 1. Idempotency lookup.
    let identity: OperationIdentity = {
      operationId: request.operationId,
      actor: request.actor,
      kind: OPERATION,
      inputsDigest: request.planDigest,
      idempotencyKey: request.idempotencyKey,
    };
    try {
      const intent = await findIntentByIdempotencyKey(db, request.idempotencyKey);
      if (intent !== undefined) {
        if (intent.inputsDigest !== request.planDigest) {
          return envelope(replyId, null, [
            bundleError(
              'RAY_IDEMPOTENCY_CONFLICT',
              'this idempotency key was used for another plan; use a new key for a new plan',
              { path: '/idempotencyKey' },
            ),
          ]);
        }
        const receipts = await readOperationReceipts(db, intent.operationId);
        const outcome = latestOutcome(receipts);
        if (outcome?.outcome === 'succeeded') {
          const revision = Number(outcome.detail?.environmentRevision);
          return envelope(replyId, {
            status: 'already-applied',
            environmentRevision: Number.isSafeInteger(revision) ? revision : 1,
            receipts: reportedReceipts(sinceLastIntent(receipts)),
          });
        }
        if (outcome?.outcome === 'failed' && outcome.detail?.interrupted !== true) {
          return envelope(replyId, null, [recordedError(outcome)]);
        }
        if (outcome === null && (await holdsLiveLease(db, intent.operationId))) {
          return envelope(replyId, null, [
            bundleError(
              'RAY_LOCK_TIMEOUT',
              'the operation under this idempotency key is still running; retry once it has finished',
            ),
          ]);
        }
        // Refused (nothing ran) or interrupted: continue the same operation, without a second key.
        identity = {
          operationId: intent.operationId,
          actor: request.actor,
          kind: OPERATION,
          inputsDigest: request.planDigest,
        };
      }
    } catch {
      return envelope(replyId, null, [infraUnavailable()]);
    }

    // 2–3. Freshness, blockers and the fence, before anything is written.
    try {
      const refusal = await freshnessRefusal(
        request,
        plan,
        await readLiveState(query),
        options.steps.length > 0,
      );
      if (refusal !== null) return envelope(replyId, null, [refusal]);
    } catch {
      return envelope(replyId, null, [infraUnavailable()]);
    }

    // 4. The lease and the intent receipt.
    let lease: OperationLease;
    try {
      lease = await acquireWithin(db, identity, ttlMs, options.leaseWaitMs ?? 0);
    } catch (err) {
      // Another applier recorded the same key between the lookup and here: look it up again.
      if (isUniqueViolation(err) && attempt === 0) continue;
      if (err instanceof OperationLeaseError) {
        return envelope(replyId, null, [bundleError(err.code, err.message)]);
      }
      return envelope(replyId, null, [infraUnavailable()]);
    }
    return await underLease(options, lease, replyId, observers, ttlMs);
  }
}

async function underLease(
  options: ApplyOptions,
  lease: OperationLease,
  replyId: string,
  observers: StateObservers,
  ttlMs: number,
): Promise<ResultEnvelope<ApplyData>> {
  const { db, request, plan, steps } = options;
  const checkpoint = options.onCheckpoint ?? (async () => {});
  const renewal = setInterval(
    () => {
      lease.renew(ttlMs).catch(() => {});
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  renewal.unref();
  let anyDone = false;
  const refuse = async (error: BundleError): Promise<ResultEnvelope<ApplyData>> => {
    await lease
      .release('refused', { code: error.code, message: error.message })
      .catch(() => undefined);
    return envelope(replyId, null, [error]);
  };

  try {
    await checkpoint('after-intent');

    // 5. Reconcile what earlier applies left unsettled.
    const report = await reconcileUnsettled(db, lease, observers);
    if (report.length > 0) options.onReconciled?.(report);
    const blocked = blockedError(report);
    if (blocked !== null) return await refuse(blocked);

    // 6. Freshness again, under the lease.
    const refusal = await freshnessRefusal(
      request,
      plan,
      await readLiveState((sql) => db.$client.unsafe(sql)),
      steps.length > 0,
    );
    if (refusal !== null) return await refuse(refusal);

    // 7. The steps. A step this operation already finished (it is continuing itself) is not run again.
    const earlier = await readOperationReceipts(db, lease.identity.operationId);
    const finishedEarlier = new Set(
      earlier.filter((r) => r.event === 'step-finished' && r.step !== null).map((r) => r.step),
    );
    let stepError: unknown;
    let failedStep: string | undefined;
    const context: StepContext = { operationId: lease.identity.operationId };
    for (const step of steps) {
      if (finishedEarlier.has(step.name)) continue;
      await lease.renew(ttlMs);
      if (step.pending !== undefined && !(await step.pending())) {
        await lease.record({ event: 'step-skipped', step: step.name });
        continue;
      }
      const read = step.observer === undefined ? undefined : observers[step.observer];
      if (step.observer !== undefined && read === undefined) {
        throw new RangeError(`no observer named ${step.observer}`);
      }
      const before = read === undefined ? null : await read();
      await lease.record({
        event: 'step-started',
        step: step.name,
        detail: {
          observer: step.observer ?? null,
          before,
          after: step.expectedAfter ?? null,
          atomic: step.kind === 'transaction',
          rerunnable: step.rerunnable === true,
        },
      });
      await checkpoint('after-step-started', step.name);
      try {
        if (step.kind === 'transaction') {
          await lease.mutate(
            async (tx) => {
              const effect = await step.run(tx, context);
              await checkpoint('after-step-effect', step.name);
              await lease.recordIn(tx, {
                event: 'step-finished',
                step: step.name,
                digest: effect?.digest ?? null,
              });
            },
            step.schemaChange
              ? {
                  beforeGuard: (tx) =>
                    lockSchemaInTransaction(tx, options.lockTimeoutMs ?? undefined),
                }
              : {},
          );
        } else {
          const effect = await step.run(context);
          await checkpoint('after-step-effect', step.name);
          await lease.record({
            event: 'step-finished',
            step: step.name,
            digest: effect?.digest ?? null,
          });
        }
        anyDone = true;
      } catch (err) {
        stepError = err;
        failedStep = step.name;
        if (err instanceof OperationLeaseError) break;
        // Settle the step now when its outcome is certain; otherwise it stays open for the next
        // apply to reconcile (and, if still unknown, to block on).
        const settled =
          step.kind === 'transaction'
            ? 'not-applied'
            : read === undefined
              ? 'unknown'
              : (await read().catch(() => null)) === before
                ? 'not-applied'
                : 'unknown';
        if (settled === 'not-applied') {
          await lease
            .record({ event: 'step-skipped', step: step.name, detail: { failed: true } })
            .catch(() => undefined);
        }
        break;
      }
    }

    if (stepError !== undefined) {
      const error = stepErrorFor(stepError, failedStep as string);
      await lease
        .release(
          'failed',
          { code: error.code, message: error.message, step: failedStep },
          {
            bumpRevision: anyDone,
          },
        )
        .catch(() => undefined);
      const ownError =
        stepError instanceof OperationLeaseError || stepError instanceof ApplyStepRefusal;
      if (options.rethrowStepErrors === true && !ownError) {
        throw new StepFailure(stepError);
      }
      return envelope(replyId, null, [error]);
    }

    // 8. The outcome, and the revision when anything ran.
    const revision = await lease.release(
      'succeeded',
      (environmentRevision) => ({ environmentRevision, planDigest: request.planDigest }),
      { bumpRevision: anyDone },
    );
    const receipts = await readOperationReceipts(db, lease.identity.operationId);
    return envelope(replyId, {
      status: 'applied',
      environmentRevision: revision,
      receipts: reportedReceipts(receipts).filter((r) => steps.some((s) => s.name === r.step)),
    });
  } catch (err) {
    if (err instanceof StepFailure) throw err.cause;
    await lease.release('failed').catch(() => undefined);
    if (err instanceof OperationLeaseError) {
      return envelope(replyId, null, [bundleError(err.code, err.message)]);
    }
    // A caller's own mistake (a step naming an observer it did not pass), not the database.
    if (err instanceof RangeError) {
      return envelope(replyId, null, [bundleError('RAY_INTERNAL', err.message)]);
    }
    return envelope(replyId, null, [infraUnavailable()]);
  } finally {
    clearInterval(renewal);
  }
}

/** Carries a step's own error out of the apply, after its receipts are written. */
class StepFailure extends Error {
  constructor(cause: unknown) {
    super('an apply step failed', { cause });
  }
}

function stepErrorFor(err: unknown, step: string): BundleError {
  if (err instanceof OperationLeaseError) return bundleError(err.code, err.message);
  if (err instanceof ApplyStepRefusal) return err.error;
  if (err instanceof SchemaLockTimeoutError) return bundleError('RAY_LOCK_TIMEOUT', err.message);
  return bundleError('RAY_INTERNAL', `the step ${step} failed; its receipts record where`);
}

// ─── manual reconciliation ─────────────────────────────────────────────────────────────────────

/** An operator's record of what an interrupted step actually did. */
export interface ResolveStepRequest {
  /** UUID v4 of this resolution. */
  operationId: string;
  actor: string;
  /** The operation that left the step open. */
  interruptedOperationId: string;
  step: string;
  /** What the operator established: the step took effect, or it did not. */
  outcome: 'applied' | 'not-applied';
}

export type ResolveStepResult = { ok: true; settled: boolean } | { ok: false; error: BundleError };

/**
 * Record, under the operation lease, what an operator established about a step reconciliation could
 * not decide. The step is closed on the interrupted operation's record (finished for `applied`,
 * skipped for `not-applied`) with `manual: true` and the resolving operation's id; once every step of
 * that operation is settled it gets its outcome. The next apply then runs, and a step that was not
 * applied runs again only through a new plan. Nothing here repeats or reverses the step itself.
 */
export async function resolveInterruptedStep(
  db: Db,
  request: ResolveStepRequest,
  opts: { leaseTtlMs?: number } = {},
): Promise<ResolveStepResult> {
  if (!isUuidV4(request.operationId) || !isUuidV4(request.interruptedOperationId)) {
    return {
      ok: false,
      error: bundleError('RAY_USAGE', 'both operation ids must be UUID v4', {
        path: '/interruptedOperationId',
      }),
    };
  }
  let lease: OperationLease;
  try {
    lease = await acquireOperationLease(
      db,
      {
        operationId: request.operationId,
        actor: request.actor,
        kind: OPERATION,
        inputsDigest: digestOf({
          resolve: request.interruptedOperationId,
          step: request.step,
          outcome: request.outcome,
        }),
      },
      { ttlMs: opts.leaseTtlMs ?? DEFAULT_APPLY_LEASE_TTL_MS },
    );
  } catch (err) {
    if (err instanceof OperationLeaseError) {
      return { ok: false, error: bundleError(err.code, err.message) };
    }
    if (err instanceof RangeError) {
      return { ok: false, error: bundleError('RAY_USAGE', err.message) };
    }
    return { ok: false, error: infraUnavailable() };
  }
  try {
    const found = await unsettledOperations((sql) => db.$client.unsafe(sql));
    const open = found.open.filter((o) => o.operationId === request.interruptedOperationId);
    if (!open.some((o) => o.step === request.step)) {
      await lease.release('refused', { code: 'RAY_USAGE' });
      return {
        ok: false,
        error: bundleError('RAY_USAGE', 'that operation has no unsettled step of that name', {
          path: '/step',
        }),
      };
    }
    const receipts = await readOperationReceipts(db, request.interruptedOperationId);
    const first = receipts[0] as OperationReceipt;
    const target = {
      operationId: request.interruptedOperationId,
      kind: first.operationKind,
      inputsDigest: first.inputsDigest,
    };
    const detail = {
      manual: true,
      resolvedBy: request.operationId,
      observed: request.outcome,
    };
    await lease.recordFor(target, {
      event: request.outcome === 'applied' ? 'step-finished' : 'step-skipped',
      step: request.step,
      detail,
    });
    const settled = open.length === 1;
    if (settled && found.interrupted.includes(request.interruptedOperationId)) {
      await lease.recordFor(target, {
        event: 'outcome',
        outcome: 'failed',
        detail: { interrupted: true, resolvedBy: request.operationId },
      });
    }
    await lease.release('succeeded', {
      resolved: request.interruptedOperationId,
      step: request.step,
      outcome: request.outcome,
    });
    return { ok: true, settled };
  } catch (err) {
    await lease.release('failed').catch(() => undefined);
    if (err instanceof OperationLeaseError) {
      return { ok: false, error: bundleError(err.code, err.message) };
    }
    return { ok: false, error: infraUnavailable() };
  }
}
