/**
 * The delta-diff core — a pure `StoreSpec[]` → forward-migration generator.
 *
 * `generateProductSql` answers "materialize this spec on a FRESH DB" (CREATE-only). This module
 * answers the UPDATE question: given the PRIOR declared stores and the NEW declared stores, what is
 * the deterministic forward migration that evolves the existing database from old → new? Additive
 * changes (new tables, new nullable columns, new indexes/FKs, relaxed NOT NULL) flow automatically;
 * DESTRUCTIVE changes (dropped tables/columns, tightened types/NOT NULL, dropped indexes/FKs, a
 * non-nullable ADD with no default) are emitted honestly AND paired with a machine-proposed
 * allowlist so the deploy gate (`scanMigrationSql`) can, after a HUMAN review, let them through.
 *
 * LOAD-BEARING INVARIANT (the whole point of the slice): every proposed `AllowlistEntry.match` is
 * BYTE-FAITHFUL to what `scanMigrationSql` computes for that statement — the SAME whitespace-collapse
 * + trailing-`;` strip the scan's MIG-3 matcher uses (`normalizeStatementForMatch` below mirrors the
 * scan's `collapse` + `stripTerminator`). A drift of a single space would re-BLOCK a reviewed change
 * at deploy time, collapsing the update UX — so a test drives the EXACT emitted statement through the
 * REAL scan: BLOCKED with an empty allowlist, PASSES with this module's `proposedAllowlist`.
 *
 * PURE / DETERMINISTIC: no DB access, no `deploy.ts` import, no product vocabulary. `diffProductStores`
 * is a total function of its two `StoreSpec[]` inputs; `nextMigrationFilename` is a total function of
 * an existing-filenames list. Identifiers are re-asserted safe before any verbatim interpolation
 * (TEN-1 defense-in-depth), exactly like the generator.
 *
 * WHAT A SPEC DIFF CANNOT EXPRESS (honest limits, surfaced in `notes`):
 *  - RENAMES are NOT inferable. A store/column that changed name is indistinguishable from a drop of
 *    the old + an add of the new, so this module emits DROP + ADD (which does NOT preserve data). A
 *    true rename (`ALTER … RENAME …`, data-preserving) must be a hand-authored, separately-reviewed
 *    migration.
 *  - A non-nullable ADD COLUMN has no author-supplied DEFAULT in the grammar — on a populated table it
 *    fails; expand-contract (add nullable → backfill → tighten) is the authoring discipline.
 *  - A column TYPE change carries a `USING` cast only where universally safe (→ text); otherwise the
 *    implicit assignment cast is emitted and the reviewer must supply a `USING` if the data needs it.
 */
import {
  assertSafeIdentifier,
  type ColumnType,
  type StoreColumn,
  type StoreForeignKey,
  type StoreSpec,
} from '@rayspec/spec';
import {
  emitFkSql,
  emitStoreSql,
  fkConstraintName,
  generateProductSql,
  type StoreConflictKeys,
  topoSortStoresByFk,
} from './generated/generate-product-sql.js';
import { INJECTED_AFTER } from './generated/injected-columns.js';
import type { AllowlistEntry, DestructiveKind } from './migration-scan.js';
import { scanMigrationSql } from './migration-scan.js';

/** The Drizzle statement-breakpoint marker (matches `generateProductSql`; stripped by the applier). */
const STATEMENT_BREAKPOINT = '\n--> statement-breakpoint\n';

/** Map the closed ColumnType vocabulary to its Postgres column type (mirrors the generator). */
const PG_TYPE: Record<ColumnType, string> = {
  text: 'text',
  uuid: 'uuid',
  timestamp: 'timestamp with time zone',
  integer: 'integer',
  boolean: 'boolean',
  jsonb: 'jsonb',
};

/** Per-statement classification of the diff output (destructive kinds mapped to the scan's vocabulary). */
export interface StatementFinding {
  /** The forward-migration statement (no trailing `;`), exactly as it appears in `migrationSql`. */
  readonly sql: string;
  /**
   * The destructive kinds the REAL `scanMigrationSql` flags for this statement — empty ⇒ ADDITIVE
   * (no gate finding). Derived from the actual scan of `migrationSql`, so it can never claim additive
   * for a statement the gate would block.
   */
  readonly destructiveKinds: DestructiveKind[];
}

/** Options for {@link diffProductStores} (reserved + minimal — `label` annotates the delta header). */
export interface DiffProductStoresOptions {
  /**
   * A short human label woven into the delta migration's header comment (informational only — it is a
   * SQL comment, never scanned). Sanitized to a safe slug; defaults to `update`.
   */
  readonly label?: string;
  /**
   * The NEW stores' per-store conflict-key carve-out (see {@link StoreConflictKeys}) — the
   * index shape to EMIT. A unique column IN its store's set → single-column `(col)` index (the durable
   * `ON CONFLICT` target); a unique column NOT in it → tenant-scoped compound `(tenant_id, col)`. Secure
   * default (omitted) = compound. Drives every added-table CREATE and every surviving-table
   * CREATE UNIQUE INDEX.
   */
  readonly newConflictKeys?: StoreConflictKeys;
  /**
   * The OLD (live) stores' per-store conflict-key carve-out — the shape the EXISTING indexes have. Used
   * ONLY to detect a SURVIVING `unique: true` column whose carve-out class CHANGED (single↔compound):
   * when its old-set membership ≠ its new-set membership the live index columns differ, so the diff emits
   * a DROP + CREATE REINDEX pair (the index NAME is stable, so it is a genuine reindex). Omitted ⇒ assume
   * the old class equals the new (no reindex) — correct for a first materialization and for any caller
   * that never changes a column's durable-conflict-key status.
   */
  readonly oldConflictKeys?: StoreConflictKeys;
  /**
   * When true, every SURVIVING table also gets an ADDITIVE, IDEMPOTENT backfill of the
   * injected tenancy/GDPR columns (`ADD COLUMN IF NOT EXISTS` for each nullable injected column +
   * `CREATE UNIQUE INDEX IF NOT EXISTS` for the idempotency index). This reconciles a store that was
   * MATERIALIZED before an injected column existed (e.g. an older deployment that lacks
   * `created_by`/`idempotency_key`): the spec diff is BLIND to injected columns (they are constant, not
   * declared), so without this a platform-version bump would leave an old store permanently `drifted`
   * with no reconciling migration. `IF NOT EXISTS` makes it a genuine no-op on an already-current store,
   * so it is safe to emit unconditionally on the update path. DEFAULT off ⇒ `diff(old, old)` stays EMPTY
   * (the NO-OP invariant) — the `rayspec plan` update path opts in; the pure golden tests do not.
   */
  readonly backfillInjectedColumns?: boolean;
}

/** The structured result of diffing two declared-store sets into a forward migration. */
export interface StoreDiffResult {
  /**
   * The ordered forward-migration statements (each WITHOUT a trailing `;`), byte-stable for a given
   * (old, new) pair. Order: added tables → additive alters on surviving tables → destructive alters
   * (incl. FK REPLACE drop+add adjacent pairs — see below) → dropped tables (most destructive last).
   * Empty ⇒ no schema change.
   */
  readonly statements: string[];
  /**
   * The ready-to-scan / ready-to-apply migration SQL (header + `statements` joined with Drizzle
   * `--> statement-breakpoint` markers, each terminated by `;`). For a first materialization
   * (`oldStores` empty, purely additive) this equals `generateProductSql(newStores)` BYTE-FOR-BYTE.
   * Empty string ⇒ no schema change.
   */
  readonly migrationSql: string;
  /** Per-statement destructive/additive classification (from the REAL scan of `migrationSql`). */
  readonly findings: StatementFinding[];
  /**
   * Machine-PROPOSED reviewed-allowlist entries — one per (kind, destructive statement) — whose
   * `match` is byte-faithful to the scan gate. MUST be human-reviewed before deploy: this is a
   * proposal that makes the reviewed-update path expressible, NOT self-approval. Empty ⇒ the migration
   * is purely additive (the gate passes with no allowlist).
   */
  readonly proposedAllowlist: AllowlistEntry[];
  /** True iff the migration carries at least one destructive statement (a reviewed allowlist is required). */
  readonly destructive: boolean;
  /** Honest caveats about what this diff could NOT express safely (renames, no-default NN, USING casts, drop ordering). */
  readonly notes: string[];
}

// ---------------------------------------------------------------------------------------
// Statement builders (Drizzle DDL style — identical quoting/keywords to the generator so the
// destructive scan tokenizes them exactly as it does hand-authored/generated migrations).
// ---------------------------------------------------------------------------------------

/** ADD COLUMN. Non-nullable with no default is emitted honestly (the scan flags it for review). */
function addColumnSql(table: string, col: StoreColumn): string {
  const nn = col.nullable ? '' : ' NOT NULL';
  return `ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${PG_TYPE[col.type]}${nn}`;
}

/** DROP COLUMN (destructive — the scan flags `drop-column`). */
function dropColumnSql(table: string, column: string): string {
  return `ALTER TABLE "${table}" DROP COLUMN "${column}"`;
}

/**
 * A `USING` cast is emitted ONLY where universally safe regardless of stored data: any type → text
 * (the assignment cast to text is total). Every other target returns `null` — the implicit cast is
 * emitted and the reviewer must supply a `USING` if the data needs one (surfaced in `notes`).
 */
function safeUsingCast(column: string, newType: ColumnType): string | null {
  return newType === 'text' ? `"${column}"::${PG_TYPE[newType]}` : null;
}

/** ALTER COLUMN ... SET DATA TYPE (destructive — `using-cast` if a USING is safe, else `type-change-no-using`). */
function alterColumnTypeSql(table: string, column: string, newType: ColumnType): string {
  const using = safeUsingCast(column, newType);
  const base = `ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DATA TYPE ${PG_TYPE[newType]}`;
  return using ? `${base} USING ${using}` : base;
}

/** ALTER COLUMN ... SET NOT NULL (destructive — tightening; fails if any existing row is NULL). */
function setNotNullSql(table: string, column: string): string {
  return `ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`;
}

/** ALTER COLUMN ... DROP NOT NULL (additive — relaxing; always safe). */
function dropNotNullSql(table: string, column: string): string {
  return `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`;
}

/**
 * CREATE UNIQUE INDEX (additive to the scan; NB it can still fail on duplicate data — noted). `compound`
 * → tenant-scoped `("tenant_id", col)` (a NON-key `unique: true` column); otherwise single `(col)` (a
 * conflict-key column — the durable `ON CONFLICT` target). The index NAME is unchanged in both cases, so
 * `dropUniqueIndexSql` (name-keyed) and drift-detect key off the stable name.
 */
function createUniqueIndexSql(table: string, column: string, compound: boolean): string {
  const indexColumns = compound ? `"tenant_id", "${column}"` : `"${column}"`;
  return `CREATE UNIQUE INDEX "${table}_${column}_unique" ON "${table}" USING btree (${indexColumns})`;
}

/** DROP INDEX for a column that lost `unique` (destructive — the scan flags `drop-index`). */
function dropUniqueIndexSql(table: string, column: string): string {
  return `DROP INDEX "${table}_${column}_unique"`;
}

/**
 * ADD CONSTRAINT for a product→product FK (additive). Delegates to the generator's `emitFkSql` so the
 * add-on-update path is BYTE-IDENTICAL to a first materialization — including the tenant-scoped compound
 * form for a business-key FK (`referencesColumn` set). Single source of truth for the FK DDL.
 */
function addFkSql(table: string, fk: StoreForeignKey): string {
  return emitFkSql(table, fk);
}

/**
 * DROP CONSTRAINT for a removed/changed FK (destructive — the scan flags `drop-constraint`). The
 * constraint NAME comes from the shared `fkConstraintName`, so the DROP names EXACTLY what a prior ADD
 * created (id-target `_id_fk` OR business-key `_<refcol>_fk`) — a reviewed FK change re-blocks nowhere.
 */
function dropFkSql(table: string, fk: StoreForeignKey): string {
  return `ALTER TABLE "${table}" DROP CONSTRAINT "${fkConstraintName(table, fk)}"`;
}

/** DROP TABLE for a removed store (destructive — the scan flags `drop-table`). */
function dropTableSql(table: string): string {
  return `DROP TABLE "${table}"`;
}

/**
 * The ADDITIVE, IDEMPOTENT injected-column backfill for a surviving table. Emits
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS` ONLY for injected columns marked `backfill` (added AFTER the
 * first release — `created_by` + `idempotency_key`; a nullable ADD is additive, the scan
 * never flags it, and `IF NOT EXISTS` makes it a no-op when the column already exists) + a
 * `CREATE UNIQUE INDEX IF NOT EXISTS` for each injected column carrying a `uniqueIndex` marker (the
 * tenant-scoped idempotency index). Reconciles a store materialized before those columns existed without
 * ever failing on an already-current one. The always-present injected columns (id/tenant_id/created_at/
 * deleted_at/retention_days/region) are NOT re-emitted — every materialized store already carries them,
 * so `rayspec plan --against` on an unchanged spec no longer prints spurious backfill DDL for them.
 */
function injectedBackfillSql(table: string): string[] {
  const out: string[] = [];
  for (const inj of INJECTED_AFTER) {
    if (!inj.backfill) continue; // only columns added after the first release need a surviving-table ADD
    out.push(
      `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${inj.sqlName}" ${PG_TYPE[inj.type]}`,
    );
  }
  for (const inj of INJECTED_AFTER) {
    if (inj.uniqueIndex === 'tenant-scoped') {
      out.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_${inj.sqlName}_unique" ON "${table}" ` +
          `USING btree ("tenant_id", "${inj.sqlName}")`,
      );
    }
  }
  return out;
}

/**
 * Reject duplicate store names within one input array (SE-2, TEN-1-style input guard). A diff over
 * two stores that share a name is ambiguous (which one is the survivor?) — fail closed rather than
 * silently pick the last-seen. Consistent with the module's bypass-the-linter defense-in-depth posture.
 */
function assertUniqueStoreNames(stores: readonly StoreSpec[], which: string): void {
  const seen = new Set<string>();
  for (const s of stores) {
    if (seen.has(s.name)) {
      throw new Error(
        `diffProductStores: duplicate store name '${s.name}' in ${which} (store names must be unique).`,
      );
    }
    seen.add(s.name);
  }
}

/** Re-assert every identifier we interpolate for a store is safe (TEN-1 defense-in-depth). */
function assertStoreIdentifiers(store: StoreSpec): void {
  assertSafeIdentifier(store.name, `store name '${store.name}'`);
  for (const col of store.columns) {
    assertSafeIdentifier(col.name, `column '${store.name}.${col.name}'`);
  }
  for (const fk of store.foreignKeys) {
    assertSafeIdentifier(fk.column, `FK column '${store.name}.${fk.column}'`);
    assertSafeIdentifier(fk.references, `FK reference '${store.name} -> ${fk.references}'`);
    if (fk.referencesColumn !== undefined) {
      assertSafeIdentifier(
        fk.referencesColumn,
        `FK referencesColumn '${store.name} -> ${fk.references}.${fk.referencesColumn}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// Byte-faithful allowlist-match normalization (mirrors migration-scan.ts collapse + stripTerminator).
// ---------------------------------------------------------------------------------------

/**
 * Normalize a statement to the EXACT form the scan's MIG-3 matcher compares against: collapse runs of
 * whitespace (incl. newlines) to single spaces, trim, and strip a single trailing `;`. This MUST stay
 * bit-identical to `scanMigrationSql`'s `collapse(...)` + `stripTerminator(...)` — a proposed
 * `AllowlistEntry.match` that deviates re-BLOCKS the reviewed statement at deploy. A shadow-mutation
 * test weakens this function and asserts the "passes-with-proposed-allowlist" proof goes RED.
 */
function normalizeStatementForMatch(statement: string): string {
  return statement
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*;\s*$/, '')
    .trim();
}

// ---------------------------------------------------------------------------------------
// The diff.
// ---------------------------------------------------------------------------------------

/** Index a column list by name (author BUSINESS columns only — injected tenancy columns are constant). */
function columnsByName(store: StoreSpec): Map<string, StoreColumn> {
  return new Map(store.columns.map((c) => [c.name, c]));
}

/** Index a store's FKs by their local column (the key drift-detect + the FK name key off). */
function fksByColumn(store: StoreSpec): Map<string, StoreForeignKey> {
  return new Map(store.foreignKeys.map((fk) => [fk.column, fk]));
}

/**
 * Do two FKs describe the SAME constraint (same target store + same referenced column + same onDelete)?
 * `referencesColumn` is part of the identity: switching an FK between the injected `id` and a named
 * business key (or between two business keys) changes the constraint SHAPE + NAME, so it must emit a
 * DROP + ADD REPLACE — comparing it here is what makes that reachable. `undefined === undefined` holds,
 * so two id-target FKs still compare equal (no spurious REPLACE for an unchanged FK).
 */
function fkEqual(a: StoreForeignKey, b: StoreForeignKey): boolean {
  return (
    a.references === b.references &&
    a.onDelete === b.onDelete &&
    a.referencesColumn === b.referencesColumn
  );
}

/** The forward statements for ONE surviving table, split into additive-first / destructive-last buckets. */
interface SurvivingTablePlan {
  additive: string[];
  destructive: string[];
  notes: string[];
}

function planSurvivingTable(
  oldStore: StoreSpec,
  newStore: StoreSpec,
  newConflictKeys?: ReadonlySet<string>,
  oldConflictKeys?: ReadonlySet<string>,
  backfillInjected = false,
): SurvivingTablePlan {
  const table = newStore.name;
  const oldCols = columnsByName(oldStore);
  const newCols = columnsByName(newStore);
  const oldFks = fksByColumn(oldStore);
  const newFks = fksByColumn(newStore);

  const additive: string[] = [];
  const destructive: string[] = [];
  const notes: string[] = [];

  // --- columns: additions (new-column order preserves declared order) ---
  for (const col of newStore.columns) {
    if (oldCols.has(col.name)) continue;
    additive.push(addColumnSql(table, col)); // may be scan-destructive when NOT NULL w/ no default
    // A brand-new `unique` column also needs its unique index (a NEW column holds no duplicate data,
    // so the CREATE UNIQUE INDEX is additive — no de-dup caveat, unlike a survivor gaining uniqueness).
    if (col.unique)
      additive.push(
        createUniqueIndexSql(table, col.name, !(newConflictKeys?.has(col.name) ?? false)),
      );
    if (!col.nullable) {
      notes.push(
        `added non-nullable column "${table}"."${col.name}" has no default — it FAILS on a ` +
          'populated table; add it nullable, backfill, then tighten (expand-contract).',
      );
    }
  }

  // --- columns: removals (declared-order of the OLD store) ---
  for (const col of oldStore.columns) {
    if (!newCols.has(col.name)) destructive.push(dropColumnSql(table, col.name));
  }

  // --- columns: type / nullability / uniqueness changes on surviving columns ---
  for (const col of newStore.columns) {
    const prev = oldCols.get(col.name);
    if (!prev) continue;
    if (prev.type !== col.type) {
      destructive.push(alterColumnTypeSql(table, col.name, col.type));
      if (safeUsingCast(col.name, col.type) === null) {
        notes.push(
          `column type change "${table}"."${col.name}" (${prev.type} → ${col.type}) is emitted ` +
            'without a USING clause (relying on the implicit assignment cast) — if existing data ' +
            'cannot be cast, supply a reviewed USING expression in a hand-edited migration.',
        );
      }
    }
    if (prev.nullable !== col.nullable) {
      if (col.nullable) {
        additive.push(dropNotNullSql(table, col.name)); // relaxing — safe
      } else {
        destructive.push(setNotNullSql(table, col.name)); // tightening — fails on existing NULLs
        notes.push(
          `column "${table}"."${col.name}" tightened to NOT NULL — this FAILS if any existing row ` +
            'holds NULL; backfill first.',
        );
      }
    }
    const newIsKey = newConflictKeys?.has(col.name) ?? false;
    const oldIsKey = oldConflictKeys?.has(col.name) ?? false;
    if (prev.unique !== col.unique) {
      if (col.unique) {
        additive.push(createUniqueIndexSql(table, col.name, !newIsKey));
        notes.push(
          `unique index added on "${table}"."${col.name}" — CREATE UNIQUE INDEX FAILS if existing ` +
            'rows hold duplicate values; de-duplicate first.',
        );
      } else {
        destructive.push(dropUniqueIndexSql(table, col.name));
      }
    } else if (col.unique && oldIsKey !== newIsKey) {
      // The column STAYS `unique: true` but its durable-conflict-key status changed, so its live index
      // columns change (single `(col)` ↔ tenant-scoped compound `(tenant_id, col)`). The index NAME is
      // stable, so this is a genuine REINDEX: DROP the old-shape index + CREATE the new-shape one,
      // ADJACENT in the DESTRUCTIVE segment (DROP first — an ADD before the DROP of the same-named index
      // would collide on a real DB), mirroring the FK-replace pattern below. Threading `oldConflictKeys`
      // is what makes this reachable: without the OLD carve-out class the diff cannot see the change and
      // silently leaves the wrong index shape (the update/diff blindness this closes).
      destructive.push(
        dropUniqueIndexSql(table, col.name),
        createUniqueIndexSql(table, col.name, !newIsKey),
      );
      notes.push(
        `unique index on "${table}"."${col.name}" is REINDEXED (` +
          `${oldIsKey ? 'single-column (col)' : 'tenant-scoped compound (tenant_id, col)'} → ` +
          `${newIsKey ? 'single-column (col)' : 'tenant-scoped compound (tenant_id, col)'}) because its ` +
          'durable-conflict-key status changed — DROP + CREATE; the CREATE FAILS if existing rows now ' +
          'violate the new uniqueness scope.',
      );
    }
  }

  // --- foreign keys: additions / removals / changes ---
  // A pure ADD is additive; a pure REMOVE is destructive. A CHANGE (onDelete and/or target) is a
  // drop-then-add REPLACE emitted as an ADJACENT pair in the DESTRUCTIVE segment: for an onDelete-only
  // change the old and new constraint NAMES are byte-identical (the name encodes no policy), so an ADD
  // before the DROP fails 42710 duplicate_object on a real DB — the pair MUST be drop-then-add.
  for (const fk of newStore.foreignKeys) {
    const prev = oldFks.get(fk.column);
    if (!prev) {
      additive.push(addFkSql(table, fk)); // pure addition — additive
    } else if (!fkEqual(prev, fk)) {
      destructive.push(dropFkSql(table, prev), addFkSql(table, fk)); // REPLACE — adjacent, drop first
    }
  }
  for (const fk of oldStore.foreignKeys) {
    if (!newFks.has(fk.column)) destructive.push(dropFkSql(table, fk)); // pure removal — destructive
  }

  // Idempotent injected-column backfill (additive; no-op when already present). Emitted
  // LAST in the additive segment so a real business change reads first, then the injected reconciliation.
  if (backfillInjected) additive.push(...injectedBackfillSql(table));

  return { additive, destructive, notes };
}

/**
 * Diff two declared-store sets into a deterministic forward migration. See {@link StoreDiffResult}.
 * Pure: a total function of `(oldStores, newStores)` — no DB, no I/O, no product vocabulary.
 */
export function diffProductStores(
  oldStores: readonly StoreSpec[],
  newStores: readonly StoreSpec[],
  opts: DiffProductStoresOptions = {},
): StoreDiffResult {
  assertUniqueStoreNames(oldStores, 'oldStores');
  assertUniqueStoreNames(newStores, 'newStores');
  for (const s of oldStores) assertStoreIdentifiers(s);
  for (const s of newStores) assertStoreIdentifiers(s);

  const oldByName = new Map(oldStores.map((s) => [s.name, s]));
  const newByName = new Map(newStores.map((s) => [s.name, s]));

  const addedStores = newStores.filter((s) => !oldByName.has(s.name)); // newStores order
  const removedStores = oldStores.filter((s) => !newByName.has(s.name)); // oldStores order
  const survivingStores = newStores.filter((s) => oldByName.has(s.name)); // newStores order

  const notes: string[] = [];
  const newConflictKeys = opts.newConflictKeys;
  const oldConflictKeys = opts.oldConflictKeys;

  // Phase A — added tables (byte-identical CREATE path: injected tenancy cols + FK + indexes). The
  // ADDED set is FK-topo-sorted so a parent table's CREATE precedes any added child that references it
  // (a child declared before its parent would otherwise emit its FK REFERENCES before the parent CREATE
  // → 42P01 at apply). References to SURVIVING stores are out-of-set and ignored (they already exist).
  const addedStatements = topoSortStoresByFk(addedStores).flatMap((s) =>
    emitStoreSql(s, newConflictKeys?.get(s.name)),
  );

  // Phases B/C — surviving-table alters, split additive-first / destructive-last.
  const survivingAdditive: string[] = [];
  const survivingDestructive: string[] = [];
  for (const store of survivingStores) {
    const oldStore = oldByName.get(store.name);
    if (!oldStore) continue; // unreachable (survivingStores are in oldByName) — narrows the type
    const plan = planSurvivingTable(
      oldStore,
      store,
      newConflictKeys?.get(store.name),
      oldConflictKeys?.get(store.name),
      opts.backfillInjectedColumns ?? false,
    );
    survivingAdditive.push(...plan.additive);
    survivingDestructive.push(...plan.destructive);
    notes.push(...plan.notes);
  }

  // Phase D — dropped tables LAST, in REVERSE declared order so a child (declared after its parent)
  // is dropped before the parent it references (the common FK direction). Cross-table drop ordering
  // that a spec cannot express is surfaced as a note (below) and caught by shadow-apply downstream.
  const dropStatements = [...removedStores].reverse().map((s) => dropTableSql(s.name));

  const deltaStatements = [...survivingAdditive, ...survivingDestructive, ...dropStatements];
  const statements = [...addedStatements, ...deltaStatements];

  // --- rename caveat: a drop + an add of the SAME object kind is indistinguishable from a rename. ---
  const droppedColumns = survivingDestructive.some((s) => /\bDROP COLUMN\b/.test(s));
  const addedColumns = survivingAdditive.some((s) => /\bADD COLUMN\b/.test(s));
  if (removedStores.length > 0 && addedStores.length > 0) {
    notes.push(
      'a dropped table + an added table cannot be distinguished from a table RENAME — this diff ' +
        'emits DROP + CREATE (data is NOT migrated); a true rename must be a hand-authored ' +
        'ALTER TABLE … RENAME migration reviewed separately.',
    );
  }
  if (droppedColumns && addedColumns) {
    notes.push(
      'a dropped column + an added column cannot be distinguished from a column RENAME — this diff ' +
        'emits DROP + ADD (data is NOT migrated); a true rename must be a hand-authored ' +
        'ALTER TABLE … RENAME COLUMN migration reviewed separately.',
    );
  }
  if (removedStores.length > 0) {
    notes.push(
      'dropped tables are emitted last in reverse declared order — verify no SURVIVING foreign key ' +
        'still references a dropped table (Postgres will reject the DROP; shadow-apply catches it).',
    );
  }

  // --- assemble migrationSql (header choice preserves the generator byte-equality for first-materialize) ---
  const migrationSql = assembleMigrationSql(addedStores, deltaStatements, statements, opts);

  // --- classify + propose allowlist from the REAL scan of the exact emitted SQL (byte-fidelity source) ---
  const scan = scanMigrationSql(migrationSql, []);

  const kindsByStatement = new Map<string, DestructiveKind[]>();
  for (const f of scan.findings) {
    const key = normalizeStatementForMatch(f.text);
    const arr = kindsByStatement.get(key) ?? [];
    if (!arr.includes(f.kind)) arr.push(f.kind);
    kindsByStatement.set(key, arr);
  }
  const findings: StatementFinding[] = statements.map((s) => ({
    sql: s,
    destructiveKinds: kindsByStatement.get(normalizeStatementForMatch(s)) ?? [],
  }));

  const proposedAllowlist: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const f of scan.findings) {
    const match = normalizeStatementForMatch(f.text);
    const key = `${f.kind}::${match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposedAllowlist.push({
      kind: f.kind,
      match,
      reason:
        `MACHINE-PROPOSED by diffProductStores for a ${f.kind} change — REVIEW REQUIRED before ` +
        'deploy (this is not self-approval; a human must confirm the destructive operation).',
    });
  }

  return {
    statements,
    migrationSql,
    findings,
    proposedAllowlist,
    destructive: proposedAllowlist.length > 0,
    notes,
  };
}

/**
 * Assemble the migration SQL string. For a first materialization (purely additive, no delta
 * statements) this delegates to `generateProductSql(addedStores)` so the output is BYTE-IDENTICAL to
 * the CREATE-only generator (and `diffProductStores([], new).migrationSql === generateProductSql(new)`
 * holds exactly). A delta migration that carries destructive statements gets its OWN honest header
 * (the generator's header claims "purely additive", which would be a lie for a drop).
 */
function assembleMigrationSql(
  addedStores: readonly StoreSpec[],
  deltaStatements: readonly string[],
  allStatements: readonly string[],
  opts: DiffProductStoresOptions,
): string {
  if (allStatements.length === 0) return '';
  // Purely additive (only added tables, no surviving-table alters, no drops): identical to the
  // CREATE-only generator — including the first-materialization case `diffProductStores([], new)`.
  if (deltaStatements.length === 0)
    return generateProductSql(addedStores as StoreSpec[], opts.newConflictKeys);

  const label = sanitizeLabel(opts.label ?? 'update');
  const header = [
    `-- GENERATED delta migration (${label}) — review before applying (read the SQL).`,
    '-- Produced by @rayspec/db diffProductStores from prior → new validated `stores[]`.',
    '-- MAY contain DESTRUCTIVE statements (drops, tightening, type changes) — each needs a reviewed',
    '-- allowlist entry (see the machine-proposed allowlist) before the deploy gate will apply it.',
    '',
  ].join('\n');
  const body = allStatements.map((s) => `${s};`).join(STATEMENT_BREAKPOINT);
  return `${header}${body}`;
}

// ---------------------------------------------------------------------------------------
// Versioned migration naming (the append convention that replaces overwriting one `0000` file).
// ---------------------------------------------------------------------------------------

const MIGRATION_FILE_RE = /^(\d{4})_.*\.sql$/;
const MAX_MIGRATION_SEQUENCE = 9999;

/** Sanitize a free-text label into a safe migration-filename slug (`[a-z0-9_]`, non-empty, bounded). */
function sanitizeLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'update';
}

/**
 * The next versioned migration filename for a migrations directory — the APPEND convention that
 * replaces the old "overwrite one `0000_product_stores.sql`" behavior for UPDATES. Given the list of
 * existing filenames, returns `<NNNN>_<label>.sql` where `NNNN` = (max existing 4-digit sequence) + 1,
 * zero-padded. An EMPTY list returns `0000_…` (the first materialization); any list already containing
 * `0000_…` returns `0001_…` or higher, so an existing migration is NEVER overwritten.
 *
 * Pure: a total function of `(existing, label)` — the caller reads the directory (fs is I/O, kept out
 * of this pure module). Non-`NNNN_*.sql` entries (e.g. `meta/`) are ignored.
 */
export function nextMigrationFilename(existing: readonly string[], label = 'update'): string {
  let max = -1;
  for (const name of existing) {
    const m = MIGRATION_FILE_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = max + 1;
  if (next > MAX_MIGRATION_SEQUENCE) {
    throw new Error(`migration sequence exhausted (> ${MAX_MIGRATION_SEQUENCE})`);
  }
  return `${String(next).padStart(4, '0')}_${sanitizeLabel(label)}.sql`;
}
