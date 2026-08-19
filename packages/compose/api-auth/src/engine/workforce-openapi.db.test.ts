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
 * WHAT THIS SUITE DOES NOT ENFORCE — stated, not implied away. The loop above closes on PATHS and
 * METHODS. It does NOT close on response body shape: the row schemas and every request body are
 * DERIVED (from the drizzle table columns and from the very Zod schemas the handlers parse, so
 * those cannot drift), but the bespoke response envelopes — `status`, the three `cost` shapes,
 * `pause`/`resume`, `signal`, `halt`/`cancel`, `verdict`, `goals` — are hand-written, and nothing
 * here compares them to the handler's own `c.json(...)` literal. Status codes are SPOT-CHECKED:
 * five are OBSERVED against the running server (401, 501, two 400s, 404) and asserted to be
 * documented; the rest are hand-derived from `mapEngineError` by reading, so a newly-added
 * `mapEngineError` branch does not go red here.
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
import { schema } from '@rayspec/db';
import { parseSpec, type RaySpec, WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION } from '@rayspec/spec';
import { OPERATOR_SIGNAL_KINDS, TASK_PRIORITIES, TASK_STATUSES } from '@rayspec/tasks';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import {
  WORKFORCE_EXPERIMENTAL_HEADER,
  WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
} from '../routes/workforce.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { OPENAPI_POSTURE_NOTICE } from './emit-openapi.js';
import { WORKFORCE_OPENAPI_TAG, WORKFORCE_SECTION_PREFIX } from './emit-workforce-openapi.js';

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
      workforceGoalIntake: { submitGoal: async () => ({ outcome: 'not_found' as const }) },
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
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    token = (await sw.json()).accessToken as string;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
    await hNoSeam.close();
  });

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
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks').responses['501']).toBeTruthy();
  });

  it('OBSERVED 400: an off-vocabulary status filter answers 400, and 400 is documented', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks?status=nonsense`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
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
    const op = operationAt(doc, 'POST', '/v1/workforce/{workforceId}/goals');
    expect(op.responses['400']).toBeTruthy();
    expect(op.responses['400']?.description).toMatch(/Idempotency-Key/);
  });

  it('OBSERVED 404: an unknown task id answers a uniform 404, and 404 is documented', async () => {
    const res = await fetch(`${base}/v1/workforce/tasks/no-such-task`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(operationAt(doc, 'GET', '/v1/workforce/tasks/{id}').responses['404']).toBeTruthy();
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
});
