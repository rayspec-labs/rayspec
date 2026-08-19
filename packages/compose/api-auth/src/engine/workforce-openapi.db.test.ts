/**
 * The `/v1/workforce/*` control surface is DESCRIBED by the served OpenAPI document — and the
 * description cannot drift away from the router without going red.
 *
 * WHY THIS SUITE EXISTS. Until this slice the 16 workforce control routes had no published
 * contract at all: `rayspec openapi` emits the PRODUCT-PROFILE view surface (and refuses a
 * backend-profile document), and the served `GET /v1/openapi.json` was built from the spec's
 * DECLARED `api[]` alone — while `/v1/workforce/*` are PLATFORM routes, registered
 * unconditionally in `createAuthApp` and present in neither. An integrator holding a running
 * deployment's base URL could not fetch a spec and could not generate a client.
 *
 * THE ONE ASSERTION THIS FILE IS FOR. A hand-written document is a claim like any other, so the
 * headline arm derives the path/method set from the ROUTER ITSELF (`app.routes`, Hono's own
 * registration table) and compares it, BOTH DIRECTIONS, against the paths of the document that
 * actually crossed a socket:
 *
 *   - a route added to `routes/workforce.ts` with no document entry  → RED;
 *   - a document entry whose route was removed                       → RED;
 *   - a method added to an already-documented path                   → RED.
 *
 * It carries its own ANTI-VACUITY guard, because set-equality between two EMPTY sets passes: the
 * router scan must find at least the 16 routes that exist today, or the arm fails before it ever
 * reaches the comparison.
 *
 * THE SECOND LOOP: THE RESPONSE BODIES. The path/method loop pins WHICH routes exist and says
 * nothing about what they RETURN, and the success envelopes are hand-written — so a handler that
 * added, removed or renamed a field would leave the published contract silently wrong. That is not
 * an abstract risk: it was reported live by another branch adding two fields to the `status`
 * response, and this document is about to be handed to a workforce that will generate a UI FROM IT,
 * so a wrong document becomes wrong code.
 *
 * `LIVE ENVELOPES` closes it BEHAVIOURALLY. It drives eleven reachable 2xx responses against the
 * booted server with real seeded engine state, takes each response's OWN top-level key set, and
 * asserts SET EQUALITY against the documented schema's `required` list — so a field the handler
 * returns and the document omits is RED, and so is a field the document lists and the handler
 * omits. `LIVE ROW SHAPES` does the same for the three list routes and the single-row read, against
 * non-empty seeded pages, so the table-derived row schemas are checked against what
 * `c.json(rows)` actually serializes rather than only against the columns.
 *
 * WHAT REMAINS UNCHECKED — stated, not implied away:
 *
 *   1. NESTED shapes. Both live arms compare TOP-LEVEL keys only. A change inside
 *      `status.budget`, `tree.budgets`, a `cost` group, or a `goals` task entry does NOT go red.
 *   2. THREE of the sixteen success bodies are driven by nothing and are transcription-only: the
 *      review-verdict 200 (`{reviewId, verdict, taskId, taskStatus}`, covered by nothing at all),
 *      the approval-decide 200 (the approval ROW, whose SHAPE is covered by the inbox probe, but
 *      whose operation is never called) and the SSE events 200. That set is DERIVED by
 *      `THE PUBLISHED POSTURE…` as `documented 2xx - observed 2xx` and compared against what the
 *      served tag publishes, so neither this comment nor the document can drift away from it.
 *      The 504 drain-timeout body used to be on this list as "unreachable". It is not: `OBSERVED
 *      504` drives it, which is how the wrong description of `details.stillWorking` was pinned.
 *   3. STATUS CODES are spot-checked, not derived. 21 of the 106 documented `(operation, status)`
 *      pairs are OBSERVED against the running server — the thirteen driven 2xx above plus 401; the
 *      fail-closed 501; a 400 on an off-vocabulary status filter; a 400 on the goals
 *      `Idempotency-Key` refusal; a 404 on an unknown task id; a 404 on a tenantless credential; a
 *      429 from the SHIPPED goal-submit quota; and the 504 drain timeout. The rest are hand-derived
 *      from `mapEngineError` by reading, so a newly-added `mapEngineError` branch does not go red
 *      here.
 *   4. FIELD TYPES are not compared — only key sets. A field whose type changed stays green.
 *
 * TWO ARMS EXIST BECAUSE THE FIRST DRAFT OF THE DOCUMENT WAS WRONG, and every structural arm stayed
 * green through both errors — which is exactly what item 3 predicts. The draft claimed a
 * `Retry-After` header on the goals 429 (this route sends none; the hint is
 * `error.details.retryAfterMs`), and it omitted the 404 that `enforcePermission` raises for a
 * tenantless credential on all sixteen routes. Both corrections are now OBSERVED rather than merely
 * reworded.
 *
 * SERVED, NOT SOURCED. The document under test is fetched with `fetch()` from a REAL
 * `serve({ fetch: app.fetch })` listener on a loopback port — the pattern
 * `declared-route-rate-limit.db.test.ts` establishes. A document that exists only in source is the
 * exact gap this slice closes, so a fixture would prove nothing.
 */

import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { forTenant, schema } from '@rayspec/db';
import { parseSpec, type RaySpec, WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION } from '@rayspec/spec';
import {
  applyTransition,
  createRootTask,
  ensureWorkforceRuntime,
  OPERATOR_SIGNAL_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '@rayspec/tasks';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import {
  HTTP_DRAIN_TIMEOUT_MS,
  WORKFORCE_EXPERIMENTAL_HEADER,
  WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
} from '../routes/workforce.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { OPENAPI_POSTURE_NOTICE } from './emit-openapi.js';
import {
  WORKFORCE_OPENAPI_TAG,
  WORKFORCE_SECTION_PREFIX,
  WORKFORCE_VERIFICATION_POSTURE,
} from './emit-workforce-openapi.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this suite carries the ONLY mechanism that keeps the published contract
// tied to the router. A silent self-skip would let the document drift while CI stayed green.
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-openapi.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the document/router drift guard.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
// packages/compose/api-auth/src/engine -> repo-root/examples/acme-notes-backend
const YAML_PATH = resolve(here, '../../../../../examples/acme-notes-backend/rayspec.yaml');

function loadThrowawaySpec(): RaySpec {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/**
 * The declared `{agent}` route of the throwaway spec resolves against this registry. The document
 * emission never touches it — it is here only so `createAuthApp` can register the declared routes
 * at all (an unresolvable agent id is a deliberate boot failure).
 */
const agentRegistry: AgentRegistry = new Map<string, AgentRegistryEntry>([
  [
    'summarizer',
    {
      spec: {
        name: 'note-summarizer',
        instructions: 'summarize',
        model: 'gpt-4o-mini',
        input: '',
        tools: [],
        maxTurns: 6,
      },
      backend: new FakeRunBackend(),
    },
  ],
]);

/** The workforce the read probes and the goals probe address (never paused or halted). */
const PROBE_WORKFORCE = 'envelope-probe';
/** A SECOND workforce, used only by pause/resume/halt, so a halt cannot affect the reads above. */
const CONTROL_WORKFORCE = 'control-probe';
/**
 * A THIRD workforce, owned entirely by the OBSERVED 504 arm. It ends the run PAUSED with one task
 * stuck in `working`, which is precisely the state no other arm may see — hence its own id.
 */
const DRAIN_WORKFORCE = 'drain-504-probe';

/**
 * A `details` value's OBSERVED JavaScript type → the prose the served document is REQUIRED to use
 * for it, and the prose it may not.
 *
 * WHY THIS TABLE EXISTS. `details.stillWorking` shipped in the first draft of this document
 * described as a value that "lists the task ids still working". It is a `number` — a `count(*)::int`
 * taken IN the database (`@rayspec/tasks` `control.ts`, `workingCount`) precisely so a drain poll
 * never materializes the working set. A generated client that believed the document would have
 * iterated an integer. Nothing in this suite noticed: a reviewer replaced an entire response
 * description with a nonsense claim and all 32 arms stayed green, because DESCRIPTIONS were checked
 * by nothing at all.
 *
 * So the rule is derived from the wire rather than transcribed: whatever `typeof` the real response
 * carries selects the vocabulary the description must use. `mustNot` deliberately targets the FALSE
 * CLAIM SHAPE — a verb that says the field ENUMERATES something — and not the bare word `ids`, so a
 * description is still free to say "not their ids", which is the useful thing to tell a client.
 */
const DETAIL_TYPE_PROSE: Readonly<
  Record<string, { readonly must: RegExp; readonly mustNot: RegExp }>
> = {
  number: {
    must: /\b(count|number of)\b/i,
    mustNot: /\b(lists?|names|enumerates)\b[^.]{0,40}\bids?\b/i,
  },
};

/**
 * THE OBSERVATION LEDGER — what this RUN actually drove against the booted server.
 *
 * The served tag publishes a number: how many of the `(operation, status)` pairs it documents are
 * OBSERVED rather than read off `mapEngineError` by hand. That number is a claim about THIS FILE,
 * so this file is where it has to be answered. Every arm that drives a real request records the
 * pair it observed here, and the posture arm — declared LAST, so it runs last — compares the
 * recording against `WORKFORCE_VERIFICATION_POSTURE.observedPairs`. Add an observation and the
 * document's number must move with it; delete an arm and the number goes red.
 *
 * A pair is `METHOD <openapi path> <status>`, so the three `cost` probes (one route, three query
 * shapes) collapse to one observation — the document has one `(operation, status)` entry for them.
 */
const observedPairs = new Set<string>();
function recordObserved(method: string, docPath: string, status: string): void {
  observedPairs.add(`${method.toUpperCase()} ${docPath} ${status}`);
}

/** The extension keyword, taken from the JSON-Schema annotation so there is exactly ONE spelling. */
const EXPERIMENTAL_KEY = Object.keys(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION).find((k) =>
  k.startsWith('x-'),
) as string;

// --- minimal structural views of the served document (no OpenAPI type dependency) -------------
interface DocResponse {
  description: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}
interface DocOperation {
  summary: string;
  operationId: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses: Record<string, DocResponse>;
  [ext: string]: unknown;
}
type DocPathItem = Record<string, DocOperation>;
interface Doc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string; [ext: string]: unknown }[];
  paths: Record<string, DocPathItem>;
  components?: { schemas?: Record<string, unknown> };
}

/** `/v1/workforce/:workforceId/status` (Hono) → `/v1/workforce/{workforceId}/status` (OpenAPI). */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * The workforce path/method set AS THE ROUTER HOLDS IT. `app.use(glob)` registers as method `ALL`
 * and is the marking middleware, not a route, so it is excluded; a route registered with several
 * middlewares pushes ONE `RouterRoute` PER HANDLER, so the set dedupes on `METHOD path`.
 */
function registeredWorkforceRoutes(app: { routes: { path: string; method: string }[] }): string[] {
  const seen = new Set<string>();
  for (const r of app.routes) {
    if (!r.path.startsWith(WORKFORCE_SECTION_PREFIX)) continue;
    if (r.method.toUpperCase() === 'ALL') continue;
    seen.add(`${r.method.toUpperCase()} ${toOpenApiPath(r.path)}`);
  }
  return [...seen].sort();
}

/** The workforce path/method set AS THE SERVED DOCUMENT DESCRIBES IT. */
function documentedWorkforceRoutes(doc: Doc): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith(WORKFORCE_SECTION_PREFIX)) continue;
    for (const method of Object.keys(item)) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out.sort();
}

/** Every workforce operation in the served document, flattened. */
function workforceOperations(doc: Doc): { path: string; method: string; op: DocOperation }[] {
  const out: { path: string; method: string; op: DocOperation }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith(WORKFORCE_SECTION_PREFIX)) continue;
    for (const [method, op] of Object.entries(item)) out.push({ path, method, op });
  }
  return out;
}

function operationAt(doc: Doc, method: string, path: string): DocOperation {
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`no documented operation ${method} ${path}`);
  return op;
}

describeDb('the served OpenAPI document describes /v1/workforce/*', () => {
  let h: Harness;
  let hNoSeam: Harness;
  let server: Server;
  let base: string;
  let doc: Doc;
  let token: string;
  /** The tenant the `token` above is scoped to — the OBSERVED 504 arm seeds its own row through it. */
  let probeOrgId: string;
  /** Seeded engine state the live-envelope probes read and mutate. See `ENVELOPE_PROBES`. */
  let seeded: {
    readonly treeTaskId: string;
    readonly cancelTaskId: string;
    readonly signalTaskId: string;
  };

  beforeAll(async () => {
    const port = await new Promise<number>((r) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => r(p));
      });
    });
    base = `http://127.0.0.1:${port}`;
    h = await createHarness({
      schema: 'rayspec_test_workforce_openapi',
      engineSpec: loadThrowawaySpec(),
      agentRegistry,
      // Both workforce seams wired: without them every route is a fail-closed 501 and the
      // OBSERVED-status arms could not reach the refusals they cross-check.
      workforce: { kick: () => {} },
      // Returns `created` so the goals route's OWN 202 envelope (`{ workforceId, tasks }`) is
      // reachable for the live-envelope probe. The seam is a stand-in for the orchestration
      // strategy, but the envelope under test is assembled by the ROUTE, not by this stub.
      workforceGoalIntake: {
        submitGoal: async () => ({
          outcome: 'created' as const,
          tasks: [{ taskId: 'probe-task', owner: 'probe-owner', title: 'probe title' }],
        }),
      },
    });
    // The seam-LESS posture, for the observed 501. Same routes, no dispatcher.
    hNoSeam = await createHarness({
      schema: 'rayspec_test_workforce_openapi_noseam',
      engineSpec: loadThrowawaySpec(),
      agentRegistry,
    });
    server = serve({ fetch: h.app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((r) => setTimeout(r, 50));

    // THE DOCUMENT UNDER TEST — fetched over a real socket, unauthenticated (the read is public).
    const res = await fetch(`${base}/v1/openapi.json`);
    expect(res.status, 'the served document must be fetchable').toBe(200);
    doc = (await res.json()) as Doc;

    // A `store:read` + `store:write` principal for the observed-status arms.
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'wf-openapi@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: 'Org Workforce OpenApi' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    probeOrgId = orgId;
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    token = (await sw.json()).accessToken as string;

    // ── seed the minimum engine state the LIVE-ENVELOPE probes need ────────────────────────────
    // Seeded through the ENGINE's own creation surface (`createRootTask`) and the tenant chokepoint,
    // never by hand-writing a response: the point of those probes is to compare the document against
    // what the HANDLERS actually serialize, so the rows must be real rows.
    const tdb = forTenant(h.db, orgId);
    await ensureWorkforceRuntime(tdb, PROBE_WORKFORCE);
    await ensureWorkforceRuntime(tdb, CONTROL_WORKFORCE);
    const root = (title: string) =>
      createRootTask(tdb, {
        workforceId: PROBE_WORKFORCE,
        title,
        goal: `${title} goal`,
        owner: 'user',
        requestedBy: 'user:seed',
      });
    // Three separate roots so a MUTATING probe (cancel) cannot change what a READ probe (tree) sees,
    // whatever order they run in.
    const [treeTask, cancelTask, signalTask] = await Promise.all([
      root('tree probe'),
      root('cancel probe'),
      root('signal probe'),
    ]);
    seeded = {
      treeTaskId: treeTask.taskId,
      cancelTaskId: cancelTask.taskId,
      signalTaskId: signalTask.taskId,
    };
    // One approval and one review row so the two inbox routes return a NON-EMPTY page — an empty
    // array would make their item-shape check vacuous.
    await tdb.insert(schema.workforceApprovals, {
      taskId: treeTask.taskId,
      question: 'Proceed?',
      approver: 'user',
      status: 'pending',
      onTimeout: 'fail',
    });
    await tdb.insert(schema.workforceReviews, {
      taskId: treeTask.taskId,
      reviewer: 'user',
      round: 1,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
    await hNoSeam.close();
  });

  /** One authenticated request at the BOOTED server. `body === undefined` sends no body at all. */
  async function authed(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // ── A. served and fetchable ──────────────────────────────────────────────────────────────────

  it('is served at GET /v1/openapi.json over a real socket, as JSON, without a credential', async () => {
    const res = await fetch(`${base}/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const fetched = (await res.json()) as Doc;
    expect(fetched.openapi).toBe('3.1.0');
    // Non-vacuous: the workforce section is actually IN the bytes that crossed the socket.
    expect(
      Object.keys(fetched.paths).filter((p) => p.startsWith(WORKFORCE_SECTION_PREFIX)).length,
    ).toBeGreaterThan(0);
  });

  // ── B. the drift loop — derived from the router, both directions ─────────────────────────────

  it("THE DRIFT LOOP: the documented path/method set EQUALS the router's, both directions", () => {
    const registered = registeredWorkforceRoutes(
      h.app as unknown as { routes: { path: string; method: string }[] },
    );
    // ANTI-VACUITY. Two empty sets are equal; a scan that found nothing must fail HERE, loudly,
    // rather than reporting a clean sweep over nothing. 16 is the count that exists today and is a
    // FLOOR, not a pin — adding a route is caught by the set comparison below, with a diff.
    expect(
      registered.length,
      'the router scan found fewer workforce routes than exist — the scan is broken, not the doc',
    ).toBeGreaterThanOrEqual(16);
    expect(documentedWorkforceRoutes(doc)).toEqual(registered);
  });

  it('every documented workforce path is in OpenAPI `{param}` form — no Hono `:param` leaks', () => {
    for (const path of Object.keys(doc.paths)) {
      if (!path.startsWith(WORKFORCE_SECTION_PREFIX)) continue;
      expect(
        path,
        `${path} carries a Hono-style parameter a client generator cannot read`,
      ).not.toContain(':');
    }
  });

  it('every operationId in the WHOLE document is unique — a generator names its methods from these', () => {
    // OpenAPI requires document-wide uniqueness, and a client generator derives one method name per
    // operationId. A collision between a workforce operation and a DECLARED product operation would
    // silently drop one method from the generated client — so this arm scans the whole document, not
    // just the workforce section.
    const ids: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(item)) ids.push(op.operationId);
    }
    expect(ids.length, 'the document declares no operations at all').toBeGreaterThan(16);
    expect([...new Set(ids)].sort()).toEqual([...ids].sort());
  });

  it('every documented path parameter is declared required, and matches the path template', () => {
    for (const { path, method, op } of workforceOperations(doc)) {
      const templated = [...path.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1] as string);
      const declared = (op.parameters ?? []).filter((p) => p.in === 'path');
      expect(declared.map((p) => p.name).sort(), `${method} ${path} path params`).toEqual(
        [...templated].sort(),
      );
      for (const p of declared) expect(p.required, `${method} ${path} ${p.name}`).toBe(true);
    }
  });

  // ── C. the experimental marking, IN the document ─────────────────────────────────────────────

  it('the workforce TAG carries the experimental keyword — and it is the SAME keyword the JSON Schema uses', () => {
    expect(EXPERIMENTAL_KEY).toBe('x-rayspec-experimental');
    const tag = (doc.tags ?? []).find((t) => t.name === WORKFORCE_OPENAPI_TAG);
    expect(tag, 'the served document declares no workforce tag').toBeTruthy();
    expect((tag as Record<string, unknown>)[EXPERIMENTAL_KEY]).toBe(true);
    expect(tag?.description).toMatch(/EXPERIMENTAL/);
  });

  it('the tag tells a consumer WHICH PARTS of this document are mechanically verified', () => {
    // A generated client is built by someone with no access to this repository's test suite, so the
    // only place they can learn how far the document's guarantees reach is the document. Both halves
    // must be there: what is checked, and — the half that is easy to drop — what is not.
    const tag = (doc.tags ?? []).find((t) => t.name === WORKFORCE_OPENAPI_TAG);
    const text = tag?.description ?? '';
    expect(text, 'the tag does not say what is CHECKED').toMatch(/CHECKED/);
    expect(text, 'the tag does not say what is NOT checked').toMatch(/NOT CHECKED/);
    // Name the two loops that exist and the three gaps that remain, so a later edit that removes a
    // mechanism (or adds one) has to touch this sentence too.
    for (const phrase of [/paths and\s+methods/i, /TOP-LEVEL field names/i]) {
      expect(text, `the tag omits a CHECKED mechanism: ${phrase}`).toMatch(phrase);
    }
    for (const phrase of [/nested/i, /TYPES/, /status codes/i]) {
      expect(text, `the tag omits a NOT-CHECKED gap: ${phrase}`).toMatch(phrase);
    }
  });

  it('EVERY workforce operation carries the tag AND its own experimental keyword', () => {
    const ops = workforceOperations(doc);
    expect(ops.length).toBeGreaterThanOrEqual(16);
    for (const { path, method, op } of ops) {
      expect(op.tags, `${method} ${path} tags`).toContain(WORKFORCE_OPENAPI_TAG);
      // Per-operation as well as per-tag: a generator that ignores `tags` still sees the marking.
      expect(op[EXPERIMENTAL_KEY], `${method} ${path} ${EXPERIMENTAL_KEY}`).toBe(true);
    }
  });

  it('EVERY workforce response documents the X-Experimental header the wire actually carries', () => {
    for (const { path, method, op } of workforceOperations(doc)) {
      for (const [status, response] of Object.entries(op.responses)) {
        const header = response.headers?.[WORKFORCE_EXPERIMENTAL_HEADER] as
          | { schema?: { const?: string } }
          | undefined;
        expect(
          header,
          `${method} ${path} ${status} omits ${WORKFORCE_EXPERIMENTAL_HEADER}`,
        ).toBeTruthy();
        expect(header?.schema?.const).toBe(WORKFORCE_EXPERIMENTAL_HEADER_VALUE);
      }
    }
  });

  it('NEGATIVE CONTROL: a DECLARED (product) operation carries neither the tag nor the keyword', () => {
    const declared = Object.entries(doc.paths).filter(
      ([p]) => !p.startsWith(WORKFORCE_SECTION_PREFIX),
    );
    expect(
      declared.length,
      'the throwaway spec declares no routes — control is vacuous',
    ).toBeGreaterThan(0);
    for (const [path, item] of declared) {
      for (const [method, op] of Object.entries(item)) {
        expect(op.tags ?? [], `${method} ${path}`).not.toContain(WORKFORCE_OPENAPI_TAG);
        expect(op[EXPERIMENTAL_KEY], `${method} ${path}`).toBeUndefined();
      }
    }
  });

  it('the wire marking and the document marking agree (the header is still sent)', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks`);
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBe(
      WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
    );
  });

  // ── D. the SSE route is described as what it is ──────────────────────────────────────────────

  it('the events route documents text/event-stream, NOT a JSON body', () => {
    const op = operationAt(doc, 'GET', '/v1/workforce/tasks/{id}/events');
    const ok = op.responses['200'];
    expect(ok, 'the events route documents no 200').toBeTruthy();
    expect(Object.keys(ok?.content ?? {})).toEqual(['text/event-stream']);
    expect(ok?.content?.['application/json']).toBeUndefined();
  });

  it('the events route declares the Last-Event-Id resume header as a request parameter', () => {
    const op = operationAt(doc, 'GET', '/v1/workforce/tasks/{id}/events');
    // Case-INSENSITIVE: HTTP header names are, and the handler matches on the lower-cased name
    // (`journal-replay.ts`). Pinning the exact casing would make this a cosmetic assertion.
    const names = (op.parameters ?? [])
      .filter((p) => p.in === 'header')
      .map((p) => p.name.toLowerCase());
    expect(names).toContain('last-event-id');
    // The query-parameter fallback the same helper honours, for a client that cannot set a header.
    const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(query).toContain('lastEventId');
  });

  it('NEGATIVE CONTROL: every OTHER workforce 2xx is application/json', () => {
    for (const { path, method, op } of workforceOperations(doc)) {
      if (path === '/v1/workforce/tasks/{id}/events') continue;
      for (const [status, response] of Object.entries(op.responses)) {
        if (!status.startsWith('2')) continue;
        if (response.content === undefined) continue; // a documented no-body 2xx
        expect(Object.keys(response.content), `${method} ${path} ${status}`).toEqual([
          'application/json',
        ]);
      }
    }
  });

  // ── E. the shapes that are DERIVED (so they cannot drift) ────────────────────────────────────

  it('the task row schema is derived from the workforce_tasks table — every column, no hand-picked subset', () => {
    const op = operationAt(doc, 'GET', '/v1/workforce/tasks/{id}');
    const rowSchema = op.responses['200']?.content?.['application/json']?.schema as {
      properties?: Record<string, unknown>;
    };
    const columns = Object.keys(getTableColumns(schema.workforceTasks)).sort();
    expect(Object.keys(rowSchema?.properties ?? {}).sort()).toEqual(columns);
  });

  it("the signal request body enum IS the engine's operator-signal vocabulary", () => {
    const op = operationAt(doc, 'POST', '/v1/workforce/tasks/{id}/signal');
    const body = op.requestBody?.content['application/json']?.schema as {
      properties?: { kind?: { enum?: string[] } };
    };
    expect(body?.properties?.kind?.enum).toEqual([...OPERATOR_SIGNAL_KINDS]);
  });

  it("the goals request body derives its priority enum + required set from the route's own Zod", () => {
    const op = operationAt(doc, 'POST', '/v1/workforce/{workforceId}/goals');
    const body = op.requestBody?.content['application/json']?.schema as {
      properties?: { priority?: { enum?: string[] } };
      required?: string[];
    };
    expect(body?.properties?.priority?.enum).toEqual([...TASK_PRIORITIES]);
    expect(body?.required).toEqual(['goal']);
  });

  it('the task-list status filter enum IS the closed task-status set', () => {
    const op = operationAt(doc, 'GET', '/v1/workforce/tasks');
    const status = (op.parameters ?? []).find((p) => p.name === 'status');
    expect((status?.schema as { enum?: string[] } | undefined)?.enum).toEqual([...TASK_STATUSES]);
  });

  // ── F. OBSERVED statuses — real requests, cross-checked against the document ──────────────────

  it('OBSERVED 401: an unauthenticated read answers 401, and 401 is documented', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks`);
    expect(res.status).toBe(401);
    recordObserved('GET', '/v1/workforce/tasks', '401');
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks').responses['401']).toBeTruthy();
  });

  it('OBSERVED 501: a deployment with no dispatcher seam answers 501, and 501 is documented', async () => {
    const reg = await jsonRequest(hNoSeam.app, 'POST', '/v1/auth/register', {
      body: { email: 'wf-openapi-noseam@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hNoSeam.app, 'POST', '/v1/orgs', {
      body: { name: 'Org No Seam' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const sw = await jsonRequest(hNoSeam.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const noSeamToken = (await sw.json()).accessToken as string;
    const res = await jsonRequest(hNoSeam.app, 'GET', '/v1/workforce/tasks', {
      headers: { authorization: `Bearer ${noSeamToken}` },
    });
    expect(res.status).toBe(501);
    recordObserved('GET', '/v1/workforce/tasks', '501');
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks').responses['501']).toBeTruthy();
  });

  it('OBSERVED 400: an off-vocabulary status filter answers 400, and 400 is documented', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks?status=nonsense`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    recordObserved('GET', '/v1/workforce/tasks', '400');
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks').responses['400']).toBeTruthy();
  });

  it('OBSERVED 400: the goals route REFUSES an Idempotency-Key, and that refusal is documented', async () => {
    // The newly-added intake refusal: this route does not honor the header yet, and accepting-then-
    // dropping it would be a double-bill trap. A client generator must see the 400.
    const res = await fetch(`${base}/v1/workforce/acme/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Idempotency-Key': 'k-1',
      },
      body: JSON.stringify({ goal: 'ship it' }),
    });
    expect(res.status).toBe(400);
    recordObserved('POST', '/v1/workforce/{workforceId}/goals', '400');
    const op = operationAt(doc, 'POST', '/v1/workforce/{workforceId}/goals');
    expect(op.responses['400']).toBeTruthy();
    expect(op.responses['400']?.description).toMatch(/Idempotency-Key/);
  });

  it('OBSERVED 404: an unknown task id answers a uniform 404, and 404 is documented', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks/no-such-task`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    recordObserved('GET', '/v1/workforce/tasks/{id}', '404');
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks/{id}').responses['404']).toBeTruthy();
  });

  it('OBSERVED 404 on a LIST route: a tenantless credential is refused before the handler', async () => {
    // The second correction the handlers forced (see the 429 arm for the first). `resolveTenant`
    // sets `tenantId` only from a principal that HAS an org and does NOT refuse one that does not;
    // `enforcePermission` then throws NOT_FOUND. So a valid, org-less credential gets a 404 from the
    // MIDDLEWARE on all sixteen routes — including the four list routes, which have no resource to
    // miss and had carried no 404 at all. Registering without switching to an org is exactly that
    // principal.
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'wf-openapi-tenantless@example.test', password: 'a-long-enough-password' },
    });
    const orgless = (await reg.json()).accessToken as string;
    const res = await fetch(`${base}/v1/workforce/tasks`, {
      headers: { authorization: `Bearer ${orgless}` },
    });
    expect(res.status).toBe(404);
    recordObserved('GET', '/v1/workforce/tasks', '404');
    // …and the document says so on a route whose 404 comes ONLY from this path.
    const listOp = operationAt(doc, 'GET', '/v1/workforce/tasks');
    expect(listOp.responses['404'], 'the list route documents no 404').toBeTruthy();
    expect(listOp.responses['404']?.description).toMatch(/not scoped to a tenant/i);
    // Universal: every workforce operation carries a 404, because every one runs the same gate.
    for (const { path, method, op } of workforceOperations(doc)) {
      expect(op.responses['404'], `${method} ${path} documents no 404`).toBeTruthy();
    }
  });

  it('OBSERVED 429: the goal quota answers 429 with `details.retryAfterMs` and NO Retry-After header', async () => {
    // THIS ARM EXISTS BECAUSE THE FIRST DRAFT OF THE DOCUMENT GOT IT WRONG. It documented a
    // `Retry-After` response header on this 429 — plausible, because three sibling surfaces really
    // do send one (the declared-route limiter, the run surface, the playback middleware). This route
    // does not: it throws a `RATE_LIMITED` ApiError and `onError` maps that to the envelope alone,
    // putting the hint in `error.details.retryAfterMs`. A generated client that backed off on the
    // header would have read `null`. So the correction is OBSERVED here rather than merely reworded.
    //
    // Its own workforce id, so this bucket cannot interact with the Idempotency-Key arm's.
    const fire = () =>
      fetch(`${base}/v1/workforce/quota-probe/goals`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'probe the quota' }),
      });
    let throttled: Response | undefined;
    // The real shipped policy is 30 per 60s (`DEFAULT_POLICIES['goal-submit']`); this drives the
    // REAL limiter rather than an injected tiny one, so the arm proves the shipped behaviour.
    for (let i = 0; i < 40 && throttled === undefined; i += 1) {
      const res = await fire();
      if (res.status === 429) throttled = res;
      else await res.text();
    }
    expect(throttled, 'the goal-submit quota never engaged').toBeDefined();
    expect(throttled?.headers.get('retry-after'), 'this route sends no Retry-After').toBeNull();
    const envelope = (await (throttled as Response).json()) as {
      error: { code: string; details?: { retryAfterMs?: number } };
    };
    expect(envelope.error.code).toBe('RATE_LIMITED');
    expect(typeof envelope.error.details?.retryAfterMs).toBe('number');
    recordObserved('POST', '/v1/workforce/{workforceId}/goals', '429');

    // …and the document says exactly that, header absence included.
    const op = operationAt(doc, 'POST', '/v1/workforce/{workforceId}/goals');
    const documented = op.responses['429'];
    expect(documented).toBeTruthy();
    expect(documented?.description).toMatch(/retryAfterMs/);
    expect(Object.keys(documented?.headers ?? {})).toEqual([WORKFORCE_EXPERIMENTAL_HEADER]);
  });

  it('OBSERVED 504: the drain timeout is REAL, and the document describes `details.stillWorking` as ' +
    'the count it is — not as a list of ids', async () => {
    /**
     * THE THIRD FALSE CLAIM THIS DOCUMENT SHIPPED, and the first one a test can hold down.
     *
     * The 504's description said `details.stillWorking` "lists the task ids still working". It is
     * a `number`: `WorkforceDrainTimeoutError` declares `readonly stillWorking: number`
     * (`@rayspec/tasks` `control.ts`), it is filled from a `count(*)::int` evaluated IN the
     * database so that a drain poll never materializes the working set, and `mapEngineError`
     * (`routes/workforce.ts`) passes it to the envelope verbatim. A UI generated from the wrong
     * document would have tried to render an integer as a list of task ids.
     *
     * WHY IT SURVIVED. Every other arm in this file checks STRUCTURE — which paths, which
     * statuses, which keys, which headers. Response DESCRIPTIONS were checked by nothing: a
     * reviewer swapped this one for an unrelated claim and the suite stayed 32/32 green. So this
     * arm does not reword the sentence, it OBSERVES the value and makes the sentence answer to it.
     *
     * WHY IT IS WORTH ~25 SECONDS. The previous arm here asserted only that a `504` key existed on
     * both draining routes and said in a comment that reaching it "needs a turn that outlives the
     * 25s HTTP drain window". It does — and `routes/workforce.test.ts` already pays that cost, so
     * "unreachable" was never true. Paying it here turns the last transcription-only status on
     * this surface into an observed one, which is the whole posture this document publishes.
     *
     * BOTH DRAINING ROUTES ARE COVERED BY ONE DRIVE. `pause` and `halt` share the single
     * `DRAIN_TIMEOUT` constant in the emitter, so observing either one validates the sentence
     * both of them serve — and the loop below asserts the sentence on both.
     */
    const tdb = forTenant(h.db, probeOrgId);
    await ensureWorkforceRuntime(tdb, DRAIN_WORKFORCE);
    const task = await createRootTask(tdb, {
      workforceId: DRAIN_WORKFORCE,
      title: 'drain 504 probe',
      goal: 'occupy the drain',
      owner: 'user',
      requestedBy: 'user:seed',
    });
    // Through the engine's own transition chokepoint, never by writing `status` by hand: the
    // drain counts what `applyTransition` produced, so a hand-written row would prove nothing.
    const queued = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: 'openapi-drain-claim',
    });

    const res = await authed(`/v1/workforce/${DRAIN_WORKFORCE}/pause`, 'POST', { drain: true });
    expect(res.status, 'the drain did not time out — this arm proves nothing').toBe(504);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('GATEWAY_TIMEOUT');
    const details = body.error.details ?? {};
    // The whole `details` object, not just the one key: if the envelope ever grows a second
    // field the loop below demands the document describe that one too.
    expect(Object.keys(details).sort(), 'the 504 carries a different detail set now').toEqual([
      'stillWorking',
    ]);
    expect(details.stillWorking, 'one task was seeded working').toBe(1);
    recordObserved('POST', '/v1/workforce/{workforceId}/pause', '504');

    for (const path of ['/v1/workforce/{workforceId}/pause', '/v1/workforce/{workforceId}/halt']) {
      const desc = operationAt(doc, 'POST', path).responses['504']?.description ?? '';
      // (1) IT MUST STILL BE ABOUT THIS REFUSAL. This is the half that reds when a description is
      //     replaced wholesale rather than subtly mis-worded — the failure mode observed in
      //     review. Each token below is derived, not transcribed: the field names come from the
      //     live envelope, the window from the route's own exported constant.
      for (const token of [...Object.keys(details), String(HTTP_DRAIN_TIMEOUT_MS), 'drain']) {
        expect(desc, `POST ${path} 504 no longer mentions '${token}'`).toContain(token);
      }
      // (2) IT MUST DESCRIBE THE VALUE AS THE TYPE THE WIRE ACTUALLY CARRIES.
      for (const [key, value] of Object.entries(details)) {
        const rule = DETAIL_TYPE_PROSE[typeof value];
        expect(
          rule,
          `the 504 carries \`${key}\` as a ${typeof value} and no prose rule covers that type — ` +
            'add one to DETAIL_TYPE_PROSE rather than leaving the description unguarded',
        ).toBeTruthy();
        expect(
          desc,
          `POST ${path} 504 describes \`${key}\` (a ${typeof value} on the wire) without saying so`,
        ).toMatch((rule as { must: RegExp }).must);
        expect(
          desc,
          `POST ${path} 504 claims \`${key}\` enumerates ids — it is a ${typeof value}`,
        ).not.toMatch((rule as { mustNot: RegExp }).mustNot);
      }
    }
    // The 60 s per-test timeout below: ~25 s of real waiting happens INSIDE the request.
    // `HTTP_DRAIN_TIMEOUT_MS` is a module constant with no injection seam, so that wait is the
    // honest cost of an OBSERVED 504 rather than a stubbed one.
  }, 60_000);

  it('OBSERVED headers: the two list routes differ on X-Result-Truncated, and the document says which', async () => {
    // The response headers are the other place a hand-written document can quietly over-claim (see
    // the 429 arm). These two routes are DELIBERATELY different and the document distinguishes them,
    // so a blanket "always present" claim on either would fail here.
    //
    // `approvals` sets it UNCONDITIONALLY — 'false' on a page that did not fill.
    const approvals = await fetch(`${base}/v1/workforce/approvals`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approvals.status).toBe(200);
    recordObserved('GET', '/v1/workforce/approvals', '200');
    expect(approvals.headers.get('x-result-truncated')).toBe('false');
    const approvalsDoc = operationAt(doc, 'GET', '/v1/workforce/approvals').responses['200'];
    expect(Object.keys(approvalsDoc?.headers ?? {})).toContain('X-Result-Truncated');
    expect(approvalsDoc?.description).toBeTruthy();

    // `tasks` sets it ONLY when the page filled to `limit`, so an unfilled page carries NO header —
    // and the document's header entry says exactly that rather than promising it unconditionally.
    const tasks = await fetch(`${base}/v1/workforce/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tasks.status).toBe(200);
    recordObserved('GET', '/v1/workforce/tasks', '200');
    expect(
      tasks.headers.get('x-result-truncated'),
      'an unfilled task page sends no flag',
    ).toBeNull();
    const tasksHeaders = (operationAt(doc, 'GET', '/v1/workforce/tasks').responses['200']
      ?.headers ?? {}) as Record<string, { description?: string }>;
    expect(tasksHeaders['X-Result-Truncated']?.description).toMatch(/only when/i);
  });

  // ── H. THE LIVE-ENVELOPE LOOP — the document's success bodies vs the handlers' real bytes ─────

  it('LIVE ENVELOPES: every reachable 2xx body has EXACTLY the documented top-level keys', async () => {
    /**
     * THE HALF OF THE LOOP THAT USED TO BE OPEN.
     *
     * The path/method arm above pins WHICH routes exist. It says nothing about what they RETURN, and
     * the bespoke envelopes are hand-written — so a handler that added, removed or renamed a field
     * left the published contract silently wrong, and the contract is about to be handed to a
     * workforce that will generate a UI from it. A wrong document becomes wrong code.
     *
     * This arm closes it BEHAVIOURALLY rather than statically: it drives each route against the
     * BOOTED server with real seeded engine state, takes the response's own top-level key set, and
     * asserts SET EQUALITY against the documented schema's `required` list. Both directions fail:
     *
     *   - a field the handler returns and the document omits  → RED (the document under-describes);
     *   - a field the document lists and the handler omits    → RED (the document over-promises).
     *
     * Every bespoke envelope schema marks all of its properties `required` and sets
     * `additionalProperties: false`, which is what makes set equality the right comparison rather
     * than a subset check. NESTED shapes are NOT compared — only the top level (see the residual
     * note at the end of this file's header).
     */
    const probes: {
      readonly name: string;
      readonly method: string;
      readonly path: string;
      readonly status: string;
      readonly send: () => Promise<Response>;
    }[] = [
      {
        name: 'status',
        method: 'GET',
        path: '/v1/workforce/{workforceId}/status',
        status: '200',
        send: () => authed(`/v1/workforce/${PROBE_WORKFORCE}/status`),
      },
      {
        name: 'cost (default, per ledger scope)',
        method: 'GET',
        path: '/v1/workforce/cost',
        status: '200',
        send: () => authed('/v1/workforce/cost'),
      },
      {
        name: 'cost (by=department)',
        method: 'GET',
        path: '/v1/workforce/cost',
        status: '200',
        send: () => authed('/v1/workforce/cost?by=department'),
      },
      {
        name: 'cost (by=employee)',
        method: 'GET',
        path: '/v1/workforce/cost',
        status: '200',
        send: () => authed('/v1/workforce/cost?by=employee'),
      },
      {
        name: 'tree',
        method: 'GET',
        path: '/v1/workforce/tasks/{id}/tree',
        status: '200',
        send: () => authed(`/v1/workforce/tasks/${seeded.treeTaskId}/tree`),
      },
      {
        name: 'goals',
        method: 'POST',
        path: '/v1/workforce/{workforceId}/goals',
        status: '202',
        send: () =>
          authed('/v1/workforce/goal-envelope/goals', 'POST', { goal: 'probe the shape' }),
      },
      {
        name: 'signal',
        method: 'POST',
        path: '/v1/workforce/tasks/{id}/signal',
        status: '202',
        send: () =>
          authed(`/v1/workforce/tasks/${seeded.signalTaskId}/signal`, 'POST', {
            kind: 'manual_unblock',
          }),
      },
      {
        name: 'cancel',
        method: 'POST',
        path: '/v1/workforce/tasks/{id}/cancel',
        status: '202',
        send: () => authed(`/v1/workforce/tasks/${seeded.cancelTaskId}/cancel`, 'POST', {}),
      },
      // The three control verbs run LAST and on their OWN workforce, in pause → resume → halt order:
      // a halt drains and cancels, so running it first would change what the reads above observe.
      {
        name: 'pause',
        method: 'POST',
        path: '/v1/workforce/{workforceId}/pause',
        status: '200',
        send: () => authed(`/v1/workforce/${CONTROL_WORKFORCE}/pause`, 'POST', {}),
      },
      {
        name: 'resume',
        method: 'POST',
        path: '/v1/workforce/{workforceId}/resume',
        status: '200',
        send: () => authed(`/v1/workforce/${CONTROL_WORKFORCE}/resume`, 'POST'),
      },
      {
        name: 'halt',
        method: 'POST',
        path: '/v1/workforce/{workforceId}/halt',
        status: '200',
        send: () => authed(`/v1/workforce/${CONTROL_WORKFORCE}/halt`, 'POST', { reason: 'probe' }),
      },
    ];

    // Non-vacuity: if this list ever shrinks to nothing the arm must fail, not sweep over zero.
    expect(probes.length, 'no envelope probes').toBeGreaterThanOrEqual(11);

    for (const probe of probes) {
      const res = await probe.send();
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status, `${probe.name}: ${JSON.stringify(body)}`).toBe(Number(probe.status));
      recordObserved(probe.method, probe.path, probe.status);

      const op = operationAt(doc, probe.method, probe.path);
      const schemaNode = op.responses[probe.status]?.content?.['application/json']?.schema as
        | {
            required?: string[];
            oneOf?: { required?: string[]; properties?: Record<string, { const?: unknown }> }[];
          }
        | undefined;
      expect(schemaNode, `${probe.name}: no documented ${probe.status} JSON schema`).toBeTruthy();

      // `cost` documents THREE shapes as a `oneOf`; pick the branch by the discriminating `by`
      // field the handler actually returned, so each branch is checked against its own response.
      const documented =
        schemaNode?.required ??
        schemaNode?.oneOf?.find((branch) =>
          body.by === undefined
            ? branch.properties?.by === undefined
            : branch.properties?.by?.const === body.by,
        )?.required;
      expect(documented, `${probe.name}: no documented required-key list`).toBeTruthy();

      expect(Object.keys(body).sort(), `${probe.name} — ${probe.method} ${probe.path}`).toEqual(
        [...(documented as string[])].sort(),
      );
    }
  });

  it('LIVE ROW SHAPES: the three list routes return rows with EXACTLY the documented properties', async () => {
    // The row schemas are DERIVED from the drizzle tables, so they cannot drift from the columns —
    // but "the columns" and "what `c.json(rows)` serializes" are still two different things (a
    // projection, a redaction or a `.select({...})` narrowing would break them apart). Each list is
    // seeded with at least one row, so an empty page cannot make this vacuous.
    const lists: { name: string; path: string; docPath: string }[] = [
      { name: 'tasks', path: '/v1/workforce/tasks', docPath: '/v1/workforce/tasks' },
      { name: 'approvals', path: '/v1/workforce/approvals', docPath: '/v1/workforce/approvals' },
      { name: 'reviews', path: '/v1/workforce/reviews', docPath: '/v1/workforce/reviews' },
    ];
    for (const list of lists) {
      const res = await authed(list.path);
      expect(res.status).toBe(200);
      recordObserved('GET', list.docPath, '200');
      const rows = (await res.json()) as Record<string, unknown>[];
      expect(
        rows.length,
        `${list.name}: seeded page came back empty — the check would be vacuous`,
      ).toBeGreaterThan(0);
      const op = operationAt(doc, 'GET', list.docPath);
      const items = (
        op.responses['200']?.content?.['application/json']?.schema as {
          items?: { properties?: Record<string, unknown> };
        }
      )?.items;
      expect(
        items?.properties,
        `${list.name}: documented 200 is not an array of objects`,
      ).toBeTruthy();
      expect(Object.keys(rows[0] as object).sort(), `${list.name} row`).toEqual(
        Object.keys(items?.properties ?? {}).sort(),
      );
    }
    // The single-row read serves the SAME shape as the list, from a different handler.
    const one = await authed(`/v1/workforce/tasks/${seeded.treeTaskId}`);
    expect(one.status).toBe(200);
    recordObserved('GET', '/v1/workforce/tasks/{id}', '200');
    const row = (await one.json()) as Record<string, unknown>;
    const props = (
      operationAt(doc, 'GET', '/v1/workforce/tasks/{id}').responses['200']?.content?.[
        'application/json'
      ]?.schema as { properties?: Record<string, unknown> }
    )?.properties;
    expect(Object.keys(row).sort()).toEqual(Object.keys(props ?? {}).sort());
  });

  it('the typed 504 drain timeout is documented on BOTH routes that can drain', () => {
    // NOT observed — reaching it needs a turn that outlives the 25s HTTP drain window. Documented
    // because `mapEngineError` maps `WorkforceDrainTimeoutError` → GATEWAY_TIMEOUT (504), and both
    // `pause` (with `drain`) and `halt` (which drains first) can raise it.
    expect(
      operationAt(doc, 'POST', '/v1/workforce/{workforceId}/pause').responses['504'],
    ).toBeTruthy();
    expect(
      operationAt(doc, 'POST', '/v1/workforce/{workforceId}/halt').responses['504'],
    ).toBeTruthy();
  });

  it('every documented error response points at the shared error envelope', () => {
    for (const { path, method, op } of workforceOperations(doc)) {
      for (const [status, response] of Object.entries(op.responses)) {
        if (status.startsWith('2')) continue;
        const schemaRef = response.content?.['application/json']?.schema as
          | { $ref?: string }
          | undefined;
        expect(schemaRef?.$ref, `${method} ${path} ${status}`).toBe('#/components/schemas/Error');
      }
    }
    expect(doc.components?.schemas?.Error, 'the envelope component is missing').toBeTruthy();
  });

  // ── G. the decoration must not damage what was already served ────────────────────────────────

  it('the POSTURE NOTICE still rides info.description (the decoration did not clobber it)', () => {
    expect(doc.info.description).toContain('NOT internet-facing');
    expect(doc.info.description).toContain(OPENAPI_POSTURE_NOTICE);
  });

  it('the DECLARED product routes are still described, byte-for-byte as before the decoration', async () => {
    const spec = loadThrowawaySpec();
    expect(
      spec.api.length,
      'the throwaway declares no routes — control is vacuous',
    ).toBeGreaterThan(0);
    for (const route of spec.api) {
      const op = doc.paths[route.path]?.[route.method.toLowerCase()];
      expect(op, `declared ${route.method} ${route.path} vanished from the document`).toBeTruthy();
    }
    expect(doc.info.title).toBe(spec.metadata.name);
  });

  // ── I. THE POSTURE LOOP — the document's claim about its own coverage, vs this run ────────────

  /**
   * DECLARED LAST ON PURPOSE. Vitest runs the arms of a file in declaration order, so by the time
   * this one executes every observing arm above has filed its `(operation, status)` pair in
   * `observedPairs`. This arm is therefore the only place in the repository that can answer the
   * question the served document asks a stranger to trust: *how much of this is actually checked?*
   *
   * It is deliberately the LAST loop to close. The first three loops (path/method, success-body
   * keys, row shapes) each pin a piece of the document against the running system. None of them
   * pins the document's statement ABOUT those pins — and that statement was wrong in both
   * directions at once: it over-claimed ("the TOP-LEVEL field names of EACH successful response",
   * when three of sixteen are driven by nothing) and under-claimed ("seven status codes observed",
   * when twenty-one of the hundred-and-six documented pairs are). An over-claim turns into wrong
   * generated code; an under-claim makes a reader distrust coverage that is real. Both are defects
   * in the artifact, and neither could go red before this arm existed.
   *
   * Note what is DERIVED rather than transcribed here: the undriven success bodies are computed as
   * `documented 2xx − observed 2xx`, so the list the document publishes is checked against the
   * document and this run — never against a comment someone kept up to date by hand.
   *
   * If you are running a single arm with `-t`, this one will fail: it compares what THIS RUN drove
   * against what the document publishes, and a filtered run drives almost nothing. That is the
   * mechanism, not a flake. Run the file.
   */
  it('THE PUBLISHED POSTURE IS THE POSTURE THIS FILE ACTUALLY ENFORCES', () => {
    const documentedPairs: string[] = [];
    for (const { path, method, op } of workforceOperations(doc)) {
      for (const status of Object.keys(op.responses)) {
        documentedPairs.push(`${method.toUpperCase()} ${path} ${status}`);
      }
    }
    // Anti-vacuity, the same guard the path/method arm carries: an empty document would satisfy
    // every set comparison below.
    expect(documentedPairs.length, 'the document describes no responses at all').toBeGreaterThan(
      16,
    );
    expect(observedPairs.size, 'this run observed nothing — the ledger is empty').toBeGreaterThan(
      0,
    );

    // 1. NOTHING IS OBSERVED THAT IS NOT DOCUMENTED. A response a test drives and the document does
    //    not describe is a hole in the contract, whichever way it got there.
    for (const pair of [...observedPairs].sort()) {
      expect(documentedPairs, `OBSERVED ${pair}, which the document does not describe`).toContain(
        pair,
      );
    }

    // 2. THE COUNT THE DOCUMENT PUBLISHES IS THE COUNT THIS FILE DROVE.
    expect(
      observedPairs.size,
      'the document publishes an observed-pair count that this run did not produce — add the ' +
        'observation, or correct WORKFORCE_VERIFICATION_POSTURE.observedPairs',
    ).toBe(WORKFORCE_VERIFICATION_POSTURE.observedPairs);

    // 3. THE UNDRIVEN SUCCESS BODIES ARE DERIVED, NOT TRUSTED: documented 2xx minus observed 2xx.
    //    This is the arm that catches the over-claim. A 17th operation added without a probe lands
    //    here, and so does a probe deleted from `LIVE ENVELOPES`.
    const is2xx = (pair: string) => /\s2\d\d$/.test(pair);
    const undriven = documentedPairs.filter((p) => is2xx(p) && !observedPairs.has(p)).sort();
    expect(
      undriven,
      'the document names a different set of unchecked success bodies than the one this run ' +
        'leaves unchecked',
    ).toEqual([...WORKFORCE_VERIFICATION_POSTURE.successBodiesTranscribed].sort());

    // 4. AND ALL OF IT IS IN THE SERVED BYTES — not merely in a constant a consumer never sees.
    //    The tag is the only place a client generator can read any of this.
    const text = (doc.tags ?? []).find((t) => t.name === WORKFORCE_OPENAPI_TAG)?.description ?? '';
    const operations = workforceOperations(doc).length;
    const checked = operations - undriven.length;
    expect(text, 'the tag does not say how many success bodies are checked').toContain(
      `${checked} of the ${operations} operations`,
    );
    expect(text, 'the tag does not say how large this section is').toContain(
      `${documentedPairs.length} (operation, status) pairs`,
    );
    expect(text, 'the tag does not say how many pairs are observed').toContain(
      `${observedPairs.size} are OBSERVED`,
    );
    // The exact over-claim that shipped. It is cheap to name it and expensive to let it back.
    expect(text, 'the tag is back to claiming EACH successful response is checked').not.toMatch(
      /each successful response/i,
    );
    // Every undriven success body must be NAMED, not merely counted: "three are unchecked" does not
    // tell an integrator whether the one they are about to generate against is among them.
    for (const pair of undriven) {
      expect(text, `the tag does not name the unchecked success body ${pair}`).toContain(pair);
    }
    // `mapEngineError` maps errors; no 2xx is in it. The old sentence implied the residue was all
    // error codes, which is why the three unchecked 2xx had nowhere to be mentioned.
    expect(text, 'the tag does not say the error mapping covers no 2xx').toMatch(/no 2xx/i);
  });
});
