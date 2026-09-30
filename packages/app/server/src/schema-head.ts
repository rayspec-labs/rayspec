/**
 * THE LIVE SCHEMA HEAD — the two-part head the runtime-control operations report and compare.
 *
 * `platform` is the tag of the last applied platform migration. The drizzle ledger
 * (`drizzle.__drizzle_migrations`) stores a hash and `created_at`, not the tag, and `created_at` is
 * the journal entry's `when`; so the tag is the entry of the runtime's own journal whose `when` equals
 * the highest `created_at`. A ledger row no journal entry explains means the database was migrated by
 * a newer runtime than this one: that is drift, never a guess.
 *
 * `product` is the SHA-256 of the canonical product schema description, read from the LIVE catalog:
 * every ordinary table in the schema that is not a platform table, with its columns, primary key,
 * unique constraints, indexes and foreign keys (`productSchemaDigest` in the contract package holds
 * the ordering rules). Nothing here writes; every query reads `pg_catalog` or the ledger.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProductTable,
  PUBLIC_PLATFORM_TABLE_NAMES,
  productSchemaDigest,
  type SchemaHead,
} from '@rayspec/bundle-contract';
import { migrationsDir } from '@rayspec/db';

/** Something that runs one read-only query with positional parameters. */
export type CatalogQuery = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** The entries of the runtime's own platform migration journal, in order. */
export function platformJournal(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/** The tag of the last migration this runtime ships: the platform head a fresh apply reaches. */
export function runtimePlatformHead(): string {
  const entries = platformJournal();
  const last = entries[entries.length - 1];
  if (last === undefined) throw new Error('the platform migration journal is empty');
  return last.tag;
}

/** The live platform head: none applied, one this runtime knows, or a ledger it cannot explain. */
export type LivePlatformHead =
  | { state: 'empty' }
  | { state: 'known'; tag: string }
  | { state: 'unknown'; unexplainedRows: number };

/** Read the platform ledger and map it onto the runtime's journal. */
export async function readPlatformHead(query: CatalogQuery): Promise<LivePlatformHead> {
  const present = await query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (present[0]?.present !== true) return { state: 'empty' };
  const rows = await query(
    'SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations',
  );
  if (rows.length === 0) return { state: 'empty' };
  const byWhen = new Map(platformJournal().map((e) => [String(e.when), e]));
  let unexplained = 0;
  let head: JournalEntry | undefined;
  for (const row of rows) {
    const entry = byWhen.get(String(row.created_at));
    if (entry === undefined) {
      unexplained += 1;
      continue;
    }
    if (head === undefined || entry.when > head.when) head = entry;
  }
  if (unexplained > 0 || head === undefined)
    return { state: 'unknown', unexplainedRows: unexplained };
  return { state: 'known', tag: head.tag };
}

const ON_DELETE: Readonly<Record<string, string>> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/**
 * Describe the product tables of `schema` from the live catalog: every ordinary or partitioned table
 * whose name is not a platform table. The primary key's own index is described by `primaryKey`, not
 * repeated under `indexes`.
 */
export async function readProductTables(
  query: CatalogQuery,
  schema = 'public',
): Promise<ProductTable[]> {
  const tables = await query(
    `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  const described = new Map<string, ProductTable>();
  for (const t of tables) {
    const name = String(t.name);
    if (PUBLIC_PLATFORM_TABLE_NAMES.has(name)) continue;
    described.set(name, {
      name,
      columns: [],
      primaryKey: [],
      uniques: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  if (described.size === 0) return [];

  const columns = await query(
    `SELECT c.relname::text AS table_name, a.attname::text AS name,
            format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS column_default
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  for (const col of columns) {
    described.get(String(col.table_name))?.columns.push({
      name: String(col.name),
      type: String(col.type),
      nullable: col.nullable === true,
      default: col.column_default === null ? null : String(col.column_default),
    });
  }

  const constraints = await query(
    `SELECT c.relname::text AS table_name, con.contype::text AS kind,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num
                   ORDER BY k.ord) AS columns,
            rc.relname::text AS ref_table,
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num
                   ORDER BY k.ord) AS ref_columns,
            con.confdeltype::text AS on_delete
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class rc ON rc.oid = con.confrelid
      WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'f')`,
    [schema],
  );
  for (const con of constraints) {
    const table = described.get(String(con.table_name));
    if (table === undefined) continue;
    const cols = (con.columns as string[]).map(String);
    if (con.kind === 'p') table.primaryKey = cols;
    else if (con.kind === 'u') table.uniques.push(cols);
    else {
      table.foreignKeys.push({
        columns: cols,
        references: {
          table: String(con.ref_table),
          columns: (con.ref_columns as string[]).map(String),
        },
        onDelete: ON_DELETE[String(con.on_delete)] ?? String(con.on_delete),
      });
    }
  }

  const indexes = await query(
    `SELECT c.relname::text AS table_name, ic.relname::text AS name, i.indisunique AS is_unique,
            ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                    FROM generate_series(1, i.indnkeyatts::int) AS k ORDER BY k) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT i.indisprimary`,
    [schema],
  );
  for (const ix of indexes) {
    described.get(String(ix.table_name))?.indexes.push({
      name: String(ix.name),
      columns: (ix.columns as string[]).map(String),
      unique: ix.is_unique === true,
    });
  }
  return [...described.values()];
}

/** The product half of the live head. */
export async function readProductSchemaDigest(query: CatalogQuery, schema = 'public') {
  return productSchemaDigest(await readProductTables(query, schema));
}

/**
 * The live two-part head: null before the first platform migration, `unknown` when the ledger holds
 * a migration this runtime does not ship (the database is newer than the runtime).
 */
export async function readSchemaHead(
  query: CatalogQuery,
): Promise<{ state: 'empty' } | { state: 'known'; head: SchemaHead } | { state: 'unknown' }> {
  const platform = await readPlatformHead(query);
  if (platform.state === 'empty') return { state: 'empty' };
  if (platform.state === 'unknown') return { state: 'unknown' };
  return {
    state: 'known',
    head: { platform: platform.tag, product: await readProductSchemaDigest(query) },
  };
}
