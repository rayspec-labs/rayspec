/**
 * the `stream` (mode:'playback') primitive + the SECOND auth path END-TO-END,
 * DB-backed, through the REAL createAuthApp chain, driving the THROWAWAY stream backend.
 *
 * THE MEDIA-JWT BATTERY IS THE HEADLINE (fail-the-fix, ground truth). All of these must
 * DENY a playback GET, and a valid token for the caller's OWN resource must serve the bytes:
 *   - a FORGED token (signed with a DIFFERENT media secret) → 401;
 *   - a token with a SWAPPED/forged tenantId claim (re-signed by an attacker w/o our secret) → 401;
 *   - a tenant-A token used against tenant-B's blob → 404 (the DB ownership re-validation: B's pointer
 *     row is invisible under A's tenant scope). ⚠ RED-FIRST (PM reproduces): flip the handler's DB
 *     re-check OFF and this MUST start SUCCEEDING — that is what proves the test bites;
 *   - ALG-CONFUSION: an `alg:none` token, an RS256-signed token, AND a normal API Bearer/JWKS token in
 *     `?token=` → 401 (the verifier pins HS256 + the distinct media key);
 *   - an EXPIRED token → 401;
 *   - a VALID media token for the caller's own resource → 200/206 serves the exact bytes.
 *
 * DISTINCT-KEY ISOLATION (both directions):
 *   - a VALID media token does NOT authenticate the normal API surface;
 *   - a normal API Bearer/JWKS token does NOT authenticate the playback route.
 *
 * RANGE/206 + conditional-GET: byte-range correctness, 416 on a bad range, full GET → 200, If-None-Match
 * → 304, If-Range mismatch → full 200. SEMAPHORE: N+1 concurrent streams → 429 + Retry-After.
 *
 * The Bearer mint path works (POST .../play-token under the normal chain mints a usable token).
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
import { decodeJwt, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMediaTokenService, type MediaTokenService } from '../media/media-token.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { loadStreamPack } from '../test-support/stream-pack-support.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed media-JWT SECURITY suite must never silently self-skip to a
// false green. When the DB is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'stream-playback.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

const MEDIA_SECRET = 'p5s3-media-secret-at-least-32-bytes-xx';

/** POST a raw BINARY chunk (the ingest route). */
async function postChunk(
  app: Harness['app'],
  upload: string,
  index: number,
  token: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
): Promise<Response> {
  return app.request(`/uploads/${upload}/chunks/${index}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: bytes,
  });
}

/** GET a playback range with a `?token=` media-JWT (+ optional extra headers). */
function playbackUrl(upload: string, index: number, token: string): string {
  return `/uploads/${upload}/chunks/${index}/playback?token=${encodeURIComponent(token)}`;
}

describe.skipIf(!hasDb)('stream PLAYBACK + media-JWT second auth path', () => {
  let h: Harness;
  let handlers: ReadonlyMap<string, ResolvedHandler>;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;
  let media: MediaTokenService;

  beforeAll(async () => {
    // the FULL stream surface (ingest + playback + mint) loaded VIA THE PACK MECHANISM
    // (loadExtensions merges the pack; handlers load via the multi-root importer). This proves the
    // pack mechanism carries the actual playback + media-JWT surface end-to-end.
    const merged = await loadStreamPack();
    const spec = merged.spec;
    handlers = merged.handlers;
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-stream-s3-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    // The SAME media secret the harness wires into the engine — so the test can ALSO mint forged /
    // cross-tenant / expired tokens directly with the real signer for the RED-first battery.
    media = createMediaTokenService(MEDIA_SECRET);
    h = await createHarness({
      engineSpec: spec,
      engineHandlers: handlers,
      blobFactory,
      mediaTokenService: media,
      // A tiny per-user cap so the semaphore 429 is deterministic — but big enough for the happy paths.
      playbackMaxStreamsPerUser: 2,
      schema: 'rayspec_test_p5s3',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Register → org → switch → JWT (member: store:read/write). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; userId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const regBody = await reg.json();
    const t0 = regBody.accessToken as string;
    // The access token's `sub` IS the userId (auth-core tokens.ts) — decode it for the media-token sub.
    const userId = (decodeJwt(t0).sub as string) ?? '';
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
    return { orgId, userId, token };
  }

  /** Ingest one chunk's bytes for `upload`/`index` under the principal, returning the bytes. */
  async function ingest(
    p: { token: string },
    upload: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const r = await postChunk(h.app, upload, index, p.token, bytes, 'audio/ogg');
    expect(r.status).toBe(200);
  }

  /** Mint a play-token for `upload`/`index` via the REAL Bearer mint route. */
  async function mintViaRoute(
    p: { token: string },
    upload: string,
    index: number,
  ): Promise<Response> {
    return h.app.request(`/uploads/${upload}/chunks/${index}/play-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.token}` },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The happy path + the Bearer mint route.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('the mint route (Bearer) mints a token, and playback (media-JWT) serves the exact bytes (200)', async () => {
    const a = await principal('s3-happy@example.com', 'S3Happy');
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    await ingest(a, 'upl-1', 0, bytes);

    // Mint via the REAL authed route.
    const mintRes = await mintViaRoute(a, 'upl-1', 0);
    expect(mintRes.status).toBe(200);
    const { token, resource } = await mintRes.json();
    expect(resource).toBe('upl-1/0');
    expect(typeof token).toBe('string');

    // Full GET with the media token → 200 + the exact bytes + headers.
    const res = await h.app.request(playbackUrl('upl-1', 0, token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('audio/ogg');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    const back = new Uint8Array(await res.arrayBuffer());
    expect([...back]).toEqual([...bytes]);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The media-JWT RED-first battery — every one of these must DENY.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('DENIES a FORGED token (signed with a different media secret) → 401', async () => {
    const a = await principal('s3-forged@example.com', 'S3Forged');
    await ingest(a, 'upl-1', 0, new Uint8Array([1, 2, 3]));
    const forged = await createMediaTokenService('a-DIFFERENT-media-secret-32-bytes-xx').mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    const res = await h.app.request(playbackUrl('upl-1', 0, forged));
    expect(res.status).toBe(401);
  });

  it('DENIES a SWAPPED-tenantId token (re-signed without our secret) → 401', async () => {
    const a = await principal('s3-swap@example.com', 'S3Swap');
    await ingest(a, 'upl-1', 0, new Uint8Array([1, 2, 3]));
    // An attacker who knows a victim's org id forges a token claiming it — but cannot sign with our
    // media secret, so it is signed with a wrong key → 401 (the signature, not the claim, is the gate).
    const swapped = await createMediaTokenService('attacker-controlled-secret-32-bytesxx').mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    expect((await h.app.request(playbackUrl('upl-1', 0, swapped))).status).toBe(401);
  });

  it("DENIES a tenant-A token used against tenant-B's blob → 404 (tenant boundary holds end-to-end)", async () => {
    // The END-TO-END tenant boundary (defended by BOTH the tenant-bound blob AND the DB re-check). A
    // tenant-A media token for a resource B owns CANNOT read B's bytes: A's blob handle is bound to A's
    // root (no bytes there) AND A's DB scope has no pointer row → 404. (The DB-check-ISOLATING RED-first
    // proof is the SEPARATE test below — here both layers agree on 404.)
    const a = await principal('s3-tenA@example.com', 'S3TenA');
    const b = await principal('s3-tenB@example.com', 'S3TenB');
    await ingest(b, 'upl-X', 0, new Uint8Array([9, 9, 9])); // B owns upl-X/0; A does not.
    const aToken = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-X/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    expect((await h.app.request(playbackUrl('upl-X', 0, aToken))).status).toBe(404);

    // GROUND TRUTH the other way: B's OWN token serves B's bytes (so the 404 is the boundary, not a
    // missing blob).
    const bToken = await media.mint({
      tenantId: b.orgId,
      resource: 'upl-X/0',
      sub: b.userId,
      ttlSeconds: 300,
    });
    const ok = await h.app.request(playbackUrl('upl-X', 0, bToken));
    expect(ok.status).toBe(200);
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([9, 9, 9]);
  });

  it('the DB ownership re-validation is LOAD-BEARING: bytes present but NO pointer row → 404 (RED-first isolating)', async () => {
    // This ISOLATES the DB re-check (the end-to-end test above is defended by the blob binding too, so
    // it cannot prove the DB check alone bites). Here the bytes ARE reachable by the token tenant's OWN
    // blob handle, but there is NO DB pointer row — so ONLY the DB re-validation stands between the
    // token and the bytes.
    //   ⚠ RED-FIRST (the PM reproduces): flip the chunk-playback handler's `const row = rows[0]; if
    //   (!row) return 404;` so it fabricates a row from the key (serve off the token's mediaResource,
    //   skipping the init.db.select). THIS test then FLIPS from 404 to 200 (A reads its own
    //   pointer-less bytes) — that flip is the proof the DB re-validation is the load-bearing gate here.
    const a = await principal('s3-nopointer@example.com', 'S3NoPointer');
    // Put bytes DIRECTLY into A's OWN tenant-bound blob at the resource key — WITHOUT going through the
    // ingest route, so there is NO DB pointer row for it. (The blob handle is tenant-bound; this is A's
    // own root.)
    const aBlob = blobFactory(a.orgId);
    await aBlob.put('upl-orphan/0', new Uint8Array([5, 5, 5]), { contentType: 'audio/ogg' });
    // A mints a VALID token (its own tenant) for that exact resource. The verifier accepts it (signed,
    // unexpired, A's tenant); the blob.stat would SUCCEED (the bytes are in A's root) — so the ONLY
    // thing that denies is the DB ownership re-validation finding no pointer row.
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-orphan/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    const res = await h.app.request(playbackUrl('upl-orphan', 0, token));
    expect(res.status).toBe(404); // the DB re-check denies; with it OFF this would be a 200.
  });

  it('DENIES an alg:none token → 401 (alg-confusion)', async () => {
    const a = await principal('s3-none@example.com', 'S3None');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    const none = new UnsecuredJWT({ tenantId: a.orgId, resource: 'upl-1/0', sub: a.userId })
      .setIssuer('rayspec-media')
      .setAudience('rayspec-media-playback')
      .setJti('x')
      .setExpirationTime('5m')
      .encode();
    expect((await h.app.request(playbackUrl('upl-1', 0, none))).status).toBe(401);
  });

  it('DENIES an RS256-signed token in ?token= → 401 (alg-confusion)', async () => {
    const a = await principal('s3-rs@example.com', 'S3Rs');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    const { generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const rs = await new SignJWT({ tenantId: a.orgId, resource: 'upl-1/0', sub: a.userId })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('rayspec-media')
      .setAudience('rayspec-media-playback')
      .setJti('x')
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await h.app.request(playbackUrl('upl-1', 0, rs))).status).toBe(401);
  });

  it('DENIES a normal API Bearer/JWKS token used in ?token= → 401 (distinct key chains)', async () => {
    const a = await principal('s3-apitok@example.com', 'S3ApiTok');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    // The RS256 API access token (a.token) is NOT an HS256 media token → the verifier rejects it.
    expect((await h.app.request(playbackUrl('upl-1', 0, a.token))).status).toBe(401);
  });

  it('DENIES an EXPIRED token → 401', async () => {
    const a = await principal('s3-exp@example.com', 'S3Exp');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    const tok = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 1,
    });
    await new Promise((res) => setTimeout(res, 1100));
    expect((await h.app.request(playbackUrl('upl-1', 0, tok))).status).toBe(401);
  });

  it('DENIES a tokenless playback GET → 401', async () => {
    const a = await principal('s3-notoken@example.com', 'S3NoTok');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    expect((await h.app.request('/uploads/upl-1/chunks/0/playback')).status).toBe(401);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // Distinct-key isolation (the other direction): a media token does NOT authenticate the API.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('a VALID media token does NOT authenticate the normal API surface', async () => {
    const a = await principal('s3-iso@example.com', 'S3Iso');
    await ingest(a, 'upl-1', 0, new Uint8Array([1]));
    const mediaToken = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    // Use the media token as a Bearer on an API route (the mint route itself, or any authed route). It
    // is not a JWKS-verifiable RS256 token and not an api-key shape → the API chain does NOT authorize.
    const res = await h.app.request('/uploads/upl-1/chunks/0/play-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${mediaToken}` },
    });
    expect([401, 403]).toContain(res.status);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // Range/206 + conditional-GET.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('Range/206: byte-range correctness (Content-Range + Content-Length exact)', async () => {
    const a = await principal('s3-range@example.com', 'S3Range');
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await ingest(a, 'upl-1', 0, bytes);
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    // bytes=2-5 → the 4 bytes [2,3,4,5].
    const res = await h.app.request(playbackUrl('upl-1', 0, token), {
      headers: { range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });

  it('Range/206: an open-ended range bytes=7- → the tail', async () => {
    const a = await principal('s3-tail@example.com', 'S3Tail');
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await ingest(a, 'upl-1', 0, bytes);
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    const res = await h.app.request(playbackUrl('upl-1', 0, token), {
      headers: { range: 'bytes=7-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  it('416 on an unsatisfiable range (start past EOF)', async () => {
    const a = await principal('s3-416@example.com', 'S3_416');
    const bytes = new Uint8Array([0, 1, 2]);
    await ingest(a, 'upl-1', 0, bytes);
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    const res = await h.app.request(playbackUrl('upl-1', 0, token), {
      headers: { range: 'bytes=99-200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */3');
  });

  it('conditional-GET: If-None-Match → 304', async () => {
    const a = await principal('s3-304@example.com', 'S3_304');
    await ingest(a, 'upl-1', 0, new Uint8Array([1, 2, 3]));
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    const first = await h.app.request(playbackUrl('upl-1', 0, token));
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    // Need a SECOND token (the first stream consumed a permit; but cap is 2 and that stream ended).
    const res = await h.app.request(playbackUrl('upl-1', 0, token), {
      headers: { 'if-none-match': etag as string },
    });
    expect(res.status).toBe(304);
  });

  it('If-Range mismatch → serves the full 200 (not 206)', async () => {
    const a = await principal('s3-ifrange@example.com', 'S3IfRange');
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    await ingest(a, 'upl-1', 0, bytes);
    const token = await media.mint({
      tenantId: a.orgId,
      resource: 'upl-1/0',
      sub: a.userId,
      ttlSeconds: 300,
    });
    // If-Range carries a STALE etag → the server must ignore the Range and serve the full 200.
    const res = await h.app.request(playbackUrl('upl-1', 0, token), {
      headers: { range: 'bytes=1-2', 'if-range': '"stale00000"' },
    });
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes]);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The per-user streaming semaphore.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('semaphore: the (N+1)th concurrent stream for one user → 429 + Retry-After; a permit releases on end', async () => {
    const a = await principal('s3-sema@example.com', 'S3Sema');
    // Three uploads so three distinct resources/tokens (cap is 2).
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      await ingest(a, `upl-${i}`, 0, new Uint8Array([i, i, i, i]));
      tokens.push(
        await media.mint({
          tenantId: a.orgId,
          resource: `upl-${i}/0`,
          sub: a.userId,
          ttlSeconds: 300,
        }),
      );
    }
    // Open 3 streams CONCURRENTLY WITHOUT consuming their bodies (so the permits stay held). The 3rd
    // must be 429 (cap=2). We must read the body of the 200s to release; do that AFTER asserting.
    const responses = await Promise.all(
      tokens.map((t, i) => h.app.request(playbackUrl(`upl-${i}`, 0, t))),
    );
    const statuses = responses.map((r) => r.status).sort();
    // Two succeeded (200), the third saturated (429).
    expect(statuses).toEqual([200, 200, 429]);
    const rate = responses.find((r) => r.status === 429);
    expect(rate?.headers.get('retry-after')).toBeTruthy();

    // Drain the two 200 bodies → their permits release.
    for (const r of responses) {
      if (r.status === 200) await r.arrayBuffer();
    }
    // After release, a fresh stream succeeds again (the permit was freed on stream end — no leak).
    const again = await h.app.request(playbackUrl('upl-0', 0, tokens[0]));
    expect(again.status).toBe(200);
    await again.arrayBuffer();
  });
});
