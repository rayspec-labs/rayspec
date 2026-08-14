/**
 * Workforce boot wiring — the two things a deploy/serve does for a declared `workforce:` section
 * BEYOND parsing it: (1) the REDEPLOY GATE — a new document may not remove or rename an employee,
 * department, team OR THE WORKFORCE ITSELF while live non-terminal tasks still reference it (pure
 * additions always deploy); (2) persisting the DERIVED budgets onto the per-workforce runtime row
 * (the engine reads ceilings from that row at every dispatch). Org structure itself is never
 * persisted — it derives fresh from the deployed document at every boot.
 *
 * Removals are detected from LIVE EVIDENCE — the only thing a redeploy can actually strand: a
 * non-terminal task under a declared workforce id the document no longer carries, a non-terminal
 * task whose owner or department it no longer declares, or a live delegation whose original target
 * names a departed employee/department/team. `deploy --dry-run` has no database and cannot run this
 * check; its output says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DECLARATION MARKER — how "this workforce was removed" became a decidable question.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The two hardest removals are the maximal ones: deleting the whole `workforce:` section, and
 * RENAMING `workforce.id` (which is a removal of the old id wearing a new name). A gate keyed only
 * on the declared id cannot see either — with the section gone there is no id to ask on behalf of,
 * and a rename points every query at an id no row carries, matching nothing and passing trivially
 * while the live tasks keep dispatching under the old id against a runtime row nothing refreshes.
 *
 * Reading the task rows instead is not enough on its own, because `workforce_tasks.workforce_id` is
 * set by WHOEVER CREATED THE TASK. Live work under an id is exactly as consistent with:
 *
 *   - a deployment that DECLARED a workforce and just removed it (the work is stranded: with no
 *     declaration no turn-handler resolver is wired, and every dispatched owner fails typed), as with
 *   - a deployment that NEVER declared one and drives the task engine directly (`/v1/workforce`
 *     exists precisely for this, and it is a shipped, supported posture).
 *
 * Both leave identical evidence on every row — same tasks, same runtime row (the scheduler creates
 * one on first dispatch), same delegations, same journal. So the boot RECORDS the fact that only it
 * knows: `ensureDeclaredWorkforceRuntime` stamps `budgets.declaredAt` on the runtime row of a
 * workforce THE DOCUMENT DECLARES, and nothing else ever writes it. The gate then refuses exactly
 * when a MARKED id is no longer declared and still carries live non-terminal tasks. A workforce id
 * that no document ever declared is never marked, so the engine-only posture is untouched by
 * construction rather than by exemption.
 *
 * A clean retirement RELEASES the marker (`releaseDepartedWorkforceDeclarations`, run after the gate
 * passes): once a document has stopped declaring an id and nothing live depends on it, the fact is
 * no longer true, and leaving it would make a LATER engine-only boot refuse over tasks created after
 * the workforce was legitimately retired.
 *
 * ONE TRANSITIONAL WINDOW, stated rather than glossed: a workforce declared by a boot that ran
 * BEFORE this marker existed carries none, so a deletion or rename between that boot and the next
 * declaring boot is not caught. The first boot that still declares the workforce stamps it, and the
 * removal is caught from then on. On this branch that window is theoretical — nothing has shipped —
 * but it is real for any database whose rows predate the marker.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { deriveWorkforceBudgets, type WorkforceSpec } from '@rayspec/spec';
import { ensureWorkforceRuntime, TERMINAL_STATUSES } from '@rayspec/tasks';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { BootConfigError } from './boot-config-error.js';

const LISTED_TASK_IDS = 20;

/** A redeploy that would strand live work on departed declarations. */
export class WorkforceSpecChangeError extends BootConfigError {
  /** The id the new document declares, or `(none)` when it declares no workforce at all. */
  readonly workforceId: string;
  readonly taskIds: readonly string[];
  constructor(workforceId: string, missing: readonly string[], taskIds: readonly string[]) {
    const listed = taskIds.slice(0, LISTED_TASK_IDS).join(', ');
    const more =
      taskIds.length > LISTED_TASK_IDS ? ` … and ${taskIds.length - LISTED_TASK_IDS} more` : '';
    super(
      `Boot aborted — the deployed document (workforce '${workforceId}') no longer carries ` +
        `${missing.join(', ')}, but non-terminal tasks still reference the departed ` +
        `declaration(s): ${listed}${more}. A redeploy may not remove or rename a workforce, ` +
        'employee, department or team while live work references it — complete, cancel or re-own ' +
        'those tasks first, or restore the declaration. Pure additions always deploy.',
    );
    this.name = 'WorkforceSpecChangeError';
    this.workforceId = workforceId;
    this.taskIds = taskIds;
  }
}

/** Parse a delegation record's original target string. A bare value is an employee id. */
export function parseDelegatedTo(raw: string): {
  readonly kind: 'employee' | 'department' | 'team';
  readonly id: string;
} {
  const match = /^(employee|department|team):(.+)$/.exec(raw);
  if (match) {
    return { kind: match[1] as 'employee' | 'department' | 'team', id: match[2] as string };
  }
  return { kind: 'employee', id: raw };
}

/**
 * The redeploy gate. Refuses (typed, task ids named) when live non-terminal state references a
 * declaration the new document no longer carries. Runs BEFORE the deploy pipeline so a refusal
 * precedes any DDL or mount; an empty database (the first deploy) passes trivially.
 *
 * `workforce` is OPTIONAL because a document that declares none is the maximal removal, not an
 * exemption — see the module header.
 */
export async function assertWorkforceSpecCompatible(
  tdb: TenantDb,
  workforce: WorkforceSpec | undefined,
): Promise<void> {
  const declaredId = workforce?.id ?? null;
  const employees = new Set(workforce?.employees.map((e) => e.id) ?? []);
  const departments = new Set(workforce?.departments.map((d) => d.id) ?? []);
  const teams = new Set(workforce?.teams.map((t) => t.id) ?? []);

  const missing = new Set<string>();
  const strandedTaskIds = new Set<string>();

  // EVERY live non-terminal task that belongs to SOME workforce — no id filter, because the id
  // itself is one of the declarations under test. A bare platform task carries a NULL workforce id
  // and is not a workforce declaration; SQL NULL semantics exclude it from the predicate.
  const declaredIds = await markedWorkforceIds(tdb);
  const tasks = (await tdb
    .select(schema.workforceTasks, {
      taskId: schema.workforceTasks.taskId,
      workforceId: schema.workforceTasks.workforceId,
      owner: schema.workforceTasks.owner,
      department: schema.workforceTasks.department,
    })
    .where(
      and(
        isNotNull(schema.workforceTasks.workforceId),
        notInArray(schema.workforceTasks.status, [...TERMINAL_STATUSES]),
      ),
    )) as Array<{
    taskId: string;
    workforceId: string;
    owner: string;
    department: string | null;
  }>;

  // 1. Live work under a MARKED workforce id this document no longer declares — the section was
  //    deleted, or the id renamed. Its employees/departments are not checked individually: the
  //    whole workforce is gone, and naming every member of it would bury the fact that matters.
  //    An UNMARKED id is nobody's declaration (see the header) and is passed over here.
  const ownTasks: typeof tasks = [];
  for (const task of tasks) {
    if (task.workforceId === declaredId) {
      ownTasks.push(task);
    } else if (declaredIds.has(task.workforceId)) {
      missing.add(`workforce '${task.workforceId}'`);
      strandedTaskIds.add(task.taskId);
    }
  }

  // 2. Non-terminal tasks under the STILL-DECLARED workforce whose OWNER or DEPARTMENT departed.
  //    'user' is the human-owner sentinel and is never a declaration.
  for (const task of ownTasks) {
    if (task.owner !== 'user' && !employees.has(task.owner)) {
      missing.add(`employee '${task.owner}'`);
      strandedTaskIds.add(task.taskId);
    }
    if (task.department !== null && !departments.has(task.department)) {
      missing.add(`department '${task.department}'`);
      strandedTaskIds.add(task.taskId);
    }
  }

  // 3. Live delegations whose ORIGINAL target departed (a team resolves to its lead at delegation
  //    time, so tasks alone cannot witness a team removal — the delegation record can).
  const openTaskIds = ownTasks.map((t) => t.taskId);
  if (declaredId !== null && openTaskIds.length > 0) {
    const delegations = (await tdb
      .select(schema.workforceDelegations, {
        childTaskId: schema.workforceDelegations.childTaskId,
        delegatedTo: schema.workforceDelegations.delegatedTo,
      })
      .where(
        and(
          eq(schema.workforceDelegations.workforceId, declaredId),
          inArray(schema.workforceDelegations.childTaskId, openTaskIds),
        ),
      )) as Array<{ childTaskId: string; delegatedTo: string }>;
    for (const delegation of delegations) {
      const target = parseDelegatedTo(delegation.delegatedTo);
      const declared =
        target.kind === 'employee'
          ? employees.has(target.id)
          : target.kind === 'department'
            ? departments.has(target.id)
            : teams.has(target.id);
      if (!declared) {
        missing.add(`${target.kind} '${target.id}'`);
        strandedTaskIds.add(delegation.childTaskId);
      }
    }
  }

  if (missing.size > 0) {
    throw new WorkforceSpecChangeError(
      declaredId ?? '(none)',
      [...missing].sort(),
      [...strandedTaskIds].sort(),
    );
  }
}

/**
 * The workforce ids whose runtime row carries a DECLARATION MARKER — the ids some document declared,
 * as opposed to ids that only ever labelled engine-owned tasks. The gate's whole ability to call a
 * removal a removal rests on this set; see the module header.
 */
async function markedWorkforceIds(tdb: TenantDb): Promise<Set<string>> {
  const rows = (await tdb
    .select(schema.workforceRuntime, {
      workforceId: schema.workforceRuntime.workforceId,
      budgets: schema.workforceRuntime.budgets,
    })
    .all()) as Array<{ workforceId: string; budgets: unknown }>;
  const marked = new Set<string>();
  for (const row of rows) {
    if (declarationMarkerOf(row.budgets) !== null) marked.add(row.workforceId);
  }
  return marked;
}

/** Read the marker off a stored budgets payload without imposing the engine's strict parse. */
function declarationMarkerOf(budgets: unknown): string | null {
  if (budgets === null || typeof budgets !== 'object') return null;
  const value = (budgets as { declaredAt?: unknown }).declaredAt;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Persist the DECLARED budgets onto the runtime row — the third `ensureWorkforceRuntime` argument
 * is exactly this boot hook. Idempotent (upsert on the UNIQUE (tenant, workforce) key), so every
 * reboot refreshes the declared ceilings and the very next dispatch reads them.
 *
 * This is ALSO the only writer of the DECLARATION MARKER (`budgets.declaredAt`): reaching here means
 * a deployed document declared this workforce id, which is exactly the fact the redeploy gate cannot
 * otherwise learn. The stamp is refreshed every boot, so its value reads as "the last boot that
 * declared this workforce".
 */
export async function ensureDeclaredWorkforceRuntime(
  tdb: TenantDb,
  workforce: WorkforceSpec,
): Promise<void> {
  await ensureWorkforceRuntime(tdb, workforce.id, {
    ...(deriveWorkforceBudgets(workforce) as Readonly<Record<string, unknown>>),
    declaredAt: new Date().toISOString(),
  });
}

/**
 * RELEASE the declaration marker of every workforce this document no longer declares — run AFTER
 * the gate has passed, so it only ever runs on a retirement the gate found clean (nothing live
 * references the departed id).
 *
 * Clearing rather than leaving it is deliberate: the marker asserts "a document declares this id",
 * and once one has stopped and the retirement is clean, that is simply no longer true. A marker left
 * behind would make a LATER engine-only boot refuse over tasks created under that id long after the
 * workforce was legitimately retired — a refusal naming a declaration nobody would recognise.
 *
 * The budgets stay untouched: they are a fact about ceilings, and the runtime row still serves the
 * `/v1/workforce` control surface for whatever work continues under that id.
 */
export async function releaseDepartedWorkforceDeclarations(
  tdb: TenantDb,
  workforce: WorkforceSpec | undefined,
): Promise<void> {
  const rows = (await tdb
    .select(schema.workforceRuntime, {
      workforceId: schema.workforceRuntime.workforceId,
      budgets: schema.workforceRuntime.budgets,
    })
    .all()) as Array<{ workforceId: string; budgets: unknown }>;
  for (const row of rows) {
    if (row.workforceId === workforce?.id) continue;
    if (declarationMarkerOf(row.budgets) === null) continue;
    const { declaredAt: _released, ...rest } = row.budgets as Record<string, unknown>;
    await tdb
      .update(schema.workforceRuntime, { budgets: rest })
      .where(eq(schema.workforceRuntime.workforceId, row.workforceId));
  }
}
