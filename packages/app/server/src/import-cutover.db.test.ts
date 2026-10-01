/**
 * The cutover of an import, on GROUND TRUTH against a throwaway database whose fence an import holds
 * (written here as the import leaves it):
 *  - a cutover token works once: the wrong token, a spent one, an expired one and one whose binding no
 *    longer holds (another migration bundle, a moved environment revision) are refused, and so is a
 *    target whose catalog changed since the import;
 *  - a renewed token replaces the old one;
 *  - `resume` releases the fence only for the cutover that consumed the token, never for a failed
 *    import, and `quiesce` keeps the import's hold as it found it.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION } from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';
import { quiesceOperation, resumeOperation } from './fence-operations.js';
import { catalogDigest, readCatalog } from './import-catalog.js';
import {
  CUTOVER_TOKEN_LIFETIME_MS,
  type CutoverDatabases,
  type CutoverImport,
  consumeCutoverToken,
  issueCutoverToken,
  renewCutoverToken,
} from './import-cutover.js';
import { ensureRuntimeControlState } from './operation-lease.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'import-cutover.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent',
  );
}
let armsRan = 0;
const ARMS = 6;

const SUITE_DB = `rayspec_import_cutover_${process.pid}`;
const RUNTIME_ROLE = `rayspec_cutover_runtime_${process.pid}`;
const DEPLOYMENT = '0123456789abcdef';

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('the cutover of an import', () => {
  let db: Db;
  let dbs: CutoverDatabases;
  let record: CutoverImport;

  const state = async () =>
    (
      (await db.$client.unsafe(
        `SELECT fence_state, fence_epoch::int AS epoch, environment_revision::int AS revision,
                fence_barriers FROM runtime_control_state WHERE id = 1`,
      )) as unknown as {
        fence_state: string;
        epoch: number;
        revision: number;
        fence_barriers: Record<string, unknown> | null;
      }[]
    )[0]!;

  /** The fence as an import that ended ready for its cutover (or failed) leaves it. */
  async function holdFence(importState: 'ready-for-cutover' | 'failed'): Promise<void> {
    const catalog = catalogDigest([await readCatalog(db, RUNTIME_ROLE)]);
    await db.$client.unsafe(
      `UPDATE runtime_control_state
          SET fence_state = 'fenced', fence_epoch = 3, environment_revision = 5, deployment_id = $1,
              fence_barriers = $2::text::jsonb
        WHERE id = 1`,
      [
        DEPLOYMENT,
        JSON.stringify({
          database: {
            barrier: 'database-write-role',
            state: 'held',
            role: RUNTIME_ROLE,
            grants: [],
            workflowSystemGrants: [],
          },
          objects: { barrier: 'object-writes', state: 'held' },
          import: { operationId: record.operationId, state: importState, catalogSha256: catalog },
        }),
      ],
    );
  }

  const outcome = (r: { ok: boolean; errors?: { code: string; message: string }[] }) =>
    r.ok ? 'ok' : `${r.errors![0]!.code}: ${r.errors![0]!.message}`;

  beforeAll(async () => {
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    db = makeDb(withDbName(baseUrl, SUITE_DB), 2);
    await applyMigrations(db);
    await db.$client.begin((tx) => ensureRuntimeControlState(tx));
    dbs = { control: db, workflowSystem: null, runtimeRole: RUNTIME_ROLE };
  }, 120_000);

  beforeEach(async () => {
    if (!baseUrl) return;
    record = {
      operationId: randomUUID(),
      deploymentId: DEPLOYMENT,
      migrationBundleSha256: 'a'.repeat(64),
      sourceFenceEpoch: 7,
    };
    await db.$client.unsafe('DROP VIEW IF EXISTS public.after_import');
    await holdFence('ready-for-cutover');
  });

  afterAll(async () => {
    await db?.$client.end().catch(() => {});
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 60_000);

  it('takes the token once, refuses another token, and keeps only its SHA-256', async () => {
    const issued = await issueCutoverToken(dbs, record, 'b'.repeat(64));
    expect(outcome(issued)).toBe('ok');
    if (!issued.ok) return;
    const { token } = issued.value;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await state()).fence_barriers)).not.toContain(token);
    expect(issued.value.binding).toMatchObject({
      targetFenceEpoch: 3,
      targetEnvironmentRevision: 5,
      sourceFenceEpoch: 7,
    });
    expect(
      Date.parse(issued.value.binding.expiresAt) - Date.parse(issued.value.binding.issuedAt),
    ).toBe(CUTOVER_TOKEN_LIFETIME_MS);

    const wrong = await consumeCutoverToken(dbs, record, 'c'.repeat(64), randomUUID());
    expect(outcome(wrong)).toMatch(/^RAY_POLICY_DENIED: .*not the one this import issued/);
    expect(outcome(await consumeCutoverToken(dbs, record, 'not-a-token', randomUUID()))).toMatch(
      /^RAY_USAGE/,
    );
    const cutoverBy = randomUUID();
    const used = await consumeCutoverToken(dbs, record, token, cutoverBy);
    expect(outcome(used)).toBe('ok');
    expect(used.ok && used.value.fenceEpoch).toBe(3);
    // Spent, even though the fence was not released yet.
    const again = await consumeCutoverToken(dbs, record, token, randomUUID());
    expect(outcome(again)).toMatch(/^RAY_POLICY_DENIED: the cutover token was used already/);
    expect((await state()).fence_state).toBe('fenced');
    armsRan += 1;
  });

  it('refuses an expired token, and a renewed token replaces the old one', async () => {
    const past = new Date(Date.now() - CUTOVER_TOKEN_LIFETIME_MS - 60_000);
    const issued = await issueCutoverToken(dbs, record, 'b'.repeat(64), past);
    expect(outcome(issued)).toBe('ok');
    if (!issued.ok) return;
    expect(Date.parse(issued.value.binding.expiresAt)).toBeLessThan(Date.now());
    const expired = await consumeCutoverToken(dbs, record, issued.value.token, randomUUID());
    expect(outcome(expired)).toMatch(/^RAY_POLICY_DENIED: the cutover token expired/);

    const renewed = await renewCutoverToken(dbs, record);
    expect(outcome(renewed)).toBe('ok');
    if (!renewed.ok) return;
    expect(renewed.value.token).not.toBe(issued.value.token);
    expect(
      outcome(await consumeCutoverToken(dbs, record, issued.value.token, randomUUID())),
    ).toMatch(/not the one this import issued/);
    expect(outcome(await consumeCutoverToken(dbs, record, renewed.value.token, randomUUID()))).toBe(
      'ok',
    );
    armsRan += 1;
  });

  it('refuses a token whose binding no longer holds, and a target whose catalog changed', async () => {
    const issued = await issueCutoverToken(dbs, record, 'b'.repeat(64));
    if (!issued.ok) throw new Error(outcome(issued));
    const { token } = issued.value;
    // Another migration bundle, deployment or source fence than the import record's.
    for (const other of [
      { ...record, migrationBundleSha256: 'e'.repeat(64) },
      { ...record, sourceFenceEpoch: 8 },
    ]) {
      expect(outcome(await consumeCutoverToken(dbs, other, token, randomUUID()))).toMatch(
        /^RAY_POLICY_DENIED: the cutover token binds another/,
      );
    }
    // A catalog that changed since the import.
    await db.$client.unsafe('CREATE VIEW public.after_import AS SELECT 1 AS one');
    expect(outcome(await consumeCutoverToken(dbs, record, token, randomUUID()))).toMatch(
      /^RAY_RECONCILIATION_REQUIRED/,
    );
    expect(outcome(await renewCutoverToken(dbs, record))).toMatch(/^RAY_RECONCILIATION_REQUIRED/);
    await db.$client.unsafe('DROP VIEW public.after_import');
    // An environment revision that moved.
    await db.$client.unsafe(
      'UPDATE runtime_control_state SET environment_revision = environment_revision + 1 WHERE id = 1',
    );
    expect(outcome(await consumeCutoverToken(dbs, record, token, randomUUID()))).toMatch(
      /^RAY_POLICY_DENIED: the target's fence or environment revision moved/,
    );
    armsRan += 1;
  });

  it('resume releases the fence only for the cutover that consumed the token', async () => {
    const issued = await issueCutoverToken(dbs, record, 'b'.repeat(64));
    if (!issued.ok) throw new Error(outcome(issued));
    const request = () => ({
      contractVersion: CONTRACT_VERSION,
      operationId: randomUUID(),
      actor: 'test',
      fenceEpoch: 3,
    });
    const plain = await resumeOperation(request(), randomUUID(), { db });
    expect(plain.ok).toBe(false);
    expect(plain.errors[0]).toMatchObject({ code: 'RAY_USAGE' });
    expect(plain.errors[0]!.message).toContain('--cutover-token');
    const someone = await resumeOperation(request(), randomUUID(), {
      db,
      cutoverBy: randomUUID(),
    });
    expect(someone.errors[0]).toMatchObject({ code: 'RAY_USAGE' });
    expect((await state()).fence_state).toBe('fenced');

    const cutoverBy = randomUUID();
    expect(outcome(await consumeCutoverToken(dbs, record, issued.value.token, cutoverBy))).toBe(
      'ok',
    );
    const released = await resumeOperation(request(), randomUUID(), { db, cutoverBy });
    expect(released.ok, JSON.stringify(released.errors)).toBe(true);
    expect(released.data).toMatchObject({ released: true, fenceEpoch: 3 });
    const after = await state();
    expect(after.fence_state).toBe('open');
    expect(after.fence_barriers).toBeNull();
    // Nothing is left to cut over.
    expect(outcome(await consumeCutoverToken(dbs, record, issued.value.token, cutoverBy))).toMatch(
      /^RAY_POLICY_DENIED: the target's fence is not held by this import/,
    );
    armsRan += 1;
  });

  it('never resumes the fence of an import that failed, and issues it no token', async () => {
    await holdFence('failed');
    const resumed = await resumeOperation(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'test',
        fenceEpoch: 3,
      },
      randomUUID(),
      { db, cutoverBy: randomUUID() },
    );
    expect(resumed.errors[0]).toMatchObject({ code: 'RAY_USAGE' });
    expect(resumed.errors[0]!.message).toContain('--discard-failed');
    expect(outcome(await issueCutoverToken(dbs, record, 'b'.repeat(64)))).toMatch(
      /^RAY_POLICY_DENIED: the target's fence is not held by this import/,
    );
    expect((await state()).fence_state).toBe('fenced');
    armsRan += 1;
  });

  it('a quiesce of the fenced target keeps the import hold as it found it', async () => {
    const before = (await state()).fence_barriers;
    const quiesced = await quiesceOperation(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'test',
        reason: 'again',
        deadline: new Date(Date.now() + 5_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        sourceStopped: false,
      },
      randomUUID(),
      { db },
    );
    expect(quiesced.data?.fenceEpoch).toBe(3);
    expect((await state()).fence_barriers?.import).toEqual(before?.import);
    armsRan += 1;
  });
});
