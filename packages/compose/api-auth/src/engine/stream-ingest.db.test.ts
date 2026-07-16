/**
 * the `stream` (mode:'ingest') primitive END-TO-END, DB-backed, through the
 * REAL createAuthApp chain, driving the THROWAWAY stream backend (platform stays product-free).
 *
 * Proves (fail-the-fix, ground truth, not pass-the-shape):
 *  1. RAW binary round-trip: a non-JSON binary POST reaches the handler via the RAW branch (NO JSON
 *     parse — a binary body must NOT 400) and the exact bytes land in the tenant-bound BlobStore.
 *  2. Idempotency vs a REAL `UNIQUE(chunk_ref)` (a real per-suite DB schema via makeDbWithSchema — the
 * lesson: the constraint is the REAL committed unique index, not a fake-as-plain-array):
 *       - index == next_expected → 200, watermark advances ({next_expected_index: idx+1});
 *       - re-POST same index → 200 no-op (no double row; the blob put-by-index overwrites);
 *       - a gap index → 409 {error:'gap'};
 *       - a crash BETWEEN the blob put and the pointer insert does not double-append on retry.
 *  3. CONCURRENT same-index POSTs collide on the UNIQUE: one wins, the other is a handled 200 no-op —
 *     NEVER a 500, and exactly ONE pointer row + ONE blob exist after.
 *  4. TENANT-SCOPED: tenant A's ingest is INVISIBLE to tenant B (the blob is tenant-bound by
 *     construction; the pointer row is tenant-scoped via the chokepoint) — same (upload,index) in B
 *     is a fresh index-0 ack, not a 409/no-op against A's data.
 *
 * Skips when DATABASE_URL is absent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BlobStoreFactory,
  makeFsBlobStoreFactory,
  type ResolvedHandler,
} from '@rayspec/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { ingestOnly, loadStreamPack } from '../test-support/stream-pack-support.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the stream-ingest idempotency + tenant isolation
// over a REAL unique index — it must never silently self-skip to a false green. When the DB is REQUIRED
// but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'stream-ingest.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

/** POST a raw BINARY body to a stream route (NOT JSON — the content-type is octet-stream). */
async function postChunk(
  app: Harness['app'],
  path: string,
  token: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: bytes,
  });
}

describe.skipIf(!hasDb)('stream INGEST primitive end-to-end', () => {
  let h: Harness;
  let handlers: ReadonlyMap<string, ResolvedHandler>;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;

  beforeAll(async () => {
    // load the stream surface VIA THE PACK MECHANISM (loadExtensions merges the pack's
    // stores/handlers/routes; handlers load via the multi-root importer — the SAME path a deployment
    // uses). ingestOnly drops the playback route + its handler ref so the boot completes (the ingest
    // arm is what this suite exercises). This proves the pack mechanism carries the actual ingest surface.
    const merged = ingestOnly(await loadStreamPack());
    handlers = merged.handlers;
    // A per-suite temp dir for the fs blob backend — the SAME makeFsBlobStoreFactory the composition
    // root injects, over an isolated dir (cleaned in afterAll). This is the live blob injection path.
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-stream-ingest-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    h = await createHarness({
      engineSpec: merged.spec,
      engineHandlers: handlers,
      blobFactory,
      schema: 'rayspec_test_stream_ingest',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Register → org → switch → JWT (member role: store:read/write — store:write gates the ingest). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  const chunkPath = (upload: string, index: number): string => `/uploads/${upload}/chunks/${index}`;

  it('the ingest handler resolved as a route-kind handler from the jailed root', () => {
    expect(handlers.get('chunk_ingest_handler')?.kind).toBe('route');
  });

  it('a RAW binary POST round-trips the raw branch (no JSON parse) + the exact bytes land in the blob', async () => {
    const { orgId, token } = await principal('raw@example.com', 'RawOrg');
    // Binary bytes that are NOT valid JSON (a leading 0x00 byte etc.) — if the platform tried to
    // c.req.json() this body it would 400; the raw branch must accept it.
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7b, 0x6e, 0x6f]);
    const res = await postChunk(h.app, chunkPath('upl-raw', 0), token, bytes);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next_expected_index: 1 });

    // GROUND TRUTH: the exact bytes landed in the tenant-bound blob (read them back via a fresh handle
    // bound to the SAME tenant — the on-disk key is `${tenantId}/upl-raw/0`).
    const blob = blobFactory(orgId);
    const got = await blob.get('upl-raw/0');
    if ('notFound' in got) throw new Error('blob not found after ingest');
    const back = new Uint8Array(await new Response(got.body).arrayBuffer());
    expect([...back]).toEqual([...bytes]);
    expect(got.contentLength).toBe(bytes.length);
  });

  it('the idempotent 200-ack / 200-no-op / 409-gap contract (vs the REAL UNIQUE), watermark advances', async () => {
    const { orgId, token } = await principal('idem@example.com', 'IdemOrg');
    const upl = 'upl-idem';

    // index 0 == next_expected (watermark -1) → 200, watermark advances to 0.
    const r0 = await postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([1]));
    expect(r0.status).toBe(200);
    expect(await r0.json()).toEqual({ next_expected_index: 1 });

    // index 2 is a GAP (next_expected is 1) → 409, no row written.
    const rGap = await postChunk(h.app, chunkPath(upl, 2), token, new Uint8Array([9]));
    expect(rGap.status).toBe(409);
    expect(await rGap.json()).toEqual({ error: 'gap', next_expected_index: 1 });

    // index 1 == next_expected → 200, watermark advances to 1.
    const r1 = await postChunk(h.app, chunkPath(upl, 1), token, new Uint8Array([2]));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ next_expected_index: 2 });

    // re-POST index 0 (< next_expected 2) → 200 NO-OP (idempotent), no double row.
    const r0again = await postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([1]));
    expect(r0again.status).toBe(200);
    expect(await r0again.json()).toEqual({ next_expected_index: 2 });

    // GROUND TRUTH: EXACTLY two pointer rows for this upload (index 0 + 1), no duplicate from the
    // re-POST or the 409 gap. The REAL UNIQUE(chunk_ref) is what would have crashed a double-insert.
    expect(await countChunks(h, orgId, upl)).toBe(2);
  });

  it('re-POST after a simulated crash between blob put and pointer insert does not double-append', async () => {
    // The put-by-index is idempotent + the pointer UNIQUE is the authority. We emulate "the bytes were
    // put but the pointer insert never committed" by pre-putting the blob for index 0 directly (the
    // blob is tenant-bound), then doing the real ingest: it re-puts the same key (no-op overwrite) and
    // inserts the pointer once. A SECOND ingest of index 0 is then the idempotent no-op (one row).
    const { orgId, token } = await principal('crash@example.com', 'CrashOrg');
    const upl = 'upl-crash';
    const blob = blobFactory(orgId);
    await blob.put('upl-crash/0', new Uint8Array([7, 7, 7])); // the "crashed-before-pointer" bytes

    const r0 = await postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([7, 7, 7]));
    expect(r0.status).toBe(200);
    expect(await r0.json()).toEqual({ next_expected_index: 1 });

    const r0again = await postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([7, 7, 7]));
    expect(r0again.status).toBe(200); // idempotent no-op, NOT a 500 / double row

    expect(await countChunks(h, orgId, upl)).toBe(1);
  });

  it('CONCURRENT same-index POSTs collide on the UNIQUE: one wins, none 500s, exactly one row', async () => {
    const { orgId, token } = await principal('conc@example.com', 'ConcOrg');
    const upl = 'upl-conc';
    // Fire N concurrent index-0 POSTs. All see watermark -1 (next_expected 0) and race the insert; the
    // UNIQUE(chunk_ref) admits exactly one, the losers catch 23505 → 200 no-op. None may 500.
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([0x42])),
      ),
    );
    for (const r of results) {
      expect([200]).toContain(r.status); // never 500 — the race is handled, not crashed
      expect(await r.json()).toEqual({ next_expected_index: 1 });
    }
    // GROUND TRUTH: EXACTLY one pointer row (the UNIQUE held; the losers did not double-insert).
    expect(await countChunks(h, orgId, upl)).toBe(1);
  });

  it('TENANT-SCOPED: tenant A ingest is invisible to tenant B (same upload/index is a fresh ack in B)', async () => {
    const a = await principal('tenA@example.com', 'TenAOrg');
    const b = await principal('tenB@example.com', 'TenBOrg');
    const upl = 'shared-upload-id';

    // A ingests index 0 + 1.
    expect((await postChunk(h.app, chunkPath(upl, 0), a.token, new Uint8Array([1]))).status).toBe(
      200,
    );
    expect((await postChunk(h.app, chunkPath(upl, 1), a.token, new Uint8Array([2]))).status).toBe(
      200,
    );

    // B posts the SAME upload id + index 0. If A's data leaked, B would see watermark 1 → a 409 (gap)
    // or a no-op. Tenant isolation means B's watermark is -1 → a clean index-0 ACK.
    const bRes = await postChunk(h.app, chunkPath(upl, 0), b.token, new Uint8Array([9]));
    expect(bRes.status).toBe(200);
    expect(await bRes.json()).toEqual({ next_expected_index: 1 });

    // GROUND TRUTH: A has 2 rows, B has 1 — disjoint. And B's blob bytes are B's, not A's.
    expect(await countChunks(h, a.orgId, upl)).toBe(2);
    expect(await countChunks(h, b.orgId, upl)).toBe(1);
    const bBlob = blobFactory(b.orgId);
    const bGot = await bBlob.get(`${upl}/0`);
    if ('notFound' in bGot) throw new Error('B blob missing');
    const bBytes = new Uint8Array(await new Response(bGot.body).arrayBuffer());
    expect([...bBytes]).toEqual([9]); // B's bytes, not A's [1]
  });

  it('the ingest pointer row stamps created_by from the SERVER-DERIVED principal (user:<userId>), un-spoofably', async () => {
    // The ingest route runs the full auth chain, so the handler's store facade must stamp the injected
    // created_by column with the authenticated caller's identity — the SAME invariant the JSON {handler}
    // route and the declarative store.create path uphold. This exercises the WHOLE path: the route derives
    // the actor from c.get('principal') → invokeStreamRouteHandler → makeHandlerDb → the pointer insert.
    const email = 'ingest-actor@example.com';
    const { orgId, token } = await principal(email, 'IngestActorOrg');
    const upl = 'upl-actor';

    // One clean ingest (index 0 == next_expected) → 200 ack, exactly one pointer row written.
    const r0 = await postChunk(h.app, chunkPath(upl, 0), token, new Uint8Array([1, 2, 3]));
    expect(r0.status).toBe(200);
    expect(await countChunks(h, orgId, upl)).toBe(1);

    // GROUND TRUTH: created_by carries the AUTHENTICATED user's identity `user:<userId>`. It is
    // UN-SPOOFABLE and SERVER-DERIVED: the stream body is RAW bytes (no JSON field the caller could set),
    // the handler cannot write created_by (the facade rejects that server-controlled column), and the
    // stamped value equals the real `users.id` the caller never transmitted. RED without the thread: the
    // stream path built its facade with NO actor (2-arg makeHandlerDb), so created_by was NULL.
    const userId = await userIdByEmail(h, email);
    expect(await chunkCreatedBy(h, orgId, upl)).toBe(`user:${userId}`);
  });
});

/**
 * Count the pointer rows for one upload within a tenant — the GROUND-TRUTH idempotency check. Reads
 * the REAL `blob_chunks` table (the throwaway's generated product table) through the tenant chokepoint
 * by raw SQL on the isolated schema (the table is product, not a core `schema.*` export).
 */
async function countChunks(h: Harness, orgId: string, uploadId: string): Promise<number> {
  // The harness schema is the isolated `rayspec_test_stream_ingest`; the pool's search_path resolves it.
  const rows = (await h.db.$client.unsafe(
    'select count(*)::int as n from blob_chunks where tenant_id = $1 and upload_id = $2',
    [orgId, uploadId],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * The `created_by` actor stamp on the (single) pointer row for one upload within a tenant — the
 * GROUND-TRUTH for the actor-stamp invariant. Reads the REAL `blob_chunks` table through the isolated
 * schema's search_path (same raw-SQL path as countChunks).
 */
async function chunkCreatedBy(h: Harness, orgId: string, uploadId: string): Promise<string | null> {
  const rows = (await h.db.$client.unsafe(
    'select created_by from blob_chunks where tenant_id = $1 and upload_id = $2',
    [orgId, uploadId],
  )) as unknown as Array<{ created_by: string | null }>;
  return rows[0]?.created_by ?? null;
}

/**
 * The SERVER-side `users.id` for an email — the identity the created_by stamp must equal. The caller
 * never transmits this value, so asserting against it proves the stamp is server-derived, not client-set.
 */
async function userIdByEmail(h: Harness, email: string): Promise<string> {
  const rows = (await h.db.$client.unsafe('select id from users where email = $1', [
    email,
  ])) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error(`userIdByEmail: no user row for ${email}`);
  return id;
}
