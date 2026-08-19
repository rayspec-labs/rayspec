/**
 * The `/v1/workforce/*` control surface, as an OpenAPI 3.1 section.
 *
 * WHAT THIS CLOSES. `buildDeclaredRoutesOpenApi` (emit-openapi.ts) documents the spec's DECLARED
 * `api[]` and nothing else, and `rayspec openapi` emits the PRODUCT-PROFILE view surface and refuses
 * a backend document. The workforce control routes are PLATFORM routes registered unconditionally in
 * `createAuthApp`, so they appeared in neither — an integrator holding a running deployment's base
 * URL could fetch a document that did not mention the 16 routes they actually needed, and could not
 * generate a client for them.
 *
 * WHY A DECORATOR AND NOT A SECOND DOCUMENT. There is exactly one served document, at
 * `GET /v1/openapi.json`, and it is assembled at one place (`app.ts`, the engine branch). This module
 * DECORATES that document on its way to the route — same document, same URL, same posture notice —
 * rather than introducing a parallel one. A second document would be a second thing to keep true.
 *
 * THE SECTION SAYS IT IS EXPERIMENTAL, IN THE DOCUMENT. `X-Experimental: workforce` already rides
 * every response from this prefix, and it stays; it is the marking a caller receives whether or not
 * they ever fetch a document. What a marking on the wire cannot do is reach a CLIENT GENERATOR,
 * which reads the document and never makes a request. So the section carries the marking three ways:
 * a top-level tag, the same extension keyword ON EVERY OPERATION (a generator that ignores `tags`
 * still sees it), and the `X-Experimental` header itself documented on every response. The keyword
 * is `x-rayspec-experimental` — the SAME spelling `spec.schema.json` uses for the grammar's
 * `workforce:` block, taken from `WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION` rather than retyped, so
 * a rename there fails THIS module's typecheck instead of quietly forking the vocabulary.
 *
 * ACCURACY: DERIVED WHERE IT CAN BE, HAND-WRITTEN WHERE IT CANNOT — and the difference is stated.
 *
 *   DERIVED (cannot drift):
 *     - every request body, via `z.toJSONSchema` over THE VERY Zod schema the handler parses
 *       (`routes/workforce.ts` exports them for this reason). `requestBody.required` is derived from
 *       whether that schema has any required member — which is why `cancel` and `pause` are
 *       documented as body-OPTIONAL (their handlers fall back to `{}`) and `halt` is not;
 *     - every task / approval / review row response, from `getTableColumns()` over the drizzle table
 *       the handler selects — so a column added to `workforce_tasks` appears here with no edit;
 *     - the closed vocabularies (`TASK_STATUSES`, `TASK_PRIORITIES`, `OPERATOR_SIGNAL_KINDS`,
 *       `APPROVAL_STATUSES`) and the paging/drain constants, imported from where they are enforced;
 *     - the error body, from the platform's own `ErrorEnvelope` Zod, emitted ONCE into
 *       `components.schemas.Error` and `$ref`ed by every non-2xx response.
 *
 *   HAND-WRITTEN, BUT CROSS-CHECKED AGAINST REAL RESPONSES:
 *     - the bespoke response envelopes — `status`, the three `cost` shapes, `pause`/`resume`,
 *       `signal`, `halt`/`cancel`, `goals`. These are assembled inline by the handlers
 *       (`c.json({...})`), so there is no object to derive them from — but
 *       `workforce-openapi.db.test.ts`'s `LIVE ENVELOPES` arm drives each one against a BOOTED
 *       server with real seeded engine state and asserts SET EQUALITY between the response's own
 *       top-level keys and this file's `required` list. Adding a field to a handler without adding
 *       it here goes RED, and so does the reverse. `LIVE ROW SHAPES` does the same for the list
 *       routes, which catches a wire/column divergence (a narrowed `.select`) that the table
 *       derivation above cannot see.
 *
 *   STILL UNCHECKED (say it; do not let a later edit quietly upgrade it):
 *     - NESTED shapes. Both live arms compare TOP-LEVEL keys only, so a change inside
 *       `status.budget`, `tree.budgets`, a `cost` group or a `goals` task entry stays green;
 *     - FIELD TYPES — key sets are compared, not types;
 *     - the review-verdict 200 and the 504 drain-timeout body, which need engine state the suite
 *       does not reach. (The approval-decide 200 is the approval ROW, covered by the inbox probe.);
 *     - the per-operation status-code SETS. Seven are cross-checked against a running server;
 *       the rest are read off `mapEngineError`.
 *
 *   TWO ERRORS ALREADY SHIPPED INTO THIS FILE'S FIRST DRAFT AND WERE CAUGHT BY READING THE
 *   HANDLERS, not by a red test — a `Retry-After` header on the goals 429 that this route does not
 *   send, and a missing 404 on the four list routes (`enforcePermission` refuses a tenantless
 *   credential with one, before any handler runs). Both are now observed. That is the hand-written
 *   half behaving exactly as the paragraph above warns; expect the next edit to be able to do it
 *   again, and re-read the handler rather than the neighbouring entry.
 *
 * TWO STRUCTURAL LOOPS, both in `workforce-openapi.db.test.ts`:
 *   1. the PATH/METHOD set here is compared, BOTH DIRECTIONS, against Hono's own registration table
 *      (`app.routes`) — a route added to `routes/workforce.ts` without an entry here goes RED, and
 *      so does an entry here whose route was removed;
 *   2. the SUCCESS-BODY top-level key set is compared, BOTH DIRECTIONS, against the bytes eleven
 *      real requests bring back from a booted server.
 * Neither reaches nested shapes or field types. Read the split above before adding a claim.
 *
 * DELIBERATELY NOT DOCUMENTED: `X-Request-Id`. The platform echoes it broadly, but this module only
 * documents headers whose presence on THIS surface is pinned by a test, and that one is not. An
 * under-claim is recoverable; an over-claim is the defect this program exists to prevent.
 *
 * NOT PREMIUM, NOT PRODUCT: this module reads no license, no edition and no tenant, and names no
 * product store, route or column. Every literal in it is a PLATFORM path or a platform constant.
 */
import { ErrorEnvelope } from '@rayspec/auth-core';
import { schema } from '@rayspec/db';
import type { WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION } from '@rayspec/spec';
import {
  OPERATOR_SIGNAL_KINDS,
  RESERVED_WORKFORCE_SEGMENTS,
  reviewVerdictSchema,
  TASK_STATUSES,
} from '@rayspec/tasks';
import { type Column, getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  APPROVAL_STATUSES,
  cancelRequestSchema,
  DEFAULT_PAGE,
  decideRequestSchema,
  goalRequestSchema,
  HTTP_DRAIN_TIMEOUT_MS,
  haltRequestSchema,
  MAX_PAGE,
  pauseRequestSchema,
  signalRequestSchema,
  TREE_MAX_TASKS,
  WORKFORCE_EXPERIMENTAL_HEADER,
  WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
} from '../routes/workforce.js';
import type {
  OpenApiDocument,
  OpenApiHeader,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiResponse,
} from './emit-openapi.js';

/** The path prefix this section owns. Also the prefix the drift guard scans the router for. */
export const WORKFORCE_SECTION_PREFIX = '/v1/workforce';

/** The OpenAPI tag every operation in this section carries. */
export const WORKFORCE_OPENAPI_TAG = 'workforce';

/**
 * The experimental extension keyword — ONE spelling across the repository.
 *
 * The type is the `x-`-prefixed key of the JSON-Schema annotation the grammar already ships
 * (`spec.schema.json` / `version-1.0.schema.json`). If that keyword is ever renamed, the literal
 * below stops satisfying the type and THIS FILE fails to compile — which is what keeps the document
 * marking and the schema marking from forking into two vocabularies a consumer has to watch twice.
 */
type ExperimentalExtensionKey = Extract<
  keyof typeof WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION,
  `x-${string}`
>;
const EXPERIMENTAL_EXTENSION_KEY: ExperimentalExtensionKey = 'x-rayspec-experimental';

/**
 * The tag's prose. States the stability claim; it does NOT restate the deployment posture.
 *
 * It also states HOW MUCH OF THIS SECTION IS MECHANICALLY VERIFIED. A generated client is built by
 * someone who has no access to this repository's test suite, so "which parts of this document are
 * checked against the running server" is knowledge they can only get from the document itself.
 * Shipping the verification posture inside the artifact is the difference between a contract and a
 * claim — and this section's own history says the difference matters: its first draft named a
 * response header the route does not send.
 */
const WORKFORCE_TAG_DESCRIPTION =
  'EXPERIMENTAL — the durable task-engine control surface. These routes are NOT part of the frozen ' +
  'v1.0 API. While the section is experimental its paths, request and response shapes, status codes ' +
  'and behaviour may change in any release, including a patch release, and no deprecation period is ' +
  'promised. Every response from this prefix also carries the ' +
  `\`${WORKFORCE_EXPERIMENTAL_HEADER}: ${WORKFORCE_EXPERIMENTAL_HEADER_VALUE}\` header.\n\n` +
  'HOW MUCH OF THIS SECTION IS VERIFIED, so you know what to trust. CHECKED against the running ' +
  'server, in both directions, by a test that fails if they disagree: (a) the set of paths and ' +
  'methods, against the router itself; (b) the TOP-LEVEL field names of each successful response, ' +
  'against real responses from a booted server. Also derived from the code rather than transcribed: ' +
  'every request body schema, and the task / approval / review row schemas. NOT CHECKED — treat as ' +
  'documentation rather than as contract: nested object shapes, field TYPES (only names are ' +
  'compared), and most status codes (seven are observed; the rest are transcribed from the error ' +
  'mapping). See docs/workforce-compatibility.md.';

/** Every non-2xx body on this surface is the platform's closed error envelope. */
const ERROR_SCHEMA_REF = { $ref: '#/components/schemas/Error' } as const;

/** The marking, documented as the fixed-value response header it actually is. */
const EXPERIMENTAL_RESPONSE_HEADER: OpenApiHeader = {
  description:
    'The section stability marking. Present on EVERY response from this prefix, including the ' +
    'fail-closed 501 and an unauthenticated 401.',
  schema: { type: 'string', const: WORKFORCE_EXPERIMENTAL_HEADER_VALUE },
};

const TRUNCATED_HEADER = (detail: string): OpenApiHeader => ({
  description: detail,
  schema: { type: 'string', enum: ['true', 'false'] },
});

// --- derivation helpers ------------------------------------------------------------------------

/**
 * Convert a Zod schema to JSON Schema with `io: 'input'` — the SAME setting the declared-route
 * emitter uses, so an optional or `.default()`ed member is documented as NOT required on input,
 * which is what the handler actually accepts.
 */
function toJsonSchema(s: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

/** The JSON-Schema fragment for one drizzle column, from the column's OWN declared type. */
function schemaForColumn(column: Column): Record<string, unknown> {
  // `numeric` columns are DELIBERATELY 'string' here: drizzle hands them back as strings and the
  // handlers return several of them unconverted (the default `cost` roll-up returns `settledUsd` /
  // `reservedUsd` verbatim). Reporting `number` would describe a wire shape that does not occur.
  const base: Record<string, unknown> = (() => {
    switch (column.dataType) {
      case 'number':
        // `integer` where the column really is one, so a generated client gets an int rather than a
        // float. Any other numeric column type falls through to the wider `number`, which is never
        // wrong — under-claiming here costs precision, over-claiming would cost correctness.
        return column.columnType === 'PgInteger' ? { type: 'integer' } : { type: 'number' };
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
        return { type: 'string', format: 'date-time' };
      case 'json':
        // Opaque by construction: `ancestry_path`, `dependencies`, `artifacts`, `result`,
        // `token_usage`, `join_policy`, `budgets` carry engine- or author-shaped payloads the
        // platform does not statically know.
        return {};
      case 'bigint':
        return { type: 'string' };
      default:
        return column.columnType === 'PgUUID'
          ? { type: 'string', format: 'uuid' }
          : { type: 'string' };
    }
  })();
  if (column.notNull) return base;
  const type = base.type;
  if (typeof type === 'string') return { ...base, type: [type, 'null'] };
  return base; // an untyped (json) column already admits null
}

/**
 * The wire shape of one row of `table`, DERIVED from its columns. Keys are the drizzle TS property
 * names, which is what `c.json(rows)` actually serializes; every column is `required` because a
 * `SELECT *` always returns it (nullable columns come back as `null`, not absent).
 */
function rowSchema(table: PgTable, title: string, description: string): Record<string, unknown> {
  const columns = getTableColumns(table);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, column] of Object.entries(columns)) {
    properties[key] = schemaForColumn(column as Column);
    required.push(key);
  }
  return { type: 'object', title, description, properties, required, additionalProperties: false };
}

const object = (
  properties: Record<string, unknown>,
  required: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
});

const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
  oneOf: [schema, { type: 'null' }],
});

const str = { type: 'string' } as const;
const nullableStr = { type: ['string', 'null'] } as const;
const nullableTimestamp = { type: ['string', 'null'], format: 'date-time' } as const;
const int = { type: 'integer' } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const strArray = { type: 'array', items: { type: 'string' } } as const;

// --- the row schemas the reads return -----------------------------------------------------------

const TASK_ROW = rowSchema(
  schema.workforceTasks,
  'WorkforceTask',
  'One durable task row, exactly as the tenant-scoped select returns it.',
);
const APPROVAL_ROW = rowSchema(
  schema.workforceApprovals,
  'WorkforceApproval',
  "One approval request row — the engine's human-in-the-loop accountability artifact.",
);
const REVIEW_ROW = rowSchema(
  schema.workforceReviews,
  'WorkforceReview',
  'One review row. `verdict` is null while the review is undecided.',
);

// --- the bespoke response envelopes (HAND-WRITTEN — see the module header) ----------------------

/**
 * MERGE NOTE FOR WHOEVER LANDS THE BUDGET-REPORTING BRANCH ON TOP OF THIS ONE — read this before
 * silencing the red it will give you.
 *
 * That branch adds THREE top-level fields to `GET /v1/workforce/{workforceId}/status`:
 * `budgetExhausted`, `blockedOnBudget` and `budgetTiers`. They do NOT exist on this branch, so they
 * are deliberately absent from `STATUS_RESPONSE` — documenting a field the handler does not send is
 * an over-promise, and this file's own mutation battery (M12) proves the `LIVE ENVELOPES` arm reds
 * on exactly that. The arm will red on merge; that is the mechanism working, not a defect. Add the
 * three fields here and it goes green.
 *
 * ADD THE SEMANTICS TOO, NOT JUST THE KEYS. `LIVE ENVELOPES` compares TOP-LEVEL KEY NAMES only, so
 * everything below is invisible to it — the document is the only place these can live, and every
 * one is an overclaim waiting to happen:
 *
 *   - `consumedUsd` is NOT bounded by `ceilingUsd`. The denial fires when the NEXT turn's
 *     reservation would cross the line, so the turn already in flight is never aborted and settles
 *     above the ceiling by at most its own cost.
 *   - `headroomUsd` FLOORS AT 0, so 0 means "at OR PAST", never "exactly at". The unclamped
 *     `consumedUsd` beside it is the only field that distinguishes the two.
 *   - `consumedTurns` counts DISPATCHED turns, metered at AUTHORIZE; `consumedUsd` is metered at
 *     SETTLEMENT. They move at different moments — do not let the schema imply they move together.
 *   - `exhausted` is `>=`, not `>`. Landing exactly on a turns ceiling is the ORDINARY case, since
 *     turns increment by one.
 *   - `budgetExhausted` is `any tier exhausted` OR `blockedOnBudget > 0`. The disjunction is
 *     load-bearing: the tier half catches a spent ceiling with an empty queue, the parked half
 *     catches the `task` and `subtree` scopes. It means "a declared ceiling somewhere is spent",
 *     NOT "this workforce is dead".
 *   - `blockedOnBudget` counts PARKS, not CAUSES — it does not say which tier refused. That is in
 *     the journal (`workforce.budget.exceeded` carries scopeKind/scopeId/ceiling/consumed).
 *
 * AND THE ONE THAT IS AN OVERCLAIM BY OMISSION: `budgetTiers` enumerates only the tiers whose
 * cardinality the DECLARATION bounds — the workforce and each declared department. The `task` and
 * `subtree` scopes are NEVER in it, because they are one ledger row per task and per submitted
 * goal. So `budgetTiers` is NOT a complete list of the ceilings that can refuse work, and a client
 * that renders it as "here are your budgets" will mislead an operator whose runs are being denied
 * by a scope the array never shows. Say that in the field's own description rather than leaving it
 * inferable from the `scopeKind` enum, and say that `budgetExhausted` + `blockedOnBudget` are what
 * cover those two invisible scopes. The same caveat already applies to `budget` below and is
 * written there.
 */
const STATUS_RESPONSE = object(
  {
    workforceId: str,
    paused: {
      ...bool,
      description:
        'THE LIVENESS FLAG — the only field that answers "is this workforce stopped right now". A ' +
        'halt implies a pause, so this covers both operator verbs.',
    },
    pausedAt: nullableTimestamp,
    pausedBy: nullableStr,
    haltReason: {
      ...nullableStr,
      description:
        'HISTORICAL: why this workforce was LAST halted. It is NOT cleared by a resume, so ' +
        '`{ paused: false, haltReason: "incident" }` is a normal RUNNING state. Branching on this ' +
        'to decide liveness reports a resumed workforce as halted forever — branch on `paused`.',
    },
    tasks: {
      type: 'object',
      description:
        'Task counts by status, aggregated in the database. Absent statuses are omitted.',
      additionalProperties: int,
    },
    queueDepth: int,
    oldestQueuedAt: nullableTimestamp,
    budget: {
      ...nullable(
        object({ ceilingUsd: num, consumedUsd: num, headroomUsd: num }, [
          'ceilingUsd',
          'consumedUsd',
          'headroomUsd',
        ]),
      ),
      description:
        'Headroom on the CURRENT workforce budget window; null when no whole-workforce usd ceiling ' +
        'is declared. NOT A COMPLETE PICTURE OF WHAT CAN REFUSE WORK: this is the WORKFORCE tier ' +
        'alone. The engine also enforces `department`, `task` and `subtree` ceilings, and any of ' +
        'them can park a task with none of it visible here — a null `budget` does NOT mean "no ' +
        'ceiling can stop this workforce". `consumedUsd` is NOT bounded by `ceilingUsd`: a ceiling ' +
        'bounds what may be DISPATCHED, not what may be SETTLED, so a turn already in flight ' +
        'settles above it by at most its own cost. `headroomUsd` is floored at 0, so 0 means "at ' +
        'OR PAST the ceiling", never "exactly at it" — the unclamped `consumedUsd` beside it is ' +
        'what distinguishes the two.',
    },
  },
  [
    'workforceId',
    'paused',
    'pausedAt',
    'pausedBy',
    'haltReason',
    'tasks',
    'queueDepth',
    'oldestQueuedAt',
    'budget',
  ],
);

const TREE_RESPONSE = object(
  {
    rootTaskId: str,
    tasks: {
      type: 'array',
      items: TASK_ROW,
      description:
        `The whole subtree, FLAT, in \`taskId\` ascending order, capped at ${TREE_MAX_TASKS} rows. ` +
        "The root ALWAYS rides the response. Parent pointers are on the rows; nesting is the caller's.",
    },
    budgets: nullable(
      object({ taskUsd: nullable(num), taskTurns: nullable(int) }, ['taskUsd', 'taskTurns']),
    ),
  },
  ['rootTaskId', 'tasks', 'budgets'],
);

const COST_SCOPE = object(
  {
    scopeKind: str,
    scopeId: str,
    windowStart: { type: 'string', format: 'date-time' },
    reservedUsd: str,
    settledUsd: str,
    settledTurns: int,
  },
  ['scopeKind', 'scopeId', 'windowStart', 'reservedUsd', 'settledUsd', 'settledTurns'],
);

const COST_RESPONSE = {
  oneOf: [
    object(
      {
        window: str,
        totalSettledUsd: {
          ...num,
          description: 'Sums the `task`-scope rows OF THE RETURNED PAGE, not of the whole window.',
        },
        scopes: { type: 'array', items: COST_SCOPE },
      },
      ['window', 'totalSettledUsd', 'scopes'],
      {
        title: 'CostByScope',
        description: 'The default shape (no `by`): one entry per ledger scope.',
      },
    ),
    object(
      {
        window: str,
        by: { const: 'department' },
        basis: {
          const: 'budget_ledger',
          description:
            'Read from the ENFORCING ledger, so the window is real settlement-bucket semantics.',
        },
        groups: {
          type: 'array',
          items: object({ id: str, settledUsd: num, reservedUsd: num, settledTurns: int }, [
            'id',
            'settledUsd',
            'reservedUsd',
            'settledTurns',
          ]),
        },
      },
      ['window', 'by', 'basis', 'groups'],
      { title: 'CostByDepartment' },
    ),
    object(
      {
        window: str,
        by: { const: 'employee' },
        basis: {
          const: 'task_rows',
          description:
            'Aggregated from TASK ROWS (the ledger carries no employee scope), so the window is by ' +
            'task CREATION time: a long-lived task attributes its whole settled cost to the window ' +
            'it was created in.',
        },
        groups: {
          type: 'array',
          items: object({ id: str, settledUsd: num, settledTurns: int, tasks: int }, [
            'id',
            'settledUsd',
            'settledTurns',
            'tasks',
          ]),
        },
      },
      ['window', 'by', 'basis', 'groups'],
      { title: 'CostByEmployee' },
    ),
  ],
};

const PAUSE_STATE_RESPONSE = object({ workforceId: str, paused: bool }, ['workforceId', 'paused']);

const CASCADE_RESPONSE = object(
  {
    cancelled: { ...strArray, description: 'Task ids transitioned to `cancelled` in this call.' },
    signalled: {
      ...strArray,
      description:
        'Working task ids that received the absorb-at-turn-boundary cancel signal instead — a ' +
        'turn in flight is never killed.',
    },
  },
  ['cancelled', 'signalled'],
);

const SIGNAL_RESPONSE = object(
  {
    delivered: {
      ...bool,
      description: 'False when the (task, key) UNIQUE deduplicated the delivery — nothing changed.',
    },
    woke: { ...bool, description: 'True when the delivery re-queued the task.' },
  },
  ['delivered', 'woke'],
);

const VERDICT_RESPONSE = object(
  {
    reviewId: str,
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    taskId: str,
    taskStatus: str,
  },
  ['reviewId', 'verdict', 'taskId', 'taskStatus'],
);

const GOALS_RESPONSE = object(
  {
    workforceId: str,
    tasks: {
      type: 'array',
      description:
        'The created tasks, in plan order. Every one exists `planned`; nothing has run yet — the ' +
        'task list and the tree are where progress reads.',
      items: object({ taskId: str, owner: str, title: str }, ['taskId', 'owner', 'title']),
    },
  },
  ['workforceId', 'tasks'],
);

const SSE_STREAM_SCHEMA = {
  type: 'string',
  description:
    "A Server-Sent Events stream of this task's journal, replayed once from the durable event " +
    'table and then closed (it is a REPLAY, not a live subscription). Each event carries the ' +
    'journal `seq` as its SSE id, so a reconnect resumes with `Last-Event-ID`. A stored row outside ' +
    'the versioned workforce event vocabulary is DROPPED, never served verbatim.',
};

// --- shared error prose -------------------------------------------------------------------------

const UNAUTHENTICATED =
  'Missing or invalid credential. Uniform — it never reveals whether the resource exists.';
/**
 * The shared 403. Deliberately does NOT promise `details` — `enforcePermission` names the missing
 * permission only at the scope-gap site; a LIVE-MEMBERSHIP failure (a principal removed from the
 * tenant since its token was minted) throws a BARE `forbidden()`, because labelling that a missing
 * permission would misdescribe it. A client must handle a 403 with no `details` at all.
 */
const FORBIDDEN =
  'Authenticated, but not permitted: the principal lacks `store:read` (reads) or `store:write` ' +
  '(mutations), or its membership in this tenant is no longer live. `details.missing_permission` ' +
  'is present ONLY on the scope-gap form — a revoked-membership 403 is deliberately bare, so do ' +
  'not depend on it. The two decision doors add a THIRD form: see their own 403.';
const NOT_IMPLEMENTED =
  'This deployment wires no durable task dispatcher, so the WHOLE `/v1/workforce/*` surface is ' +
  'fail-closed. A decision accepted here would be a silent trap — a re-queued task nothing runs.';
/**
 * The TENANTLESS 404, which every route on this surface can answer.
 *
 * `enforcePermission` (`http/middleware.ts`) throws `NOT_FOUND` when no tenant is established —
 * `resolveTenant` sets `tenantId` only from a principal that HAS an org, and does not itself refuse
 * one that does not. So a credential that is valid but not scoped to an org gets a 404 from the
 * middleware chain, BEFORE any handler runs, on all sixteen routes. The four list routes have no
 * resource to miss and would otherwise have carried no 404 at all, which would have been an
 * under-claim; the builder therefore adds this to EVERY operation and a route with a more specific
 * 404 (an unknown task, review, approval or workforce) overrides the text.
 */
const NOT_FOUND_TENANTLESS =
  'The credential is valid but is not scoped to a tenant, so the permission gate refuses before any ' +
  'handler runs. Switch the session to an organization first. Uniform — no existence leak.';

const NOT_FOUND = `Unknown, or belongs to another tenant. ${NOT_FOUND_TENANTLESS}`;
const TOO_LARGE =
  "The request body exceeds the deployment's JSON byte cap; nothing was read or written.";
const RESERVED_SEGMENT =
  `The workforce id is empty or is a reserved path segment (${RESERVED_WORKFORCE_SEGMENTS.join(', ')}), ` +
  'which would collide with a fixed segment on this surface.';
const DRAIN_TIMEOUT =
  `The pause IS in force, but in-flight turns did not go quiet inside the ${HTTP_DRAIN_TIMEOUT_MS} ms ` +
  'request window. `details.stillWorking` lists the task ids still working. Re-issue the drain.';

// --- the operation builder ----------------------------------------------------------------------

interface OperationSpec {
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  /** Query/header parameters. PATH parameters are derived from the path template, never listed. */
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly schema: z.ZodType; readonly description: string };
  readonly success: {
    readonly status: '200' | '202';
    readonly description: string;
    readonly schema: Record<string, unknown>;
    readonly mediaType?: 'application/json' | 'text/event-stream';
    readonly headers?: Record<string, OpenApiHeader>;
  };
  /**
   * status → prose. The shared 401/403/501 are added for every operation; these are the extras.
   *
   * There is DELIBERATELY no per-error-status header hook. The first draft of this module had one,
   * and its only user was a `Retry-After` on the goals route's 429 — which this surface does not
   * send. `onError` (`app.ts`) maps a `RATE_LIMITED` `ApiError` to the envelope and sets no header;
   * only the declared-route limiter, the run surface and the playback middleware set `Retry-After`,
   * and the goals route is none of them. The hook went with the false header, so a later edit cannot
   * reintroduce an unobserved response header cheaply. `workforce-openapi.db.test.ts` OBSERVES the
   * real 429 and asserts the header is absent.
   */
  readonly errors: Readonly<Record<string, string>>;
}

/** Path parameters, DERIVED from the path template so they can never disagree with it. */
function pathParameters(path: string): OpenApiParameter[] {
  return [...path.matchAll(/\{([^}/]+)\}/g)].map((m) => ({
    name: m[1] as string,
    in: 'path' as const,
    required: true,
    description:
      m[1] === 'workforceId'
        ? 'The declared workforce id.'
        : "The resource id, scoped to the caller's tenant.",
    schema: { type: 'string' },
  }));
}

function buildOperation(spec: OperationSpec): OpenApiOperation {
  const headersFor = (extra?: Record<string, OpenApiHeader>): Record<string, OpenApiHeader> => ({
    [WORKFORCE_EXPERIMENTAL_HEADER]: EXPERIMENTAL_RESPONSE_HEADER,
    ...(extra ?? {}),
  });

  const responses: Record<string, OpenApiResponse> = {
    [spec.success.status]: {
      description: spec.success.description,
      headers: headersFor(spec.success.headers),
      content:
        spec.success.mediaType === 'text/event-stream'
          ? { 'text/event-stream': { schema: spec.success.schema } }
          : { 'application/json': { schema: spec.success.schema } },
    },
  };
  const errors: Record<string, string> = {
    '401': UNAUTHENTICATED,
    '403': FORBIDDEN,
    // Universal on this surface — see `NOT_FOUND_TENANTLESS`. Listed BEFORE the per-route errors so
    // a route with a more specific 404 (an unknown task / review / approval / workforce) overrides
    // the text, and the four list routes still carry one.
    '404': NOT_FOUND_TENANTLESS,
    ...spec.errors,
    '501': NOT_IMPLEMENTED,
  };
  for (const [status, description] of Object.entries(errors)) {
    responses[status] = {
      description,
      // The experimental marking and NOTHING else: it is the one response header this surface's
      // middleware sets unconditionally, and the only one a test observes on an error response.
      headers: headersFor(),
      content: { 'application/json': { schema: { ...ERROR_SCHEMA_REF } } },
    };
  }

  const parameters = [...pathParameters(spec.path), ...(spec.parameters ?? [])];
  const body = spec.requestBody ? toJsonSchema(spec.requestBody.schema) : undefined;

  return {
    summary: spec.summary,
    description: spec.description,
    operationId: spec.operationId,
    tags: [WORKFORCE_OPENAPI_TAG],
    [EXPERIMENTAL_EXTENSION_KEY]: true,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.requestBody && body
      ? {
          requestBody: {
            // DERIVED: a body is required exactly when its schema has a required member. `cancel`
            // and `pause` parse an ABSENT body as `{}` at the handler, so they are optional here.
            required: Array.isArray(body.required) && body.required.length > 0,
            content: { 'application/json': { schema: body } },
          },
        }
      : {}),
    responses,
  };
}

// --- the 16 operations --------------------------------------------------------------------------

const OPERATIONS: readonly OperationSpec[] = [
  {
    method: 'get',
    path: '/v1/workforce/{workforceId}/status',
    operationId: 'getWorkforceStatus',
    summary: "Read a workforce's control state, task counts, queue depth and budget headroom.",
    description:
      'Read `paused` to know whether the workforce is stopped RIGHT NOW. `haltReason` is a ' +
      'historical record of the last halt and survives a resume by design.',
    success: {
      status: '200',
      description: "The workforce's current control state.",
      schema: STATUS_RESPONSE,
    },
    errors: { '400': RESERVED_SEGMENT, '404': 'No such workforce in this tenant.' },
  },
  {
    method: 'get',
    path: '/v1/workforce/tasks',
    operationId: 'listWorkforceTasks',
    summary: 'List durable tasks, keyset-paginated.',
    description:
      'Ordered by `taskId` ascending — a precision-proof key, so a page boundary never re-serves ' +
      'its last row. Follow `X-Next-Cursor` to page.',
    parameters: [
      {
        name: 'status',
        in: 'query',
        description: 'Filter to one status from the closed set.',
        schema: { type: 'string', enum: [...TASK_STATUSES] },
      },
      {
        name: 'owner',
        in: 'query',
        description: 'Filter by owning employee id (or `user`).',
        schema: str,
      },
      {
        name: 'workforceId',
        in: 'query',
        description: 'Filter to one declared workforce.',
        schema: str,
      },
      {
        name: 'cursor',
        in: 'query',
        description: 'An opaque `X-Next-Cursor` value from a previous page. Strictly after.',
        schema: str,
      },
      {
        name: 'limit',
        in: 'query',
        description:
          `Page size. An out-of-range or unparseable value is CLAMPED to [1, ${MAX_PAGE}], not ` +
          'refused — this route answers no 400 for a large `limit`, so a client that sends one gets ' +
          `200 with at most ${MAX_PAGE} rows. The bounds below describe the ACCEPTED range, not a ` +
          'rejection rule.',
        schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE },
      },
    ],
    success: {
      status: '200',
      description: 'One page of task rows.',
      schema: { type: 'array', items: TASK_ROW },
      headers: {
        'X-Next-Cursor': {
          description: 'The cursor for the next page. Absent when the page came back empty.',
          schema: str,
        },
        'X-Result-Truncated': {
          description:
            'Set to `true` only when the page filled to `limit`, i.e. more rows may exist.',
          schema: { type: 'string', const: 'true' },
        },
      },
    },
    errors: {
      '400': 'The `status` filter is outside the closed status set, or the `cursor` is malformed.',
    },
  },
  {
    method: 'get',
    path: '/v1/workforce/approvals',
    operationId: 'listWorkforceApprovals',
    summary: "The operator's approval inbox.",
    description: 'Ordered oldest-first. Defaults to `pending` when no status is given.',
    parameters: [
      {
        name: 'status',
        in: 'query',
        description: 'Which approval rows to list.',
        schema: { type: 'string', enum: [...APPROVAL_STATUSES], default: 'pending' },
      },
    ],
    success: {
      status: '200',
      description: `Up to ${MAX_PAGE} approval rows.`,
      schema: { type: 'array', items: APPROVAL_ROW },
      headers: {
        'X-Result-Truncated': TRUNCATED_HEADER(
          `Always present. \`true\` when more than ${MAX_PAGE} rows matched.`,
        ),
      },
    },
    errors: { '400': 'The `status` filter is outside the closed approval-status set.' },
  },
  {
    method: 'get',
    path: '/v1/workforce/reviews',
    operationId: 'listWorkforceReviews',
    summary: 'The undecided-review inbox.',
    description:
      'Every review with a null verdict, oldest-first. A parked review must be decidable — an ' +
      'enterable state with no exit would be a defect.',
    success: {
      status: '200',
      description: `Up to ${MAX_PAGE} undecided review rows.`,
      schema: { type: 'array', items: REVIEW_ROW },
      headers: {
        'X-Result-Truncated': TRUNCATED_HEADER(
          `Always present. \`true\` when more than ${MAX_PAGE} rows matched.`,
        ),
      },
    },
    errors: {},
  },
  {
    method: 'get',
    path: '/v1/workforce/cost',
    operationId: 'getWorkforceCost',
    summary: 'Settled and reserved spend over a window.',
    description:
      'Each grouping names its BASIS, because the two are honest about different things — read ' +
      '`basis` before comparing two responses. There is deliberately NO workforce filter: the ' +
      "ledger's scope ids are not uniformly workforce-keyed across kinds.",
    parameters: [
      {
        name: 'window',
        in: 'query',
        description: 'A window like `24h` or `7d`. At most `90d`.',
        schema: { type: 'string', pattern: '^(\\d{1,3})([hd])$', default: '24h' },
      },
      {
        name: 'by',
        in: 'query',
        description: 'Group server-side. Omit for the per-ledger-scope default shape.',
        schema: { type: 'string', enum: ['employee', 'department'] },
      },
    ],
    success: {
      status: '200',
      description: 'The roll-up, in one of three shapes depending on `by`.',
      schema: COST_RESPONSE,
      headers: {
        'X-Result-Truncated': TRUNCATED_HEADER(
          `Always present. \`true\` when more than ${MAX_PAGE} rows matched the window.`,
        ),
      },
    },
    errors: {
      '400':
        'The `window` is malformed or exceeds `90d`, or `by` is neither `employee` nor `department`.',
    },
  },
  {
    method: 'get',
    path: '/v1/workforce/tasks/{id}',
    operationId: 'getWorkforceTask',
    summary: 'Read one task row.',
    description: 'A foreign or absent task id is a uniform 404.',
    success: { status: '200', description: 'The task row.', schema: TASK_ROW },
    errors: { '404': NOT_FOUND },
  },
  {
    method: 'get',
    path: '/v1/workforce/tasks/{id}/events',
    operationId: 'streamWorkforceTaskEvents',
    summary: "Replay one task's journal as Server-Sent Events.",
    description:
      'NOT a JSON response: the body is an SSE stream (`text/event-stream`). Ownership is probed ' +
      'on the tenant-scoped task row BEFORE streaming, so a foreign or absent id is a 404 with no ' +
      'stream at all.',
    parameters: [
      {
        // Spelled as `createAuthApp`'s CORS `allowHeaders` list spells it, so a browser client
        // reads one vocabulary. HTTP header names are case-insensitive and the handler matches
        // lower-case, so the casing is presentation only.
        name: 'Last-Event-Id',
        in: 'header',
        description:
          'Resume cursor: replay strictly after this journal `seq`. Takes precedence over `lastEventId`.',
        schema: str,
      },
      {
        name: 'lastEventId',
        in: 'query',
        description:
          'The same resume cursor as a query parameter, for clients that cannot set the header.',
        schema: str,
      },
    ],
    success: {
      status: '200',
      description: "The task's journal, replayed once and then closed.",
      schema: SSE_STREAM_SCHEMA,
      mediaType: 'text/event-stream',
    },
    errors: { '404': NOT_FOUND },
  },
  {
    method: 'get',
    path: '/v1/workforce/tasks/{id}/tree',
    operationId: 'getWorkforceTaskTree',
    summary: 'Read the whole subtree a task belongs to, flat.',
    description:
      '`id` may be ANY member of the subtree — the read anchors on its root, so an operator can ' +
      'ask from whichever task id they are holding.',
    success: {
      status: '200',
      description: 'The subtree, capped and flagged rather than refused.',
      schema: TREE_RESPONSE,
      headers: {
        'X-Result-Truncated': TRUNCATED_HEADER(
          `Always present. \`true\` when the subtree exceeded ${TREE_MAX_TASKS} rows and the page is a prefix.`,
        ),
      },
    },
    errors: { '404': NOT_FOUND },
  },
  {
    method: 'post',
    path: '/v1/workforce/tasks/{id}/signal',
    operationId: 'signalWorkforceTask',
    summary: 'Deliver one operator wake signal to a parked task.',
    description:
      'OPERATOR kinds only. The mechanism kinds are refused here because posting one would assert ' +
      'by hand the very fact its park is waiting to observe.',
    requestBody: { schema: signalRequestSchema, description: 'The signal to deliver.' },
    success: {
      status: '202',
      description: 'Accepted. `delivered: false` means the idempotency key collapsed a re-send.',
      schema: SIGNAL_RESPONSE,
    },
    errors: {
      '400': `The body is malformed, or \`kind\` is outside the operator set (${OPERATOR_SIGNAL_KINDS.join(', ')}).`,
      '404': NOT_FOUND,
      '413': TOO_LARGE,
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/tasks/{id}/cancel',
    operationId: 'cancelWorkforceTask',
    summary: 'Cancel a task and its subtree, root-first.',
    description:
      'A turn already in flight is never killed — it absorbs the cancel at its next boundary.',
    requestBody: { schema: cancelRequestSchema, description: 'An optional operator reason.' },
    success: {
      status: '202',
      description: 'Accepted. Names what was cancelled outright and what was signalled instead.',
      schema: CASCADE_RESPONSE,
    },
    errors: {
      '400': 'The body is malformed or carries an unknown field.',
      '404': NOT_FOUND,
      '413': TOO_LARGE,
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/approvals/{id}/decide',
    operationId: 'decideWorkforceApproval',
    summary: 'Resolve one pending approval and wake its task.',
    description:
      "The approval's recorded `approver` binds this door: `store:write` alone is not enough to " +
      'decide a row addressed to someone else. `override: true` asks to break the glass and takes ' +
      'the separate `workforce:override` permission — asking without holding it is a 403, never a ' +
      'silent downgrade to an ordinary decision.',
    // `decideRequestSchema`, not the engine's `approvalDecisionSchema` it aliases: the point of
    // deriving is to read the object THE HANDLER PARSES, so if this route ever narrows its body the
    // document narrows with it rather than describing the engine's wider one.
    requestBody: { schema: decideRequestSchema, description: 'The decision.' },
    success: { status: '200', description: 'The decided approval row.', schema: APPROVAL_ROW },
    errors: {
      '400': 'The body is malformed or carries an unknown field.',
      '403':
        `${FORBIDDEN} On THIS route a third form is possible: the approval names a DIFFERENT ` +
        'approver, and `details.approver` carries that name so the refusal is actionable (route it ' +
        'to that principal, or re-send with `override: true` if you hold `workforce:override`). ' +
        'Asking to override WITHOUT that permission is also a 403 — and nothing was decided.',
      '404': NOT_FOUND,
      '409': 'The approval is already decided.',
      '413': TOO_LARGE,
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/reviews/{id}/verdict',
    operationId: 'applyWorkforceReviewVerdict',
    summary: 'Apply one verdict to a review.',
    description:
      '`accept` completes the task; `reject` reworks it through `queued` until the declared round ' +
      "ceiling parks it for a human. The review's recorded `reviewer` binds this door on the same " +
      'terms as the approval door.',
    requestBody: { schema: reviewVerdictSchema, description: 'The verdict.' },
    success: {
      status: '200',
      description: "The verdict was applied; the task's resulting status is named.",
      schema: VERDICT_RESPONSE,
    },
    errors: {
      '400': 'The body is malformed or carries an unknown field.',
      '403':
        `${FORBIDDEN} On THIS route a third form is possible: the review names a DIFFERENT ` +
        'reviewer, and `details.reviewer` carries that name. Asking to override without holding ' +
        '`workforce:override` is also a 403 — and nothing was written.',
      '404': NOT_FOUND,
      '409':
        'The review already carries a verdict, the task is no longer waiting for a review, or the ' +
        'task is waiting on a DIFFERENT review (the stale-inbox interleaving). Nothing was written.',
      '413': TOO_LARGE,
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/{workforceId}/goals',
    operationId: 'submitWorkforceGoal',
    summary: "Submit a goal; the deployment's orchestration strategy shapes it into durable tasks.",
    description:
      '202 means the tasks EXIST `planned` — nothing has run yet. EVERY CALL IS ITS OWN ' +
      'SUBMISSION: there is no idempotency on this route, so a retry after a lost 202 would mint a ' +
      'second billed root. Check the task list before retrying rather than re-sending.',
    requestBody: { schema: goalRequestSchema, description: 'The goal, and optional context.' },
    success: {
      status: '202',
      description: 'Accepted. The created tasks exist `planned`; the dispatcher picks them up.',
      schema: GOALS_RESPONSE,
    },
    errors: {
      '400':
        'The body is malformed, the goal or description exceeds the byte ceiling, the workforce id ' +
        'is a reserved segment — OR an `Idempotency-Key` header was supplied. This route does NOT ' +
        'support Idempotency-Key yet: accepting and silently dropping it would be a lost-write ' +
        'trap, so the header is REFUSED rather than ignored. Omit it.',
      '404': 'No such workforce on this deployment, or it belongs to another tenant.',
      '409': 'The workforce is paused and is not accepting new work. Resume it, then re-submit.',
      '413': TOO_LARGE,
      // FINDING, recorded rather than fixed — the contract is FROZEN in this slice, so this
      // documents what the route DOES, not what it arguably should do. Three sibling throttled
      // surfaces set a real `Retry-After` header (`engine/route-rate-limit.ts`, `routes/runs.ts`,
      // `media/playback-middleware.ts`); this one does not, because it throws a `RATE_LIMITED`
      // `ApiError` and `onError` builds the envelope without touching headers. A client that
      // generalises from the siblings backs off on a header that is always absent. Adding the
      // header here would be a ROUTE BEHAVIOUR CHANGE and is deliberately out of scope; the
      // inconsistency across sibling surfaces is worth someone's attention on its own.
      '429':
        'Per (tenant, workforce) submission quota exceeded. The throttle runs BEFORE the body read, ' +
        'so nothing was read and nothing was dispatched. The retry hint is `error.details.' +
        'retryAfterMs` IN THE ENVELOPE — this route does NOT send a `Retry-After` header. Two sibling ' +
        'surfaces do (the declared-route limiter and the run surface), so a client that assumes the ' +
        'header from those would back off on a value that is not there.',
      '500':
        'The orchestration strategy produced a plan the intake refused — a server-side ' +
        'configuration defect, not something the caller can fix. The detail stays in the server logs.',
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/{workforceId}/pause',
    operationId: 'pauseWorkforce',
    summary: 'Stop reserving new work; optionally wait for in-flight turns to go quiet.',
    description:
      'Without `drain` the pause returns immediately and in-flight turns finish on their own. With ' +
      '`drain` the request is held until the workforce is quiet or the drain window expires.',
    requestBody: {
      schema: pauseRequestSchema,
      description: 'Whether to drain. Body optional; omitted ⇒ no drain.',
    },
    success: { status: '200', description: 'The pause is in force.', schema: PAUSE_STATE_RESPONSE },
    errors: {
      '400': RESERVED_SEGMENT,
      '404': 'No such workforce in this tenant.',
      '413': TOO_LARGE,
      '504': DRAIN_TIMEOUT,
    },
  },
  {
    method: 'post',
    path: '/v1/workforce/{workforceId}/resume',
    operationId: 'resumeWorkforce',
    summary: 'Resume reserving work.',
    description:
      'Reads no request body. Nothing needs re-queueing — the parked rows are still parked. The ' +
      'halt reason (if any) is deliberately KEPT, so `paused: false` with a `haltReason` set is normal.',
    success: {
      status: '200',
      description: 'Reserving has restarted.',
      schema: PAUSE_STATE_RESPONSE,
    },
    errors: { '400': RESERVED_SEGMENT, '404': 'No such workforce in this tenant.' },
  },
  {
    method: 'post',
    path: '/v1/workforce/{workforceId}/halt',
    operationId: 'haltWorkforce',
    summary: 'Drain, then cancel every live root of the workforce.',
    description:
      'A halt drains FIRST, so it can also answer 504 exactly as a draining pause can. It never ' +
      'kills a turn mid-flight. The reason is recorded and survives a later resume.',
    requestBody: {
      schema: haltRequestSchema,
      description: 'The halt reason. Required — a halt is an attributed act.',
    },
    success: {
      status: '200',
      description: 'The workforce is halted; the affected task ids are named.',
      schema: CASCADE_RESPONSE,
    },
    errors: {
      '400': `${RESERVED_SEGMENT} Or the body is missing its required \`reason\`.`,
      '404': 'No such workforce in this tenant.',
      '413': TOO_LARGE,
      '504': DRAIN_TIMEOUT,
    },
  },
];

/**
 * Decorate a served OpenAPI document with the `/v1/workforce/*` section.
 *
 * PURE and TOTAL: it never mutates its argument, never reads a request, an env var or the clock, and
 * never inspects the spec — the section is the same on every deployment, exactly as the routes are
 * (they are registered unconditionally by `createAuthApp`; a deployment with no dispatcher seam
 * answers the documented 501 on every one of them). The declared `paths` pass through untouched, and
 * so does `info` — including `OPENAPI_POSTURE_NOTICE`.
 */
export function withWorkforceSection(doc: OpenApiDocument): OpenApiDocument {
  // Prototype-free accumulator, for the same reason `buildDeclaredRoutesOpenApi` uses one: the keys
  // are path strings, so a null prototype keeps any exotic key a plain own-property.
  const paths: Record<string, Record<string, OpenApiOperation>> = Object.create(null);
  for (const spec of OPERATIONS) {
    let item = paths[spec.path];
    if (!item) {
      item = Object.create(null) as Record<string, OpenApiOperation>;
      paths[spec.path] = item;
    }
    // Two methods on one path (none today) would merge into one path item, as OpenAPI requires.
    item[spec.method] = buildOperation(spec);
  }
  return {
    ...doc,
    tags: [
      ...(doc.tags ?? []),
      {
        name: WORKFORCE_OPENAPI_TAG,
        description: WORKFORCE_TAG_DESCRIPTION,
        [EXPERIMENTAL_EXTENSION_KEY]: true,
      },
    ],
    // The workforce section wins a path collision, which MATCHES RUNTIME: `registerWorkforceRoutes`
    // runs BEFORE `registerDeclaredRoutes` in `createAuthApp`, and Hono resolves in registration
    // order — so a declared `api[]` route that claimed a `/v1/workforce/*` path would be unreachable
    // anyway (`RESERVED_ROUTE_PREFIXES` guards the static frontend mounts, not declared api paths).
    // Documenting the reachable operation is the honest choice; documenting the shadowed one would
    // describe a route no request can reach.
    paths: { ...doc.paths, ...paths },
    components: {
      ...(doc.components ?? {}),
      schemas: {
        ...(doc.components?.schemas ?? {}),
        // The closed error envelope every non-2xx on this surface returns, derived from the
        // platform's own Zod so the documented `code` enum cannot drift from `ErrorCode`.
        Error: toJsonSchema(ErrorEnvelope),
      },
    },
  };
}
