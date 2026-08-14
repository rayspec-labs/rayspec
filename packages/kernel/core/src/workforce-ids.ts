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
 * NOT declarable as ordinary tools by an agent a workforce employee runs. A declared tool carrying
 * one of these names would be silently shadowed by the native at dispatch (natives win, always), so
 * spec validation refuses the collision up front and the dispatch layer re-asserts it fail-closed.
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
  'request_approval',
  'request_clarification',
  'request_review',
  'send_message',
  'submit_result',
  'submit_review',
]);
