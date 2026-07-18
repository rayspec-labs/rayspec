/**
 * From-clean-DB structural cross-check — the DETERMINISTIC primary drift oracle.
 *
 * Invoked by scripts/migrate-clean.sh AFTER `drizzle-kit migrate` has applied the full chain to a
 * fresh empty database (MIGRATE_CLEAN_URL). It asserts the LIVE schema equals schema.ts for EVERY
 * core platform table — COMPLETELY:
 *   - every COLUMN: name + SQL type + nullability + DEFAULT + array element type (both directions —
 *     a column in the DB not declared in schema.ts also fails);
 *   - every PRIMARY KEY: presence + exact ORDERED column list (single-column AND composite, e.g.
 *     oidc_models (model, id));
 *   - every FOREIGN KEY: target table + ON DELETE action (both directions — an extra FK fails);
 *   - every INDEX: name + uniqueness + exact ORDERED column list + partial-WHERE predicate +
 *     expression body (both directions — an extra index fails).
 *
 * AUTO-DERIVED, CANNOT ROT: the EXPECTED shape is read from the actual Drizzle table objects in
 * schema.ts via getTableConfig — so when schema.ts changes, this check tracks it automatically and a
 * hand-maintained list can never go stale. The push oracle in migrate-clean.sh also tracks schema.ts
 * but carries a benign array-default normalization quirk and is weak for expression/partial indexes;
 * THIS check is quirk-free and is the DETERMINISTIC oracle that bites on the drift classes the fix
 * round closed (PK loss, column-default change, index column re-key, dropped partial-WHERE, changed
 * expression body, array element type).
 *
 * Exits non-zero (failing gate:migrate-clean) on ANY drift finding, listing each precise diff.
 */
import { getTableName, type SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import {
  apiKeys,
  authAudit,
  conversationItems,
  idempotencyKeys,
  invites,
  journalSteps,
  memberships,
  oidcModels,
  orgs,
  runEvents,
  runs,
  sessions,
  users,
  workflowArtifacts,
  workflowNodeStates,
  workflowRuns,
} from '../src/schema.js';

// The full core platform table set. Drift on ANY of these fails the gate. The base 12 platform
// tables the PRD enumerates + the workflow-runtime journal trio (workflow_runs /
// workflow_node_states / workflow_artifacts), so the from-clean-DB structural oracle covers the
// durable workflow journal too.
const CORE_PLATFORM_TABLES: PgTable[] = [
  orgs,
  users,
  memberships,
  sessions,
  apiKeys,
  authAudit,
  oidcModels,
  idempotencyKeys,
  invites,
  runs,
  journalSteps,
  conversationItems,
  runEvents,
  workflowRuns,
  workflowNodeStates,
  workflowArtifacts,
];

const url = process.env.MIGRATE_CLEAN_URL;
if (!url) {
  console.error('MIGRATE-CLEAN: FAIL — MIGRATE_CLEAN_URL not set.');
  process.exit(1);
}

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

/**
 * Normalize a Postgres type for comparison. information_schema.data_type reports `timestamp with time
 * zone`, `numeric`, `boolean`, `uuid`, `text`, `ARRAY`; Drizzle getSQLType() reports those plus
 * `text[]` for arrays. We compare on a canonical token, treating any array as `array`; the ELEMENT
 * type is separately cross-checked via udt_name (so `text[]` vs `int[]` is NOT lost — HON-1 resolved
 * by an actual check, not by softening).
 */
function normType(t: string): string {
  const s = t.toLowerCase().trim();
  if (s === 'array' || s.endsWith('[]')) return 'array';
  return s;
}

/** Map a Drizzle array SQL type (`text[]`) to the PG udt_name for the array (`_text`). */
function expectedArrayUdt(sqlType: string): string | null {
  const m = /^(.*)\[\]$/.exec(sqlType.trim());
  if (!m) return null;
  const elem = (m[1] ?? '').toLowerCase().trim();
  // PG names array types as `_<element>`; text→_text, int4→_int4. Map the common cases used here.
  const elemUdt: Record<string, string> = {
    text: 'text',
    integer: 'int4',
    int: 'int4',
    bigint: 'int8',
  };
  return `_${elemUdt[elem] ?? elem}`;
}

/**
 * Reconstruct a Drizzle `sql` fragment (queryChunks) to a flat SQL string: array chunks carry raw SQL
 * literals (`.value[0]`), string chunks are column names, column objects carry `.name`. Used for both
 * expression-index bodies (`lower(slug)`) and partial-index WHERE predicates (`deleted_at is null`).
 */
function flattenSql(frag: unknown): string {
  const chunks = (frag as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return '';
  let out = '';
  for (const ch of chunks) {
    if (Array.isArray((ch as { value?: unknown[] })?.value)) {
      out += (ch as { value: unknown[] }).value.join('');
    } else if (typeof ch === 'string') {
      out += ch;
    } else if (typeof (ch as { name?: string })?.name === 'string') {
      out += (ch as { name: string }).name;
    }
  }
  return out;
}

/**
 * Canonicalize a default expression (from either schema.ts or the live column_default) for comparison:
 * lowercase, strip a `::type` cast suffix, strip surrounding single quotes, collapse whitespace.
 *   live `'api_key'::text` → `api_key`; live `'{}'::text[]` → `{}`; live `'0'::numeric` → `0`;
 *   live `now()` → `now()`; `false` → `false`.
 */
function canonDefault(raw: string): string {
  let s = raw.trim();
  // Strip a trailing ::type (or ::type[]) cast, e.g. 'api_key'::text, '{}'::text[], '0'::numeric.
  s = s.replace(/::["\w ]+(?:\[\])?$/i, '');
  s = s.trim();
  // Strip one layer of surrounding single quotes.
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) s = s.slice(1, -1);
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Render schema.ts's declared default to a comparable expression string. */
function expectedDefault(col: {
  default?: unknown;
  defaultFn?: unknown;
  hasDefault?: boolean;
}): string | null {
  if (!col.hasDefault) return null;
  const d = col.default;
  if (d === undefined && col.defaultFn) return null; // runtime fn default (none in core schema) — skip
  if (d === null || d === undefined) return null;
  // An sql`...` default (gen_random_uuid(), now()).
  if (typeof d === 'object' && 'queryChunks' in (d as object)) return flattenSql(d);
  if (typeof d === 'boolean') return String(d);
  if (typeof d === 'number') return String(d);
  if (Array.isArray(d)) return `{${d.join(',')}}`; // text[] default [] → {}
  if (typeof d === 'string') return d;
  return String(d);
}

const sql = postgres(url, { max: 1 });

async function main(): Promise<void> {
  for (const table of CORE_PLATFORM_TABLES) {
    const name = getTableName(table);
    const cfg = getTableConfig(table);

    // --- table presence ---
    const present = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}`;
    if ((present[0]?.c ?? 0) !== 1) {
      fail(`table "${name}" is MISSING from the migrated DB (schema.ts declares it).`);
      continue;
    }

    // --- columns: name + type + nullability + DEFAULT + array element type (both directions) ---
    const liveCols = await sql<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        udt_name: string;
      }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${name}`;
    const liveByName = new Map(liveCols.map((c) => [c.column_name, c]));
    const expectedNames = new Set(cfg.columns.map((c) => c.name));

    for (const col of cfg.columns) {
      const live = liveByName.get(col.name);
      if (!live) {
        fail(`"${name}".${col.name} is MISSING (schema.ts declares ${col.getSQLType()}).`);
        continue;
      }
      const expType = normType(col.getSQLType());
      const gotType = normType(live.data_type);
      if (expType !== gotType) {
        fail(
          `"${name}".${col.name} TYPE drift: schema.ts=${col.getSQLType()} (→${expType}) but DB=${live.data_type} (→${gotType}).`,
        );
      }
      // Array element type (e.g. text[] → udt _text). Only when the declared type is an array.
      const expUdt = expectedArrayUdt(col.getSQLType());
      if (expUdt && live.udt_name.toLowerCase() !== expUdt) {
        fail(
          `"${name}".${col.name} ARRAY-ELEMENT drift: schema.ts=${col.getSQLType()} (expects udt ${expUdt}) but DB udt=${live.udt_name}.`,
        );
      }
      const expNullable = !col.notNull;
      const gotNullable = live.is_nullable === 'YES';
      if (expNullable !== gotNullable) {
        fail(
          `"${name}".${col.name} NULLABILITY drift: schema.ts notNull=${col.notNull} but DB is_nullable=${live.is_nullable}.`,
        );
      }
      // DEFAULT: compare the canonicalized expected vs live column_default. Both presence and value.
      const expDef = expectedDefault(col as unknown as { default?: unknown; hasDefault?: boolean });
      const liveDef = live.column_default;
      if (expDef !== null && liveDef === null) {
        fail(`"${name}".${col.name} DEFAULT drift: schema.ts=${expDef} but DB has NO default.`);
      } else if (expDef === null && liveDef !== null) {
        fail(`"${name}".${col.name} DEFAULT drift: schema.ts has NO default but DB=${liveDef}.`);
      } else if (expDef !== null && liveDef !== null) {
        const e = canonDefault(expDef);
        const g = canonDefault(liveDef);
        if (e !== g) {
          fail(
            `"${name}".${col.name} DEFAULT drift: schema.ts=${expDef} (→${e}) but DB=${liveDef} (→${g}).`,
          );
        }
      }
    }
    // A column in the DB that schema.ts does NOT declare is also drift (the chain over-created).
    for (const live of liveCols) {
      if (!expectedNames.has(live.column_name)) {
        fail(`"${name}".${live.column_name} exists in the DB but is NOT declared in schema.ts.`);
      }
    }

    // --- PRIMARY KEY: presence + exact ORDERED column list (single-col + composite) ---
    const expectedPkCols: string[] = (() => {
      if (cfg.primaryKeys.length > 0) {
        // Composite PK (e.g. oidc_models (model, id)).
        return cfg.primaryKeys[0]?.columns.map((c) => c.name) ?? [];
      }
      const single = cfg.columns.filter((c) => (c as { primary?: boolean }).primary);
      return single.map((c) => c.name);
    })();
    // Live PK columns in ordinal (key) order.
    const livePk = await sql<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary AND n.nspname = 'public' AND c.relname = ${name}
      ORDER BY array_position(i.indkey, a.attnum)`;
    const livePkCols = livePk.map((r) => r.column_name);
    if (expectedPkCols.length === 0 && livePkCols.length > 0) {
      fail(
        `"${name}" has a PRIMARY KEY (${livePkCols.join(', ')}) the schema.ts table does not declare.`,
      );
    } else if (expectedPkCols.join(',') !== livePkCols.join(',')) {
      fail(
        `"${name}" PRIMARY KEY drift: schema.ts=(${expectedPkCols.join(', ')}) but DB=(${livePkCols.join(', ')}).`,
      );
    }

    // --- foreign keys: target table + ON DELETE (both directions) ---
    const liveFks = await sql<
      { conname: string; def: string }[]
    >`SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE contype = 'f' AND conrelid = ${`public.${name}`}::regclass`;
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const refTable = getTableName(ref.foreignTable);
      const localCols = ref.columns.map((c) => c.name);
      const localColsLabel = localCols.join(', ');
      const onDelete = (fk.onDelete ?? 'no action').toLowerCase();
      // pg_get_constraintdef emits the local columns UNQUOTED unless they need quoting, e.g.
      // `FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE`. Match on a quote-insensitive
      // local-column list AND the referenced table, so the matcher tracks the def format robustly.
      const colsPattern = localCols.map((c) => `"?${c}"?`).join(',\\s*');
      const match = liveFks.find(
        (l) =>
          new RegExp(`FOREIGN KEY \\(${colsPattern}\\)`, 'i').test(l.def) &&
          new RegExp(`REFERENCES\\s+"?${refTable}"?\\s*\\(`, 'i').test(l.def),
      );
      if (!match) {
        fail(
          `"${name}" FK on (${localColsLabel}) → ${refTable} is MISSING in the migrated DB. Live FKs: ${liveFks
            .map((l) => l.def)
            .join(' | ')}`,
        );
        continue;
      }
      const liveOnDelete = /ON DELETE CASCADE/i.test(match.def)
        ? 'cascade'
        : /ON DELETE SET NULL/i.test(match.def)
          ? 'set null'
          : /ON DELETE RESTRICT/i.test(match.def)
            ? 'restrict'
            : 'no action';
      if (liveOnDelete !== onDelete) {
        fail(
          `"${name}" FK on (${localColsLabel}) ON DELETE drift: schema.ts=${onDelete} but DB=${liveOnDelete} (${match.def}).`,
        );
      }
    }
    // Reverse: an FK in the DB not declared in schema.ts is drift (chain over-created).
    if (liveFks.length > cfg.foreignKeys.length) {
      fail(
        `"${name}" has ${liveFks.length} FK(s) in the DB but schema.ts declares ${cfg.foreignKeys.length} (extra/undeclared FK). Live: ${liveFks
          .map((l) => l.conname)
          .join(', ')}`,
      );
    }

    // --- indexes: name + uniqueness + ORDERED columns + partial-WHERE + expression body ---
    const liveIdx = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${name}`;
    const liveIdxByName = new Map(liveIdx.map((i) => [i.indexname, i]));
    // The PK-backing index (named <table>_pkey by default, but a composite primaryKey() can be named
    // e.g. oidc_models_model_id_pk) is the PRIMARY KEY (asserted above), not a declared index — fetch
    // its actual name from pg_index so the reverse check excludes it accurately (not just by convention).
    const pkIdx = await sql<{ indexname: string }[]>`
      SELECT c2.relname AS indexname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class c2 ON c2.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary AND n.nspname = 'public' AND c.relname = ${name}`;
    const pkIdxNames = new Set(pkIdx.map((r) => r.indexname));
    const declaredIdxNames = new Set(cfg.indexes.map((ix) => ix.config.name));
    for (const ix of cfg.indexes) {
      const ixName = ix.config.name;
      const live = liveIdxByName.get(ixName);
      if (!live) {
        fail(`"${name}" index "${ixName}" is MISSING in the migrated DB (schema.ts declares it).`);
        continue;
      }
      const def = live.indexdef;
      const expUnique = !!ix.config.unique;
      const gotUnique = /CREATE UNIQUE INDEX/i.test(def);
      if (expUnique !== gotUnique) {
        fail(
          `"${name}" index "${ixName}" UNIQUENESS drift: schema.ts unique=${expUnique} but DB unique=${gotUnique} (${def}).`,
        );
      }
      // Ordered column / expression list: extract the parenthesized `USING btree (...)` body and
      // compare token-by-token to the declared ORDERED columns (plain name) / expression body.
      const bodyMatch = /USING\s+\w+\s*\(([\s\S]*?)\)(?:\s+WHERE|\s*$)/i.exec(def);
      const liveBody = (bodyMatch?.[1] ?? '').trim();
      const liveTokens = liveBody
        .split(',')
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '));
      const expTokens = ix.config.columns.map((c) => {
        const named = (c as { name?: string }).name;
        if (named) return named.toLowerCase();
        // Expression column (lower(slug)) — reconstruct from its sql chunks.
        return flattenSql((c as { sql?: SQL }).sql ?? c)
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      });
      if (expTokens.join(' | ') !== liveTokens.join(' | ')) {
        fail(
          `"${name}" index "${ixName}" COLUMN/EXPR drift (ordered): schema.ts=[${expTokens.join(', ')}] but DB=[${liveTokens.join(', ')}] (${def}).`,
        );
      }
      // Partial-index WHERE predicate.
      const expWhere = ix.config.where ? flattenSql(ix.config.where) : null;
      const liveWhereMatch = /\bWHERE\s+(.+)$/i.exec(def);
      const liveWhere = liveWhereMatch?.[1] ?? null;
      const canonWhere = (w: string | null) =>
        w === null ? null : w.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
      const ew = canonWhere(expWhere);
      const lw = canonWhere(liveWhere);
      if (ew !== lw) {
        fail(
          `"${name}" index "${ixName}" partial-WHERE drift: schema.ts=${ew ?? '(none)'} but DB=${lw ?? '(none)'} (${def}).`,
        );
      }
    }
    // Reverse: a non-PK index in the DB not declared in schema.ts is drift.
    for (const live of liveIdx) {
      if (pkIdxNames.has(live.indexname)) continue; // the PK-backing index (asserted separately)
      if (!declaredIdxNames.has(live.indexname)) {
        fail(
          `"${name}" index "${live.indexname}" exists in the DB but is NOT declared in schema.ts (${live.indexdef}).`,
        );
      }
    }
  }

  await sql.end({ timeout: 5 });

  if (failures.length > 0) {
    console.error(`MIGRATE-CLEAN: FAIL — ${failures.length} structural drift finding(s):`);
    for (const f of failures) console.error(`    ${f}`);
    process.exit(1);
  }
  console.log(
    `  ok: complete structural cross-check PASSED for all ${CORE_PLATFORM_TABLES.length} core platform tables ` +
      `(columns incl. type/nullability/DEFAULT/array-elem, PRIMARY KEYs, FKs both directions, indexes incl. ordered cols/partial-WHERE/expression body both directions).`,
  );
}

main().catch(async (err) => {
  console.error('MIGRATE-CLEAN: FAIL — structural cross-check threw:', err);
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
