/**
 * The fixture pack's TOOL handler — the code behind the one tool this pack contributes.
 *
 * It exists so the other half of the handler contract has a witness in the repository: a `tooling`
 * declaration is only a name and a wire until something is written at the end of it, and this is that
 * module. Like the route beside it, it is reached through a REAL declaration — the manifest's
 * `handlers` fragment addresses it by id/module/export/kind and the `tooling` fragment points a tool
 * at that id — so the merge, the jail and the loader all see it the way they see a pack's route.
 *
 * It is deliberately trivial: it echoes the argument it was called with and the tenant the invocation
 * ran under. What is being witnessed is the CONTRACT — that a module annotated against
 * `@rayspec/pack-sdk` alone is the module the platform's tool chokepoint calls — not what the handler
 * computes; a handler that touched the database would make that measurement depend on one.
 *
 * ONE IMPORT. It names `@rayspec/pack-sdk` and nothing else — the point being that ONE types-only,
 * zero-dependency package covers both halves of a contribution. A pack shipping from its own
 * repository could install `@rayspec/handler-sdk` (it releases in the same closure), but doing so
 * would add that package's runtime and its three production dependencies to a pack's install for a
 * shape this one already promises.
 */
import type { PackToolHandler } from '@rayspec/pack-sdk';

/** What the model supplies — validated against the tool's declared `parameters` before this runs. */
interface DescribeTurnArgs {
  readonly turn_id: string;
}

/** What the tool answers: neutral, serializable data, validated against the declared `outputSchema`. */
interface TurnDescription {
  readonly turn_id: string;
  readonly tenant_id: string;
}

/**
 * Echo the turn the model asked about, together with the tenant this call ran under. `init.tenantId`
 * is SERVER-DERIVED — it is not among the arguments, so a model cannot name another tenant through
 * this tool however it phrases the call.
 */
export const describeTurn: PackToolHandler<DescribeTurnArgs, TurnDescription> = (args, init) => ({
  turn_id: args.turn_id,
  tenant_id: init.tenantId,
});
