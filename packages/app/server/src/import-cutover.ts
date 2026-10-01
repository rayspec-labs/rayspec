/**
 * THE CUTOVER OF AN IMPORT — the one step that lets an imported target serve, approved by the cutover
 * token the import issued.
 *
 * THE TOKEN. When an import ends ready for its cutover, it holds the target's fence (`import` in the
 * barrier record, `fence-operations.ts`) and issues a token: the SHA-256 of what it binds — the
 * migration bundle's digest, the application's, the target's deployment id, the source's fence epoch
 * the snapshot was taken under, the target's fence epoch and environment revision, the digest of the
 * target's catalogs as the import left them, the time it was issued and a random nonce. The token is
 * shown once; the fence keeps only its SHA-256 and what it binds, never the nonce, so the token cannot
 * be worked out from anything the target or the receipts hold.
 *
 * THE CUTOVER (`consumeCutoverToken`, then `resume` with `cutoverBy`) takes the token and, in one
 * transaction on the target's runtime-control state:
 *  - refuses a target whose fence the import does not hold ready for its cutover, a token that does
 *    not hash to the one issued, one already used (single use: the first cutover that checks it
 *    marks it used, whether or not it then finishes), one past its expiry (15 minutes), and one whose
 *    binding no longer holds — another migration bundle, deployment or source fence epoch than the
 *    import record's, or a target fence or environment revision that moved (`RAY_POLICY_DENIED`);
 *  - refuses a target whose catalogs no longer hash to what the import left
 *    (`RAY_RECONCILIATION_REQUIRED`);
 *  - marks the token used by this cutover.
 * Only then does `resume` release the fence: it grants the runtime role the writes the import
 * recorded and increases the environment revision. A resume without the cutover that consumed the
 * token is refused.
 *
 * RENEWAL (`renewCutoverToken`). A token that expired, or was used by a cutover that did not finish,
 * is replaced by a new one with the same binding, as long as the fence and the catalogs are still
 * what the import left. The old token stops working.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type BundleError, bundleError, digestOf, formatTimestamp } from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import { type CutoverHold, type ImportHold, readBarrierRecord } from './fence-operations.js';
import { catalogDigest, readCatalog } from './import-catalog.js';

/** The cutover token's lifetime. */
export const CUTOVER_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/** A cutover token as the operator passes it: 64 lowercase hex digits. */
const TOKEN = /^[0-9a-f]{64}$/;

/** What a cutover token binds, as the receipts record it: no nonce, no token. */
export interface CutoverToken {
  cutoverTokenFormatVersion: 1;
  migrationBundleSha256: string;
  applicationDigest: string;
  targetDeploymentId: string;
  sourceFenceEpoch: number;
  targetFenceEpoch: number;
  targetEnvironmentRevision: number;
  catalogSha256: string;
  issuedAt: string;
  expiresAt: string;
}

/** The import a cutover belongs to, as the target's state directory records it. */
export interface CutoverImport {
  operationId: string;
  deploymentId: string;
  migrationBundleSha256: string;
  sourceFenceEpoch: number;
}

export interface CutoverDatabases {
  /** The target's application database, as its migration role. */
  control: Db;
  /** The target's workflow system database, as its migration role, when it has one. */
  workflowSystem: Db | null;
  runtimeRole: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What the target's catalogs hash to now. */
async function currentCatalog(dbs: CutoverDatabases): Promise<string> {
  const states = [await readCatalog(dbs.control, dbs.runtimeRole)];
  if (dbs.workflowSystem !== null) {
    states.push(await readCatalog(dbs.workflowSystem, dbs.runtimeRole));
  }
  return catalogDigest(states);
}

interface StateRow {
  fence_state: string;
  fence_epoch: number;
  environment_revision: number;
  deployment_id: string | null;
  fence_barriers: Record<string, unknown> | null;
}

type Tx = { unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown> };

async function lockState(tx: Tx): Promise<StateRow | undefined> {
  const [row] = (await tx.unsafe(
    `SELECT fence_state, fence_epoch::int AS fence_epoch,
            environment_revision::int AS environment_revision, deployment_id, fence_barriers
       FROM runtime_control_state WHERE id = 1 FOR UPDATE`,
  )) as StateRow[];
  return row;
}

class CutoverRefusal extends Error {
  constructor(readonly error: BundleError) {
    super(error.message);
  }
}

const denied = (message: string) => new CutoverRefusal(bundleError('RAY_POLICY_DENIED', message));

/** The import's hold on the fence, ready for its cutover; refused otherwise. */
function readyHold(row: StateRow | undefined, record: CutoverImport): ImportHold {
  const hold = readBarrierRecord(row?.fence_barriers)?.import;
  if (
    row?.fence_state !== 'fenced' ||
    hold === undefined ||
    hold.operationId !== record.operationId ||
    hold.state !== 'ready-for-cutover'
  ) {
    throw denied(
      "the target's fence is not held by this import ready for its cutover: the cutover ran " +
        'already, or the import failed',
    );
  }
  if (row.deployment_id !== record.deploymentId) {
    throw new CutoverRefusal(
      bundleError(
        'RAY_USAGE',
        'the database the environment names belongs to another deployment than the import',
      ),
    );
  }
  return hold;
}

/** Write a new token's binding into the hold; returns the token, shown once. */
async function writeToken(
  tx: Tx,
  row: StateRow,
  hold: ImportHold,
  binding: Omit<CutoverToken, 'cutoverTokenFormatVersion' | 'issuedAt' | 'expiresAt'>,
  now: Date,
): Promise<{ token: string; binding: CutoverToken }> {
  const full: CutoverToken = {
    cutoverTokenFormatVersion: 1,
    ...binding,
    issuedAt: formatTimestamp(now),
    expiresAt: formatTimestamp(new Date(now.getTime() + CUTOVER_TOKEN_LIFETIME_MS)),
  };
  const token = digestOf({ ...full, nonce: randomBytes(32).toString('hex') });
  const cutover: CutoverHold = {
    tokenSha256: sha256(token),
    migrationBundleSha256: full.migrationBundleSha256,
    applicationDigest: full.applicationDigest,
    targetDeploymentId: full.targetDeploymentId,
    sourceFenceEpoch: full.sourceFenceEpoch,
    targetFenceEpoch: full.targetFenceEpoch,
    targetEnvironmentRevision: full.targetEnvironmentRevision,
    catalogSha256: full.catalogSha256,
    issuedAt: full.issuedAt,
    expiresAt: full.expiresAt,
  };
  await tx.unsafe(
    'UPDATE runtime_control_state SET fence_barriers = $1::text::jsonb, updated_at = now() WHERE id = 1',
    [JSON.stringify({ ...row.fence_barriers, import: { ...hold, cutover } })],
  );
  return { token, binding: full };
}

export type CutoverResult<T> = { ok: true; value: T } | { ok: false; errors: BundleError[] };

async function refusing<T>(run: () => Promise<T>): Promise<CutoverResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof CutoverRefusal) return { ok: false, errors: [err.error] };
    throw err;
  }
}

/**
 * Issue the cutover token of an import that just ended ready for its cutover, binding `record`, the
 * application and the target's fence and environment revision as they are now.
 */
export async function issueCutoverToken(
  dbs: CutoverDatabases,
  record: CutoverImport,
  applicationDigest: string,
  now: Date = new Date(),
): Promise<CutoverResult<{ token: string; binding: CutoverToken; tokenSha256: string }>> {
  return refusing(async () => {
    const catalog = await currentCatalog(dbs);
    return dbs.control.$client.begin(async (tx) => {
      const row = await lockState(tx);
      const hold = readyHold(row, record);
      if (hold.catalogSha256 === undefined || hold.catalogSha256 !== catalog) {
        throw new CutoverRefusal(
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            "the target's catalogs are not what the import left; the target is not cut over",
          ),
        );
      }
      const issued = await writeToken(
        tx,
        row!,
        hold,
        {
          migrationBundleSha256: record.migrationBundleSha256,
          applicationDigest,
          targetDeploymentId: record.deploymentId,
          sourceFenceEpoch: record.sourceFenceEpoch,
          targetFenceEpoch: row!.fence_epoch,
          targetEnvironmentRevision: row!.environment_revision,
          catalogSha256: catalog,
        },
        now,
      );
      return { ...issued, tokenSha256: sha256(issued.token) };
    });
  });
}

/**
 * Replace the cutover token of an import ready for its cutover: same binding, new times, new token.
 * Refused when the binding no longer holds or the catalogs changed.
 */
export async function renewCutoverToken(
  dbs: CutoverDatabases,
  record: CutoverImport,
  now: Date = new Date(),
): Promise<CutoverResult<{ token: string; binding: CutoverToken; tokenSha256: string }>> {
  return refusing(async () => {
    const catalog = await currentCatalog(dbs);
    return dbs.control.$client.begin(async (tx) => {
      const row = await lockState(tx);
      const hold = readyHold(row, record);
      const earlier = hold.cutover;
      if (earlier === undefined) {
        throw new CutoverRefusal(
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            'the import never issued a cutover token; the target is not cut over',
          ),
        );
      }
      checkBinding(earlier, row!, record);
      if (earlier.catalogSha256 !== catalog) {
        throw new CutoverRefusal(
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            "the target's catalogs are not what the import left; the target is not cut over",
          ),
        );
      }
      const issued = await writeToken(
        tx,
        row!,
        hold,
        {
          migrationBundleSha256: earlier.migrationBundleSha256,
          applicationDigest: earlier.applicationDigest,
          targetDeploymentId: earlier.targetDeploymentId,
          sourceFenceEpoch: earlier.sourceFenceEpoch,
          targetFenceEpoch: earlier.targetFenceEpoch,
          targetEnvironmentRevision: earlier.targetEnvironmentRevision,
          catalogSha256: earlier.catalogSha256,
        },
        now,
      );
      return { ...issued, tokenSha256: sha256(issued.token) };
    });
  });
}

/** The binding against the import record and the fence as it is. */
function checkBinding(cutover: CutoverHold, row: StateRow, record: CutoverImport): void {
  if (
    cutover.migrationBundleSha256 !== record.migrationBundleSha256 ||
    cutover.targetDeploymentId !== record.deploymentId ||
    cutover.sourceFenceEpoch !== record.sourceFenceEpoch
  ) {
    throw denied(
      'the cutover token binds another migration bundle, target or source fence than this import',
    );
  }
  if (
    cutover.targetFenceEpoch !== row.fence_epoch ||
    cutover.targetEnvironmentRevision !== row.environment_revision
  ) {
    throw denied(
      "the target's fence or environment revision moved since the cutover token was issued; the " +
        'target is not cut over',
    );
  }
}

/**
 * Check a cutover token and mark it used by the cutover `cutoverBy`; returns the fence epoch the
 * cutover then resumes at. The token works once.
 */
export async function consumeCutoverToken(
  dbs: CutoverDatabases,
  record: CutoverImport,
  token: string,
  cutoverBy: string,
  now: Date = new Date(),
): Promise<CutoverResult<{ fenceEpoch: number; binding: CutoverHold }>> {
  return refusing(async () => {
    if (!TOKEN.test(token)) {
      throw new CutoverRefusal(
        bundleError(
          'RAY_USAGE',
          'a cutover token is 64 lowercase hex digits, as the import printed it',
          {
            path: '/cutover-token',
          },
        ),
      );
    }
    const catalog = await currentCatalog(dbs);
    return dbs.control.$client.begin(async (tx) => {
      const row = await lockState(tx);
      const hold = readyHold(row, record);
      const cutover = hold.cutover;
      if (cutover === undefined || sha256(token) !== cutover.tokenSha256) {
        throw denied(
          'the cutover token is not the one this import issued; the target is not cut over',
        );
      }
      if (cutover.usedBy !== undefined) {
        throw denied(
          'the cutover token was used already; a token works once — issue a new one with ' +
            '`rayspec import --target <target state directory> --renew-cutover-token`',
        );
      }
      if (now.getTime() > Date.parse(cutover.expiresAt)) {
        throw denied(
          `the cutover token expired at ${cutover.expiresAt}; issue a new one with ` +
            '`rayspec import --target <target state directory> --renew-cutover-token`',
        );
      }
      checkBinding(cutover, row!, record);
      if (cutover.catalogSha256 !== catalog) {
        throw new CutoverRefusal(
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            "the target's catalogs are not what the import left; the target is not cut over",
          ),
        );
      }
      const used: CutoverHold = { ...cutover, usedBy: cutoverBy };
      await tx.unsafe(
        'UPDATE runtime_control_state SET fence_barriers = $1::text::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify({ ...row!.fence_barriers, import: { ...hold, cutover: used } })],
      );
      return { fenceEpoch: row!.fence_epoch, binding: used };
    });
  });
}
