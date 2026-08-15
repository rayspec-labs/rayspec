/**
 * The task-history RECALL PROVIDER — the shipped `WorkforceMemoryProvider`: recency- and
 * keyword-ranked recall over THIS TENANT'S OWN prior work, so an employee's turn starts with what
 * this workforce already did instead of a blank slate. Two corpora, both already durable:
 *
 *   - COMPLETED TASK RESULTS — `workforce_tasks` rows scoped to this employee (owner) and their
 *     department, excluding the current root's whole subtree (the task's own children arrive in
 *     the assembly's section 5; recall is PRIOR work, never a mirror);
 *   - JOURNALED DECISIONS — review verdicts, approval decisions and raised escalations from
 *     `run_events`, resolved onto the SAME scoped task set (two bounded reads through the tenant
 *     chokepoint; the journal itself carries no owner column, so scoping rides the task rows).
 *
 * SCOPING IS CONSTRUCTOR-INJECTED TRUSTED DATA — the workforce id, the employee id, the
 * department and the current root come from the deployed configuration and the dispatched task
 * row, never from the query: the frozen `MemoryQuery` shape cannot carry them, and a
 * `query.workforceId` naming any OTHER workforce returns nothing, fail-closed. Every read runs on
 * the caller's TenantDb, so recall can never cross the tenant.
 *
 * `remember` RETAINS NOTHING, honestly: the engine already durably stores every result and
 * journals every decision this provider reads — there is no second store, no migration, and
 * nothing a caller could remember here that the durable rows do not already carry. A provider
 * with its own store replaces this one through the seam.
 *
 * Ranking is recency plus keyword match and NOTHING MORE — no embeddings, no decision
 * extraction, no consolidation. Deterministic per construction: ages and the recency decay are
 * computed from the injected `now`, ordering ties break on stable ids, and the same rows with
 * the same query rank identically every time.
 */
import type { MemoryEntry, MemoryHit, MemoryQuery, WorkforceMemoryProvider } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import type { TaskRecord } from '@rayspec/tasks';
import { and, asc, desc, eq, gte, inArray, ne, or, type SQL } from 'drizzle-orm';

/** Recall's bounds: row scans, age window, hit text and hit count. */
export const RECALL_SCAN_LIMIT = 200;
export const RECALL_MAX_AGE_MS = 30 * 24 * 3_600_000;
export const RECALL_HIT_TEXT_MAX_CHARS = 300;
export const RECALL_MAX_HITS = 10;
const RECALL_DEFAULT_HITS = 5;
const MAX_QUERY_TOKENS = 8;
/** Keyword dominance: one matched token outweighs any recency difference (decay is in [0, 1]). */
const TOKEN_MATCH_WEIGHT = 10;

/** The journal types recall reads as DECISIONS. A closed list — a new decision-shaped event is
 * added here deliberately, with its own renderer below. */
const DECISION_EVENT_TYPES = [
  'workforce.review.decided',
  'workforce.approval.decided',
  'workforce.escalation.raised',
] as const;

export interface RecallScope {
  readonly workforceId: string;
  readonly employeeId: string;
  readonly department: string | null;
  /** The dispatched task's root — its whole subtree is excluded (prior work only). */
  readonly currentRootTaskId: string;
  /** The clock, injected: ages and decay are deterministic per construction. */
  readonly now: Date;
}

/** Tokenize a recall query: lowercase word stems ≥ 3 chars, deduped, first N. Deterministic. */
export function tokenizeRecallQuery(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((token) => token.length >= 3),
    ),
  ].slice(0, MAX_QUERY_TOKENS);
}

/** The deterministic age label a hit is stamped with: `<1h`, `Nh` under two days, else `Nd`. */
export function formatRecallAge(ageMs: number): string {
  if (ageMs < 3_600_000) return '<1h';
  if (ageMs < 48 * 3_600_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / (24 * 3_600_000))}d`;
}

/** Score one candidate: matched tokens dominate; recency decays linearly over the age window. */
export function scoreRecallCandidate(input: {
  readonly tokens: readonly string[];
  readonly haystack: string;
  readonly ageMs: number;
}): number {
  const haystack = input.haystack.toLowerCase();
  const matches = input.tokens.filter((token) => haystack.includes(token)).length;
  const recency = Math.min(Math.max((RECALL_MAX_AGE_MS - input.ageMs) / RECALL_MAX_AGE_MS, 0), 1);
  return matches * TOKEN_MATCH_WEIGHT + recency;
}

interface Candidate {
  readonly id: string;
  readonly text: string;
  readonly haystack: string;
  readonly ageMs: number;
}

function clampText(text: string): string {
  return text.length <= RECALL_HIT_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, RECALL_HIT_TEXT_MAX_CHARS - 1)}…`;
}

function resultSummary(result: unknown): string | null {
  if (typeof result === 'object' && result !== null && 'summary' in result) {
    const summary = (result as { summary: unknown }).summary;
    return typeof summary === 'string' ? summary : null;
  }
  return null;
}

/** Render one journaled decision as recall text; null for a payload outside the known shapes. */
function decisionText(type: string, payload: Record<string, unknown>): string | null {
  if (type === 'workforce.review.decided') {
    const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
    const first = typeof reasons[0] === 'string' ? `: ${reasons[0]}` : '';
    return `review ${String(payload.verdict)} (round ${String(payload.round)}) by '${String(payload.reviewer)}'${first}`;
  }
  if (type === 'workforce.approval.decided') {
    const reason = typeof payload.reason === 'string' ? `: ${payload.reason}` : '';
    return `approval ${String(payload.decision)} by ${String(payload.decidedBy)}${reason}`;
  }
  if (type === 'workforce.escalation.raised') {
    return `escalated (${String(payload.reason)}) to '${String(payload.escalateTo)}'`;
  }
  return null;
}

export class TaskHistoryMemoryProvider implements WorkforceMemoryProvider {
  readonly id = 'task-history-recency-keyword';
  readonly #tdb: TenantDb;
  readonly #scope: RecallScope;

  constructor(tdb: TenantDb, scope: RecallScope) {
    this.#tdb = tdb;
    this.#scope = scope;
  }

  async search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    // The frozen query shape cannot carry scoping — and a caller naming a DIFFERENT workforce
    // gets nothing rather than this one's memory under the wrong label. Fail-closed.
    if (query.workforceId !== undefined && query.workforceId !== this.#scope.workforceId) {
      return [];
    }
    const scope = this.#scope;
    const cutoff = new Date(scope.now.getTime() - RECALL_MAX_AGE_MS);
    const tasks = schema.workforceTasks;

    // The employee's reach: their own tasks, plus their department's. Both are trusted config
    // facts; a department-less employee recalls their own work only.
    const reach: SQL | undefined =
      scope.department !== null
        ? or(eq(tasks.owner, scope.employeeId), eq(tasks.department, scope.department))
        : eq(tasks.owner, scope.employeeId);

    // Corpus 1 — completed results: bounded, newest first, stable tiebreak.
    const completedRows = (await this.#tdb
      .select(tasks)
      .where(
        and(
          eq(tasks.workforceId, scope.workforceId),
          eq(tasks.status, 'completed'),
          ne(tasks.rootTaskId, scope.currentRootTaskId),
          gte(tasks.completedAt, cutoff),
          reach,
        ),
      )
      .orderBy(desc(tasks.completedAt), asc(tasks.taskId))
      .limit(RECALL_SCAN_LIMIT)) as TaskRecord[];

    // Corpus 2 — journaled decisions on the SAME scoped set (any status: a rejection on a task
    // still in rework is exactly the memory a sibling turn wants). Two bounded reads because the
    // journal carries no owner column — the scoped task page resolves the ids first.
    const scopedTaskRows = (await this.#tdb
      .select(tasks, { taskId: tasks.taskId, title: tasks.title, goal: tasks.goal })
      .where(
        and(
          eq(tasks.workforceId, scope.workforceId),
          ne(tasks.rootTaskId, scope.currentRootTaskId),
          gte(tasks.createdAt, cutoff),
          reach,
        ),
      )
      .orderBy(desc(tasks.createdAt), asc(tasks.taskId))
      .limit(RECALL_SCAN_LIMIT)) as Array<{ taskId: string; title: string; goal: string }>;
    const scopedById = new Map(scopedTaskRows.map((row) => [row.taskId, row]));
    const events = schema.runEvents;
    const decisionRows =
      scopedById.size === 0
        ? []
        : ((await this.#tdb
            .select(events, {
              runId: events.runId,
              type: events.type,
              data: events.data,
              seq: events.seq,
              createdAt: events.createdAt,
            })
            .where(
              and(
                inArray(events.runId, [...scopedById.keys()]),
                inArray(events.type, [...DECISION_EVENT_TYPES]),
                gte(events.createdAt, cutoff),
              ),
            )
            .orderBy(desc(events.createdAt), asc(events.runId), desc(events.seq))
            .limit(RECALL_SCAN_LIMIT)) as Array<{
            runId: string;
            type: string;
            data: unknown;
            seq: string;
            createdAt: Date;
          }>);

    const tokens = tokenizeRecallQuery(query.text);
    const candidates: Candidate[] = [];
    for (const row of completedRows) {
      const completedAt = row.completedAt instanceof Date ? row.completedAt : scope.now;
      const ageMs = Math.max(scope.now.getTime() - completedAt.getTime(), 0);
      const summary = resultSummary(row.result) ?? row.title;
      candidates.push({
        id: row.taskId,
        text: clampText(`[${row.taskId} · ${formatRecallAge(ageMs)}] ${summary}`),
        haystack: `${row.title} ${row.goal} ${summary}`,
        ageMs,
      });
    }
    for (const row of decisionRows) {
      const payload =
        typeof row.data === 'object' && row.data !== null
          ? (row.data as Record<string, unknown>)
          : {};
      const text = decisionText(row.type, payload);
      if (text === null) continue;
      const task = scopedById.get(row.runId);
      const ageMs = Math.max(scope.now.getTime() - row.createdAt.getTime(), 0);
      candidates.push({
        id: row.runId,
        text: clampText(`[${row.runId} · ${formatRecallAge(ageMs)}] ${text}`),
        haystack: `${task?.title ?? ''} ${task?.goal ?? ''} ${text}`,
        ageMs,
      });
    }

    const limit = Math.min(Math.max(query.limit ?? RECALL_DEFAULT_HITS, 0), RECALL_MAX_HITS);
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        text: candidate.text,
        score: scoreRecallCandidate({
          tokens,
          haystack: candidate.haystack,
          ageMs: candidate.ageMs,
        }),
      }))
      .sort(
        // Codepoint comparison, never localeCompare — a host locale must not reorder recall.
        (a, b) =>
          b.score - a.score ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
          (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
      )
      .slice(0, limit);
  }

  remember(_entry: MemoryEntry): Promise<void> {
    // Honest no-op — see the module header: the durable rows this provider reads ARE the memory.
    return Promise.resolve();
  }
}
