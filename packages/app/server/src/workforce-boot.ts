/**
 * Workforce boot wiring — the two things a deploy/serve does for a declared `workforce:` section
 * BEYOND parsing it: (1) the REDEPLOY GATE — a new document may not remove or rename an employee,
 * department, team OR THE WORKFORCE ITSELF while live non-terminal tasks still reference it (pure
 * additions always deploy); (2) persisting the DERIVED budgets onto the per-workforce runtime row
 * (the engine reads ceilings from that row at every dispatch). Org structure itself is never
 * persisted — it derives fresh from the deployed document at every boot.
 *
 * There is no stored prior declaration, so removals are detected from LIVE EVIDENCE — the only
 * thing a redeploy can actually strand: a non-terminal task under a workforce id the document no
 * longer declares, a non-terminal task whose owner or department it no longer declares, or a live
 * delegation whose original target names a departed employee/department/team. `deploy --dry-run`
 * has no database and cannot run this check; its output says so.
 *
 * THE GATE READS THE DATABASE FIRST AND THE DOCUMENT SECOND. A gate keyed on the declared id can
 * only ever ask "is THIS id's live work still declared?", so RENAMING `workforce.id` pointed every
 * query at an id no row carried: it matched zero rows and passed trivially while the live tasks
 * kept dispatching under the old id, against a runtime row nothing would refresh again. Live
 * workforce ids are therefore enumerated from the task rows and each is checked against what the
 * document declares.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GATE CANNOT SEE: A DOCUMENT THAT DROPS `workforce:` ENTIRELY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * That is the maximal removal, and it is NOT checked here — not as an oversight, but because the
 * database cannot distinguish the two situations it would have to tell apart:
 *
 *   - a deployment that DECLARED a workforce and just removed it (live work is stranded: with no
 *     declaration, no turn-handler resolver is wired and every dispatched owner fails typed), and
 *   - a deployment that NEVER declared one and runs the task engine directly (`workforce_tasks`
 *     rows carry a `workforce_id` for budget and control scoping whoever created them — the
 *     `/v1/workforce` surface exists precisely for this, and it is a shipped, supported posture).
 *
 * Both leave IDENTICAL evidence: non-terminal tasks with a workforce id, a runtime row (the
 * scheduler creates one on first dispatch), delegation rows, a journal. Nothing on any row records
 * that a DOCUMENT once declared the id. Refusing on the shared evidence would abort every
 * engine-only deployment, so the gate declines to guess.
 *
 * Closing it needs the one thing the module header above says does not exist — a stored prior
 * declaration — which is a deliberate design decision (what to record, where, and how a first boot
 * after the change behaves), not a fix-up. Until then this case is UNGATED and named as such here,
 * rather than implied to be covered by the rename check next to it.
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

  // 1. Live work under a workforce id this document declares DIFFERENTLY — the id was renamed. Its
  //    employees/departments are not checked individually: the whole workforce is gone under that
  //    name, and naming every member of it would bury the fact that matters. Only reachable when a
  //    workforce IS declared; see the header for why a document declaring none cannot ask this.
  const ownTasks: typeof tasks = [];
  for (const task of tasks) {
    if (declaredId !== null && task.workforceId !== declaredId) {
      missing.add(`workforce '${task.workforceId}'`);
      strandedTaskIds.add(task.taskId);
    } else if (task.workforceId === declaredId) {
      ownTasks.push(task);
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
 * Persist the DECLARED budgets onto the runtime row — the third `ensureWorkforceRuntime` argument
 * is exactly this boot hook. Idempotent (upsert on the UNIQUE (tenant, workforce) key), so every
 * reboot refreshes the declared ceilings and the very next dispatch reads them.
 */
export async function ensureDeclaredWorkforceRuntime(
  tdb: TenantDb,
  workforce: WorkforceSpec,
): Promise<void> {
  await ensureWorkforceRuntime(
    tdb,
    workforce.id,
    deriveWorkforceBudgets(workforce) as Readonly<Record<string, unknown>>,
  );
}
