/**
 * A CONTRIBUTED ROUTE READS THE RUN JOURNAL AND STREAMS IT — measured end to end, with two tenants and
 * real rows.
 *
 * `pack-route-auth-parity.db.test.ts` holds the incremental route to the same refusals as every other
 * route, and that is a statement about the CHAIN. It cannot be a statement about the DATA: the fixture
 * pack's other handler reads nothing, so nothing there measured what a READING contributed handler can
 * and cannot see. This suite is the other half.
 *
 * It boots ONE app carrying the deployment's own routes plus the in-tree fixture pack, resolved and
 * merged by the REAL `loadExtensions` with its handlers loaded by the REAL multi-root importer, and
 * writes REAL journal rows for TWO tenants under the SAME run id — the arrangement in which a missing
 * tenant predicate is indistinguishable from a present one unless somebody looks. Then:
 *
 *   (A) THE READ WORKS AT ALL — the accept control, and the arm without which every "sees nothing"
 *       below would be satisfied by a route that serves nobody. Tenant A asks for its own run and gets
 *       its own entries back, in recorded order, as `text/event-stream` frames.
 *   (B) IT IS BOUNDED, AND THE PAGE SAYS SO. The fixture reads two entries at a time and drains at
 *       most two pages, so a run of six is answered with four frames and a statement that more were
 *       waiting. The second of those pages is read from INSIDE the producer — after the route
 *       transaction has committed — which is the arrangement the reader is built to survive.
 *   (C) IT RESUMES, RATHER THAN REPLAYING FROM ZERO. Reconnecting with the last frame's id as
 *       `Last-Event-ID` returns the entries AFTER it — no duplicate, no gap — and the union of the two
 *       responses is exactly what A recorded.
 *   (D) A CURSOR THE READER DID NOT ISSUE IS REFUSED. Not answered with an empty stream, and not
 *       answered by replaying everything: either would be a silent wrong answer to a resume.
 *   (E) TENANT ISOLATION, WITH REAL ROWS ON BOTH SIDES. Tenant B asks for the SAME run id, with a
 *       credential valid for B, and gets B's own entry and nothing of A's — not one step id, not one
 *       payload. The read is scoped by construction (the reader is built from the request's
 *       server-derived tenant), and this is the measurement of that, not a restatement of it.
 *
 * WHY THE ROWS ARE WRITTEN DIRECTLY. The journal is written by the platform for the work it runs, and
 * standing up a real agent run here would put a model backend between the assertion and the thing
 * being asserted. What matters to this suite is that the rows are REAL rows in the REAL table, under
 * two real tenants — which is what the read has to be scoped against.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions, loadHandlers, type ResolvedHandler } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: (E) is a tenant-isolation assertion over a contributed READ, so a silent
// self-skip on a run that REQUIRES the database would retire it to a false green.
if (requireDb && !hasDb) {
  throw new Error(
    'pack-journal-stream.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip a tenant-isolation suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
// packages/compose/api-auth/src/engine -> packages/test/fixture-pack
const PACK_DIR = resolve(here, '../../../../test/fixture-pack');
// packages/compose/api-auth/src/engine -> repo-root/examples/acme-notes-backend
const DEPLOYMENT_YAML = resolve(here, '../../../../../examples/acme-notes-backend/rayspec.yaml');

const PACK_ID = 'fixture-pack';
/** The pack's INCREMENTAL route — a `readonly` `{handler}`, therefore gated on `store:read`. */
const STREAM_ROUTE = (runId: string) => `/ext/${PACK_ID}/journal/${runId}`;
/** The one run id BOTH tenants record steps under, so a missing tenant predicate would show. */
const SHARED_RUN_ID = 'shared-run-both-tenants-write-to';
/**
 * What ONE response delivers: the fixture reads pages of two and drains at most two of them, so six
 * recorded entries take one response plus a resume — which is what makes the resume arm below real
 * rather than a second request that happens to return nothing.
 */
const RESPONSE_BOUND = 4;

let h: Harness;

/** The merged document: the deployment's `{store}` routes plus the fixture pack's contributions. */
async function mergedSpec(): Promise<{
  spec: RaySpec;
  handlers: ReadonlyMap<string, ResolvedHandler>;
}> {
  const parsed = parseSpec(readFileSync(DEPLOYMENT_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`deployment spec invalid: ${JSON.stringify(parsed.errors)}`);
  const base = parsed.value;
  const loaded = await loadExtensions([{ id: PACK_ID, module: './dist', version: '1.0.0' }], {
    packsRoot: PACK_DIR,
    deploymentRoot: PACK_DIR,
  });
  const spec: RaySpec = {
    ...base,
    api: [...base.api.filter((r) => r.action.kind === 'store'), ...loaded.api],
    handlers: [...loaded.handlers],
    agents: [],
    tooling: [],
    triggers: [],
    extensions: [],
  };
  const handlers = await loadHandlers(PACK_DIR, spec.handlers, loaded.importer);
  return { spec, handlers };
}

/** Provision a principal (register → org → switch → JWT) with the member role (store:read/write). */
async function principal(
  email: string,
  orgName: string,
): Promise<{ orgId: string; token: string }> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  return { orgId, token: (await switchRes.json()).accessToken as string };
}

/**
 * Append ONE real journal step for `tenantId`. The columns the read contract does not name
 * (`backend`, `auth_mode`) are still NOT NULL in the table, so they are written with the neutral
 * values the platform's own writer uses — the row has to be a real row, not a reduced one.
 */
async function recordStep(
  tenantId: string,
  runId: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await h.db.execute(sql`
    INSERT INTO journal_steps
      (run_id, tenant_id, backend, type, idempotency_key, input_hash, output,
       input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status, auth_mode)
    VALUES
      (${runId}, ${tenantId}::uuid, 'test-backend', 'tool', ${key}, ${`hash-${key}`},
       ${JSON.stringify(payload)}::jsonb, 3, 5, 8, 0.25, 42, 'ok', 'api_key')
  `);
}

/** One parsed SSE frame: the `id:`, the `event:` and the (single-line JSON) `data:`. */
interface Frame {
  id?: string;
  event?: string;
  data: unknown;
}

/** Parse an SSE body into frames. The fixture serializes each payload as ONE line of JSON. */
function parseSse(body: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    const frame: Frame = { data: undefined };
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
    }
    frames.push(frame);
  }
  return frames;
}

/** Read the pack's incremental route as `token`, optionally resuming from `lastEventId`. */
async function readStream(
  token: string,
  runId: string,
  lastEventId?: string,
  query = '',
): Promise<{ status: number; contentType: string | null; frames: Frame[]; body: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
  const res = await jsonRequest(h.app, 'GET', `${STREAM_ROUTE(runId)}${query}`, { headers });
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    frames: parseSse(body),
    body,
  };
}

const stepFrames = (frames: Frame[]): Frame[] => frames.filter((f) => f.event === 'journal_step');
const endFrame = (frames: Frame[]): Record<string, unknown> =>
  (frames.find((f) => f.event === 'journal_end')?.data ?? {}) as Record<string, unknown>;
const stepIds = (frames: Frame[]): string[] =>
  stepFrames(frames).map((f) => (f.data as { stepId: string }).stepId);

beforeAll(async () => {
  if (!hasDb) return;
  const { spec, handlers } = await mergedSpec();
  h = await createHarness({
    engineSpec: spec,
    engineHandlers: handlers,
    schema: 'rayspec_test_apiauth_packjournalstream',
  });
});
beforeEach(async () => {
  if (!hasDb) return;
  await h.reset();
});
afterAll(async () => {
  if (!hasDb) return;
  await h.close();
});

describeDb('a pack route reads the journal back and streams it, scoped to its own tenant', () => {
  it('(A,B) reads its own tenant’s entries as an event stream, BOUNDED, and says more are waiting', async () => {
    const a = await principal('journal-a@example.test', 'Journal A');
    for (const key of ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6']) {
      await recordStep(a.orgId, SHARED_RUN_ID, key, { note: `PAYLOAD_${key.toUpperCase()}` });
    }

    const first = await readStream(a.token, SHARED_RUN_ID);
    expect(first.status).toBe(200);
    expect(first.contentType).toContain('text/event-stream');
    // BOUNDED: six entries exist and the response carried four — the read is paged and the pages are
    // capped, so no request can drain the journal however long it is.
    expect(stepFrames(first.frames)).toHaveLength(RESPONSE_BOUND);
    // …and the page SAYS more were waiting, rather than leaving the client to infer it from a count.
    expect(endFrame(first.frames)).toMatchObject({ hasMore: true });
    // In recorded order, across BOTH pages the response drained — the second of which was read from
    // inside the producer, after the route transaction had already committed.
    const payloads = stepFrames(first.frames).map(
      (f) => (f.data as { output: { note: string } }).output.note,
    );
    expect(payloads).toEqual(['PAYLOAD_A-1', 'PAYLOAD_A-2', 'PAYLOAD_A-3', 'PAYLOAD_A-4']);
    for (const frame of stepFrames(first.frames)) {
      expect((frame.data as { tenantId: string }).tenantId).toBe(a.orgId);
      // EVERY entry frame carries a resume cursor as its SSE id — without it, (C) is impossible.
      expect(frame.id).toBeTruthy();
    }
  });

  it('(C) a client reconnecting with Last-Event-ID resumes rather than replaying from zero', async () => {
    const a = await principal('journal-resume@example.test', 'Journal Resume');
    const keys = ['r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6'];
    for (const key of keys) {
      await recordStep(a.orgId, SHARED_RUN_ID, key, { note: `PAYLOAD_${key.toUpperCase()}` });
    }

    const first = await readStream(a.token, SHARED_RUN_ID);
    const cursor = stepFrames(first.frames).at(-1)?.id;
    expect(cursor).toBeTruthy();
    // The page's own `nextCursor` is the same value the last frame's id carried — one position, not
    // two conventions a client would have to choose between.
    expect(endFrame(first.frames).nextCursor).toBe(cursor);

    const resumed = await readStream(a.token, SHARED_RUN_ID, cursor);
    expect(resumed.status).toBe(200);
    // The REMAINING two entries, and only them: no duplicate of what was already delivered, no gap.
    expect(stepFrames(resumed.frames)).toHaveLength(2);
    expect(
      stepFrames(resumed.frames).map((f) => (f.data as { output: { note: string } }).output.note),
    ).toEqual(['PAYLOAD_R-5', 'PAYLOAD_R-6']);
    expect(endFrame(resumed.frames)).toMatchObject({ hasMore: false });
    // The union of the two responses is EXACTLY what was recorded — the property a resume exists for.
    const seen = [...stepIds(first.frames), ...stepIds(resumed.frames)];
    expect(seen).toHaveLength(keys.length);
    expect(new Set(seen).size).toBe(keys.length);
  });

  it('(D) a cursor this reader did not issue is REFUSED, not silently replayed', async () => {
    const a = await principal('journal-badcursor@example.test', 'Journal Bad Cursor');
    await recordStep(a.orgId, SHARED_RUN_ID, 'bc-1', { note: 'PAYLOAD_BC-1' });

    const refused = await readStream(a.token, SHARED_RUN_ID, 'not-a-cursor-this-reader-issued');
    // The route fails rather than answering: an empty stream would read as "nothing left" and a full
    // one would re-deliver what the client already had. Both are wrong answers to a resume.
    expect(refused.status).toBe(500);
    expect(stepFrames(refused.frames)).toHaveLength(0);
    expect(refused.body).not.toContain('PAYLOAD_BC-1');

    // ACCEPT CONTROL for this arm: the same route, the same tenant, no cursor — 200 with the entry.
    const accepted = await readStream(a.token, SHARED_RUN_ID);
    expect(accepted.status).toBe(200);
    expect(stepFrames(accepted.frames)).toHaveLength(1);
  });

  /**
   * (F) AN EMPTY RESUME CURSOR IS ABSENT, NOT A CURSOR — the request is served, not refused.
   *
   * A browser `EventSource` sends `Last-Event-ID:` empty when it has no last id, and a proxy can
   * synthesise one. Under a plain `??` that empty string wins over anything sent beside it and then
   * survives every downstream "absent?" test, all of which compare against `undefined` — the init
   * spread, the fixture's own check — until the reader refuses it and a well-formed first request
   * comes back 500. That is the shape this arm exists to keep out, in all three of its forms.
   */
  it('(F) an EMPTY Last-Event-ID is served from the beginning, and never beats the query', async () => {
    const a = await principal('journal-empty@example.test', 'Journal Empty');
    for (const key of ['e-1', 'e-2', 'e-3']) {
      await recordStep(a.orgId, SHARED_RUN_ID, key, { note: `PAYLOAD_${key.toUpperCase()}` });
    }

    // (i) an empty header alone: a FIRST request, served from the beginning rather than refused.
    const empty = await readStream(a.token, SHARED_RUN_ID, '');
    expect(empty.status).toBe(200);
    expect(empty.contentType).toContain('text/event-stream');
    expect(stepFrames(empty.frames)).toHaveLength(3);

    // (ii) an empty QUERY is absent too — the other half of the same rule.
    const emptyQuery = await readStream(a.token, SHARED_RUN_ID, undefined, '?lastEventId=');
    expect(emptyQuery.status).toBe(200);
    expect(stepFrames(emptyQuery.frames)).toHaveLength(3);

    // (iii) the shape that made this blocking: an empty header supplied BESIDE a real cursor. The
    // header must not win, or the client's own resume position is discarded.
    const cursor = stepFrames(empty.frames)[0]?.id;
    expect(cursor).toBeTruthy();
    const resumed = await readStream(a.token, SHARED_RUN_ID, '', `?lastEventId=${cursor}`);
    expect(resumed.status).toBe(200);
    expect(
      stepFrames(resumed.frames).map((f) => (f.data as { output: { note: string } }).output.note),
    ).toEqual(['PAYLOAD_E-2', 'PAYLOAD_E-3']);

    // Accept control: a NON-empty header still outranks the query, so precedence is intact and (iii)
    // is not passing because the header is ignored altogether.
    const headerWins = await readStream(a.token, SHARED_RUN_ID, cursor, '?lastEventId=');
    expect(stepFrames(headerWins.frames)).toHaveLength(2);
  });

  it('(E) a second tenant asking for the SAME run sees its own entry and nothing of the first’s', async () => {
    const a = await principal('journal-iso-a@example.test', 'Journal Iso A');
    const b = await principal('journal-iso-b@example.test', 'Journal Iso B');
    // Both tenants record under the SAME run id: the read cannot be scoped by the run id, only by
    // the tenant, so a missing predicate would hand B all four rows.
    for (const key of ['iso-a-1', 'iso-a-2']) {
      await recordStep(a.orgId, SHARED_RUN_ID, key, { note: `SECRET_FROM_A_${key}` });
    }
    await recordStep(b.orgId, SHARED_RUN_ID, 'iso-b-1', { note: 'PAYLOAD_FROM_B' });

    const aStream = await readStream(a.token, SHARED_RUN_ID);
    const bStream = await readStream(b.token, SHARED_RUN_ID);

    // A sees exactly its own two, B exactly its own one — the accept control on both sides, so
    // neither emptiness can be mistaken for isolation.
    expect(stepFrames(aStream.frames)).toHaveLength(2);
    expect(stepFrames(bStream.frames)).toHaveLength(1);
    expect((stepFrames(bStream.frames)[0]?.data as { tenantId: string }).tenantId).toBe(b.orgId);

    // Nothing of A's reaches B: not a payload, not a step id, not a tenant id.
    expect(bStream.body).not.toContain('SECRET_FROM_A');
    expect(bStream.body).not.toContain(a.orgId);
    for (const id of stepIds(aStream.frames)) expect(bStream.body).not.toContain(id);
    // …and symmetrically, B's row is not in A's stream.
    expect(aStream.body).not.toContain('PAYLOAD_FROM_B');
    expect(aStream.body).not.toContain(b.orgId);
  });
});
