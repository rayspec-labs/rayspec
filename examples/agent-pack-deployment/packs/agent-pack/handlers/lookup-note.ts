/**
 * SYNTHETIC agent-pack tool handler — the platform's own forcing-function for an
 * `agents` EXTENSION FRAGMENT. It is the tool the pack-declared agent references.
 *
 * Like the other example handlers (lookup-notebook.ts), this imports `@rayspec/handler-sdk`
 * type-only. This dir is in NO tsconfig (an `examples/` fixture, excluded from turbo/CI build) — the
 * loader's importer transforms the `.ts` at TEST/deploy time. The handler returns ONLY neutral data
 * (validated against the tool's `outputSchema` by dispatchTool); it is a safe deterministic read
 * (`idempotent: true`), scoped to the run's tenant by the auto-injected tenant predicate (init.db).
 */
import type { ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

interface LookupNoteArgs {
  note_id: string;
}

interface NoteMetadata {
  title: string;
}

/**
 * Look up a pack-declared `notes` row by id, tenant-scoped (the TenantDb auto-injects the tenant
 * predicate so the handler can only see its own tenant's rows). Returns the neutral shape the tool's
 * `outputSchema` declares.
 */
export const lookupNote: ToolHandler<LookupNoteArgs, NoteMetadata> = async (
  args,
  init: ToolHandlerInit,
) => {
  const rows = await init.db.select('notes', { id: args.note_id });
  const note = rows[0];
  if (!note) {
    throw new Error(`note '${args.note_id}' not found`);
  }
  return { title: String(note.title) };
};
