/**
 * THE RECEIPTS OF AN EXPORT — every transition of the migration state machine an export goes
 * through, recorded where the operator and the environment can read it back:
 *
 *   PRECHECK → QUIESCING → FROZEN → EXPORTING → EXPORTED, and BLOCKED from any of them.
 *
 * Each transition carries the operation id, the actor, the fence epoch and state at that moment, the
 * time, the digests known by then and the recovery action that applies from there on.
 *
 * TWO RECORDS.
 *  - The LOCAL RECEIPT, `receipts/export-<operationId>.json` in the deployment state directory
 *    (mode 0600, replaced atomically on each transition). It is written to be shared: it holds no
 *    secret, no connection string, no path, no record content and no table or store name — counts,
 *    digests, codes and states only. A refusal is recorded by its code and reason, never its message,
 *    which may name a table.
 *  - The ENVIRONMENT'S RECEIPTS, rows of `runtime_control_receipts` under the export's operation id
 *    (kind `export`, one `step-finished` per transition, then the `outcome`), from the moment the
 *    export starts to fence the source. A precheck that blocks changes nothing at the source, so it
 *    is recorded locally only.
 *
 * A KILLED EXPORT leaves a local receipt without an outcome. The next export of the deployment finds
 * it once it holds the scratch lock (the killed process can no longer be running), and closes it as
 * BLOCKED with `interrupted: true` and the operation that closed it — locally and, when the database
 * is reachable, in the environment's receipts.
 */
import {
  type BundleError,
  CONTRACT_VERSION,
  digestOf,
  formatTimestamp,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type { StateDirectory } from './deployment-state.js';
import { appendOperationReceipt } from './operation-lease.js';

/** The states of the migration state machine an export moves through. */
export type ExportState =
  | 'PRECHECK'
  | 'QUIESCING'
  | 'FROZEN'
  | 'EXPORTING'
  | 'EXPORTED'
  | 'BLOCKED';

/** The actor an export records: the CLI on the operator's host. Never a credential. */
export const EXPORT_ACTOR = 'rayspec-export';

/** Digests an export knows at a transition; each is lowercase hex SHA-256. */
export interface ExportDigests {
  applicationDigest?: string;
  innerArchiveSha256?: string;
  ciphertextSha256?: string;
  migrationBundleSha256?: string;
}

export interface ExportTransition {
  state: ExportState;
  /** UTC RFC 3339. */
  at: string;
  /** The fence epoch and state of the environment at this transition; null when it was not read. */
  fenceEpoch: number | null;
  fenceState: 'open' | 'fenced' | null;
  digests: ExportDigests;
  /** What the operator does from here on. */
  recovery: string;
  /** The refusal that blocked the export: code and reason, never the message. */
  error?: { code: string; reason?: string };
  /** Set when a later export closed this one, which had been killed. */
  interrupted?: true;
  closedBy?: string;
}

/** Counts and facts of a finished export; no table, store or record is named. */
export interface ExportSummary {
  applicationId: string;
  applicationVersion: string;
  sourceRuntime: string;
  runHistoryPolicy: 'included' | 'excluded';
  workflowSystemDatabase: 'included' | 'absent';
  excludedDataCategories: string[];
  tables: { application: number; workflowSystem: number };
  rows: { application: number; workflowSystem: number };
  objectCount: number;
  reader: 'snapshot-role' | 'single-role';
  barriers: { barrier: string; state: string }[];
  ciphertextSize: number;
}

/** The local operation receipt of one export. */
export interface ExportReceipt {
  receiptFormatVersion: 1;
  contractVersion: typeof CONTRACT_VERSION;
  operation: 'export';
  operationId: string;
  actor: string;
  deploymentId: string;
  /** SHA-256 of the canonical request (deployment, recipient, policies), never the request itself. */
  inputsDigest: string;
  outcome: 'exported' | 'blocked' | null;
  transitions: ExportTransition[];
  summary: ExportSummary | null;
}

/** The request an export's inputs digest covers. */
export interface ExportInputs {
  deploymentId: string;
  recipient: string;
  runHistoryPolicy: 'included' | 'excluded';
  sourceStopped: boolean;
  quiesceDeadlineSeconds: number;
}

/** The local receipt's name for an export's operation id. */
export function exportReceiptName(operationId: string): string {
  return `export-${operationId}`;
}

/** The recovery instruction once the source may be fenced at `fenceEpoch`. */
export function resumeInstruction(deploymentId: string, fenceEpoch: number): string {
  return `rayspec resume --deployment ${deploymentId} --fence-epoch ${fenceEpoch}`;
}

/**
 * The receipts of one export. Every write to the local file is awaited; a write to the environment's
 * receipts that fails is noted (`databaseReceiptsFailed`) and does not stop the export, whose own
 * result reports what happened.
 */
export class ExportReceiptLog {
  readonly #stateDir: StateDirectory;
  readonly #receipt: ExportReceipt;
  #db: Db | null = null;
  #databaseFailed = false;

  private constructor(stateDir: StateDirectory, receipt: ExportReceipt) {
    this.#stateDir = stateDir;
    this.#receipt = receipt;
  }

  /** Start the receipt of a new export; nothing is written until its first transition. */
  static start(
    stateDir: StateDirectory,
    operationId: string,
    inputs: ExportInputs,
  ): ExportReceiptLog {
    return new ExportReceiptLog(stateDir, {
      receiptFormatVersion: 1,
      contractVersion: CONTRACT_VERSION,
      operation: 'export',
      operationId,
      actor: EXPORT_ACTOR,
      deploymentId: inputs.deploymentId,
      inputsDigest: digestOf(inputs),
      outcome: null,
      transitions: [],
      summary: null,
    });
  }

  get receipt(): ExportReceipt {
    return this.#receipt;
  }

  get databaseReceiptsFailed(): boolean {
    return this.#databaseFailed;
  }

  /**
   * From now on every transition is also recorded in the environment's receipts; the transitions
   * already recorded locally are written there first, in order.
   */
  async attach(db: Db): Promise<void> {
    this.#db = db;
    for (const t of this.#receipt.transitions) await this.#record(t);
  }

  /** Record a transition. `EXPORTED` and `BLOCKED` end the receipt. */
  async transition(
    state: ExportState,
    detail: {
      fenceEpoch: number | null;
      fenceState: 'open' | 'fenced' | null;
      digests?: ExportDigests;
      recovery: string;
      error?: BundleError;
      now?: Date;
    },
  ): Promise<void> {
    const t: ExportTransition = {
      state,
      at: formatTimestamp(detail.now ?? new Date()),
      fenceEpoch: detail.fenceEpoch,
      fenceState: detail.fenceState,
      digests: { ...(detail.digests ?? {}) },
      recovery: detail.recovery,
      ...(detail.error === undefined
        ? {}
        : {
            error: {
              code: detail.error.code,
              ...(detail.error.reason === undefined ? {} : { reason: detail.error.reason }),
            },
          }),
    };
    this.#receipt.transitions.push(t);
    if (state === 'EXPORTED') this.#receipt.outcome = 'exported';
    if (state === 'BLOCKED') this.#receipt.outcome = 'blocked';
    await this.#stateDir.writeReceipt(exportReceiptName(this.#receipt.operationId), this.#receipt);
    if (this.#db !== null) await this.#record(t);
  }

  /** Record the counts and facts of a finished export in the local receipt. */
  async summarize(summary: ExportSummary): Promise<void> {
    this.#receipt.summary = summary;
    await this.#stateDir.writeReceipt(exportReceiptName(this.#receipt.operationId), this.#receipt);
  }

  async #record(t: ExportTransition): Promise<void> {
    if (this.#db === null) return;
    try {
      await appendExportTransition(this.#db, this.#receipt, t);
    } catch {
      this.#databaseFailed = true;
    }
  }
}

/** Append one transition of `receipt` to the environment's receipts. */
async function appendExportTransition(
  db: Db,
  receipt: Pick<ExportReceipt, 'operationId' | 'actor' | 'inputsDigest'>,
  t: ExportTransition,
): Promise<void> {
  const identity = {
    operationId: receipt.operationId,
    kind: 'export' as const,
    actor: receipt.actor,
    inputsDigest: receipt.inputsDigest,
  };
  const digest =
    t.digests.migrationBundleSha256 ??
    t.digests.innerArchiveSha256 ??
    t.digests.applicationDigest ??
    null;
  const detail = { ...t } as unknown as Record<string, unknown>;
  const terminal = t.state === 'EXPORTED' || t.state === 'BLOCKED';
  await appendOperationReceipt(db, identity, {
    event: terminal ? 'outcome' : 'step-finished',
    step: t.state,
    digest,
    ...(terminal ? { outcome: t.state === 'EXPORTED' ? 'succeeded' : 'failed' } : {}),
    detail,
  });
}

function isExportReceipt(value: unknown): value is ExportReceipt {
  const v = value as Partial<ExportReceipt> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.receiptFormatVersion === 1 &&
    v.operation === 'export' &&
    typeof v.operationId === 'string' &&
    Array.isArray(v.transitions)
  );
}

/**
 * Close the local receipt of an export that was killed before it ended: a BLOCKED transition with
 * `interrupted: true` and `closedBy`, recorded in the environment's receipts too when that export
 * had reached them and `db` is given. Returns the fence epoch the killed export last recorded, or
 * null when there was nothing to close.
 */
export async function closeInterruptedExport(
  stateDir: StateDirectory,
  interruptedOperationId: string,
  closedBy: string,
  db: Db | null,
): Promise<{ fenceEpoch: number | null } | null> {
  const name = exportReceiptName(interruptedOperationId);
  let found: unknown;
  try {
    found = await stateDir.readReceipt(name);
  } catch {
    return null;
  }
  if (!isExportReceipt(found) || found.outcome !== null) return null;
  const last = found.transitions.at(-1);
  const fenceEpoch = [...found.transitions]
    .reverse()
    .find((t) => t.fenceState === 'fenced')?.fenceEpoch;
  const reachedEnvironment = found.transitions.some((t) => t.state === 'QUIESCING');
  const t: ExportTransition = {
    state: 'BLOCKED',
    at: formatTimestamp(new Date()),
    fenceEpoch: last?.fenceEpoch ?? null,
    fenceState: last?.fenceState ?? null,
    digests: { ...(last?.digests ?? {}) },
    recovery: reachedEnvironment
      ? 'the export was killed before it finished; the source may stay fenced: run the export ' +
        `again, or release the fence with ${resumeInstruction(found.deploymentId, fenceEpoch ?? last?.fenceEpoch ?? 0)}`
      : 'the export was killed during its precheck; nothing changed at the source',
    error: { code: 'RAY_INTERRUPTED' },
    interrupted: true,
    closedBy,
  };
  found.transitions.push(t);
  found.outcome = 'blocked';
  await stateDir.writeReceipt(name, found);
  if (db !== null && reachedEnvironment) {
    await appendExportTransition(db, found, t).catch(() => {});
  }
  return { fenceEpoch: fenceEpoch ?? null };
}
