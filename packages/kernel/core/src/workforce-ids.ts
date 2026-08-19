/**
 * Reserved workforce identifiers — the two closed name sets every workforce surface agrees on.
 *
 * They live HERE, in the dependency root, because three packages that cannot import each other all
 * consume them: the task engine binds the segment set where a workforce id is minted
 * (@rayspec/tasks create-task.ts) and re-exports it for the HTTP edge, while the spec grammar's
 * validation pass rejects the same names at author time (@rayspec/spec cannot import @rayspec/tasks
 * — the dependency edge runs db → spec, never back). One literal, one source, no drift test needed.
 */

/**
 * Workforce ids the HTTP surface spends on its own collections, so a workforce may not carry one:
 * `/v1/workforce/tasks/:id` and `/v1/workforce/:workforceId/status` are the same shape, and a
 * workforce called `tasks` would answer for the wrong resource. The routes refuse these on the
 * `:workforceId` path — but a refusal at the READ side only produces a workforce that exists and is
 * permanently un-pausable and un-queryable, so the set binds at the one place a workforce id is
 * minted (@rayspec/tasks create-task.ts) and at spec validation, as well as at the edge.
 */
export const RESERVED_WORKFORCE_SEGMENTS = ['tasks', 'approvals', 'reviews', 'cost'] as const;

export function isReservedWorkforceSegment(workforceId: string): boolean {
  return (RESERVED_WORKFORCE_SEGMENTS as readonly string[]).includes(workforceId);
}

/**
 * The native workforce tool names — runtime-provided, injected by role at dispatch, and therefore
 * NOT declarable as ordinary tools by an agent a workforce employee runs.
 *
 * TWO REFUSAL DOORS, AND THE FALLBACK BEHIND THEM. A declared tool carrying one of these names is
 * refused twice: spec validation rejects it at author time (@rayspec/spec workforce-lint.ts), and
 * the dispatch-time composition re-asserts it fail-closed (`assertNoReservedCollisions`, called by
 * @rayspec/server workforce-turn-handlers.ts before the tool list reaches `runAgent`). Behind both,
 * natives win: that composition spreads the natives LAST (`composeTurnTools`, same file) and the
 * dispatcher indexes its list into a by-name Map where a later entry overwrites an earlier one
 * (@rayspec/platform dispatch.ts), so a collision that somehow reached dispatch would resolve to the
 * runtime's tool and not the pack's. That fallback is a SECOND barrier, never the first — the doors
 * are what the reserved set is for, and neither may be relaxed because the other exists.
 *
 * The set is FROZEN alongside the toolset vocabulary; adding a name later is an additive
 * validation tightening and belongs in a release note.
 */
export const RESERVED_WORKFORCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'cancel_task',
  'create_subtask',
  'create_task',
  'delegate_task',
  'escalate',
  'get_task',
  'get_workforce_state',
  'list_department_tasks',
  'list_open_tasks',
  'report_failure',
  'request_approval',
  'request_clarification',
  'request_review',
  'send_message',
  'submit_result',
  'submit_review',
]);

/** The model-facing form an in-process MCP bridge gives a neutral tool: `mcp__<server>__<tool>`. */
const BRIDGED_TOOL_NAME = /^mcp__[a-z0-9-]+__(?<tool>.+)$/;

/**
 * The CANONICAL bridged-name pattern SOURCE. The turn-ending detector one package over
 * (`workforce-tools/roles.ts`) needs the SAME predicate (widening one alone reopens the bridged-
 * spelling gap this closes), and there is no cross-package regex identity — so it asserts its own
 * copy against THIS source at module load. Exported for that drift assert, not for re-compilation.
 */
export const BRIDGED_TOOL_NAME_SOURCE = BRIDGED_TOOL_NAME.source;

/**
 * Does a declared tool name SPELL a reserved native — exactly, or through the bridged
 * `mcp__<x>__<tool>` form one adapter records verbatim on transcripts? The bridged spelling is
 * refused with the exact one because the transcript check that detects attempted turn endings
 * normalizes it: an agent tool named `mcp__tracker__submit_result` would make a legal yield read
 * as a refused ending and take the requeue-then-fail fate, with the outcome differing by
 * adapter. One predicate, two consumers (the lint at parse, the composition at dispatch), so the
 * two doors can never disagree.
 */
export function isReservedWorkforceToolSpelling(name: string): boolean {
  const neutral = BRIDGED_TOOL_NAME.exec(name)?.groups?.tool ?? name;
  return RESERVED_WORKFORCE_TOOL_NAMES.has(neutral);
}
