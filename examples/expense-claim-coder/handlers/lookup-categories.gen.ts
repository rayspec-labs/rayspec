// AUTO-GENERATED store-lookup handler (bounded template T2). Do NOT edit by hand —
// regenerate via `rayspec gen-handler`. TRUSTED-AUTHOR, NOT SANDBOXED: it runs in-process; the two
// CI gates (handler-imports / extension-capability) are TRIPWIRES, not a sandbox — the real per-tenant
// isolate is a later hardening milestone (deferred). Imports @rayspec/handler-sdk TYPE-ONLY; ZERO npm deps; reaches
// the DB ONLY through the injected, tenant-bound, declared-stores-only init.db facade.
import type { StoreFilter, StoreRow, ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

const STORE = "expense_categories";
const FILTER_COLS = [] as const; // CLOSED allowlist — ONLY these args may build the equality filter.
const PROJECT_COLS = ["code", "name", "description"] as const; // the columns projected into each returned row (drop the rest).
const BASE_FILTER: StoreFilter = { active: true }; // the OPTIONAL fixed predicate.
const MAX_ROWS = 200; // hard cap on rows returned to the model (bounds the context).

interface LookupResult {
  /** The projected, capped rows (each restricted to PROJECT_COLS). */
  rows: StoreRow[];
  /** The number of rows returned (after the cap). */
  count: number;
}

/** Project a row to the declared PROJECT_COLS only (drop everything else — incl. injected columns). */
function project(row: StoreRow): StoreRow {
  const out: StoreRow = {};
  for (const col of PROJECT_COLS) {
    if (col in row) out[col] = row[col];
  }
  return out;
}

export const lookupCategories: ToolHandler<Record<string, unknown>, LookupResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<LookupResult> => {
  const o = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  // Build the filter from the FIXED predicate + ONLY allowlisted arg keys (a non-allowlisted key can
  // never craft a filter over an unintended/injected column). Values are DATA (scalars only).
  const filter: StoreFilter = { ...BASE_FILTER };
  for (const col of FILTER_COLS) {
    const v = o[col];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filter[col] = v;
  }
  const rows = await init.db.select(STORE, filter); // tenant predicate auto-injected by the facade.

  // OPTIONAL in-memory case-insensitive substring filter on the model's `query` arg
  // (applied AFTER the tenant-scoped DB equality filter; the facade is equality-only by design).
  let candidates = rows;
  {
    const q = o.query;
    if (typeof q === 'string' && q.length > 0) {
      const needle = q.toLowerCase();
      candidates = rows.filter((r) => {
        const field = r.name;
        return typeof field === 'string' && field.toLowerCase().includes(needle);
      });
    }
  }
  const capped = candidates.slice(0, MAX_ROWS).map(project);
  return { rows: capped, count: capped.length };
};
