/**
 * Escape-hatch TOOL handler for the agent-boot notes fixture — persists one note row.
 *
 * Self-contained native ESM (NO imports): it receives the engine-injected, tenant-bound HandlerInit and
 * returns neutral data (validated against the tool's outputSchema by the central dispatchTool). Kept as
 * a `.mjs` on purpose so it loads through the REAL handler loader in BOTH vitest AND a plain `node`
 * boot — no TS transform needed — which is exactly the property the fixture proves: the shipped
 * entrypoint boots an agent spec directly, tool handler and all.
 *
 * @param {{ title: string, body: string }} args  the validated tool args (from the model / fake backend)
 * @param {{ tenantId: string, db: { insert: (store: string, values: Record<string, unknown>) => Promise<Record<string, unknown>> } }} init
 * @returns {Promise<{ id: string, title: string }>}
 */
export async function persistNote(args, init) {
  // A real INSERT (the tenant predicate + tenant_id + id are auto-stamped by the name-keyed facade).
  const row = await init.db.insert('notes', { title: args.title, body: args.body });
  return { id: String(row.id), title: String(row.title) };
}
