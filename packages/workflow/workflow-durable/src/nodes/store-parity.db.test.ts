/**
 * The durable `TenantDbArtifactStore` handle id must be CONTENT-ADDRESSED,
 * byte-identical to the reviewed in-memory `InMemoryArtifactStore` contract, so a handle minted by one
 * backend RESOLVES against the other (no cross-backend handle-id drift). The bug: on the
 * `idempotency_key` path the DB store seeded the handle id from the KEY while the in-memory store always
 * seeds from the content HASH — so the same persist produced DIFFERENT ids across backends.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard (bottom) fails a DB-required run that lost it.
 */
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { contentHash, InMemoryArtifactStore } from '@rayspec/grounding-runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkflowDurableSchemaSql } from '../test-support/schema-ddl.js';
import { TenantDbArtifactStore } from './store.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_wfdur_storeparity_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000f6';

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let testsRan = 0;

// An idempotency_key DELIBERATELY distinct from the content hash — the exact drift trigger (the DB store
// used to seed the handle id from this key while the in-memory store seeds from the content hash).
const persistInput = {
  artifact: { kind: 'triage_result', content: { b: 2, a: 1 }, metadata: { stage: 'x' } },
  namespace: 'tenant-local',
  scope: 'session-1',
  idempotency_key: 'forced-identity-key-not-the-content-hash',
} as const;

describe.skipIf(!hasDb)('workflow-durable — artifact store handle-id parity', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');
    db = makeDbWithSchema(url, APP_SCHEMA);
    await db.$client.unsafe(buildWorkflowDurableSchemaSql(APP_SCHEMA));
    await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1,'f','f')`, [TENANT]);
  }, 60_000);

  beforeEach(async () => {
    await db.$client.unsafe('TRUNCATE workflow_artifacts CASCADE');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('the DB store mints the SAME content-addressed handle id as the in-memory store', async () => {
    testsRan += 1;
    const inMemory = new InMemoryArtifactStore().persist(persistInput);
    const dbStore = new TenantDbArtifactStore(forTenant(db, TENANT));
    const durable = await dbStore.persist(persistInput);

    // Both handles are seeded from the CONTENT hash — NOT the idempotency_key.
    expect(durable.handle.id).toBe(inMemory.handle.id);
    expect(durable.handle.content_hash).toBe(contentHash(persistInput.artifact.content));
    expect(durable.handle.id).toContain('tenant-local:session-1:triage_result:');
    // The id's hash segment is the content hash, never the (distinct) idempotency_key.
    expect(durable.handle.id).not.toContain('forced-identity-key');
  });

  it('cross-backend resolution: a handle minted by one store resolves against the other', async () => {
    testsRan += 1;
    const inMemStore = new InMemoryArtifactStore();
    const inMemory = inMemStore.persist(persistInput);
    const dbStore = new TenantDbArtifactStore(forTenant(db, TENANT));
    await dbStore.persist(persistInput);

    // The DB store resolves the in-memory-minted handle id (same content-addressed id).
    expect(await dbStore.resolve(inMemory.handle.id)).toBeDefined();
    // And the in-memory store resolves the DB-minted handle id.
    const durable = await dbStore.persist(persistInput);
    expect(inMemStore.resolve(durable.handle.id)).toBeDefined();
  });
});

/**
 * Un-skippable ran-guard: fails a DB-required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost
 * DATABASE_URL and silently skipped the parity proof above.
 */
describe('workflow-durable artifact store parity (DB) — ran-guard', () => {
  it('the parity tests ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(testsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
