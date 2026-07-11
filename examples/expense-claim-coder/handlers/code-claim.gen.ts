// AUTO-GENERATED persist-tool handler (bounded template T1). Do NOT edit by hand —
// regenerate via `rayspec gen-handler`. TRUSTED-AUTHOR, NOT SANDBOXED: it runs in-process; the two
// CI gates (handler-imports / extension-capability) are TRIPWIRES, not a sandbox — the real per-tenant
// isolate is a later hardening milestone (deferred). Imports @rayspec/handler-sdk TYPE-ONLY; ZERO npm deps; reaches
// the DB ONLY through the injected, tenant-bound, declared-stores-only init.db facade.
import type { StoreRow, ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

const STORE = "expense_claims"; // a DECLARED store; init.db fail-closes on any other name.

/**
 * Coerce the UNTRUSTED model args into the row to persist (T3 shape-map + per-ColumnType coercion).
 * Drops any non-declared key (additionalProperties:false parity with the tool parameters), never
 * throws (returns a failed result on a required/enum violation), and never writes an injected column.
 */
function coerceRow(args: Record<string, unknown>): { ok: true; row: StoreRow } | { ok: false; status: 'failed'; detail: string } {
  const o = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const row: StoreRow = {};
  // category_code: text — UNTRUSTED arg, must be a string.
  {
    const val = o.category_code;
    if (typeof val === 'string') { row.category_code = val; }
    else { return { ok: false, status: 'failed', detail: "arg category_code missing or invalid." }; }
  }
  // gl_code: text — UNTRUSTED arg, must be a string.
  {
    const val = o.gl_code;
    if (typeof val === 'string') { row.gl_code = val; }
    else { return { ok: false, status: 'failed', detail: "arg gl_code missing or invalid." }; }
  }
  // coding_summary: text — UNTRUSTED arg, must be a string.
  {
    const val = o.coding_summary;
    if (typeof val === 'string') { row.coding_summary = val; }
    else { return { ok: false, status: 'failed', detail: "arg coding_summary missing or invalid." }; }
  }
  // policy_flag: text (closed enum) — UNTRUSTED arg, membership-checked.
  {
    const val = o.policy_flag;
    if (typeof val === 'string' && (["ok", "review", "violation"] as readonly string[]).includes(val)) {
      row.policy_flag = val;
    } else { return { ok: false, status: 'failed', detail: "arg policy_flag missing or invalid." }; }
  }
  return { ok: true, row };
}

interface PersistResult {
  /** The success status ("coded") or 'failed'. */
  status: string;
  /** The affected row id, when known. */
  id?: string;
  /** A human-readable detail on failure. */
  detail?: string;
}

export const codeClaim: ToolHandler<Record<string, unknown>, PersistResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<PersistResult> => {
  const coerced = coerceRow(args);
  if (!coerced.ok) return { status: 'failed', detail: coerced.detail };
  try {
    // ── ARM A — update-by-id (the existing-row case). The id is a model arg, validated as DATA.
    const idRaw = (args as Record<string, unknown>)["claim_id"];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (id.length === 0) return { status: 'failed', detail: 'claim_id missing or not a string.' };
    // OPTIONAL server-side FK re-validation: re-check the model-chosen code against the lookup store —
    // NEVER trust the model's choice. The code value is the coerced (DATA) business column.
    {
      const code = coerced.row.category_code;
      const lookupFilter = { ...{ active: true }, code: code };
      const matches = await init.db.select("expense_categories", lookupFilter as Record<string, unknown>);
      if (matches.length === 0) {
        return { status: 'failed', detail: 'the chosen category_code is not a valid code in expense_categories.' };
      }
    }
    // Server-stamped fixed values (author constants — never a model arg; overwrite any coerced value).
    Object.assign(coerced.row, { status: "coded" });
    const updated = await init.db.update(STORE, { id }, coerced.row);
    if (updated.length === 0) return { status: 'failed', detail: 'no expense_claims row found for the given id.' };
    return { status: "coded", id };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'persist failed.';
    return { status: 'failed', detail };
  }
};
