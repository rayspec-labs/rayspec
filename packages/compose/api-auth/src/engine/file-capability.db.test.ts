/**
 * Pin the REAL first-submit emit-fault posture of the file
 * capability behind the REAL engine chain (createAuthApp → declared routes → route-handlers.ts →
 * `invokeRouteHandler`'s `TenantDb.transaction`, route-init.ts), on a REAL per-suite Postgres schema
 * (makeDbWithSchema — the real committed UNIQUE, not a fake).
 *
 * The submit module header names the posture QUESTION: what does a SURFACED first-submit sink
 * fault leave behind? This suite PINS the answer for the real platform wiring: the submit handler
 * runs INSIDE the engine's tenant transaction, so a generic sink fault that surfaces (500) ROLLS
 * THE SEAL BACK —
 *   (1) upload stages the bytes (state 'uploaded');
 *   (2) a submit whose sink throws a GENERIC fault → HTTP 500, and the pointer row is STILL
 *       state='uploaded' with submitted_at NULL (the seal write rolled back with the transaction),
 *       ZERO events delivered;
 *   (3) the client retry (sink healthy) RE-SEALS from 'uploaded' and emits — 200 with
 *       `deduped: false` (the rollback posture's tell: the persist posture would answer the retry
 *       `deduped: true` off the surviving seal), row sealed, EXACTLY ONE delivered event built from
 *       the stored row.
 * No silent zero-run either way — the fault SURFACES so the client keeps retrying (the
 * emit-fault law); this suite settles WHICH intermediate state the retry sees.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent (never a silent false green).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileSubmittedSink, SubmittedFileEvent } from '@rayspec/file-runtime';
import { mountFileCapability } from '@rayspec/file-runtime/rayspec';
import {
  type BlobStoreFactory,
  makeFsBlobStoreFactory,
  type ResolvedHandler,
} from '@rayspec/platform';
import type { RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'file-capability.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the posture pin.',
  );
}

/** A sink whose next emit can be a GENERIC transient fault (the DBOS-outage stand-in). */
class FaultableSink implements FileSubmittedSink {
  mode: 'ok' | 'fault' = 'ok';
  readonly delivered: SubmittedFileEvent[] = [];
  async emit(event: SubmittedFileEvent): Promise<void> {
    if (this.mode === 'fault') {
      throw new Error('synthetic transient enqueue outage (generic fault — NOT a rejection)');
    }
    this.delivered.push(event);
  }
}

const FILE_ID = 'dp1-doc';
const BODY = 'the dp-1 posture probe bytes';

describe.skipIf(!hasDb)('the first-submit emit-fault posture (real engine tx)', () => {
  let h: Harness;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;
  const sink = new FaultableSink();

  beforeAll(async () => {
    const mounted = mountFileCapability({ fileSubmittedSink: sink });
    // The neutral code-built engine spec (the 0.1 skeleton over the capability fragments — the same
    // shape `buildProductEngineSpec` assembles in the composition).
    const spec: RaySpec = {
      version: '1.0',
      metadata: { name: 'file-capability-dp1-test' },
      stores: mounted.stores,
      api: mounted.api,
      agents: [],
      tooling: [],
      triggers: [],
      handlers: [],
      extensions: [],
    };
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-w2fi-dp1-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    // Every capability-store unique (here file_uploads.file_ref) is a durable ON CONFLICT
    // target → keep its unique index SINGLE-column (a compound one would 42P10 the upsert).
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
      schema: 'rayspec_test_w2fi_dp1',
    });
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Register → org → switch → a member token (store:write gates upload + submit). */
  async function principal(email: string, orgName: string): Promise<string> {
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
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    return (await sw.json()).accessToken as string;
  }

  async function pointerRow(): Promise<Record<string, unknown> | undefined> {
    const rows = (await h.db.$client.unsafe(
      'SELECT file_id, state, sha256, submitted_at FROM file_uploads WHERE file_id = $1',
      [FILE_ID],
    )) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  it('a surfaced generic first-submit sink fault ROLLS THE SEAL BACK; the retry re-seals + emits (deduped:false)', async () => {
    const token = await principal('dp1@example.test', 'DP1 Co');

    // (1) Upload through the REAL stream route: the bytes stage as state 'uploaded'.
    const up = await h.app.request(`/files/${FILE_ID}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(BODY)),
      },
      body: BODY,
    });
    expect(up.status).toBe(200);
    expect(((await up.json()) as Record<string, unknown>).state).toBe('uploaded');
    expect(await pointerRow()).toMatchObject({ state: 'uploaded', submitted_at: null });

    // (2) First submit with a GENERIC sink fault: the fault SURFACES (500 — the client must keep
    // retrying) and the seal write ROLLED BACK with the engine's tenant transaction (route-init.ts):
    // the row is byte-for-byte still the staged one. Nothing was delivered downstream.
    sink.mode = 'fault';
    const faulted = await h.app.request(`/files/${FILE_ID}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(faulted.status).toBe(500);
    expect(await pointerRow()).toMatchObject({ state: 'uploaded', submitted_at: null });
    expect(sink.delivered).toHaveLength(0);

    // (3) The retry (sink healthy) re-seals FROM 'uploaded' and emits: `deduped: false` is the
    // ROLLBACK posture's tell — under the persist posture the seal would have survived and the
    // retry would answer `deduped: true` off the re-submit path.
    sink.mode = 'ok';
    const retry = await h.app.request(`/files/${FILE_ID}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as Record<string, unknown>;
    expect(retryBody.deduped).toBe(false);
    expect(await pointerRow()).toMatchObject({ state: 'submitted' });
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]).toMatchObject({ file_id: FILE_ID });
    expect(sink.delivered[0]?.event_id.endsWith(`:${FILE_ID}`)).toBe(true);
  }, 60_000);
});
