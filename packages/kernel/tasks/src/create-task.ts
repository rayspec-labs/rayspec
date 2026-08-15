/**
 * Task creation — the ONLY insert site for `workforce_tasks` rows.
 *
 * Every row is born `planned` (the literal below is the single place the initial status is
 * written; the exhaustiveness gate holds that alongside applyTransition's monopoly on updates).
 * Roots get a random id; children get ids DETERMINISTIC in (tenant, parent, turn, slot), so a
 * re-application that somehow slipped past the receipt guard collides LOUDLY on the PK and aborts
 * its transaction — defense in depth against silent duplication, not a silent no-op (the receipt
 * check in apply-intents.ts is what makes re-execution a clean no-op). Inputs are validated
 * fail-closed with strict schemas — unknown keys are rejected, priorities and reference shapes are
 * closed vocabularies — and creation journals `workforce.task.created` in the same transaction, so
 * a task that did not journal was never created.
 */

import { schema, type TenantDb } from '@rayspec/db';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { TaskRecord } from './apply-transition.js';
import { TaskDependenciesInvalidError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { deterministicChildTaskId, newRootTaskId } from './ids.js';
import { isReservedWorkforceSegment, RESERVED_WORKFORCE_SEGMENTS } from './runtime.js';

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/**
 * The bound on a task's goal and description at EVERY creation surface — defense in depth under
 * the toolset's own hand-off cap and the HTTP intake's byte ceiling. A goal renders verbatim
 * (and, for the goal, untrimmably) into the owner's turn input, and an uncapped one is a way to
 * make a later turn's context whatever the creating caller wants it to be.
 */
export const MAX_TASK_TEXT_CHARS = 16_384;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * How many prerequisites one task may declare. A bound, not a policy: the scheduler resolves the
 * whole list on every pass, so an unbounded one is an unbounded read.
 */
export const MAX_TASK_DEPENDENCIES = 100;

/**
 * Declared prerequisites: task ids that must reach `completed` before this task leaves `planned`.
 * DEDUPED at parse — a repeated id is one prerequisite, and the scheduler's old count-based
 * satisfaction check (`rows.length === deps.length`) could never be met by `["A", "A"]`, so the
 * task waited on a completed dependency forever. Existence and self-reference are checked against
 * the rows at creation (`assertDependenciesResolvable`), which a schema cannot do.
 */
const dependenciesSchema = z
  .array(z.string().min(1).max(200))
  .max(MAX_TASK_DEPENDENCIES)
  .default([])
  .transform((ids) => [...new Set(ids)]);

/**
 * The workforce a task is minted into. A RESERVED path segment is refused here, not only at the
 * routes: a workforce created as `tasks` collides with the task collection on every control and
 * read route, so it can never be paused, resumed, halted or queried — a row that is born
 * unreachable, which is a creation-time refusal and not an operator's problem to discover later.
 */
const workforceIdSchema = z
  .string()
  .min(1)
  .nullable()
  .default(null)
  .refine((id) => id === null || !isReservedWorkforceSegment(id), {
    message:
      `a workforce id may not be one of ${RESERVED_WORKFORCE_SEGMENTS.join(', ')} — those path ` +
      "segments belong to the workforce surface's own collections, and a workforce carrying one " +
      'would be unreachable for control and reads. Fail-closed.',
  });

/** Strict creation surface for a ROOT task (no parent; the task anchors its own subtree). */
export const createRootTaskInputSchema = z.strictObject({
  workforceId: workforceIdSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(MAX_TASK_TEXT_CHARS),
  description: z.string().min(1).max(MAX_TASK_TEXT_CHARS).nullable().default(null),
  owner: z.string().min(1),
  requestedBy: z.string().min(1),
  department: z.string().min(1).nullable().default(null),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  dependencies: dependenciesSchema,
  deadlineAt: z.date().nullable().default(null),
});

export type CreateRootTaskInput = z.input<typeof createRootTaskInputSchema>;

/**
 * The child-row shape the fan-out applier inserts — parentage, ancestry and the deterministic id
 * are derived HERE, not caller-supplied, so no caller can fabricate a subtree.
 */
export const childTaskSpecSchema = z.strictObject({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(MAX_TASK_TEXT_CHARS),
  description: z.string().min(1).max(MAX_TASK_TEXT_CHARS).nullable().default(null),
  owner: z.string().min(1),
  department: z.string().min(1).nullable().default(null),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
});

export type ChildTaskSpec = z.input<typeof childTaskSpecSchema>;

/**
 * A fan-out child PLUS the original delegation target the caller resolved (`employee:<id>`,
 * `department:<id>`, `team:<id>`). The task row never carries it — `owner` is the resolution — but
 * the delegation record does: `delegated_to` keeps what was ADDRESSED while `resolved_owner` keeps
 * who answers for it, so an audit can tell "sent to the department" from "sent to its manager by
 * name". Absent (a caller that resolved nothing) the delegation record falls back to the owner.
 */
export const delegationChildSpecSchema = childTaskSpecSchema.extend({
  delegatedTo: z.string().min(1).optional(),
});

export type DelegationChildSpec = z.input<typeof delegationChildSpecSchema>;

async function insertTaskRow(
  tx: TenantDb,
  row: Readonly<Record<string, unknown>> & { taskId: string },
): Promise<TaskRecord> {
  const inserted = await tx
    .insert(schema.workforceTasks, { ...row, status: 'planned' })
    .returning();
  const task = inserted[0] as TaskRecord | undefined;
  if (!task) {
    // .returning() on a plain insert always yields the row; an empty result means the insert
    // itself did not happen — surface it rather than fabricating a record.
    throw new Error(`task insert for '${row.taskId}' returned no row. Fail-closed.`);
  }
  await appendTaskEvents(tx, task.taskId, [
    {
      type: 'workforce.task.created',
      payload: {
        taskId: task.taskId,
        parentTaskId: task.parentTaskId,
        rootTaskId: task.rootTaskId,
        owner: task.owner,
        requestedBy: task.requestedBy,
        goal: task.goal,
        priority: task.priority,
      },
    },
  ]);
  return task;
}

/**
 * The rule every task-creation surface applies to a declared dependency list: each id must name a
 * task that EXISTS under this tenant and is not the task being created. Nothing else ever revisits
 * a `blocked(awaiting_dependency)` park with an answer, so an id nobody can complete is a task
 * parked forever — refused here instead. Runs inside the creating transaction, against the rows.
 */
export async function assertDependenciesResolvable(
  tx: TenantDb,
  taskId: string,
  dependencies: readonly string[],
): Promise<void> {
  if (dependencies.length === 0) return;
  if (dependencies.includes(taskId)) {
    throw new TaskDependenciesInvalidError(`task '${taskId}' depends on itself`, dependencies);
  }
  const rows = await tx
    .select(schema.workforceTasks, { taskId: schema.workforceTasks.taskId })
    .where(inArray(schema.workforceTasks.taskId, [...dependencies]));
  const present = new Set(rows.map((r) => (r as { taskId: string }).taskId));
  const unknown = dependencies.filter((id) => !present.has(id));
  if (unknown.length > 0) {
    throw new TaskDependenciesInvalidError(
      `no task under this tenant matches ${unknown.map((id) => `'${id}'`).join(', ')}`,
      dependencies,
    );
  }
}

/** Create a root task in `planned` and journal its creation. */
export async function createRootTask(
  tdb: TenantDb,
  input: CreateRootTaskInput,
): Promise<TaskRecord> {
  const parsed = createRootTaskInputSchema.parse(input);
  const taskId = newRootTaskId();
  return tdb.transaction(async (tx) => {
    await assertDependenciesResolvable(tx, taskId, parsed.dependencies);
    return insertTaskRow(tx, {
      taskId,
      workforceId: parsed.workforceId,
      parentTaskId: null,
      rootTaskId: taskId,
      ancestryPath: [],
      title: parsed.title,
      goal: parsed.goal,
      description: parsed.description,
      owner: parsed.owner,
      requestedBy: parsed.requestedBy,
      department: parsed.department,
      priority: parsed.priority,
      dependencies: parsed.dependencies,
      deadlineAt: parsed.deadlineAt,
    });
  });
}

/**
 * Insert ONE child row under a parent, `planned`, with the deterministic id for its (turn, slot).
 * Called by the fan-out applier inside ITS transaction — parentage and ancestry are derived from
 * the parent row it already holds. Exported for that applier, not as a public creation surface.
 */
export async function insertChildTask(
  tx: TenantDb,
  parent: TaskRecord,
  turnNumber: number,
  slotIndex: number,
  specInput: ChildTaskSpec,
): Promise<TaskRecord> {
  const spec = childTaskSpecSchema.parse(specInput);
  const taskId = deterministicChildTaskId(tx.tenantId, parent.taskId, turnNumber, slotIndex);
  const ancestry = Array.isArray(parent.ancestryPath) ? (parent.ancestryPath as string[]) : [];
  return insertTaskRow(tx, {
    taskId,
    workforceId: parent.workforceId,
    parentTaskId: parent.taskId,
    rootTaskId: parent.rootTaskId,
    ancestryPath: [...ancestry, parent.taskId],
    title: spec.title,
    goal: spec.goal,
    description: spec.description,
    owner: spec.owner,
    requestedBy: parent.owner,
    department: spec.department,
    priority: spec.priority,
    dependencies: [],
    deadlineAt: null,
  });
}
