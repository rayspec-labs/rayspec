/**
 * DEPLOYING A BUNDLE ON A SELF-HOSTED TARGET — the apply `rayspec deploy <file.ray>` runs, and the
 * binding revisions its plan is bound to.
 *
 * THE PLAN. `prepare` (runtime-control.ts) plans the bundle against the live environment: the schema
 * head, the product delta regenerated from the product migration ledger, the binding revisions and the
 * grants, bound in one plan digest that lives 30 minutes. `applyBundle` receives that digest with the
 * time it was prepared at, recomputes it from the live state before it writes anything and again
 * under the operation lease, and refuses a plan that no longer describes the environment
 * (`RAY_PLAN_STALE`). The idempotency key of the apply is the plan digest itself, so running the same
 * deploy again after an interruption continues the interrupted operation instead of starting another.
 *
 * THE STEPS, each with a receipt before and after it (`apply-operation.ts`):
 *   stage-bundle        verify the version directory the bundle was staged into (re-runnable)
 *   platform-migrations the runtime's platform migration chain, when the environment is behind it
 *   product-ddl         the regenerated product delta, its ledger row and the finish receipt in one
 *                       transaction under the shared schema lock (`productDdlStep`)
 *   record-application  the deployment id, the application and its grants in the state row
 *   activate            switch `active.json` to the new version in one rename (re-runnable)
 * The active version switches last, so a deploy that fails on the way leaves the previous version
 * active. A schema change that committed is never reversed automatically: the failure names what
 * changed and the forward step that finishes the deploy.
 *
 * A DATABASE WITHOUT RUNTIME-CONTROL TABLES. The receipts live in platform tables, so on a database
 * that does not have them yet — an empty one, or one a runtime before them created — the platform
 * chain that creates them runs first, outside apply, under the shared schema lock, and only after
 * the plan was accepted. The plan was prepared against the head before that chain; the recomputation
 * accepts exactly the head that chain leaves behind in its place.
 *
 * BINDING REVISIONS. A self-hosted runtime computes a binding's revision id as HMAC-SHA256 under the
 * environment's binding revision key over the name, a NUL byte and the value. An environment gets its
 * key with its runtime-control state row. For one that has no state row yet, the revision ids of the
 * first plan are computed under a key derived from the API-key pepper, and the first apply stores that
 * key as the environment's key, so the plan a dry-run printed is the plan the apply recomputes. The
 * pepper is a boot secret the deployment needs anyway; the derived key reveals nothing about it.
 */
import { createHmac } from 'node:crypto';
import {
  type ApplyData,
  BINDING_REVISION_KEY_BYTES,
  type BindingRevision,
  type BundleError,
  bindingRevisionId,
  bundleError,
  CONTRACT_VERSION,
  compareCodePoints,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  formatTimestamp,
  isPlanExpired,
  type PrepareData,
  type ResultEnvelope,
  type SchemaHead,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import {
  type ApplyCheckpoint,
  type ApplyStep,
  ApplyStepRefusal,
  DEFAULT_APPLY_LEASE_TTL_MS,
  runApply,
  type StateObservers,
} from './apply-operation.js';
import type { BlobBackendRecord } from './blob-backend-record.js';
import { productDdlStep, schemaObservers } from './deploy-apply.js';
import type { StateDirectory } from './deployment-state.js';
import { StateDirectoryError, verifyVersion } from './deployment-state.js';
import { ensureRuntimeControlState, findIntentByIdempotencyKey } from './operation-lease.js';
import { BUNDLED_DELTA_NAME } from './product-schema-plan.js';
import {
  type PreparedPlan,
  preparePlan,
  type ReadApplicationBundle,
  type RuntimeControlOptions,
} from './runtime-control.js';
import {
  type CatalogQuery,
  readPlatformHead,
  readSchemaHead,
  runtimePlatformHead,
} from './schema-head.js';

/** The actor a bundle deploy from the CLI records on its receipts. */
export const BUNDLE_DEPLOY_ACTOR = 'rayspec-deploy';

const INITIAL_KEY_LABEL = 'rayspec binding revision key v1';

/**
 * The binding revision key an environment without a state row gets with its first apply: HMAC-SHA256
 * under the API-key pepper over a fixed label.
 */
export function initialBindingRevisionKey(apiKeyPepper: string): Buffer {
  if (apiKeyPepper.length === 0) throw new RangeError('the API-key pepper is empty');
  const key = createHmac('sha256', apiKeyPepper).update(INITIAL_KEY_LABEL, 'utf8').digest();
  if (key.length !== BINDING_REVISION_KEY_BYTES) throw new Error('unexpected key length');
  return key;
}

function queryOf(db: Db): CatalogQuery {
  return async (sql, params = []) =>
    (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
}

/** Whether the environment has its runtime-control tables. */
async function controlTablesPresent(query: CatalogQuery): Promise<boolean> {
  const rows = await query(
    `SELECT to_regclass('public.runtime_control_state') IS NOT NULL
        AND to_regclass('public.runtime_control_receipts') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

/** What the environment already holds that a bundle deploy reads before it plans. */
export interface EnvironmentIdentity {
  /** The environment's binding revision key; null before it has a state row. */
  bindingRevisionKey: Buffer | null;
  /** The deployment id the environment records; null before a deploy recorded one. */
  deploymentId: string | null;
}

/** Read the binding revision key and the deployment id, without writing anything. */
export async function readEnvironmentIdentity(db: Db): Promise<EnvironmentIdentity> {
  const query = queryOf(db);
  if (!(await controlTablesPresent(query))) {
    return { bindingRevisionKey: null, deploymentId: null };
  }
  const rows = await query(
    'SELECT binding_revision_key, deployment_id FROM runtime_control_state WHERE id = 1',
  );
  const row = rows[0];
  if (row === undefined) return { bindingRevisionKey: null, deploymentId: null };
  return {
    bindingRevisionKey: Buffer.from(String(row.binding_revision_key), 'hex'),
    deploymentId: (row.deployment_id as string | null) ?? null,
  };
}

/** Revision ids for binding values, sorted by name; never the values themselves. */
export function bindingRevisions(
  values: ReadonlyMap<string, string>,
  key: Uint8Array,
): BindingRevision[] {
  return [...values.entries()]
    .map(([name, value]) => ({ name, revisionId: bindingRevisionId(key, name, value) }))
    .sort((a, b) => compareCodePoints(a.name, b.name));
}

/** The environment's live schema head, or null before the first platform migration. */
export async function liveSchemaHead(db: Db): Promise<SchemaHead | null> {
  const head = await readSchemaHead(queryOf(db));
  return head.state === 'known' ? head.head : null;
}

/** Whether a plan changes the schema or the grants, and so needs a reviewed plan digest. */
export function planNeedsReview(data: PrepareData): boolean {
  const { schemaImpact, permissionChanges: p } = data.plan;
  const schema =
    schemaImpact.from === null ||
    schemaImpact.from.platform !== schemaImpact.to.platform ||
    schemaImpact.from.product !== schemaImpact.to.product;
  const permissions =
    p.executionFrom !== p.executionTo ||
    p.egressAdded.length > 0 ||
    p.egressRemoved.length > 0 ||
    p.capabilitiesAdded.length > 0 ||
    p.capabilitiesRemoved.length > 0;
  return schema || permissions;
}

export interface ApplyBundleOptions {
  db: Db;
  /** The runtime-control options `prepare` runs with (shadow server, trusted keys, limits). */
  runtime: Omit<RuntimeControlOptions, 'db'>;
  /** Absolute path of the bundle, the bytes the plan was prepared from. */
  bundlePath: string;
  bundleSha256: string;
  /** The plan digest the operator accepted, and the time it was prepared at. */
  planDigest: string;
  preparedAt: string;
  /** Every binding value the plan covers, by name. Values never leave this process. */
  bindingValues: ReadonlyMap<string, string>;
  /** The key for an environment that has none yet (`initialBindingRevisionKey`). */
  initialBindingRevisionKey: Uint8Array;
  requireSignature?: boolean;
  stateDir: StateDirectory;
  deploymentId: string;
  /** Run the platform migration chain under the shared schema lock. */
  migratePlatform: () => Promise<void>;
  operationId: string;
  actor?: string;
  lockTimeoutMs?: number;
  leaseTtlMs?: number;
  /** Crash tests only: see `ApplyOptions.onCheckpoint`. */
  onCheckpoint?: (point: ApplyCheckpoint, step?: string) => Promise<void>;
  now?: () => Date;
  /**
   * With role separation (`db` is then the migration role's connection): the runtime role. The
   * bundled product delta brings the tables it creates under row-level isolation in its own
   * transaction.
   */
  tenantIsolation?: { runtimeRole: string };
  /**
   * The blob backend the boot resolved for this application (blob-backend-record.ts), recorded with
   * the application it belongs to. Absent: recorded as unknown (NULL).
   */
  blobBackend?: BlobBackendRecord;
}

export interface AppliedBundle {
  envelope: ResultEnvelope<ApplyData>;
  /** The version directory the deploy activated, when it succeeded. */
  versionRoot?: string;
  /**
   * When the plan carried a product change and the deploy succeeded: the product migration ledger
   * row that recorded it.
   */
  productLedgerRow?: number;
}

function refused(operationId: string, errors: BundleError[]): AppliedBundle {
  const [first, ...rest] = errors;
  return {
    envelope: {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      operation: 'runtime.apply',
      operationId,
      data: null,
      errors: [first ?? bundleError('RAY_INTERNAL', 'the apply failed'), ...rest],
      warnings: [],
    },
  };
}

function stalePlan(message: string): BundleError {
  return bundleError('RAY_PLAN_STALE', message, { path: '/planDigest' });
}

/**
 * Apply an accepted plan. Nothing is written until the plan digest recomputed from the live state
 * equals `planDigest` (or the digest names an operation already recorded under that key, which apply
 * itself then answers). The version directory must already be staged; its step verifies it.
 */
export async function applyBundle(options: ApplyBundleOptions): Promise<AppliedBundle> {
  const { db, operationId } = options;
  const query = queryOf(db);
  const now = options.now ?? (() => new Date());
  if (isPlanExpired(options.preparedAt, now())) {
    return refused(operationId, [stalePlan('the plan has expired; prepare a new plan')]);
  }

  const identity = await readEnvironmentIdentity(db);
  if (identity.deploymentId !== null && identity.deploymentId !== options.deploymentId) {
    return refused(operationId, [
      bundleError(
        'RAY_USAGE',
        'the database belongs to another deployment than the state directory; use the state ' +
          'directory of that deployment',
      ),
    ]);
  }
  const key = identity.bindingRevisionKey ?? Buffer.from(options.initialBindingRevisionKey);
  const revisions = bindingRevisions(options.bindingValues, key);
  const before = await readSchemaHead(query);
  const beforeHead = before.state === 'known' ? before.head : null;

  let bootstrappedFrom: { head: SchemaHead | null } | undefined;
  const recompute = async (): Promise<PreparedPlan> => {
    const head = await readSchemaHead(query);
    const live = head.state === 'known' ? head.head : null;
    // The head the plan was prepared at stands for the head the bootstrap chain left behind.
    const expected =
      bootstrappedFrom !== undefined &&
      live !== null &&
      live.platform === runtimePlatformHead() &&
      live.product === (bootstrappedFrom.head?.product ?? EMPTY_PRODUCT_SCHEMA_DIGEST)
        ? bootstrappedFrom.head
        : live;
    return preparePlan(
      {
        contractVersion: CONTRACT_VERSION,
        operationId,
        actor: options.actor ?? BUNDLE_DEPLOY_ACTOR,
        bundleSha256: options.bundleSha256,
        bundlePath: options.bundlePath,
        bindingRevision: revisions,
        expectedSchemaHead: expected,
      },
      { ...options.runtime, db },
      {
        preparedAt: options.preparedAt,
        ...(options.requireSignature === true ? { requireSignature: true } : {}),
        ...(bootstrappedFrom !== undefined ? { bootstrappedFrom } : {}),
      },
    );
  };

  // The plan, recomputed before anything is written.
  const first = await recompute();
  if (!first.envelope.ok) return refused(operationId, first.envelope.errors);
  const tablesPresent = await controlTablesPresent(query);
  if (first.envelope.data?.planDigest !== options.planDigest) {
    // Apply answers a key it already recorded (an applied or an interrupted operation) itself; any
    // other difference is a stale plan, refused before anything is written.
    const recorded =
      tablesPresent && (await findIntentByIdempotencyKey(db, options.planDigest)) !== undefined;
    if (!recorded) {
      return refused(operationId, [
        stalePlan(
          'the plan no longer matches the environment, the bundle or the bindings; run ' +
            '`rayspec deploy <file.ray> --dry-run` again and deploy with the new plan digest',
        ),
      ]);
    }
  }

  // A database without the runtime-control tables gets them first, outside apply.
  if (!tablesPresent) {
    await options.migratePlatform();
    bootstrappedFrom = { head: beforeHead };
  }
  await db.$client.begin(async (tx) => {
    await ensureRuntimeControlState(tx, key);
  });

  const prepared = first;
  const bundle = prepared.bundle as ReadApplicationBundle;
  const product = prepared.product;
  const plan = prepared.envelope.data as PrepareData;
  const versionRoot = options.stateDir.versionPath(options.bundleSha256);
  const target = runtimePlatformHead();
  const readActiveSha = async (): Promise<string> =>
    (await options.stateDir.readActive())?.bundleSha256 ?? 'none';

  const observers: StateObservers = {
    ...schemaObservers(query),
    'active-version': readActiveSha,
  };
  const steps: ApplyStep[] = [
    {
      kind: 'effect',
      name: 'stage-bundle',
      rerunnable: true,
      run: async () => {
        try {
          await verifyVersion(versionRoot, bundle.manifest);
        } catch (err) {
          if (err instanceof StateDirectoryError) throw new ApplyStepRefusal(err.error);
          throw new ApplyStepRefusal(
            bundleError(
              'RAY_INFRA_UNAVAILABLE',
              'the staged version directory could not be read; deploy again',
            ),
          );
        }
        return { digest: options.bundleSha256 };
      },
    },
    {
      kind: 'effect',
      name: 'platform-migrations',
      observer: 'platform-head',
      expectedAfter: target,
      pending: async () => {
        const head = await readPlatformHead(query);
        return head.state !== 'known' || head.tag !== target;
      },
      run: async () => {
        await options.migratePlatform();
        return {};
      },
    },
  ];
  if (product !== undefined && product.delta !== null) {
    steps.push(
      productDdlStep({
        name: BUNDLED_DELTA_NAME,
        sql: product.delta,
        declared: product.declared,
        expectedAfter: plan.plan.schemaImpact.to.product,
        ...(options.tenantIsolation !== undefined ? { isolateFor: options.tenantIsolation } : {}),
      }),
    );
  }
  const manifest = bundle.manifest;
  const grants = {
    execution: manifest.permissions.execution,
    egressHosts: [...manifest.permissions.egressHosts].sort(compareCodePoints),
    capabilities: [...manifest.requires].sort(compareCodePoints),
  };
  steps.push(
    {
      kind: 'transaction',
      name: 'record-application',
      schemaChange: false,
      run: async (tx) => {
        const rows = (await tx.unsafe(
          'SELECT deployment_id FROM runtime_control_state WHERE id = 1 FOR UPDATE',
        )) as unknown as { deployment_id: string | null }[];
        const recorded = rows[0]?.deployment_id ?? null;
        if (recorded !== null && recorded !== options.deploymentId) {
          throw new ApplyStepRefusal(
            bundleError(
              'RAY_USAGE',
              'the database belongs to another deployment than the state directory',
            ),
          );
        }
        await tx.unsafe(
          `UPDATE runtime_control_state
              SET deployment_id = $1, application_id = $2, application_version = $3,
                  application_digest = $4, active_grants = $5::jsonb,
                  blob_backend = $6::jsonb, updated_at = now()
            WHERE id = 1`,
          [
            options.deploymentId,
            manifest.application.id,
            manifest.application.version,
            options.bundleSha256,
            JSON.stringify(grants),
            options.blobBackend === undefined ? null : JSON.stringify(options.blobBackend),
          ],
        );
        return { digest: options.bundleSha256 };
      },
    },
    {
      kind: 'effect',
      name: 'activate',
      observer: 'active-version',
      expectedAfter: options.bundleSha256,
      rerunnable: true,
      run: async () => {
        await options.stateDir.writeActive({
          bundleSha256: options.bundleSha256,
          activatedAt: formatTimestamp(now()),
          environmentRevision: plan.environmentRevision + 1,
        });
        return { digest: options.bundleSha256 };
      },
    },
  );

  const lockTimeoutMs = options.lockTimeoutMs;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_APPLY_LEASE_TTL_MS;
  const result = await runApply({
    db,
    request: {
      contractVersion: CONTRACT_VERSION,
      operationId,
      actor: options.actor ?? BUNDLE_DEPLOY_ACTOR,
      planDigest: options.planDigest,
      expectedEnvironmentRevision: plan.environmentRevision,
      idempotencyKey: options.planDigest,
    },
    plan: {
      recompute: async () => {
        const again = await recompute();
        if (!again.envelope.ok || again.envelope.data === null) {
          // Reported by apply as an unavailable dependency, never as a plan that still holds.
          throw new Error('the plan could not be recomputed');
        }
        return again.envelope.data.planDigest;
      },
      expired: () => isPlanExpired(options.preparedAt, now()),
      blockers: plan.plan.blockers,
    },
    steps,
    observers,
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    leaseTtlMs,
    leaseWaitMs: (lockTimeoutMs ?? 60_000) + leaseTtlMs,
    ...(options.onCheckpoint !== undefined ? { onCheckpoint: options.onCheckpoint } : {}),
  });
  if (!result.ok) {
    const changed = await schemaChangedBy(db, options.planDigest);
    if (!changed) return { envelope: result };
    const [firstError, ...rest] = result.errors;
    return {
      envelope: {
        ...result,
        errors: [
          {
            ...firstError,
            message: `${firstError.message}. ${SCHEMA_CHANGED_RECOVERY}`.slice(0, 2048),
          },
          ...rest,
        ],
      },
    };
  }
  if (product !== undefined && product.delta !== null) {
    const rows = (await query(
      'SELECT max(id)::int AS id FROM product_migration_ledger WHERE product_schema_after = $1',
      [plan.plan.schemaImpact.to.product],
    )) as unknown as { id: number | null }[];
    const ledgerRow = rows[0]?.id ?? null;
    if (ledgerRow !== null) return { envelope: result, versionRoot, productLedgerRow: ledgerRow };
  }
  return { envelope: result, versionRoot };
}

/** What an operator does when a deploy stopped after it changed the schema. */
export const SCHEMA_CHANGED_RECOVERY =
  'The deploy stopped after its schema change committed. The change is not reversed ' +
  'automatically and the previous version stays active, so nothing serves until the deploy is ' +
  'finished: fix the cause, run `rayspec deploy <file.ray> --dry-run` again with the same bundle ' +
  'and deploy it with the new plan digest, which skips the schema change already made';

/** Whether an apply under this idempotency key finished a schema-changing step. */
async function schemaChangedBy(db: Db, idempotencyKey: string): Promise<boolean> {
  try {
    const rows = (await db.$client.unsafe(
      `SELECT 1 FROM runtime_control_receipts r
        WHERE r.event = 'step-finished' AND r.step IN ('product-ddl', 'platform-migrations')
          AND r.operation_id = (SELECT operation_id FROM runtime_control_receipts
                                 WHERE idempotency_key = $1 AND event = 'intent' LIMIT 1)
        LIMIT 1`,
      [idempotencyKey],
    )) as unknown as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}
