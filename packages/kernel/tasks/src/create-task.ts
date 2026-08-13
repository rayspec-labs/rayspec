/**
 * Task creation — the ONLY insert site for `workforce_tasks` rows.
 *
 * Every row is born `planned` (the literal below is the single place the initial status is
 * written; the exhaustiveness gate holds that alongside applyTransition's monopoly on updates).
 * Roots get a random id; children get ids DETERMINISTIC in (tenant, parent, turn, slot) so a
 * re-executed fan-out collides on the PK instead of duplicating (ids.ts). Inputs are validated
 * fail-closed with strict schemas — unknown keys are rejected, priorities and reference shapes are
 * closed vocabularies — and creation journals `workforce.task.created` in the same transaction, so
 * a task that did not journal was never created.
 */

import { schema, type TenantDb } from '@rayspec/db';
import { z } from 'zod';
import type { TaskRecord } from './apply-transition.js';
import { appendTaskEvents } from './events.js';
import { deterministicChildTaskId, newRootTaskId } from './ids.js';

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Strict creation surface for a ROOT task (no parent; the task anchors its own subtree). */
export const createRootTaskInputSchema = z.strictObject({
  workforceId: z.string().min(1).nullable().default(null),
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  description: z.string().min(1).nullable().default(null),
  owner: z.string().min(1),
  requestedBy: z.string().min(1),
  department: z.string().min(1).nullable().default(null),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  dependencies: z.array(z.string().min(1)).default([]),
  deadlineAt: z.date().nullable().default(null),
});

export type CreateRootTaskInput = z.input<typeof createRootTaskInputSchema>;

/**
 * The child-row shape the fan-out applier inserts — parentage, ancestry and the deterministic id
 * are derived HERE, not caller-supplied, so no caller can fabricate a subtree.
 */
export const childTaskSpecSchema = z.strictObject({
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  description: z.string().min(1).nullable().default(null),
  owner: z.string().min(1),
  department: z.string().min(1).nullable().default(null),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
});

export type ChildTaskSpec = z.input<typeof childTaskSpecSchema>;

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

/** Create a root task in `planned` and journal its creation. */
export async function createRootTask(
  tdb: TenantDb,
  input: CreateRootTaskInput,
): Promise<TaskRecord> {
  const parsed = createRootTaskInputSchema.parse(input);
  const taskId = newRootTaskId();
  return tdb.transaction(async (tx) =>
    insertTaskRow(tx, {
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
    }),
  );
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
