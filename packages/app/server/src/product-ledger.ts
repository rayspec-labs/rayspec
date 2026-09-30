/**
 * THE PRODUCT MIGRATION LEDGER — the record of every product schema change an environment applied
 * (`product_migration_ledger`, an append-only platform table).
 *
 * Product stores are generated from the spec, so their DDL keeps no drizzle ledger of its own. This
 * ledger is that record: each row holds the DDL that ran, its SHA-256, the product schema digest
 * before and after it, the product schema description after it, the declared stores the schema then
 * implements, and the operation that applied it. The row is written in the transaction that runs
 * the DDL, so a change and its row commit together or not at all.
 *
 * WHAT IT DECIDES.
 *  - Drift: the latest row's `product_schema_after` is what the live product schema must be. A live
 *    digest that differs was changed outside an apply, and the difference is named table by table
 *    from the recorded description.
 *  - The next delta: it is regenerated from the latest row's declared stores and the new spec, never
 *    taken from the bundle on trust.
 *  - The head a delta produces: regenerating every row's change from the declared stores of the row
 *    before it and its own, and running those changes in order on a throwaway database, reproduces
 *    the live product schema; applying the delta there gives the head after it. The recorded DDL
 *    text itself is never run again: a row is data, and only the generator writes DDL.
 *
 * READING FAILS CLOSED. A row of a ledger format this runtime does not know was written by a newer
 * runtime, and a row whose parts do not agree with each other was not written by an apply; either
 * makes the whole ledger unreadable, and nothing is planned or applied on top of it.
 */
import { createHash } from 'node:crypto';
import {
  isSha256,
  normalizeProductSchema,
  PRODUCT_SCHEMA_FORMAT_VERSION,
  type ProductTable,
  productSchemaDigest,
} from '@rayspec/bundle-contract';
import type { StoreConflictKeys } from '@rayspec/db';
import { StoreSpec } from '@rayspec/spec';
import type { CatalogQuery } from './schema-head.js';

/** The ledger format this runtime writes and the only one it reads. */
export const PRODUCT_LEDGER_FORMAT_VERSION = 1;

/** The stores a product schema implements, with the conflict keys its unique indexes follow. */
export interface DeclaredProductStores {
  stores: StoreSpec[];
  conflictKeys?: StoreConflictKeys;
}

/** One applied product change, as the ledger records it. */
export interface ProductLedgerRow {
  id: number;
  operationId: string;
  migrationName: string;
  ddl: string;
  ddlSha256: string;
  productSchemaBefore: string;
  productSchemaAfter: string;
  /** The product tables after the change, in the canonical order of the description. */
  tablesAfter: ProductTable[];
  declared: DeclaredProductStores;
}

/** What the ledger says about the environment. */
export type ProductLedger =
  /** No product change was ever applied through the ledger (or the table does not exist yet). */
  | { state: 'empty' }
  /** A row this runtime cannot read; nothing may be planned or applied on top of it. */
  | { state: 'unreadable'; message: string }
  | { state: 'ledgered'; rows: ProductLedgerRow[]; head: ProductLedgerRow };

/** The DDL of generated SQL, as it runs: the statement-breakpoint markers removed. */
export function runnableDdl(sql: string): string {
  return sql.replace(/-->\s*statement-breakpoint/g, '');
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The declared stores as the ledger stores them: conflict keys as sorted name lists. */
export function declaredStoresJson(declared: DeclaredProductStores): {
  stores: StoreSpec[];
  conflictKeys: Record<string, string[]>;
} {
  const conflictKeys: Record<string, string[]> = {};
  for (const [store, columns] of [...(declared.conflictKeys ?? new Map()).entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    conflictKeys[store] = [...columns].sort();
  }
  return { stores: declared.stores, conflictKeys };
}

function parseDeclared(value: unknown): DeclaredProductStores | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { stores, conflictKeys } = value as Record<string, unknown>;
  if (!Array.isArray(stores)) return null;
  const parsedStores: StoreSpec[] = [];
  for (const store of stores) {
    const parsed = StoreSpec.safeParse(store);
    if (!parsed.success) return null;
    parsedStores.push(parsed.data);
  }
  if (typeof conflictKeys !== 'object' || conflictKeys === null || Array.isArray(conflictKeys)) {
    return null;
  }
  const keys = new Map<string, ReadonlySet<string>>();
  for (const [store, columns] of Object.entries(conflictKeys)) {
    if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) return null;
    keys.set(store, new Set(columns as string[]));
  }
  return keys.size === 0 ? { stores: parsedStores } : { stores: parsedStores, conflictKeys: keys };
}

function parseTables(value: unknown): ProductTable[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const { productSchemaFormatVersion, tables } = value as Record<string, unknown>;
  if (productSchemaFormatVersion !== PRODUCT_SCHEMA_FORMAT_VERSION || !Array.isArray(tables)) {
    return null;
  }
  try {
    // Normalizing reads every member the digest covers; a row missing one fails here.
    return normalizeProductSchema(tables as ProductTable[]).tables;
  } catch {
    return null;
  }
}

/** Read the ledger, in the order it was written. Read-only. */
export async function readProductLedger(query: CatalogQuery): Promise<ProductLedger> {
  const present = await query(
    "SELECT to_regclass('public.product_migration_ledger') IS NOT NULL AS present",
  );
  if (present[0]?.present !== true) return { state: 'empty' };
  const rows = await query(
    `SELECT id::text AS id, ledger_format_version, operation_id::text AS operation_id,
            migration_name, ddl, ddl_sha256, product_schema_before, product_schema_after,
            schema_after, declared_stores
       FROM product_migration_ledger ORDER BY id`,
  );
  if (rows.length === 0) return { state: 'empty' };
  const parsed: ProductLedgerRow[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (row.ledger_format_version !== PRODUCT_LEDGER_FORMAT_VERSION) {
      return {
        state: 'unreadable',
        message:
          `product ledger row ${id} has format version ${String(row.ledger_format_version)}, ` +
          `which this runtime does not read (it reads ${PRODUCT_LEDGER_FORMAT_VERSION}): a newer ` +
          'runtime applied a product change to this environment. Deploy with that runtime or a newer one',
      };
    }
    const tablesAfter = parseTables(row.schema_after);
    const declared = parseDeclared(row.declared_stores);
    const ddl = typeof row.ddl === 'string' ? row.ddl : null;
    const before = row.product_schema_before;
    const after = row.product_schema_after;
    if (
      tablesAfter === null ||
      declared === null ||
      ddl === null ||
      sha256(ddl) !== row.ddl_sha256 ||
      !isSha256(before) ||
      !isSha256(after) ||
      productSchemaDigest(tablesAfter) !== after
    ) {
      return {
        state: 'unreadable',
        message:
          `product ledger row ${id} does not hold together (its DDL, digests, schema description ` +
          'or declared stores disagree): it was not written by an apply. Reconcile the ledger by hand',
      };
    }
    parsed.push({
      id,
      operationId: String(row.operation_id),
      migrationName: String(row.migration_name),
      ddl,
      ddlSha256: String(row.ddl_sha256),
      productSchemaBefore: before,
      productSchemaAfter: after,
      tablesAfter,
      declared,
    });
  }
  return { state: 'ledgered', rows: parsed, head: parsed[parsed.length - 1]! };
}

/** What one applied product change records. */
export interface ProductLedgerEntry {
  operationId: string;
  migrationName: string;
  ddl: string;
  productSchemaBefore: string;
  tablesAfter: readonly ProductTable[];
  declared: DeclaredProductStores;
}

/**
 * Record one applied change, through `query`, which must run in the transaction that ran the DDL.
 * Returns the product schema digest after the change.
 */
export async function recordProductMigration(
  query: CatalogQuery,
  entry: ProductLedgerEntry,
): Promise<string> {
  const description = normalizeProductSchema(entry.tablesAfter);
  const after = productSchemaDigest(entry.tablesAfter);
  await query(
    `INSERT INTO product_migration_ledger
       (ledger_format_version, operation_id, migration_name, ddl, ddl_sha256,
        product_schema_before, product_schema_after, schema_after, declared_stores)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb)`,
    [
      PRODUCT_LEDGER_FORMAT_VERSION,
      entry.operationId,
      entry.migrationName,
      entry.ddl,
      sha256(entry.ddl),
      entry.productSchemaBefore,
      after,
      JSON.stringify(description),
      JSON.stringify(declaredStoresJson(entry.declared)),
    ],
  );
  return after;
}

// ─── drift ─────────────────────────────────────────────────────────────────────────────────────

const describeColumn = (c: ProductTable['columns'][number]) =>
  `${c.type}${c.nullable ? '' : ' not null'}${c.default === null ? '' : ` default ${c.default}`}`;

/**
 * What differs between the product tables the ledger recorded and the live ones, one line per
 * table or column, in name order. Empty when they agree.
 */
export function describeProductDrift(
  recorded: readonly ProductTable[],
  live: readonly ProductTable[],
): string[] {
  const was = new Map(normalizeProductSchema(recorded).tables.map((t) => [t.name, t]));
  const now = new Map(normalizeProductSchema(live).tables.map((t) => [t.name, t]));
  const names = [...new Set([...was.keys(), ...now.keys()])].sort();
  const out: string[] = [];
  for (const name of names) {
    const a = was.get(name);
    const b = now.get(name);
    if (a === undefined) {
      out.push(`table ${name} exists but no applied change created it`);
      continue;
    }
    if (b === undefined) {
      out.push(`table ${name} is missing`);
      continue;
    }
    const aCols = new Map(a.columns.map((c) => [c.name, c]));
    const bCols = new Map(b.columns.map((c) => [c.name, c]));
    for (const col of [...new Set([...aCols.keys(), ...bCols.keys()])].sort()) {
      const x = aCols.get(col);
      const y = bCols.get(col);
      if (x === undefined) out.push(`column ${name}.${col} exists but no applied change added it`);
      else if (y === undefined) out.push(`column ${name}.${col} is missing`);
      else if (describeColumn(x) !== describeColumn(y)) {
        out.push(`column ${name}.${col} is ${describeColumn(y)}, not ${describeColumn(x)}`);
      }
    }
    const same = (k: 'primaryKey' | 'uniques' | 'indexes' | 'foreignKeys') =>
      JSON.stringify(a[k]) === JSON.stringify(b[k]);
    if (!same('primaryKey')) out.push(`table ${name} has a different primary key`);
    if (!same('uniques')) out.push(`table ${name} has different unique constraints`);
    if (!same('indexes')) out.push(`table ${name} has different indexes`);
    if (!same('foreignKeys')) out.push(`table ${name} has different foreign keys`);
  }
  return out;
}

/**
 * The drift of the live product tables from the ledger's latest row, as one message, or null when
 * the live schema is the one the ledger says it is.
 */
export function ledgerDrift(head: ProductLedgerRow, live: readonly ProductTable[]): string | null {
  if (productSchemaDigest(live) === head.productSchemaAfter) return null;
  const lines = describeProductDrift(head.tablesAfter, live);
  return (
    'the live product schema is not the one the product ledger recorded after its last change ' +
    `(${head.migrationName}): it was changed outside an apply` +
    (lines.length === 0 ? '' : ` — ${lines.join('; ')}`) +
    '. Undo the change by hand, or record it through a reviewed forward migration, before planning again'
  );
}
