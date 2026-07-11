/**
 * Predicate-presence regression.
 *
 * Fails if makeJournalSink().lookup()'s effective WHERE lacks the tenant_id predicate. Because
 * run-core lives in packages/platform (outside a routes-only grep), a future edit could
 * silently drop the structural tenant scoping; this test catches it BEHAVIOURALLY: a step
 * cached under tenant A must be INVISIBLE to a journal sink bound to tenant B for the same
 * runId/idempotencyKey, and visible to tenant A.
 */
import { schema } from '@rayspec/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeJournalSink } from './run-core.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const db = makeTestDb();
const RUN_ID = 'predicate-run';
const KEY = 'llm:k';

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A, TENANT_B);
  // Seed an 'ok' cached step for runId/KEY under tenant A only.
  await db.insert(schema.journalSteps).values({
    runId: RUN_ID,
    tenantId: TENANT_A,
    backend: 'openai',
    type: 'llm',
    idempotencyKey: KEY,
    inputHash: 'h',
    output: { finalText: 'A-CACHED' } as never,
    status: 'ok',
    authMode: 'api-key',
  });
});

afterAll(async () => {
  await db.$client.end();
});

describe('lookup() effective WHERE carries the tenant predicate', () => {
  it('tenant A sees its own cached step', async () => {
    const sink = makeJournalSink(forTenant(db, TENANT_A), RUN_ID, 'openai', true);
    const hit = await sink.lookup(KEY);
    expect(hit).not.toBeNull();
    expect((hit?.output as { finalText: string }).finalText).toBe('A-CACHED');
  });

  it('tenant B does NOT see tenant A’s cached step for the same runId/key (predicate present)', async () => {
    const sink = makeJournalSink(forTenant(db, TENANT_B), RUN_ID, 'openai', true);
    const miss = await sink.lookup(KEY);
    // If the tenant predicate were dropped, this would wrongly return A's cached step.
    expect(miss).toBeNull();
  });
});
