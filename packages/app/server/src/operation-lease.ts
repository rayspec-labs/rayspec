/**
 * THE OPERATION LEASE AND ITS RECEIPTS — one mutating runtime-control operation at a time, per
 * environment, and a durable record of what each one did.
 *
 * WHY A LEASE WITH AN EPOCH. Two processes (two CLI runs, a CLI run and a supervisor, a crashed run
 * and its retry) may try to operate on one environment at once. The lease lives in the environment's
 * own database (`runtime_control_state`, one row), so every process sees the same holder. Taking it
 * increments `lease_epoch`, a FENCING EPOCH: every mutating transaction of the holder re-reads the
 * row `FOR UPDATE` and refuses unless the epoch, the holder's operation id and the expiry still
 * match. A holder that stalls past its expiry — a long GC pause, a suspended laptop — and is taken
 * over therefore cannot write when it wakes up: its epoch is stale, and the check runs in the SAME
 * transaction as the write it guards, so there is no window between checking and writing. Expiry is
 * compared with the DATABASE clock, so two processes with skewed clocks agree on it.
 *
 * INTENT BEFORE EFFECT. Taking the lease and appending the operation's `intent` receipt happen in one
 * transaction, before the operation does anything else. A step that is not itself one database
 * transaction appends `step-started` in its own committed transaction first and `step-finished`
 * after; a crash in between leaves exactly the evidence the next holder needs: a start without a
 * finish. The next holder sees the takeover (`takenOver`, and a `lease-taken-over` receipt) and must
 * reconcile that step before it repeats anything — expiry alone never authorizes a second external
 * effect. Only an EXPIRED lease is ever taken over, even by a retry under the same operation id: a
 * live holder may still be running a step, and two holders of one operation would both run it.
 *
 * RECEIPTS ARE APPEND-ONLY. `runtime_control_receipts` refuses UPDATE, DELETE and TRUNCATE by
 * trigger. Every receipt names the operation id, the actor, the kind, the lease epoch and the inputs
 * digest; a receipt never holds a secret or a binding value.
 *
 * WHAT THE LEASE IS NOT. It is not the source fence a quiesce takes (`fence_epoch`, separate), and
 * not the shared schema lock (`schema-lock.ts`), which a schema-mutating step takes in addition.
 */
import { randomBytes } from 'node:crypto';
import {
  BINDING_REVISION_KEY_BYTES,
  isIdempotencyKey,
  isSha256,
  isUuidV4,
  MAX_ACTOR_LENGTH,
  type ResultOperation,
} from '@rayspec/bundle-contract';
import { redactValue } from '@rayspec/core';
import type { Db } from '@rayspec/db';

/** A postgres.js transaction handle, as far as this module uses it. */
export interface LeaseTx {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}

/** The longest lease one acquisition or renewal grants: one hour. */
export const MAX_LEASE_TTL_MS = 3_600_000;

/** The receipt events, in the order an operation writes them. */
export type ReceiptEvent =
  | 'intent'
  | 'lease-taken-over'
  | 'step-started'
  | 'step-finished'
  | 'step-skipped'
  | 'outcome';

/** How an operation ended. */
export type OperationOutcome = 'succeeded' | 'failed' | 'refused';

/** One receipt as read back. */
export interface OperationReceipt {
  id: number;
  operationId: string;
  operationKind: string;
  actor: string;
  leaseEpoch: number;
  inputsDigest: string;
  event: ReceiptEvent;
  step: string | null;
  digest: string | null;
  outcome: string | null;
  idempotencyKey: string | null;
  detail: Record<string, unknown> | null;
  recordedAt: Date;
}

/** Who asks for the lease, for what, and over which inputs. */
export interface OperationIdentity {
  /** UUID v4 chosen by the caller and reused on retry. */
  operationId: string;
  /** Opaque, 1 to 256 characters; never a credential. */
  actor: string;
  kind: ResultOperation;
  /** SHA-256 of the operation's canonical inputs. */
  inputsDigest: string;
  /** An apply's idempotency key; at most one intent ever carries a given key. */
  idempotencyKey?: string;
}

/** The previous holder a new lease replaced. */
export interface LeaseTakeover {
  operationId: string;
  kind: string | null;
  leaseEpoch: number;
  /** Whether the previous lease had expired (a live lease is never taken over, so always true). */
  expired: boolean;
}

/**
 * A refused lease operation. `RAY_LOCK_TIMEOUT` (retryable): another operation holds a live lease.
 * `RAY_FENCE_MISMATCH`: this holder's lease expired or was taken over, so it may not write.
 */
export class OperationLeaseError extends Error {
  readonly code: 'RAY_LOCK_TIMEOUT' | 'RAY_FENCE_MISMATCH';
  readonly retryable: boolean;
  constructor(code: 'RAY_LOCK_TIMEOUT' | 'RAY_FENCE_MISMATCH', message: string) {
    super(message);
    this.name = 'OperationLeaseError';
    this.code = code;
    this.retryable = code === 'RAY_LOCK_TIMEOUT';
  }
}

function checkTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new RangeError(`the lease lifetime must be 1 to ${MAX_LEASE_TTL_MS} ms`);
  }
}

function checkIdentity(identity: OperationIdentity): void {
  if (!isUuidV4(identity.operationId)) throw new RangeError('operationId must be a UUID v4');
  if (identity.actor.length === 0 || identity.actor.length > MAX_ACTOR_LENGTH) {
    throw new RangeError(`actor must be 1 to ${MAX_ACTOR_LENGTH} characters`);
  }
  if (!isSha256(identity.inputsDigest)) throw new RangeError('inputsDigest must be a SHA-256');
  if (identity.idempotencyKey !== undefined && !isIdempotencyKey(identity.idempotencyKey)) {
    throw new RangeError('an idempotency key is 16 to 128 characters of [A-Za-z0-9_-]');
  }
}

/**
 * Create the environment's state row when it does not exist yet, with a fresh random binding revision
 * key, or with `bindingRevisionKey` when the caller already computed revision ids under a key the
 * environment is to keep. Idempotent: an existing row, and its key, are left alone.
 */
export async function ensureRuntimeControlState(
  tx: LeaseTx,
  bindingRevisionKey?: Uint8Array,
): Promise<void> {
  if (
    bindingRevisionKey !== undefined &&
    bindingRevisionKey.length !== BINDING_REVISION_KEY_BYTES
  ) {
    throw new RangeError(`the binding revision key must be ${BINDING_REVISION_KEY_BYTES} bytes`);
  }
  const key = bindingRevisionKey ?? randomBytes(BINDING_REVISION_KEY_BYTES);
  await tx.unsafe(
    'INSERT INTO runtime_control_state (id, binding_revision_key) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    [Buffer.from(key).toString('hex')],
  );
}

interface StateLeaseRow {
  lease_epoch: string | number;
  lease_operation_id: string | null;
  lease_kind: string | null;
  live: boolean | null;
}

async function lockStateRow(tx: LeaseTx): Promise<StateLeaseRow | undefined> {
  const rows = (await tx.unsafe(
    `SELECT lease_epoch, lease_operation_id::text AS lease_operation_id, lease_kind,
            lease_expires_at > clock_timestamp() AS live
       FROM runtime_control_state WHERE id = 1 FOR UPDATE`,
  )) as StateLeaseRow[];
  return rows[0];
}

/** One receipt to append; the operation, actor and epoch come from the lease that writes it. */
export interface ReceiptInput {
  event: ReceiptEvent;
  step?: string | null;
  digest?: string | null;
  outcome?: OperationOutcome | null;
  detail?: Record<string, unknown> | null;
}

async function appendReceipt(
  tx: LeaseTx,
  identity: Pick<OperationIdentity, 'operationId' | 'kind' | 'actor' | 'inputsDigest'> & {
    idempotencyKey?: string;
  },
  leaseEpoch: number,
  receipt: ReceiptInput,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO runtime_control_receipts
       (operation_id, operation_kind, actor, lease_epoch, inputs_digest, event, step, digest,
        outcome, idempotency_key, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      identity.operationId,
      identity.kind,
      identity.actor,
      leaseEpoch,
      identity.inputsDigest,
      receipt.event,
      receipt.step ?? null,
      receipt.digest ?? null,
      receipt.outcome ?? null,
      receipt.event === 'intent' ? (identity.idempotencyKey ?? null) : null,
      // A receipt passes the one redaction path: its detail can carry a message an apply step
      // produced, and a receipt outlives the process that wrote it.
      receipt.detail === undefined || receipt.detail === null
        ? null
        : JSON.stringify(redactValue(receipt.detail)),
    ],
  );
}

/**
 * Take the operation lease for `identity`, in one transaction with its intent receipt.
 *
 * Refused with `RAY_LOCK_TIMEOUT` (retryable) while ANY holder has a live lease, including an earlier
 * attempt of the same operation id: that attempt may still be running, and the check and the take
 * happen under one row lock, so two concurrent retries of one operation cannot both hold it. A lease
 * whose holder expired is taken over: the epoch increases, so the earlier holder can no longer write,
 * and the takeover is recorded as a `lease-taken-over` receipt and returned as `takenOver`.
 */
export async function acquireOperationLease(
  db: Db,
  identity: OperationIdentity,
  opts: { ttlMs: number },
): Promise<OperationLease> {
  checkIdentity(identity);
  checkTtl(opts.ttlMs);
  let epoch = 0;
  let takenOver: LeaseTakeover | null = null;
  await db.$client.begin(async (tx) => {
    await ensureRuntimeControlState(tx);
    const row = await lockStateRow(tx);
    if (row === undefined) throw new Error('the runtime-control state row is missing');
    const holder = row.lease_operation_id;
    const live = row.live === true;
    if (holder !== null && live) {
      throw new OperationLeaseError(
        'RAY_LOCK_TIMEOUT',
        holder === identity.operationId
          ? 'an earlier attempt of this operation still holds the lease; retry once it has ' +
              'finished or its lease has expired'
          : 'another runtime-control operation holds the lease for this environment; retry once it ' +
              'has finished or its lease has expired',
      );
    }
    const updated = (await tx.unsafe(
      `UPDATE runtime_control_state
          SET lease_epoch = lease_epoch + 1, lease_operation_id = $1, lease_kind = $2,
              lease_actor = $3, lease_expires_at = clock_timestamp() + make_interval(secs => $4::float8 / 1000),
              updated_at = now()
        WHERE id = 1
        RETURNING lease_epoch`,
      [identity.operationId, identity.kind, identity.actor, opts.ttlMs],
    )) as { lease_epoch: string | number }[];
    epoch = Number(updated[0]?.lease_epoch);
    await appendReceipt(tx, identity, epoch, { event: 'intent' });
    if (holder !== null) {
      takenOver = {
        operationId: holder,
        kind: row.lease_kind,
        leaseEpoch: Number(row.lease_epoch),
        expired: !live,
      };
      await appendReceipt(tx, identity, epoch, {
        event: 'lease-taken-over',
        detail: { ...takenOver },
      });
    }
  });
  return new OperationLease(db, identity, epoch, takenOver);
}

/**
 * A held operation lease. Every method that writes checks, in its own transaction, that this holder
 * still holds the lease at its epoch; a stale holder gets `RAY_FENCE_MISMATCH` and writes nothing.
 */
export class OperationLease {
  readonly #db: Db;
  readonly identity: OperationIdentity;
  /** The fencing epoch this holder was granted. */
  readonly epoch: number;
  /** The previous holder this lease replaced, or null. */
  readonly takenOver: LeaseTakeover | null;
  #released = false;

  constructor(db: Db, identity: OperationIdentity, epoch: number, takenOver: LeaseTakeover | null) {
    this.#db = db;
    this.identity = identity;
    this.epoch = epoch;
    this.takenOver = takenOver;
  }

  /**
   * Check, inside `tx`, that this holder still holds the lease: the row is locked FOR UPDATE, so a
   * takeover waits for `tx` to end and cannot slip in between the check and the caller's write.
   */
  async guard(tx: LeaseTx): Promise<void> {
    if (this.#released) {
      throw new OperationLeaseError('RAY_FENCE_MISMATCH', 'this lease was already released');
    }
    const row = await lockStateRow(tx);
    if (
      row === undefined ||
      Number(row.lease_epoch) !== this.epoch ||
      row.lease_operation_id !== this.identity.operationId ||
      row.live !== true
    ) {
      throw new OperationLeaseError(
        'RAY_FENCE_MISMATCH',
        `the operation lease at epoch ${this.epoch} expired or was taken over; this operation may ` +
          'not write any more',
      );
    }
  }

  /**
   * Run `write` in one transaction that first checks the lease. With `bumpRevision`, the same
   * transaction increases the environment revision, and the new revision is returned beside the
   * result.
   */
  async mutate<T>(
    write: (tx: LeaseTx) => Promise<T>,
    opts: {
      bumpRevision?: boolean;
      /**
       * Runs first in the same transaction, before the lease check locks the state row: a wait here
       * (the shared schema lock) therefore never holds that row, which the lease renewal needs.
       */
      beforeGuard?: (tx: LeaseTx) => Promise<void>;
    } = {},
  ): Promise<{ result: T; environmentRevision: number | null }> {
    let result: T | undefined;
    let environmentRevision: number | null = null;
    await this.#db.$client.begin(async (tx) => {
      if (opts.beforeGuard !== undefined) await opts.beforeGuard(tx);
      await this.guard(tx);
      result = await write(tx);
      if (opts.bumpRevision === true) {
        const rows = (await tx.unsafe(
          `UPDATE runtime_control_state
              SET environment_revision = environment_revision + 1, updated_at = now()
            WHERE id = 1 RETURNING environment_revision`,
        )) as { environment_revision: string | number }[];
        environmentRevision = Number(rows[0]?.environment_revision);
      }
    });
    return { result: result as T, environmentRevision };
  }

  /** Append one receipt under the lease check. */
  async record(receipt: ReceiptInput): Promise<void> {
    await this.mutate((tx) => appendReceipt(tx, this.identity, this.epoch, receipt));
  }

  /**
   * Append one receipt inside `tx`, a transaction `mutate` opened (so the lease check already ran in
   * it): a step's finish receipt then commits together with the step's own effect, or not at all.
   */
  async recordIn(tx: LeaseTx, receipt: ReceiptInput): Promise<void> {
    await appendReceipt(tx, this.identity, this.epoch, receipt);
  }

  /**
   * Append a receipt to ANOTHER operation's record, under this lease: how the holder that reconciles
   * an interrupted operation closes its steps. The receipt names this holder as the actor and carries
   * this lease's epoch, so the record shows who settled it and when; it never carries an idempotency
   * key.
   */
  async recordFor(
    operation: { operationId: string; kind: string; inputsDigest: string },
    receipt: Omit<ReceiptInput, 'event'> & { event: Exclude<ReceiptEvent, 'intent'> },
  ): Promise<void> {
    if (!isUuidV4(operation.operationId)) throw new RangeError('operationId must be a UUID v4');
    await this.mutate((tx) =>
      appendReceipt(
        tx,
        {
          operationId: operation.operationId,
          kind: operation.kind as ResultOperation,
          actor: this.identity.actor,
          inputsDigest: operation.inputsDigest,
        },
        this.epoch,
        receipt,
      ),
    );
  }

  /**
   * Run one step with a receipt committed before and after it. `run` receives this lease so every
   * write it makes can go through `mutate`. When `run` throws, no finish receipt is written: the
   * start without a finish is the record that the step's effect is unknown.
   */
  async step<T>(
    name: string,
    run: (lease: OperationLease) => Promise<{ value: T; digest?: string | null }>,
  ): Promise<T> {
    await this.record({ event: 'step-started', step: name });
    const { value, digest } = await run(this);
    await this.record({ event: 'step-finished', step: name, digest: digest ?? null });
    return value;
  }

  /** Extend the lease by `ttlMs` from now, if this holder still holds it. */
  async renew(ttlMs: number): Promise<void> {
    checkTtl(ttlMs);
    await this.mutate(async (tx) => {
      await tx.unsafe(
        `UPDATE runtime_control_state
            SET lease_expires_at = clock_timestamp() + make_interval(secs => $1::float8 / 1000)
          WHERE id = 1`,
        [ttlMs],
      );
    });
  }

  /**
   * Record the outcome and release the lease, in one transaction. Only a holder that still holds the
   * lease can do this; a stale one gets `RAY_FENCE_MISMATCH`, and the receipts it left stay what
   * they are for the next holder to reconcile. With `bumpRevision` the same transaction increases the
   * environment revision. Returns the environment revision the outcome records; `detail` may be
   * built from it.
   */
  async release(
    outcome: OperationOutcome,
    detail?: Record<string, unknown> | ((environmentRevision: number) => Record<string, unknown>),
    opts: { bumpRevision?: boolean } = {},
  ): Promise<number> {
    let revision = 0;
    await this.mutate(async (tx) => {
      const rows = (await tx.unsafe(
        opts.bumpRevision === true
          ? `UPDATE runtime_control_state
                SET environment_revision = environment_revision + 1, updated_at = now()
              WHERE id = 1 RETURNING environment_revision`
          : 'SELECT environment_revision FROM runtime_control_state WHERE id = 1',
      )) as { environment_revision: string | number }[];
      revision = Number(rows[0]?.environment_revision);
      await appendReceipt(tx, this.identity, this.epoch, {
        event: 'outcome',
        outcome,
        detail: typeof detail === 'function' ? detail(revision) : (detail ?? null),
      });
      await tx.unsafe(
        `UPDATE runtime_control_state
            SET lease_operation_id = NULL, lease_kind = NULL, lease_actor = NULL,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = 1`,
      );
    });
    this.#released = true;
    return revision;
  }
}

interface ReceiptRow {
  id: string | number;
  operation_id: string;
  operation_kind: string;
  actor: string;
  lease_epoch: string | number;
  inputs_digest: string;
  event: ReceiptEvent;
  step: string | null;
  digest: string | null;
  outcome: string | null;
  idempotency_key: string | null;
  detail: Record<string, unknown> | null;
  recorded_at: Date | string;
}

const RECEIPT_COLUMNS = `id, operation_id::text AS operation_id, operation_kind, actor, lease_epoch,
  inputs_digest, event, step, digest, outcome, idempotency_key, detail, recorded_at`;

function toReceipt(row: ReceiptRow): OperationReceipt {
  return {
    id: Number(row.id),
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    actor: row.actor,
    leaseEpoch: Number(row.lease_epoch),
    inputsDigest: row.inputs_digest,
    event: row.event,
    step: row.step,
    digest: row.digest,
    outcome: row.outcome,
    idempotencyKey: row.idempotency_key,
    detail: row.detail,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at),
  };
}

/** Every receipt of one operation, in the order it was written. */
export async function readOperationReceipts(
  db: Db,
  operationId: string,
): Promise<OperationReceipt[]> {
  if (!isUuidV4(operationId)) throw new RangeError('operationId must be a UUID v4');
  const rows = (await db.$client.unsafe(
    `SELECT ${RECEIPT_COLUMNS} FROM runtime_control_receipts WHERE operation_id = $1 ORDER BY id`,
    [operationId],
  )) as unknown as ReceiptRow[];
  return rows.map(toReceipt);
}

/** The intent receipt that carries an idempotency key, or undefined. */
export async function findIntentByIdempotencyKey(
  db: Db,
  idempotencyKey: string,
): Promise<OperationReceipt | undefined> {
  const rows = (await db.$client.unsafe(
    `SELECT ${RECEIPT_COLUMNS} FROM runtime_control_receipts
      WHERE idempotency_key = $1 AND event = 'intent'`,
    [idempotencyKey],
  )) as unknown as ReceiptRow[];
  return rows[0] === undefined ? undefined : toReceipt(rows[0]);
}

/**
 * The steps of an operation that have a start receipt and no finish or skip receipt: what a crash
 * left in an unknown state, for the next holder to reconcile.
 */
export function unfinishedSteps(receipts: readonly OperationReceipt[]): string[] {
  const open = new Set<string>();
  for (const r of receipts) {
    if (r.step === null) continue;
    if (r.event === 'step-started') open.add(r.step);
    if (r.event === 'step-finished' || r.event === 'step-skipped') open.delete(r.step);
  }
  return [...open];
}
