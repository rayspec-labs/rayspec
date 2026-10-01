/**
 * THE RECEIPTS OF AN IMPORT — every transition of the migration state machine an import goes
 * through on the target, recorded where the operator and the target environment read it back:
 *
 *   IMPORTING → VERIFYING → READY_FOR_CUTOVER, and BLOCKED from either of the first two.
 *
 * Each transition carries the operation id, the actor, the source's fence epoch (the one the
 * snapshot was taken under) and the target's, the time, the digests known by then and the recovery
 * action that applies from there on: until the cutover the source stays authoritative, so a blocked
 * import is recovered by retrying the target (after discarding it) or by resuming the source.
 *
 * TWO RECORDS, as for an export:
 *  - the LOCAL RECEIPT, `receipts/import-<operationId>.json` in the target's state directory (mode
 *    0600, replaced atomically on each transition). It holds no secret, path, record or table name:
 *    digests, counts, codes and states only, and a refusal by its code and reason;
 *  - the TARGET'S RECEIPTS, rows of `runtime_control_receipts` under the import's operation id (kind
 *    `import`), from the moment the application database is restored and the table exists; the
 *    transitions recorded before are written there first.
 *
 * THE IMPORT RECORD, `import.json` in the target's state directory, says what state the target is in
 * (`IMPORTING`, `READY_FOR_CUTOVER`, `BLOCKED`) and which import left it so: a later import refuses a
 * target it marks, and `rayspec import --discard-failed` removes a blocked one.
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

/** The states of the migration state machine an import moves through. */
export type ImportState = 'IMPORTING' | 'VERIFYING' | 'READY_FOR_CUTOVER' | 'BLOCKED';

/** The actor an import records: the CLI on the operator's host. Never a credential. */
export const IMPORT_ACTOR = 'rayspec-import';

/** Digests an import knows at a transition; each is lowercase hex SHA-256. */
export interface ImportDigests {
  migrationBundleSha256?: string;
  ciphertextSha256?: string;
  innerArchiveSha256?: string;
  applicationDigest?: string;
}

export interface ImportTransition {
  state: ImportState;
  at: string;
  /** The fence epoch the snapshot was taken under at the source. */
  sourceFenceEpoch: number;
  /** The target's fence epoch, once the import fenced it; null before. */
  targetFenceEpoch: number | null;
  digests: ImportDigests;
  recovery: string;
  error?: { code: string; reason?: string };
  /** Set when a later run closed this import, which had been killed. */
  interrupted?: true;
  closedBy?: string;
}

/** What binds the cutover: the migration, the target and both fences. */
export interface CutoverToken {
  cutoverTokenFormatVersion: 1;
  migrationBundleSha256: string;
  applicationDigest: string;
  targetDeploymentId: string;
  sourceFenceEpoch: number;
  targetFenceEpoch: number;
  targetEnvironmentRevision: number;
  issuedAt: string;
  expiresAt: string;
}

/** The cutover token's lifetime. */
export const CUTOVER_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/** Counts and facts of a finished import; no table, store or record is named. */
export interface ImportSummary {
  applicationId: string;
  applicationVersion: string;
  sourceRuntime: string;
  workflowSystemDatabase: 'included' | 'absent';
  tables: { application: number; workflowSystem: number };
  rows: { application: number; workflowSystem: number };
  objectCount: number;
  foreignKeys: number;
  credentialReset: {
    sessions: 'reset';
    apiKeys: 'reset';
    invites: 'reset';
    oidcArtifacts: 'reset';
    passwordHashes: 'preserved' | 'reset';
    forcedLogin: boolean;
  };
  /** The target's own signing key, pepper and media key, minted by the import; never their values. */
  bootSecrets: 'reissued';
  /** How many accounts sign in again, need owner recovery, or have no way in. */
  identity: { signInAgain: number; ownerRecovery: number; noCredential: number };
}

/** The local operation receipt of one import. */
export interface ImportReceipt {
  receiptFormatVersion: 1;
  contractVersion: typeof CONTRACT_VERSION;
  operation: 'import';
  operationId: string;
  actor: string;
  /** The target's deployment id, minted by the import; null for an import that never got there. */
  deploymentId: string | null;
  /** SHA-256 of the canonical request (bundle digest, target), never the request itself. */
  inputsDigest: string;
  outcome: 'ready-for-cutover' | 'blocked' | null;
  transitions: ImportTransition[];
  summary: ImportSummary | null;
  cutover: { token: CutoverToken; tokenSha256: string } | null;
}

/** The import record a target's state directory keeps. */
export interface ImportRecord {
  importFormatVersion: 1;
  operationId: string;
  deploymentId: string;
  migrationBundleSha256: string;
  sourceFenceEpoch: number;
  state: 'IMPORTING' | 'READY_FOR_CUTOVER' | 'BLOCKED';
  updatedAt: string;
}

/** The local receipt's name for an import's operation id. */
export function importReceiptName(operationId: string): string {
  return `import-${operationId}`;
}

/** The instruction that discards a blocked import's target. */
export function discardInstruction(stateDir: string): string {
  return `rayspec import --target ${stateDir} --discard-failed`;
}

/**
 * The receipts of one import. Every write to the local file is awaited; a write to the target's
 * receipts that fails is noted (`databaseReceiptsFailed`) and does not stop the import.
 */
export class ImportReceiptLog {
  readonly #stateDir: StateDirectory;
  readonly #receipt: ImportReceipt;
  #db: Db | null = null;
  #databaseFailed = false;

  private constructor(stateDir: StateDirectory, receipt: ImportReceipt) {
    this.#stateDir = stateDir;
    this.#receipt = receipt;
  }

  /** Start the receipt of a new import; nothing is written until its first transition. */
  static start(
    stateDir: StateDirectory,
    operationId: string,
    inputs: { migrationBundleSha256: string; target: string },
  ): ImportReceiptLog {
    return new ImportReceiptLog(stateDir, {
      receiptFormatVersion: 1,
      contractVersion: CONTRACT_VERSION,
      operation: 'import',
      operationId,
      actor: IMPORT_ACTOR,
      deploymentId: null,
      inputsDigest: digestOf(inputs),
      outcome: null,
      transitions: [],
      summary: null,
      cutover: null,
    });
  }

  get receipt(): ImportReceipt {
    return this.#receipt;
  }

  get databaseReceiptsFailed(): boolean {
    return this.#databaseFailed;
  }

  /** The target's deployment id, once the import minted it. */
  setDeploymentId(deploymentId: string): void {
    this.#receipt.deploymentId = deploymentId;
  }

  /** From now on every transition is also recorded in the target's receipts, earlier ones first. */
  async attach(db: Db): Promise<void> {
    this.#db = db;
    for (const t of this.#receipt.transitions) await this.#record(t);
  }

  async transition(
    state: ImportState,
    detail: {
      sourceFenceEpoch: number;
      targetFenceEpoch: number | null;
      digests?: ImportDigests;
      recovery: string;
      error?: BundleError;
      now?: Date;
    },
  ): Promise<void> {
    const t: ImportTransition = {
      state,
      at: formatTimestamp(detail.now ?? new Date()),
      sourceFenceEpoch: detail.sourceFenceEpoch,
      targetFenceEpoch: detail.targetFenceEpoch,
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
    if (state === 'READY_FOR_CUTOVER') this.#receipt.outcome = 'ready-for-cutover';
    if (state === 'BLOCKED') this.#receipt.outcome = 'blocked';
    await this.#write();
    if (this.#db !== null) await this.#record(t);
  }

  async summarize(summary: ImportSummary): Promise<void> {
    this.#receipt.summary = summary;
    await this.#write();
  }

  async cutover(token: CutoverToken): Promise<string> {
    const tokenSha256 = digestOf(token);
    this.#receipt.cutover = { token, tokenSha256 };
    await this.#write();
    return tokenSha256;
  }

  async #write(): Promise<void> {
    await this.#stateDir.writeReceipt(importReceiptName(this.#receipt.operationId), this.#receipt);
  }

  async #record(t: ImportTransition): Promise<void> {
    if (this.#db === null) return;
    try {
      await appendImportTransition(this.#db, this.#receipt, t);
    } catch {
      this.#databaseFailed = true;
    }
  }
}

/** Append one transition of `receipt` to the target's receipts. */
async function appendImportTransition(
  db: Db,
  receipt: Pick<ImportReceipt, 'operationId' | 'actor' | 'inputsDigest' | 'cutover'>,
  t: ImportTransition,
): Promise<void> {
  const terminal = t.state === 'READY_FOR_CUTOVER' || t.state === 'BLOCKED';
  await appendOperationReceipt(
    db,
    {
      operationId: receipt.operationId,
      kind: 'import',
      actor: receipt.actor,
      inputsDigest: receipt.inputsDigest,
    },
    {
      event: terminal ? 'outcome' : 'step-finished',
      step: t.state,
      digest:
        t.state === 'READY_FOR_CUTOVER' && receipt.cutover !== null
          ? receipt.cutover.tokenSha256
          : (t.digests.migrationBundleSha256 ?? null),
      ...(terminal ? { outcome: t.state === 'READY_FOR_CUTOVER' ? 'succeeded' : 'failed' } : {}),
      detail: {
        ...t,
        ...(t.state === 'READY_FOR_CUTOVER' && receipt.cutover !== null
          ? { cutover: receipt.cutover.token }
          : {}),
      } as unknown as Record<string, unknown>,
    },
  );
}

function isImportReceipt(value: unknown): value is ImportReceipt {
  const v = value as Partial<ImportReceipt> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.receiptFormatVersion === 1 &&
    v.operation === 'import' &&
    typeof v.operationId === 'string' &&
    Array.isArray(v.transitions)
  );
}

/**
 * Close the local receipt of an import that was killed before it ended: a BLOCKED transition with
 * `interrupted: true` and `closedBy`, and, when `db` is given and the killed import had reached the
 * target's receipts, the same row there. Returns whether there was an open receipt to close.
 */
export async function closeInterruptedImport(
  stateDir: StateDirectory,
  interruptedOperationId: string,
  closedBy: string,
  db: Db | null,
  recovery: string,
): Promise<boolean> {
  const name = importReceiptName(interruptedOperationId);
  let found: unknown;
  try {
    found = await stateDir.readReceipt(name);
  } catch {
    return false;
  }
  if (!isImportReceipt(found) || found.outcome !== null) return false;
  const last = found.transitions.at(-1);
  const t: ImportTransition = {
    state: 'BLOCKED',
    at: formatTimestamp(new Date()),
    sourceFenceEpoch: last?.sourceFenceEpoch ?? 0,
    targetFenceEpoch: last?.targetFenceEpoch ?? null,
    digests: { ...(last?.digests ?? {}) },
    recovery,
    error: { code: 'RAY_INTERRUPTED' },
    interrupted: true,
    closedBy,
  };
  found.transitions.push(t);
  found.outcome = 'blocked';
  await stateDir.writeReceipt(name, found);
  if (db !== null) await appendImportTransition(db, found, t).catch(() => {});
  return true;
}
