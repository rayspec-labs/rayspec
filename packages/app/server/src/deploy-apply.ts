/**
 * THE LEGACY YAML DEPLOY THROUGH APPLY — every schema change a boot makes (`rayspec deploy <spec.yaml>`
 * and `rayspec-serve`) runs as a `runtime.apply` operation (`apply-operation.ts`): under the operation
 * lease, after the checks apply makes, with a receipt before and after, and after reconciling whatever
 * an earlier interrupted apply left behind.
 *
 * TWO KINDS OF CHANGE, each its own apply:
 *  - the platform migration chain, when the ledger is behind this runtime. The step runs the drizzle
 *    migrator (all pending migrations in one transaction, on its own connection, under the shared
 *    schema lock). Its receipts name the platform head it started from and the one it must reach, so
 *    after a crash the live ledger says which of the two it is.
 *  - each product-store migration the deployer applies. The DDL, its row in the product migration
 *    ledger (`product-ledger.ts`), the product schema digest the environment now has
 *    (`applied_product_schema`) and the step's finish receipt commit in ONE transaction, under the
 *    shared schema lock: a crash anywhere inside it leaves nothing but a start receipt, which proves
 *    the DDL was rolled back. The step first checks, under the same lock, that the live product
 *    schema is the one the ledger recorded last, and refuses drift (`RAY_SCHEMA_DRIFT`) and a ledger
 *    written by a newer runtime before running any DDL.
 *
 * THE PLAN. The legacy deploy prepares and applies in one process, so its plan digest covers what the
 * change starts from — the spec document, the platform head, the product schema digest and the
 * environment revision — and the apply recomputes it under the lease. When another boot changed any
 * of them in between (two replicas starting at once), the platform chain is planned again (usually
 * there is nothing left to do); a product migration is refused as a stale plan, as its DDL would have
 * failed on the objects the other boot created.
 *
 * WHAT A SUCCESSFUL DEPLOY PRINTS IS UNCHANGED. Nothing here writes to stdout. A reconciled operation
 * is reported on the boot's warning sink; a refusal is a `RuntimeApplyError`, which the entrypoints
 * print like every other boot refusal.
 *
 * ONE ORDERING LIMIT. The receipts live in platform tables, so the chain that creates them on a
 * database that predates them runs outside apply — under the schema lock and atomically, as before.
 * A restart that finds nothing to change takes no lease and writes nothing, except to settle an
 * interrupted operation it can settle; on an environment blocked on a step whose outcome cannot be
 * established it writes nothing at all.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  CONTRACT_VERSION,
  DEFAULT_SCHEMA_LOCK_TIMEOUT_MS,
  digestOf,
  type ExitCode,
  exitCodeFor,
  productSchemaDigest,
  type ResultEnvelope,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import {
  type ApplyCheckpoint,
  type ApplyStep,
  ApplyStepRefusal,
  DEFAULT_APPLY_LEASE_TTL_MS,
  hasUnsettledApplies,
  previewReconciliation,
  type ReconciledOperation,
  runApply,
  type StateObservers,
} from './apply-operation.js';
import { BootConfigError } from './boot-config-error.js';
import type { LeaseTx } from './operation-lease.js';
import {
  type DeclaredProductStores,
  ledgerDrift,
  readProductLedger,
  recordProductMigration,
  runnableDdl,
} from './product-ledger.js';
import {
  type CatalogQuery,
  readPlatformHead,
  readProductTables,
  runtimePlatformHead,
} from './schema-head.js';

/** The version of the legacy deploy's plan digest input. */
export const LEGACY_DEPLOY_PLAN_FORMAT_VERSION = 1;

/** The actor a boot records on its receipts. */
export const BOOT_ACTOR = 'runtime-boot';

/**
 * A boot refused by apply: a stale plan, a fenced environment, another operation holding the lease,
 * or an earlier interrupted apply that needs manual reconciliation. `code` is the contract's error
 * code and `exitCode` its exit class, which `rayspec deploy` exits with.
 */
export class RuntimeApplyError extends BootConfigError {
  readonly code: BundleErrorCode | string;
  readonly exitCode: ExitCode;
  readonly errors: readonly BundleError[];
  constructor(errors: readonly BundleError[]) {
    const first = errors[0];
    super(
      `Boot aborted — the schema change was refused (${first?.code ?? 'RAY_INTERNAL'}): ` +
        `${first?.message ?? 'the apply failed'}`,
    );
    this.name = 'RuntimeApplyError';
    this.code = first?.code ?? 'RAY_INTERNAL';
    this.exitCode = exitCodeFor(errors);
    this.errors = errors;
  }
}

/**
 * The exit code `rayspec deploy` gives a boot refusal: the contract class of a `RuntimeApplyError`
 * (an outcome the verb did not have before), 1 for every other refusal, as always.
 */
export function bootRefusalExitCode(err: unknown): number {
  return err instanceof RuntimeApplyError ? err.exitCode : 1;
}

export interface DeployApplyOptions {
  db: Db;
  /** Run the platform migration chain (the composition root's `applyMigrations`). */
  migratePlatform: () => Promise<void>;
  /** The deployed spec document, or undefined for an auth-only boot. */
  specSource?: string;
  /** The bounded wait for the shared schema lock. */
  lockTimeoutMs?: number;
  /** Where a reconciled operation is reported. */
  warn?: (line: string) => void;
  actor?: string;
  /** The lease lifetime between renewals. */
  leaseTtlMs?: number;
  /** Crash tests only: see `ApplyOptions.onCheckpoint`. */
  onCheckpoint?: (point: ApplyCheckpoint, step?: string) => Promise<void>;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function controlTablesPresent(db: Db): Promise<boolean> {
  const rows = (await db.$client.unsafe(
    `SELECT to_regclass('public.runtime_control_state') IS NOT NULL
        AND to_regclass('public.runtime_control_receipts') IS NOT NULL AS present`,
  )) as unknown as { present: boolean }[];
  return rows[0]?.present === true;
}

function txQuery(tx: LeaseTx): CatalogQuery {
  return async (sql, params = []) =>
    (await tx.unsafe(sql, params)) as unknown as Record<string, unknown>[];
}

/** The applies one boot makes. */
export class DeployApply {
  readonly #db: Db;
  readonly #options: DeployApplyOptions;
  readonly #query: CatalogQuery;

  constructor(options: DeployApplyOptions) {
    this.#db = options.db;
    this.#options = options;
    this.#query = async (sql, params = []) =>
      (await options.db.$client.unsafe(sql, params as never[])) as unknown as Record<
        string,
        unknown
      >[];
  }

  get #lockTimeoutMs(): number {
    return this.#options.lockTimeoutMs ?? DEFAULT_SCHEMA_LOCK_TIMEOUT_MS;
  }

  get #leaseTtlMs(): number {
    return this.#options.leaseTtlMs ?? DEFAULT_APPLY_LEASE_TTL_MS;
  }

  /** How long a boot waits for another holder's lease: long enough for a dead holder's to expire. */
  get #leaseWaitMs(): number {
    return this.#lockTimeoutMs + this.#leaseTtlMs;
  }

  #observers(): StateObservers {
    return schemaObservers(this.#query);
  }

  async #revision(): Promise<number> {
    const rows = await this.#query(
      'SELECT environment_revision::text AS revision FROM runtime_control_state WHERE id = 1',
    );
    return rows[0] === undefined ? 1 : Number(rows[0].revision);
  }

  /** The legacy plan digest over the live state and what the change is. */
  async #planDigest(change: Record<string, unknown>): Promise<string> {
    const head = await readPlatformHead(this.#query);
    return digestOf({
      legacyDeployPlanFormatVersion: LEGACY_DEPLOY_PLAN_FORMAT_VERSION,
      contractVersion: CONTRACT_VERSION,
      specSha256: this.#options.specSource === undefined ? null : sha256(this.#options.specSource),
      platformFrom: head.state === 'known' ? head.tag : head.state,
      productFrom: productSchemaDigest(await readProductTables(this.#query)),
      environmentRevision: await this.#revision(),
      change,
    });
  }

  #warn(line: string): void {
    (this.#options.warn ?? ((l: string) => console.warn(l)))(line);
  }

  /**
   * A boot with nothing to change on a blocked environment: the process may serve the schema it
   * finds. Every schema change stays refused until an operator records the step's outcome.
   */
  #warnBlocked(message: string): void {
    this.#warn(
      `[rayspec] WARNING — ${message}. This boot changes no schema and continues; every schema ` +
        'change is refused until the step is resolved.',
    );
  }

  #report(operations: readonly ReconciledOperation[]): void {
    const warn = (line: string) => this.#warn(line);
    for (const op of operations) {
      const steps =
        op.steps.length === 0
          ? 'no step had started'
          : op.steps.map((s) => `${s.step}: ${s.observed}`).join(', ');
      warn(
        `[rayspec] reconciled the interrupted deploy operation ${op.operationId} from its receipts ` +
          `and the live schema (${steps})${op.settled ? '' : ' — manual reconciliation required'}`,
      );
    }
  }

  async #apply(
    change: Record<string, unknown>,
    steps: readonly ApplyStep[],
  ): Promise<ResultEnvelope<unknown>> {
    const planDigest = await this.#planDigest(change);
    return await runApply({
      db: this.#db,
      request: {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: this.#options.actor ?? BOOT_ACTOR,
        planDigest,
        expectedEnvironmentRevision: await this.#revision(),
        idempotencyKey: randomBytes(16).toString('hex'),
      },
      plan: { recompute: () => this.#planDigest(change) },
      steps,
      observers: this.#observers(),
      lockTimeoutMs: this.#lockTimeoutMs,
      leaseTtlMs: this.#leaseTtlMs,
      leaseWaitMs: this.#leaseWaitMs,
      rethrowStepErrors: true,
      onReconciled: (ops) => this.#report(ops),
      ...(this.#options.onCheckpoint !== undefined
        ? { onCheckpoint: this.#options.onCheckpoint }
        : {}),
    });
  }

  /**
   * Bring the platform schema to this runtime's head, as an apply when the receipt tables exist, and
   * reconcile any interrupted apply first. A database migrated by a newer runtime is refused by the
   * migrator itself, unchanged.
   */
  async platformChain(): Promise<void> {
    if (!(await controlTablesPresent(this.#db))) {
      await this.#options.migratePlatform();
      return;
    }
    const target = runtimePlatformHead();
    const deadline = Date.now() + this.#leaseWaitMs;
    for (;;) {
      const head = await readPlatformHead(this.#query);
      if (head.state === 'unknown') {
        // Newer than this runtime: the migrator refuses it under the schema lock, having changed nothing.
        await this.#options.migratePlatform();
        return;
      }
      const pending = head.state !== 'known' || head.tag !== target;
      if (!pending) {
        if (!(await hasUnsettledApplies(this.#db))) return;
        // Nothing to change: take the lease only when reconciliation has something to settle. An
        // environment blocked on a step whose outcome no one can establish gets nothing written.
        const preview = await previewReconciliation(this.#db, this.#observers());
        if (!preview.settles) {
          if (preview.blocked !== null) this.#warnBlocked(preview.blocked.message);
          return;
        }
      }
      const step: ApplyStep = {
        kind: 'effect',
        name: 'platform-migrations',
        observer: 'platform-head',
        expectedAfter: target,
        pending: async () => {
          const now = await readPlatformHead(this.#query);
          return now.state !== 'known' || now.tag !== target;
        },
        run: async () => {
          await this.#options.migratePlatform();
          return {};
        },
      };
      const result = await this.#apply(
        { step: 'platform-migrations', platformTo: target },
        pending ? [step] : [],
      );
      if (result.ok) return;
      // Another boot changed the environment while this one waited: plan again.
      if (result.errors[0].code === 'RAY_PLAN_STALE' && Date.now() < deadline) continue;
      if (!pending && result.errors[0].code === 'RAY_RECONCILIATION_REQUIRED') {
        // It settled what it could; one step is still unknown.
        this.#warnBlocked(result.errors[0].message);
        return;
      }
      throw new RuntimeApplyError(result.errors);
    }
  }

  /**
   * Apply one product-store migration as an apply: the DDL, its ledger row, the environment's
   * product schema digest and the finish receipt commit together. `declared` is the set of stores
   * the product schema implements once the migration has run. A DDL error is rethrown as it was
   * raised, after its receipts are written; drift and a newer ledger are refused as the apply's own
   * errors.
   */
  async productMigration(
    migration: { name: string; sql: string },
    declared: DeclaredProductStores,
  ): Promise<void> {
    const step = productDdlStep({ name: migration.name, sql: migration.sql, declared });
    const result = await this.#apply(
      {
        step: 'product-ddl',
        migration: migration.name,
        ddlSha256: sha256(runnableDdl(migration.sql)),
      },
      [step],
    );
    if (!result.ok) throw new RuntimeApplyError(result.errors);
  }
}

/**
 * The observers the schema-changing steps name: the platform head and the product schema digest,
 * read through `query`. An apply that runs `productDdlStep` passes them.
 */
export function schemaObservers(query: CatalogQuery): StateObservers {
  return {
    'platform-head': async () => {
      const head = await readPlatformHead(query);
      return head.state === 'known' ? head.tag : head.state;
    },
    'product-schema': async () => productSchemaDigest(await readProductTables(query)),
  };
}

/** One product migration, as `productDdlStep` runs and records it. */
export interface ProductDdlStepInput {
  /** The name the migration is recorded under in the ledger. */
  name: string;
  /** The generated SQL; statement-breakpoint markers are removed before it runs. */
  sql: string;
  /** The stores the product schema implements once the migration has run. */
  declared: DeclaredProductStores;
  /** The product schema digest the migration must produce, when a plan computed it in advance. */
  expectedAfter?: string;
}

/**
 * The apply step that runs one product migration: under the shared schema lock and in one
 * transaction, it refuses a ledger written by a newer runtime and a live product schema the ledger
 * does not describe, runs the DDL, records it in the ledger with the operation that ran it, and
 * refuses a result other than `expectedAfter` — rolling the DDL back with it.
 */
export function productDdlStep(input: ProductDdlStepInput): ApplyStep {
  const ddl = runnableDdl(input.sql);
  return {
    kind: 'transaction',
    name: 'product-ddl',
    schemaChange: true,
    observer: 'product-schema',
    run: async (tx, context) => {
      const query = txQuery(tx);
      const ledger = await readProductLedger(query);
      if (ledger.state === 'unreadable') {
        throw new ApplyStepRefusal(bundleError('RAY_SCHEMA_DRIFT', ledger.message));
      }
      const before = await readProductTables(query);
      if (ledger.state === 'ledgered') {
        const drift = ledgerDrift(ledger.head, before);
        if (drift !== null) throw new ApplyStepRefusal(bundleError('RAY_SCHEMA_DRIFT', drift));
      }
      await tx.unsafe(ddl);
      const product = await recordProductMigration(query, {
        operationId: context.operationId,
        migrationName: input.name,
        ddl,
        productSchemaBefore: productSchemaDigest(before),
        tablesAfter: await readProductTables(query),
        declared: input.declared,
      });
      if (input.expectedAfter !== undefined && product !== input.expectedAfter) {
        throw new ApplyStepRefusal(
          bundleError(
            'RAY_MIGRATION_MISMATCH',
            'the product migration did not produce the product schema head the plan computed; it ' +
              'was rolled back',
          ),
        );
      }
      await tx.unsafe(
        'UPDATE runtime_control_state SET applied_product_schema = $1, updated_at = now() WHERE id = 1',
        [product],
      );
      return { digest: product };
    },
  };
}
