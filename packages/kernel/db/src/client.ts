/** Postgres client (postgres-js) + Drizzle handle. One pooled connection. */
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schemaNs from './schema.js';

/**
 * Pass ONLY the pgTable objects to drizzle's relational `schema` option. The schema namespace also
 * exports non-table values (TENANT_SCOPED_TABLES / CORE_TENANT_SCOPED_TABLES `as const` tuples,
 * TENANT_GUC) whose large literal-tuple types, when handed to `drizzle({ schema })`, blow up the
 * generated Db type enough that the `transaction(async (tx) => …)` callback overload fails to infer
 * and `tx` falls back to `any` (the org-store/identity-store TS7006 regression after the
 * tuple composition). Filtering to tables keeps `Db` lean AND is strictly more correct — drizzle's
 * relational schema only ever wants tables/relations. Runtime-identical to passing the namespace
 * (drizzle ignores non-table entries), but type-lean.
 */
const schema = Object.fromEntries(Object.entries(schemaNs).filter(([, v]) => is(v, PgTable)));

export type Db = ReturnType<typeof makeDb>;

/** The default postgres pool size for a `makeDb` handle (the HTTP/API pool). */
export const DEFAULT_POOL_MAX = 4;

/**
 * The boot pool's NOTICE handler: DROP the benign NOTICE-class frames, surface everything else.
 *
 * Postgres emits a NOTICE (`severity: 'NOTICE'`) for every idempotent DDL guard the migration chain
 * runs — `schema "…" already exists, skipping`, `relation "…" already exists, skipping`. postgres.js's
 * default handler `console.log`s each one, so a clean boot prints a wall of messages that READ like
 * errors to an operator. We filter TIGHTLY on the non-localized `severity` field: only the NOTICE class
 * is dropped; a `WARNING` (or any other severity) is still logged so a real advisory is never hidden.
 *
 * This CANNOT swallow a real error. A failed query is delivered by Postgres as a SEPARATE ErrorResponse
 * frame that REJECTS the query promise (the caller sees the rejection); it never reaches `onnotice`,
 * which only ever receives NoticeResponse frames (NOTICE/WARNING/INFO/…). Filtering here changes boot
 * log noise only, never error handling or query behaviour.
 */
export function logNotice(notice: postgres.Notice): void {
  if (notice.severity !== 'NOTICE') console.log(notice);
}

/**
 * Build the one raw, UNSCOPED Drizzle handle the deployment needs. This is the PRODUCTION
 * composition-root factory — exported on the main `@rayspec/db` surface (see index.ts) for the
 * boot entrypoint (`@rayspec/server`) and re-exported on `/testing` for tests/spikes. The
 * composition root is the documented single place a raw handle is built (app-context.ts); scoped
 * request/run-core code holds ONLY a `TenantDb` via `forTenant(db, tenantId)`, enforced by the
 * tenant-chokepoint grep gate (which fails the build on the `makeDb` token in a scoped root).
 *
 * `maxPoolSize` (default `DEFAULT_POOL_MAX`) overrides the pool's connection cap. The composition
 * root builds a SEPARATE, larger-pooled handle for the durable worker so a long off-request run
 * (which holds ONE connection across the whole LLM call inside `tdb.transaction()`) cannot starve
 * the HTTP pool — see `@rayspec/server` composition-root.ts (fix B). Pass it explicitly there; the
 * default keeps the HTTP pool at 4 (backward-compatible).
 */
export function makeDb(databaseUrl: string, maxPoolSize: number = DEFAULT_POOL_MAX) {
  const sql = postgres(databaseUrl, { max: maxPoolSize, onnotice: logNotice });
  const db = drizzle(sql, { schema });
  return Object.assign(db, { $client: sql });
}

/**
 * Like makeDb but pins the connection's search_path to `schemaName` (then public). Used ONLY
 * by tests so parallel DB-backed suites can each own an isolated Postgres schema on the shared
 * DATABASE_URL without colliding on table names. Not for production code.
 *
 * `maxPoolSize` (default 4) lets a worker-pool-sizing test pin the pool cap so it can saturate the
 * pool deterministically (e.g. prove N concurrent two-connection runs do not exhaust a correctly-sized
 * pool). Existing callers omit it → the unchanged default-4 behavior.
 */
export function makeDbWithSchema(databaseUrl: string, schemaName: string, maxPoolSize = 4) {
  const sql = postgres(databaseUrl, {
    max: maxPoolSize,
    connection: { search_path: `${schemaName}, public` },
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, { $client: sql });
}
