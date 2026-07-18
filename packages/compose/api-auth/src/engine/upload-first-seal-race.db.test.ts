/**
 * The first-upload TOCTOU close, proven against REAL Postgres (the committed single-column UNIQUE on
 * `file_ref` + the REAL `ON CONFLICT … DO UPDATE … WHERE` the store facade emits — a fake cannot prove
 * the SQL). Two clients race the very FIRST upload+seal of the same client-chosen file_id:
 *
 *   - the WINNER performs a genuine first upload (stages 'uploaded') and SEALS it ('submitted');
 *   - the LOSER read "no row" earlier (it entered the NEW-file arm), then lands its upsert AFTER the seal.
 *
 * Historically the loser's UNCONDITIONAL upsert reset the sealed row to 'uploaded' and repointed
 * sha256/blob_key to the loser's bytes — the enqueued run + the sealed bytes stayed consistent, but the
 * ROW POINTER diverged. The structural close is a STATE-GUARDED conditional upsert
 * (`updateWhere: { state: 'uploaded' }`): the loser's DO UPDATE may overwrite ONLY a still-staged row, so
 * a conflict on a SEALED row matches ZERO rows, the loser re-reads and lands on the post-seal arm, and the
 * seal survives untouched. This is the sanctioned `ON CONFLICT … WHERE` row-level guard — NOT an in-tx
 * 23505 catch-and-recover (which would poison the run transaction).
 *
 * DETERMINISTIC INTERLEAVING: the racing create+seal is staged EXACTLY between the loser's stale "no row"
 * read and its guarded upsert (a wrapper fires it once, immediately before the loser's first upsert). A
 * genuinely-timing-dependent `Promise.all` race would only SOMETIMES hit the TOCTOU window (a flaky gate);
 * pinning the interleaving makes this a reliable fail-the-fix: revert the `updateWhere` guard and the loser
 * resets the sealed row → the assertions go RED.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS) yet
 * absent (never a silent false green).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forTenant } from '@rayspec/db';
import {
  createInMemoryFileSubmittedSink,
  type FileBlobContext,
  fileBlobKey,
  fileRef,
  type HandlerDb,
  resolveFileConfig,
  submitFile,
  uploadFile,
} from '@rayspec/file-runtime';
import { mountFileCapability } from '@rayspec/file-runtime/rayspec';
import {
  type BlobStoreFactory,
  makeFsBlobStoreFactory,
  makeHandlerDb,
  type ResolvedHandler,
} from '@rayspec/platform';
import type { RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'upload-first-seal-race.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the first-upload TOCTOU close.',
  );
}

const FILE_ID = 'race-doc';
const WINNER_BYTES = new TextEncoder().encode('the winner first-upload bytes');
const LOSER_BYTES = new TextEncoder().encode('the loser first-upload bytes (divergent)');

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One upload request from raw bytes (a finite Content-Length + an allowlisted media type). */
function uploadRequest(bytes: Uint8Array) {
  return {
    contentLengthHeader: String(bytes.byteLength),
    contentTypeHeader: 'text/plain',
    fileNameHeader: null,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

/**
 * Wrap a `HandlerDb` so `hook` runs ONCE, immediately before the first `upsert` — the deterministic
 * TOCTOU seam for the NEW-file arm: the wrapped upload has already done its "no row" probe read, so
 * the racing create+seal interleaves exactly between that stale read and the guarded conditional upsert.
 */
function withBeforeFirstUpsert(inner: HandlerDb, hook: () => Promise<void>): HandlerDb {
  let fired = false;
  return {
    ...inner,
    async upsert(store, conflictColumns, values, opts) {
      if (!fired) {
        fired = true;
        await hook();
      }
      return inner.upsert(store, conflictColumns, values, opts);
    },
  };
}

describe.skipIf(!hasDb)('the first-upload TOCTOU close (real ON CONFLICT … WHERE)', () => {
  let h: Harness;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;
  let orgId: string;
  const winnerSink = createInMemoryFileSubmittedSink();

  beforeAll(async () => {
    const mounted = mountFileCapability({ fileSubmittedSink: winnerSink });
    const spec: RaySpec = {
      version: '1.0',
      metadata: { name: 'file-first-seal-race-test' },
      stores: mounted.stores,
      api: mounted.api,
      agents: [],
      tooling: [],
      triggers: [],
      handlers: [],
      extensions: [],
    };
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-file-race-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    // Keep every capability-store unique (file_uploads.file_ref) a SINGLE-column ON CONFLICT target (a
    // compound one would 42P10 the upsert) — the same derivation the composition does.
    const conflictKeys = new Map(
      spec.stores.map((s) => [
        s.name,
        new Set(s.columns.filter((c) => c.unique).map((c) => c.name)),
      ]),
    );
    h = await createHarness({
      engineSpec: spec,
      engineHandlers: mounted.handlers as ReadonlyMap<string, ResolvedHandler>,
      blobFactory,
      conflictKeys,
      schema: 'rayspec_test_file_race',
    });
    const rows = (await h.db.$client.unsafe(
      "INSERT INTO orgs (name, slug) VALUES ('Race Co', 'race-co') RETURNING id",
    )) as unknown as Array<{ id: string }>;
    orgId = rows[0]?.id as string;
  });

  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** A tenant-bound file context over the REAL `makeHandlerDb`/facade + the real fs blob backend. */
  function fileCtx(db: HandlerDb): FileBlobContext {
    return {
      tenantId: orgId,
      db,
      blob: blobFactory(orgId),
      config: resolveFileConfig(),
    };
  }

  function realDb(): HandlerDb {
    const productTables = h.deps.engine?.productTables;
    if (!productTables) throw new Error('harness engine.productTables missing');
    return makeHandlerDb(forTenant(h.db, orgId), productTables);
  }

  it("a loser's first upsert lands AFTER a winner's seal: the sealed row is NEVER reset — 409 to the loser, the seal survives with the winner's bytes", async () => {
    const ref = fileRef(orgId, FILE_ID);
    const winnerSha = sha256Hex(WINNER_BYTES);
    const winnerBlobKey = fileBlobKey(FILE_ID, winnerSha);

    // THE RACE: staged deterministically between the loser's stale "no row" read and its upsert.
    const loserDb = withBeforeFirstUpsert(realDb(), async () => {
      const winnerUp = await uploadFile(
        fileCtx(realDb()),
        { file_id: FILE_ID },
        uploadRequest(WINNER_BYTES),
        winnerSink,
      );
      expect(winnerUp.ok).toBe(true);
      const sealed = await submitFile(
        { tenantId: orgId, db: realDb(), config: resolveFileConfig() },
        { file_id: FILE_ID },
        undefined,
        winnerSink,
      );
      expect(sealed.ok).toBe(true);
    });

    const loserSink = createInMemoryFileSubmittedSink();
    const loserRes = await uploadFile(
      fileCtx(loserDb),
      { file_id: FILE_ID },
      uploadRequest(LOSER_BYTES),
      loserSink,
    );

    // GROUND TRUTH (raw SQL, bypassing the facade): exactly ONE row, still SEALED with the WINNER's
    // bytes. The unguarded upsert would have RESET it to 'uploaded' + repointed sha/blob_key to the loser.
    const finalRows = (await h.db.$client.unsafe(
      'SELECT state, sha256, blob_key, submitted_at FROM file_uploads WHERE file_ref = $1',
      [ref],
    )) as unknown as Array<Record<string, unknown>>;
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]?.state).toBe('submitted');
    expect(finalRows[0]?.sha256).toBe(winnerSha);
    expect(finalRows[0]?.blob_key).toBe(winnerBlobKey);
    expect(finalRows[0]?.submitted_at).not.toBeNull();

    // The loser lands on the post-seal DIVERGENT arm: the LOUD 409 (never a silent 200 overwrite).
    expect(loserRes.ok).toBe(false);
    if (loserRes.ok) throw new Error('unreachable');
    expect(loserRes.status).toBe(409);
    expect(loserRes.error).toBe('file_conflict');

    // The loser's 409 heal re-emitted the STORED authoritative event (the WINNER's bytes) exactly once,
    // never the loser's — the heal reads the sealed row, so a leak would surface a loser sha here.
    expect(loserSink.emitCount()).toBe(1);
    const healed = loserSink.deliveredFor(`${orgId}:${FILE_ID}`);
    expect(healed).toBeDefined();
    expect(healed?.sha256).toBe(winnerSha);
    // The winner's own submit delivered its event to its sink too (the winner sealed successfully).
    expect(winnerSink.deliveredFor(`${orgId}:${FILE_ID}`)?.sha256).toBe(winnerSha);
  }, 60_000);
});
