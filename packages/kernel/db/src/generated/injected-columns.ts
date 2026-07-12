/**
 * The ONE canonical descriptor of the injected tenancy/GDPR columns.
 *
 * Every product table the generator materializes carries these 6 columns, matching schema.ts
 * EXACTLY (see journalSteps/runEvents — the tenant predicate + GDPR cascade/residency). Previously the
 * set was hard-coded in five places (INJECTED_COLUMN_NAMES, the TS emit, the SQL emit, the runtime
 * twin, drift's INJECTED_COLUMNS) and only two were meta-reconciled. This is the SINGLE SOURCE: it
 * produces the names, the TS builder source, the SQL DDL line, and the drift-introspection facts —
 * so a 7th-column change (or a type/nullability change) propagates to all consumers and cannot drift.
 *
 * A meta-test asserts these names equal `@rayspec/spec`'s `RESERVED_COLUMN_NAMES` (the spec lint
 * rejects an author business column colliding with one of them).
 */
import type { ColumnType } from '@rayspec/spec';

/** Where the column sits relative to the author's business columns (matches schema.ts order). */
export type InjectedPosition = 'before' | 'after';

export interface InjectedColumn {
  /** snake_case SQL name. */
  sqlName: string;
  /** camelCase TS property name (the drizzle const key). */
  tsName: string;
  /** The closed ColumnType (for the runtime twin + drift type-check). */
  type: ColumnType;
  /** Is this column nullable in Postgres? */
  nullable: boolean;
  /** The drizzle TS builder chain source (verbatim, matching schema.ts + Biome canonical wrap). */
  tsSource: string;
  /** The SQL column-definition line body (no leading tab; no trailing comma). */
  sqlDef: string;
  /** before = emitted before business columns; after = emitted after. */
  position: InjectedPosition;
  /** True for the tenant_id FK column (the only FK-to-core; emitted as a separate ALTER, not here). */
  isTenantFk?: boolean;
  /**
   * True for an injected column ADDED AFTER the first release, so a store MATERIALIZED before it existed
   * (an older deployment) lacks it. The surviving-table backfill (`injectedBackfillSql`, opt-in
   * via `diffProductStores({ backfillInjectedColumns: true })`) emits `ADD COLUMN IF NOT EXISTS` ONLY for
   * these — NOT for the always-present injected columns (id/tenant_id/created_at/deleted_at/
   * retention_days/region), which every materialized store already carries, so `rayspec plan --against`
   * on an unchanged spec never prints spurious backfill DDL for them. Set on the `created_by`
   * + `idempotency_key` columns.
   */
  backfill?: boolean;
  /**
   * If set, the SQL generator emits a UNIQUE INDEX for this injected column. `'tenant-scoped'` = a
   * compound `(tenant_id, col)` index (so the SAME value is independent across tenants, and Postgres
   * NULLs never collide → rows that leave the column NULL are unconstrained). DDL-ONLY, exactly like
   * the injected `<table>_tenant_idx` secondary index: it is emitted by the SQL generator (and the
   * surviving-table backfill) but is NOT represented in the Drizzle ORM twins — the constraint is a
   * DB-level index the migration owns, not an ORM object (the twins carry the column, the DB owns the
   * index). Used by the `idempotency_key` column (store.create Idempotency-Key replay).
   */
  uniqueIndex?: 'tenant-scoped';
}

/**
 * The canonical injected columns, in schema.ts order: `id` + `tenant_id` BEFORE the business
 * columns, then `created_at`/`deleted_at`/`retention_days`/`region` AFTER. `tenant_id`'s FK -> orgs
 * is emitted by the generators as a separate ALTER (SQL) / `.references()` chain (TS), so its
 * `tsSource`/`sqlDef` here are the bare column; the FK is added by the caller.
 */
export const INJECTED_COLUMNS: readonly InjectedColumn[] = [
  {
    sqlName: 'id',
    tsName: 'id',
    type: 'uuid',
    nullable: false,
    tsSource: "uuid('id').defaultRandom().primaryKey()",
    sqlDef: '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
    position: 'before',
  },
  {
    sqlName: 'tenant_id',
    tsName: 'tenantId',
    type: 'uuid',
    nullable: false,
    // The .references(() => orgs.id, ...) chain is appended by the generator (3-member chain wrap).
    tsSource: "uuid('tenant_id')",
    sqlDef: '"tenant_id" uuid NOT NULL',
    position: 'before',
    isTenantFk: true,
  },
  {
    sqlName: 'created_at',
    tsName: 'createdAt',
    type: 'timestamp',
    nullable: false,
    tsSource: "timestamp('created_at', { withTimezone: true }).notNull().defaultNow()",
    sqlDef: '"created_at" timestamp with time zone DEFAULT now() NOT NULL',
    position: 'after',
  },
  {
    sqlName: 'deleted_at',
    tsName: 'deletedAt',
    type: 'timestamp',
    nullable: true,
    tsSource: "timestamp('deleted_at', { withTimezone: true })",
    sqlDef: '"deleted_at" timestamp with time zone',
    position: 'after',
  },
  {
    sqlName: 'retention_days',
    tsName: 'retentionDays',
    type: 'integer',
    nullable: true,
    tsSource: "integer('retention_days')",
    sqlDef: '"retention_days" integer',
    position: 'after',
  },
  {
    sqlName: 'region',
    tsName: 'region',
    type: 'text',
    nullable: false,
    tsSource: "text('region').notNull().default('eu')",
    sqlDef: `"region" text DEFAULT 'eu' NOT NULL`,
    position: 'after',
  },
  {
    // The actor who CREATEd the row — stamped server-side from the request principal
    // (`user:<userId>` for a JWT principal, `key:<apiKeyId>` for an API key). NEVER client-settable
    // (reserved + server-stamped on CREATE only, never on UPDATE). Nullable: a legacy row (created
    // before this column existed) carries NULL, and the CREATE path fills it going forward.
    sqlName: 'created_by',
    tsName: 'createdBy',
    type: 'text',
    nullable: true,
    tsSource: "text('created_by')",
    sqlDef: '"created_by" text',
    position: 'after',
    backfill: true,
  },
  {
    // The store.create `Idempotency-Key` header value (opaque). Nullable — Postgres
    // treats NULLs as distinct, so requests WITHOUT the header never collide on the unique index. The
    // tenant-scoped compound `(tenant_id, idempotency_key)` unique index makes the SAME key independent
    // across tenants and lets the create path REPLAY the prior row on a 23505 (no duplicate, no 409).
    sqlName: 'idempotency_key',
    tsName: 'idempotencyKey',
    type: 'text',
    nullable: true,
    tsSource: "text('idempotency_key')",
    sqlDef: '"idempotency_key" text',
    position: 'after',
    uniqueIndex: 'tenant-scoped',
    backfill: true,
  },
];

/** The injected column SQL-names (snake_case) — the single source pinned to spec RESERVED_COLUMN_NAMES. */
export const INJECTED_COLUMN_NAMES = INJECTED_COLUMNS.map((c) => c.sqlName) as readonly string[];

/** Injected columns emitted BEFORE the author business columns (id, tenant_id). */
export const INJECTED_BEFORE = INJECTED_COLUMNS.filter((c) => c.position === 'before');
/** Injected columns emitted AFTER the author business columns (created_at, deleted_at, …). */
export const INJECTED_AFTER = INJECTED_COLUMNS.filter((c) => c.position === 'after');
