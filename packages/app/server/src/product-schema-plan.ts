/**
 * PRODUCT SCHEMA PLANNING — what a bundle would do to the environment's product stores, decided from
 * the LIVE database and the product migration ledger, never from what the bundle says about itself.
 *
 * The bundle may carry a product delta, its reviewed allowlist and the product schema digests it
 * migrates between (`productMigration` in the manifest, written by `rayspec pack --against`). None
 * of that is trusted:
 *  - the delta is REGENERATED from the declared stores of the ledger's latest row and the bundle's
 *    spec, and a carried delta that differs from it by one byte is `RAY_MIGRATION_MISMATCH`;
 *  - the digest it migrates from must be the live product digest (`RAY_MIGRATION_REQUIRED`);
 *  - the digest after it is computed on a throwaway database on the shadow server, where the
 *    ledger's changes, each regenerated from the declared stores it records, must first reproduce the
 *    live product schema; a carried digest that differs is `RAY_MIGRATION_MISMATCH`;
 *  - the carried `destructive` flag is ignored: the server's own destructive-statement scanner reads
 *    the regenerated delta, and only the reviewed allowlist the bundle carries clears a finding. A
 *    finding it does not clear blocks the plan, naming the stores and columns and the review step.
 * A live schema that differs from the ledger's latest row is drift and blocks the plan.
 *
 * `rayspec pack --against` uses the same regeneration (`productDelta`) and the same shadow replay
 * (`shadowProductDigests`), so a bundle packed against the spec the environment runs carries exactly
 * the delta and digests the target computes.
 *
 * Nothing here writes to the environment's database. The only writes are to a throwaway database on
 * the shadow server, created and dropped within the call.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { BundleSpec } from '@rayspec/bundle-closure';
import {
  type BundleError,
  type BundleErrorCode,
  type BundleWarning,
  bundleError,
  type ProductMigration,
  type ProductTable,
  productSchemaDigest,
} from '@rayspec/bundle-contract';
import {
  classifyProductSchema,
  type Db,
  type DestructiveFinding,
  detectDrift,
  diffProductStores,
  makeDb,
  parseAllowlistEntries,
  type StoreDiffResult,
  scanMigrationSql,
} from '@rayspec/db';
import {
  composeCapabilityStores,
  deriveConflictKeys,
  deriveProductStores,
} from '@rayspec/product-yaml';
import { applyMigrations } from './composition-root.js';
import {
  type DeclaredProductStores,
  ledgerDrift,
  type ProductLedger,
  type ProductLedgerRow,
  readProductLedger,
  runnableDdl,
} from './product-ledger.js';
import { type CatalogQuery, readProductTables } from './schema-head.js';

/** The label woven into the header comment of every delta a bundle carries or a target regenerates. */
export const PRODUCT_DELTA_LABEL = 'bundle';

/** The name a bundled product delta is applied and recorded under. */
export const BUNDLED_DELTA_NAME = 'product-delta.sql';

/** The stores a spec materializes, with the conflict keys the product generator needs. */
export function declaredStoresOf(spec: BundleSpec): DeclaredProductStores {
  if (spec.kind === 'rayspec') return { stores: [...spec.spec.stores] };
  const capability = composeCapabilityStores(spec.spec);
  const derived = deriveProductStores(spec.spec, capability.names);
  const stores = [...capability.stores, ...derived.stores];
  return { stores, conflictKeys: deriveConflictKeys(spec.spec, stores) };
}

/** The forward delta from one set of declared stores to another, byte-stable for the pair. */
export function productDelta(
  from: DeclaredProductStores,
  to: DeclaredProductStores,
): StoreDiffResult {
  return diffProductStores(from.stores, to.stores, {
    label: PRODUCT_DELTA_LABEL,
    ...(to.conflictKeys === undefined ? {} : { newConflictKeys: to.conflictKeys }),
    ...(from.conflictKeys === undefined ? {} : { oldConflictKeys: from.conflictKeys }),
  });
}

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ─── destructive findings ──────────────────────────────────────────────────────────────────────

const TABLE_NAME = /\bTABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;
const COLUMN_NAME = /\bCOLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"([^"]+)"/i;
const INDEX_NAME = /\bINDEX\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;

/** The store, column or index a destructive statement touches, as `store.column`, `store` or `index x`. */
export function affectedObject(statement: string): string {
  const table = TABLE_NAME.exec(statement)?.[1];
  const column = COLUMN_NAME.exec(statement)?.[1];
  if (table !== undefined) return column === undefined ? table : `${table}.${column}`;
  const index = INDEX_NAME.exec(statement)?.[1];
  return index === undefined ? 'an unnamed object' : `index ${index}`;
}

/** The review step a destructive delta needs, spelled out. */
export const DESTRUCTIVE_REVIEW_STEP =
  'Review it: run `rayspec plan <new-spec> --against <spec of the running application>`, copy the ' +
  'proposed allowlist entries you approve into a file, and pack the bundle again with ' +
  '`rayspec pack --spec <new-spec> --against <spec of the running application> --allowlist <file.json>`';

/** Why a delta with findings the allowlist does not clear is refused. */
export function uncoveredDestructiveMessage(findings: readonly DestructiveFinding[]): string {
  const uncovered = findings.filter((f) => !f.allowed);
  const listed = uncovered.map((f) => `${f.kind} on ${affectedObject(f.text)}`).join(', ');
  return (
    `the product delta is destructive and no reviewed allowlist entry covers ${listed}. ` +
    DESTRUCTIVE_REVIEW_STEP
  );
}

// ─── the shadow replay ─────────────────────────────────────────────────────────────────────────

function databaseUrlWithName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** What the throwaway database looked like before and after the delta. */
export interface ShadowDigests {
  before: string;
  after: string;
  tablesBefore: ProductTable[];
  tablesAfter: ProductTable[];
}

/**
 * On a throwaway database on the shadow server: apply the platform chain, then each `baseline` DDL
 * in order (each in its own transaction), read the product schema (`before`), apply `delta` in one
 * transaction and read it again (`after`). The database is dropped on every path out.
 */
export async function shadowProductDigests(
  shadowUrl: string,
  baseline: readonly string[],
  delta: string,
): Promise<ShadowDigests> {
  // Hex only, so the name is a safe identifier by construction.
  const name = `rayspec_plan_${randomBytes(8).toString('hex')}`;
  const admin = makeDb(databaseUrlWithName(shadowUrl, 'postgres'), 1);
  let scratch: Db | undefined;
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${name}"`);
    scratch = makeDb(databaseUrlWithName(shadowUrl, name), 2);
    await applyMigrations(scratch);
    const client = scratch.$client;
    for (const ddl of baseline) {
      await client.begin(async (tx) => {
        await tx.unsafe(runnableDdl(ddl));
      });
    }
    const query: CatalogQuery = async (sql, params = []) =>
      (await client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
    const tablesBefore = await readProductTables(query);
    await client.begin(async (tx) => {
      await tx.unsafe(runnableDdl(delta));
    });
    const tablesAfter = await readProductTables(query);
    return {
      before: productSchemaDigest(tablesBefore),
      after: productSchemaDigest(tablesAfter),
      tablesBefore,
      tablesAfter,
    };
  } finally {
    await scratch?.$client.end();
    await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$client.end();
  }
}

// ─── the plan ──────────────────────────────────────────────────────────────────────────────────

/** A database read failed; the caller reports it without its detail. */
export class ProductPlanReadError extends Error {}

async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new ProductPlanReadError('a database could not be read', { cause: err });
  }
}

export interface ProductPlanInput {
  /** Reads the environment's database. */
  query: CatalogQuery;
  /** The stores the bundle's spec declares. */
  declared: DeclaredProductStores;
  /** The bundle's `productMigration` with the bytes of its files, when it carries one. */
  migration?: { manifest: ProductMigration; delta: Uint8Array; allowlist?: Uint8Array };
  /** A server where a throwaway database may be created (`SHADOW_DATABASE_URL`). */
  shadowDatabaseUrl?: string;
}

/** The product change a bundle makes, and what stands in its way. */
export interface ProductPlan {
  /** The live product schema digest. */
  from: string;
  /** The product schema digest after the change; `from` when there is no change. */
  to: string;
  /** The regenerated delta, or null when the product schema does not change. */
  delta: string | null;
  productDeltaSha256: string | null;
  /** Whether the server's scanner finds a destructive statement in the delta. */
  destructive: boolean;
  /** Whether the reviewed allowlist the bundle carries clears every finding. */
  allowlisted: boolean;
  blockers: BundleError[];
  warnings: BundleWarning[];
  /** The stores the product schema implements once the delta is applied, for the ledger. */
  declared: DeclaredProductStores;
}

function blockerAt(code: BundleErrorCode, message: string): BundleError {
  return bundleError(code, message, { path: '/productMigration' });
}

const UNLEDGERED: BundleWarning = {
  code: 'RAY_W_PRODUCT_SCHEMA_UNLEDGERED',
  message:
    'the product schema head was computed by introspection: the live product tables were created ' +
    'before the product migration ledger recorded changes',
};

/**
 * Plan the bundle's product change against the live database and the ledger. Read-only against the
 * environment; blockers are returned, not thrown. A failed read throws `ProductPlanReadError`.
 */
export async function planProductSchema(input: ProductPlanInput): Promise<ProductPlan> {
  const { query, declared, migration } = input;
  const liveTables = await guarded(() => readProductTables(query));
  const live = productSchemaDigest(liveTables);
  const ledger: ProductLedger = await guarded(() => readProductLedger(query));
  const plan: ProductPlan = {
    from: live,
    to: live,
    delta: null,
    productDeltaSha256: null,
    destructive: false,
    allowlisted: false,
    blockers: [],
    warnings: [],
    declared,
  };

  if (ledger.state === 'unreadable') {
    plan.blockers.push(blockerAt('RAY_SCHEMA_DRIFT', ledger.message));
    return plan;
  }
  if (ledger.state === 'ledgered') {
    const drift = ledgerDrift(ledger.head, liveTables);
    if (drift !== null) {
      plan.blockers.push(blockerAt('RAY_SCHEMA_DRIFT', drift));
      return plan;
    }
    await planDelta(plan, input, ledger.head.declared, regeneratedHistory(ledger.rows));
    return plan;
  }
  if (liveTables.length === 0) {
    // No product table yet: the delta is the first materialization of the declared stores.
    await planDelta(plan, input, { stores: [] }, []);
    return plan;
  }

  // Product tables the ledger never recorded: an environment deployed before the ledger existed.
  // Its declared stores are unknown, so no delta can be regenerated; only a spec the live schema
  // already implements, or one that adds whole tables, can be planned.
  plan.warnings.push(UNLEDGERED);
  if (migration !== undefined) {
    plan.blockers.push(
      blockerAt(
        'RAY_MIGRATION_REQUIRED',
        'the bundle carries a product delta, but the product migration ledger has no record of how ' +
          'the live product schema was created, so the delta cannot be regenerated and checked. ' +
          'Deploy the spec the environment runs once with `rayspec deploy <spec.yaml>` from this ' +
          'runtime, or migrate the product stores with `rayspec deploy <spec.yaml> --apply-migration`',
      ),
    );
    return plan;
  }
  const drift = await guarded(() =>
    detectDrift(declared.stores, 'public', (sql, params) => query(sql, params)),
  );
  const state = classifyProductSchema(declared.stores, drift);
  if (state === 'drifted') {
    plan.blockers.push(
      blockerAt(
        'RAY_SCHEMA_DRIFT',
        'the live product schema matches neither the active application nor this bundle, and the ' +
          'product migration ledger has no record to derive a reviewed delta from',
      ),
    );
    return plan;
  }
  if (state === 'absent') {
    // Every declared store is new: create them next to the unrecorded tables.
    const delta = productDelta({ stores: [] }, declared).migrationSql;
    await planWithShadow(plan, input, delta, null, (created) => [...liveTables, ...created]);
  }
  return plan;
}

/**
 * The ledger's changes, each regenerated from the declared stores of the row before it and its own.
 * The DDL text a row records is never run: only the generator writes the DDL the shadow server
 * runs, and whether the result reproduces the live schema is checked there.
 */
function regeneratedHistory(rows: readonly ProductLedgerRow[]): string[] {
  return rows
    .map((row, i) => productDelta(i === 0 ? { stores: [] } : rows[i - 1]!.declared, row.declared))
    .map((delta) => delta.migrationSql)
    .filter((sql) => sql !== '');
}

/** Plan the regenerated delta from `from`, with `baseline` the DDL that reproduces the live schema. */
async function planDelta(
  plan: ProductPlan,
  input: ProductPlanInput,
  from: DeclaredProductStores,
  baseline: readonly string[],
): Promise<void> {
  const { migration, declared } = input;
  const regenerated = productDelta(from, declared);
  const delta = regenerated.migrationSql;
  if (delta === '') {
    // The environment already has the schema the bundle migrates to: its delta was applied by an
    // earlier deploy of this bundle that stopped before it finished. Nothing is left to change.
    if (migration !== undefined && migration.manifest.toProductSchemaDigest === plan.from) return;
    if (migration !== undefined) {
      plan.blockers.push(
        blockerAt(
          'RAY_MIGRATION_MISMATCH',
          'the bundle carries a product delta, but its stores are the ones the environment already ' +
            'has: the regenerated delta is empty. Pack the bundle again without --against',
        ),
      );
    }
    return;
  }

  let allowlist: ReturnType<typeof parseAllowlistEntries> = { ok: true, entries: [] };
  if (migration?.allowlist !== undefined) {
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(migration.allowlist).toString('utf8'));
      allowlist = parseAllowlistEntries(data);
    } catch {
      allowlist = { ok: false, message: 'the allowlist is not valid JSON' };
    }
    if (!allowlist.ok) {
      plan.blockers.push(
        blockerAt(
          'RAY_MIGRATION_REQUIRED',
          `the bundle's reviewed allowlist is malformed, so it clears nothing: ${allowlist.message}`,
        ),
      );
    }
  }
  const scan = scanMigrationSql(delta, allowlist.ok ? allowlist.entries : []);
  plan.destructive = scan.findings.length > 0;
  plan.allowlisted = plan.destructive && scan.pass;

  const firstMaterialization = from.stores.length === 0 && baseline.length === 0;
  if (migration === undefined) {
    if (!firstMaterialization) {
      plan.blockers.push(
        blockerAt(
          'RAY_MIGRATION_REQUIRED',
          'the bundle changes the product stores of the running application but carries no ' +
            'product delta. Pack it with `rayspec pack --spec <new-spec> --against <spec of the ' +
            'running application>` (add `--allowlist <file.json>` for a reviewed destructive change)',
        ),
      );
    }
  } else {
    if (migration.manifest.fromProductSchemaDigest !== plan.from) {
      plan.blockers.push(
        blockerAt(
          'RAY_MIGRATION_REQUIRED',
          'the bundle migrates from a product schema that is not the live one: pack it again ' +
            '`--against` the spec of the running application',
        ),
      );
    }
    if (sha256(migration.delta) !== sha256(delta)) {
      plan.blockers.push(
        blockerAt(
          'RAY_MIGRATION_MISMATCH',
          'the product delta the bundle carries differs from the one regenerated from the live ' +
            'schema and the bundled spec. Rebuild the bundle against the spec of the running application',
        ),
      );
    }
  }
  if (plan.destructive && !scan.pass) {
    plan.blockers.push(
      blockerAt('RAY_MIGRATION_REQUIRED', uncoveredDestructiveMessage(scan.findings)),
    );
  }
  await planWithShadow(plan, input, delta, baseline, (_created, after) => after);
}

/**
 * Record the delta on the plan and compute the head after it on the shadow server. With `baseline`
 * the throwaway database first replays it and must reproduce the live schema; without one the delta
 * only adds tables, and `combine` puts them next to the live ones.
 */
async function planWithShadow(
  plan: ProductPlan,
  input: ProductPlanInput,
  delta: string,
  baseline: readonly string[] | null,
  combine: (created: ProductTable[], after: ProductTable[]) => ProductTable[],
): Promise<void> {
  plan.delta = delta;
  plan.productDeltaSha256 = sha256(delta);
  const shadowUrl = input.shadowDatabaseUrl;
  if (shadowUrl === undefined) {
    plan.blockers.push(
      blockerAt(
        'RAY_MIGRATION_REQUIRED',
        'the bundle changes the product schema, and without a shadow database the schema head the ' +
          'change produces cannot be computed',
      ),
    );
    return;
  }
  const shadow = await guarded(() => shadowProductDigests(shadowUrl, baseline ?? [], delta));
  if (baseline !== null && shadow.before !== plan.from) {
    plan.blockers.push(
      blockerAt(
        'RAY_SCHEMA_DRIFT',
        'the changes the product migration ledger records, regenerated from their declared stores, ' +
          'do not reproduce the live product schema: a change reached it that no generated delta ' +
          'made (a hand-written migration, or a change made outside an apply). Reconcile the ' +
          'schema by hand before planning again',
      ),
    );
    return;
  }
  const created = shadow.tablesAfter.filter(
    (t) => !shadow.tablesBefore.some((b) => b.name === t.name),
  );
  plan.to = productSchemaDigest(combine(created, shadow.tablesAfter));
  const carried = input.migration?.manifest.toProductSchemaDigest;
  if (carried !== undefined && carried !== plan.to) {
    plan.blockers.push(
      blockerAt(
        'RAY_MIGRATION_MISMATCH',
        'the product schema digest the bundle says its delta produces is not the one the delta ' +
          'produces on the live schema. Rebuild the bundle against the spec of the running application',
      ),
    );
  }
}
