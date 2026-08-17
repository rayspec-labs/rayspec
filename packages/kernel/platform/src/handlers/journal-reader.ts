/**
 * The RUN-JOURNAL READ door a `{handler}` route receives as `init.journal`.
 *
 * WHY IT EXISTS. The journal is written for every deployment and read by none of them through a
 * contract: a handler that had to serve back what its work was recorded as could only name
 * `journal_steps` and its column layout in a SQL string. This builds the same read as a typed,
 * tenant-scoped, bounded page — so the table name lives in ONE place the compiler can see instead of
 * in a text literal in somebody else's repository.
 *
 * TENANT SCOPING IS STRUCTURAL, NOT A PARAMETER. Every statement goes through the supplied `TenantDb`,
 * which AND-combines `tenant_id = <the run's server-derived tenant>` into the WHERE. There is no
 * tenant argument on this door and no way to add one to a query: a cursor, a `runId` or a `limit` from
 * another tenant reads as no rows, indistinguishable from a run that does not exist.
 *
 * ⚠ IT IS BUILT OVER THE BASE TENANT HANDLE, NOT THE ROUTE TRANSACTION. An incremental
 * (`sseResponse`) response's producer runs AFTER the route transaction has committed — that is the
 * engine's ordering, not a choice made here — so a reader bound to the transactional handle would be
 * dead exactly where a streamed replay needs it. What that costs is stated rather than hidden: a read
 * does not see the route's own uncommitted writes, and it costs nothing, because a route does not
 * write the journal (the platform records the steps its work produced).
 *
 * THE CURSOR IS A KEYSET, NOT AN OFFSET. `(created_at, step_id)` is the total order — `created_at`
 * alone is not unique (parallel steps of one turn land in the same instant) and `step_id` alone is a
 * random uuid with no order — so the cursor carries both and the read continues strictly after that
 * pair. Two properties follow that an OFFSET page cannot promise: a row appended between two reads
 * never shifts a page under the client, and resuming is exact rather than approximate. The timestamp
 * is carried at the database's OWN precision (`to_char(… .US …)`, microseconds) and bound back as
 * `timestamptz`: a JavaScript `Date` would truncate it to milliseconds, and a truncated anchor
 * re-delivers every row recorded in the same millisecond on every resume.
 *
 * A CURSOR IT CANNOT PARSE IS REFUSED, with an `Error` whose `name` is `PackJournalCursorError` — the
 * typed-refusal idiom the pack surface already uses for a transaction-control statement. Reading from
 * the beginning instead would re-deliver everything the client already saw, which is the exact failure
 * a resume exists to prevent; an empty read would be worse still, being indistinguishable from "there
 * is nothing left".
 */
import { schema, type TenantDb } from '@rayspec/db';
import type {
  HandlerJournal,
  HandlerJournalEntry,
  HandlerJournalPage,
  HandlerJournalQuery,
  HandlerJournalStatus,
  HandlerJournalStepType,
} from '@rayspec/handler-sdk';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';

/** The page size a read takes when the caller names none. */
const DEFAULT_JOURNAL_LIMIT = 100;
/** The hard bound a caller cannot ask past (the same 200 the declared store `list` page is capped at). */
const MAX_JOURNAL_LIMIT = 200;

/** The `Error.name` a refused cursor carries — the pack surface documents it under this exact name. */
const CURSOR_ERROR_NAME = 'PackJournalCursorError';

/**
 * The cursor's two halves, joined by a character neither can contain: the microsecond ISO timestamp
 * (digits, `-`, `:`, `.`, `T`, `Z`) and the step's uuid.
 */
const CURSOR_SEPARATOR = '|';
const CURSOR_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;
const CURSOR_STEP_ID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The recorded timestamp at the DATABASE's precision, ISO-8601 shaped. Selected as text rather than as
 * a `Date` for the reason the module header gives: a `Date` round trip truncates the microseconds the
 * keyset comparison depends on.
 */
const CREATED_AT_ISO = sql<string>`to_char(${schema.journalSteps.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Build the refusal a malformed cursor rejects with (named, so a caller can branch on it). */
function cursorError(message: string): Error {
  const err = new Error(message);
  err.name = CURSOR_ERROR_NAME;
  return err;
}

/** Split a cursor into its keyset halves, refusing anything this reader did not mint. */
function parseCursor(cursor: string): { createdAt: string; stepId: string } {
  const at = cursor.lastIndexOf(CURSOR_SEPARATOR);
  const createdAt = at === -1 ? '' : cursor.slice(0, at);
  const stepId = at === -1 ? '' : cursor.slice(at + 1);
  if (!CURSOR_TIMESTAMP_SHAPE.test(createdAt) || !CURSOR_STEP_ID_SHAPE.test(stepId)) {
    throw cursorError(
      `journal read: cursor '${cursor}' is not a cursor this reader issued (expected ` +
        '<timestamp>|<stepId>). A cursor is opaque — pass back one an entry carried, or omit it to ' +
        'read from the beginning. Refusing rather than replaying from zero.',
    );
  }
  return { createdAt, stepId };
}

/** Coerce a `numeric` column (the driver hands these back as strings) to a number, never to `NaN`. */
function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The columns a read projects — the neutral half of the record, plus the cursor's timestamp half. */
const PROJECTION = {
  stepId: schema.journalSteps.stepId,
  runId: schema.journalSteps.runId,
  tenantId: schema.journalSteps.tenantId,
  type: schema.journalSteps.type,
  idempotencyKey: schema.journalSteps.idempotencyKey,
  inputHash: schema.journalSteps.inputHash,
  output: schema.journalSteps.output,
  inputTokens: schema.journalSteps.inputTokens,
  outputTokens: schema.journalSteps.outputTokens,
  totalTokens: schema.journalSteps.totalTokens,
  costUsd: schema.journalSteps.costUsd,
  latencyMs: schema.journalSteps.latencyMs,
  status: schema.journalSteps.status,
  createdAtIso: CREATED_AT_ISO,
};

/** One projected row as the driver hands it back (numerics as strings, the payload as parsed jsonb). */
interface ProjectedRow {
  readonly stepId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly output: unknown;
  readonly inputTokens: unknown;
  readonly outputTokens: unknown;
  readonly totalTokens: unknown;
  readonly costUsd: unknown;
  readonly latencyMs: unknown;
  readonly status: string;
  readonly createdAtIso: string;
}

/**
 * Shape one row into the contracted entry. The two closed vocabularies are RE-VALIDATED on the way out
 * rather than trusted because they were valid on the way in: the column is `text` and the journal
 * carries a wider classification set than the API-facing one (a tool failure is journaled with a class
 * the neutral vocabulary deliberately does not contain), so a value outside the contract is mapped to
 * its fail-closed member instead of being handed on as a lie about the vocabulary.
 */
function toEntry(row: ProjectedRow): HandlerJournalEntry {
  const type: HandlerJournalStepType =
    row.type === 'llm' || row.type === 'tool' || row.type === 'store' ? row.type : 'tool';
  const status: HandlerJournalStatus = row.status === 'ok' ? 'ok' : 'error';
  return {
    stepId: row.stepId,
    runId: row.runId,
    tenantId: row.tenantId,
    type,
    idempotencyKey: row.idempotencyKey,
    inputHash: row.inputHash,
    output: row.output,
    usage: {
      inputTokens: numeric(row.inputTokens),
      outputTokens: numeric(row.outputTokens),
      totalTokens: numeric(row.totalTokens),
    },
    costUsd: numeric(row.costUsd),
    latencyMs: numeric(row.latencyMs),
    status,
    createdAt: row.createdAtIso,
    cursor: `${row.createdAtIso}${CURSOR_SEPARATOR}${row.stepId}`,
  };
}

/**
 * Build the journal read door for `tdb`'s tenant. The handle is captured, so the returned reader has
 * no tenant parameter and no path to one — the same construction `init.emit` and `init.enqueue` use.
 */
export function makeHandlerJournal(tdb: TenantDb): HandlerJournal {
  return {
    async read(query: HandlerJournalQuery = {}): Promise<HandlerJournalPage> {
      // Clamp rather than reject: an out-of-range `limit` is a caller asking for more than the door
      // gives, not a malformed request, and the page already says whether more entries wait.
      const asked = Number(query.limit ?? DEFAULT_JOURNAL_LIMIT);
      const limit = Number.isFinite(asked)
        ? Math.min(Math.max(Math.trunc(asked), 1), MAX_JOURNAL_LIMIT)
        : DEFAULT_JOURNAL_LIMIT;

      const predicates: SQL[] = [];
      if (query.runId !== undefined) {
        predicates.push(eq(schema.journalSteps.runId, query.runId));
      }
      if (query.after !== undefined) {
        const { createdAt, stepId } = parseCursor(query.after);
        // The KEYSET bound. Both halves are BOUND VALUES (the driver parameterizes a `sql` template's
        // interpolations), so the cursor's text never becomes part of the statement.
        predicates.push(
          sql`(${schema.journalSteps.createdAt}, ${schema.journalSteps.stepId}) > (${createdAt}::timestamptz, ${stepId}::uuid)`,
        );
      }

      // Read ONE past the page so `hasMore` is measured rather than inferred from a full page.
      const rows = (await tdb
        .select(schema.journalSteps, PROJECTION)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(schema.journalSteps.createdAt), asc(schema.journalSteps.stepId))
        .limit(limit + 1)) as unknown as ProjectedRow[];

      const hasMore = rows.length > limit;
      const entries = (hasMore ? rows.slice(0, limit) : rows).map(toEntry);
      const last = entries[entries.length - 1];
      return {
        entries,
        // Spread so the key is ABSENT (not `undefined`) on an empty page — there is nothing to
        // advance past, and a caller keeps the cursor it already had.
        ...(last ? { nextCursor: last.cursor } : {}),
        hasMore,
      };
    },
  };
}
