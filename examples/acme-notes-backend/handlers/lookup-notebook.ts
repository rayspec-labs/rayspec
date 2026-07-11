/**
 * Escape-hatch handler for the `lookup_notebook` tool (neutral acme-notes backend).
 *
 * Written as plausible, lint-clean TS so the example is realistic. It imports `@rayspec/handler-sdk`
 * type-only; this dir is not in any tsconfig (tsc never compiles it) and Biome does not resolve
 * imports.
 *
 * Handler contract: the engine constructs a capability-scoped `HandlerInit` (here, a tenant-bound
 * TenantDb) at resolution time and passes it in; the handler returns ONLY neutral data (validated
 * against the tool's `outputSchema` by dispatchTool). A tool handler gets NO implicit outer
 * transaction — it calls `init.db.transaction()` itself if it needs atomicity. A lookup is a safe
 * deterministic read (`idempotent: true`).
 */
import type { ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

interface LookupNotebookArgs {
  notebook_id: string;
}

interface NotebookMetadata {
  title: string;
  scheduled_at?: string;
}

/**
 * Look up a notebook's metadata by id, scoped to the run's tenant (the TenantDb auto-injects the
 * tenant predicate). Returns the neutral shape the tool's `outputSchema` declares.
 */
export const lookupNotebook: ToolHandler<LookupNotebookArgs, NotebookMetadata> = async (
  args,
  init: ToolHandlerInit,
) => {
  // The filter is a column-equality map (snake_case names) — the engine resolves it against the
  // declared `notebooks` store + auto-injects the tenant predicate (the handler can only see its own
  // tenant's rows). `id` is the injected uuid PK. (A handler returns ONLY neutral data.)
  const rows = await init.db.select('notebooks', { id: args.notebook_id });
  const notebook = rows[0];
  if (!notebook) {
    throw new Error(`notebook '${args.notebook_id}' not found`);
  }
  return {
    title: String(notebook.title),
    scheduled_at: notebook.scheduled_at ? String(notebook.scheduled_at) : undefined,
  };
};
