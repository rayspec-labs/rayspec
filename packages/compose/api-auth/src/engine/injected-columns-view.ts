/**
 * A small, product-agnostic VIEW of the injected tenancy/GDPR column names for the store interpreter
 *.
 *
 * The single source of the injected columns is `@rayspec/db`'s `injected-columns.ts` (id, tenant_id,
 * created_at, deleted_at, retention_days, region, created_by, idempotency_key). Its SQL (snake_case) names are re-exported on the
 * main `@rayspec/db` surface as `INJECTED_COLUMN_NAMES`; the runtime table builder
 * (`buildProductTables`) keys those columns by their camelCase TS property using the SAME snake→camel
 * rule. The store interpreter needs both views: snake (the wire JSON shape it exposes) and camel (the
 * Drizzle row key). We derive camel from the db's snake list with the SAME `snakeToCamel` rule the
 * builder uses, so this view CANNOT drift from the generated/runtime tables (one source: the db's
 * `INJECTED_COLUMN_NAMES` + one shared snake→camel rule).
 */

import { INJECTED_COLUMN_NAMES } from '@rayspec/db';

/**
 * snake_case → camelCase, the SAME transform `buildProductTables`/`generate-product-schema` apply to
 * column names (`snake_case` → `camelCase`, e.g. `note_id` → `noteId`). Kept identical so a wire name maps to the right Drizzle
 * key and back.
 */
export function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Map snake_case injected column name → its camelCase TS property name, derived from the db's single
 * source `INJECTED_COLUMN_NAMES`. Used to serialize a Drizzle row's injected columns back to their
 * declared snake_case wire names.
 */
export const INJECTED_COLUMN_TS_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  INJECTED_COLUMN_NAMES.map((snake) => [snake, snakeToCamel(snake)]),
);

/** The camelCase TS names of the server-controlled injected columns (never client-settable). */
export const INJECTED_CAMEL_NAMES: ReadonlySet<string> = new Set(
  Object.values(INJECTED_COLUMN_TS_NAMES),
);
