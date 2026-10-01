/**
 * TenantDb chokepoint — fail-closed, auto-stamp, auto-inject, deny-by-default.
 *
 * Uses a real Postgres (DATABASE_URL) with a minimal throwaway schema covering one registered
 * tenant-scoped table (journal_steps) + orgs (the FK root). The deny-by-default case targets a
 * GLOBAL table (users) that is deliberately NOT in TENANT_SCOPED_TABLES.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  forTenant,
  requireTenantContext,
  schema,
  TENANT_GUC,
  type TenantDb,
  tenantContextRequired,
} from './index.js';
import { makeDbWithSchema } from './testing.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';

// Isolated schema so this suite does not collide with the platform run-core suite when turbo
// runs both in parallel against the same DATABASE_URL.
const TEST_SCHEMA = 'rayspec_test_db';

let db: Db;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for TenantDb tests');
  db = makeDbWithSchema(url, TEST_SCHEMA);
  await db.$client.unsafe(`
    DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
    CREATE SCHEMA ${TEST_SCHEMA};
    SET search_path TO ${TEST_SCHEMA};
    CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE journal_steps (
      step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      backend text NOT NULL, type text NOT NULL, idempotency_key text NOT NULL,
      input_hash text NOT NULL, output jsonb,
      input_tokens numeric NOT NULL DEFAULT '0', output_tokens numeric NOT NULL DEFAULT '0',
      total_tokens numeric NOT NULL DEFAULT '0', cost_usd numeric NOT NULL DEFAULT '0',
      -- cost reconciliation + provenance columns (mirrors migration 0005).
      provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
      cost_drift boolean NOT NULL DEFAULT false, produced_by text, pricing_version text,
      latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL,
      -- error classification + retry advice columns (mirrors migration 0010).
      error_class text, retry_after_ms numeric,
      auth_mode text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  await db.$client.unsafe('TRUNCATE journal_steps, orgs CASCADE');
  await db.$client.unsafe(
    "INSERT INTO orgs (id, name) VALUES ($1,'A'), ($2,'B') ON CONFLICT DO NOTHING",
    [TENANT_A, TENANT_B],
  );
});

afterAll(async () => {
  await db.$client.end();
});

function insertStep(tdb: TenantDb, runId: string, key: string, secret: string) {
  return tdb.insert(schema.journalSteps, {
    runId,
    backend: 'openai',
    type: 'llm',
    idempotencyKey: key,
    inputHash: 'h',
    output: { secret },
    status: 'ok',
    authMode: 'api-key',
  });
}

describe('forTenant fail-closed', () => {
  it('throws on an empty tenantId', () => {
    expect(() => forTenant(db, '')).toThrow(/tenantId is required/);
  });
  it('throws on a blank tenantId', () => {
    expect(() => forTenant(db, '   ')).toThrow(/tenantId is required/);
  });
  it('throws on undefined tenantId', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately passing a bad runtime value.
    expect(() => forTenant(db, undefined as any)).toThrow(/tenantId is required/);
  });
});

describe('insert auto-stamps tenantId', () => {
  it('stamps the tenant on every inserted row', async () => {
    await insertStep(forTenant(db, TENANT_A), 'r1', 'k1', 'sA');
    const rows = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, 'r1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });
});

describe('select auto-injects the tenant predicate', () => {
  it('returns only the calling tenant’s rows', async () => {
    await insertStep(forTenant(db, TENANT_A), 'r1', 'k1', 'sA');
    await insertStep(forTenant(db, TENANT_B), 'r1', 'k1', 'sB');

    const aRows = await forTenant(db, TENANT_A).select(schema.journalSteps).all();
    expect(aRows).toHaveLength(1);
    expect((aRows[0]?.output as { secret: string }).secret).toBe('sA');

    // B cannot see A's row even when filtering by the same runId/key.
    const bRows = await forTenant(db, TENANT_B)
      .select(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, 'r1'));
    expect(bRows).toHaveLength(1);
    expect((bRows[0]?.output as { secret: string }).secret).toBe('sB');
  });
});

describe('update / delete auto-inject the tenant predicate', () => {
  it('update only affects the calling tenant’s rows', async () => {
    await insertStep(forTenant(db, TENANT_A), 'r1', 'k1', 'sA');
    await insertStep(forTenant(db, TENANT_B), 'r1', 'k1', 'sB');

    await forTenant(db, TENANT_A)
      .update(schema.journalSteps, { status: 'error' })
      .where(eq(schema.journalSteps.runId, 'r1'));

    const all = await db.select().from(schema.journalSteps);
    const a = all.find((r) => r.tenantId === TENANT_A);
    const b = all.find((r) => r.tenantId === TENANT_B);
    expect(a?.status).toBe('error');
    expect(b?.status).toBe('ok'); // B untouched
  });

  it('delete only removes the calling tenant’s rows', async () => {
    await insertStep(forTenant(db, TENANT_A), 'r1', 'k1', 'sA');
    await insertStep(forTenant(db, TENANT_B), 'r1', 'k1', 'sB');

    await forTenant(db, TENANT_A)
      .delete(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, 'r1'));

    const remaining = await db.select().from(schema.journalSteps);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tenantId).toBe(TENANT_B);
  });
});

describe('deny-by-default', () => {
  it('throws when an UNREGISTERED (global/auth) table is used via the chokepoint', () => {
    const tdb = forTenant(db, TENANT_A);
    // users is a GLOBAL table, deliberately absent from TENANT_SCOPED_TABLES.
    // biome-ignore lint/suspicious/noExplicitAny: passing a non-registered table on purpose.
    expect(() => tdb.select(schema.users as any)).toThrow(/not registered/);
    // biome-ignore lint/suspicious/noExplicitAny: passing a non-registered table on purpose.
    expect(() => tdb.insert(schema.users as any, { email: 'x@y.com' })).toThrow(/not registered/);
  });
});

describe('runHeaderOwnership probe', () => {
  it('reports absent / owned / foreign correctly', async () => {
    // Build a runs table for this probe.
    await db.$client.unsafe(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id text PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL,
        model text NOT NULL, status text NOT NULL, final_text text, output jsonb,
        cost_usd numeric NOT NULL DEFAULT '0', created_at timestamptz NOT NULL DEFAULT now()
      );
      TRUNCATE runs CASCADE;
      INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
      VALUES ('R', '${TENANT_A}', 'openai', 'api-key', 'x', 'm', 'completed');
    `);
    expect(await forTenant(db, TENANT_A).runHeaderOwnership('R')).toBe('owned');
    expect(await forTenant(db, TENANT_B).runHeaderOwnership('R')).toBe('foreign');
    expect(await forTenant(db, TENANT_A).runHeaderOwnership('missing')).toBe('absent');
  });

  it('CT-1: returns ONLY the verdict — never the foreign row payload', async () => {
    // Seed a runs row for TENANT_A whose final_text + output carry a secret. A cross-tenant
    // probe by B must learn ONLY 'foreign' (the verdict) and NOTHING about the payload — the
    // probe is the SOLE cross-tenant read, so it must not become a payload-leak side channel.
    const SECRET = 'CT1_runs_final_text_secret_zzz';
    await db.$client.unsafe(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id text PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL,
        model text NOT NULL, status text NOT NULL, final_text text, output jsonb,
        cost_usd numeric NOT NULL DEFAULT '0', created_at timestamptz NOT NULL DEFAULT now()
      );
      TRUNCATE runs CASCADE;
      INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status, final_text, output)
      VALUES ('Rsecret', '${TENANT_A}', 'openai', 'api-key', 'x', 'm', 'completed',
              '${SECRET}', '{"secret":"${SECRET}"}'::jsonb);
    `);

    const verdict = await forTenant(db, TENANT_B).runHeaderOwnership('Rsecret');

    // The verdict is EXACTLY one of the three literals — a string, not a row.
    expect(verdict).toBe('foreign');
    expect(typeof verdict).toBe('string');
    // Belt-and-suspenders: the secret never appears anywhere in the returned value.
    expect(JSON.stringify(verdict)).not.toContain(SECRET);
  });
});

describe('unscoped escape hatch', () => {
  it('returns the raw handle (for global/auth tables)', () => {
    const raw = forTenant(db, TENANT_A).unscoped();
    expect(typeof raw.select).toBe('function');
    expect(typeof raw.insert).toBe('function');
  });
});

describe('transaction populates the RLS GUC (set_config seam)', () => {
  it('current_setting(app.current_tenant) inside the tx equals the tenantId', async () => {
    const readback = await forTenant(db, TENANT_A).transaction(async (tx) => {
      const rows = (await tx
        .unscoped()
        .execute(sql`select current_setting(${TENANT_GUC}, true) as v`)) as unknown as Array<{
        v: string | null;
      }>;
      return rows[0]?.v;
    });
    expect(readback).toBe(TENANT_A);
  });

  it('a tx for a DIFFERENT tenant sets its own GUC value (per-tx isolation)', async () => {
    const readback = await forTenant(db, TENANT_B).transaction(async (tx) => {
      const rows = (await tx
        .unscoped()
        .execute(sql`select current_setting(${TENANT_GUC}, true) as v`)) as unknown as Array<{
        v: string | null;
      }>;
      return rows[0]?.v;
    });
    expect(readback).toBe(TENANT_B);
  });

  it('the inner TenantDb stays scoped: writes through it carry the same tenant', async () => {
    await forTenant(db, TENANT_A).transaction(async (tx) => {
      await insertStep(tx, 'rtx', 'ktx', 'sTx');
    });
    const rows = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, 'rtx'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });
});

describe('on a pool that serves under row-level security, every statement runs under the tenant context', () => {
  // A second pool over the same schema, marked the way the composition root marks the runtime role's.
  let db: Db;
  beforeAll(() => {
    db = requireTenantContext(makeDbWithSchema(process.env.DATABASE_URL as string, TEST_SCHEMA));
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  /** The tenant setting at the moment the statement runs, captured into the row it writes. */
  const settingNow = sql`to_jsonb(current_setting(${TENANT_GUC}, true))`;

  function insertCapturing(tdb: TenantDb, runId: string) {
    return tdb.insert(schema.journalSteps, {
      runId,
      backend: 'openai',
      type: 'llm',
      idempotencyKey: runId,
      inputHash: 'h',
      output: settingNow,
      status: 'ok',
      authMode: 'api-key',
    });
  }

  async function capturedFor(runId: string): Promise<unknown> {
    const rows = await db
      .select({ output: schema.journalSteps.output })
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, runId));
    return rows[0]?.output;
  }

  it('a statement built on the pool runs in its own transaction with the tenant set', async () => {
    await insertCapturing(forTenant(db, TENANT_A), 'ctx-pool');
    expect(await capturedFor('ctx-pool')).toBe(TENANT_A);
    const read = await forTenant(db, TENANT_B)
      .select(schema.journalSteps, { guc: sql<string>`current_setting(${TENANT_GUC}, true)` })
      .all();
    // B has no rows, so a select over B reads nothing; the setting is proven on a row of B's own.
    expect(read).toEqual([]);
    await insertCapturing(forTenant(db, TENANT_B), 'ctx-pool-b');
    const seen = await forTenant(db, TENANT_B)
      .select(schema.journalSteps, { guc: sql<string>`current_setting(${TENANT_GUC}, true)` })
      .all();
    expect(seen).toEqual([{ guc: TENANT_B }]);
  });

  it('the setting does not outlive the statement on the pooled connection', async () => {
    await insertCapturing(forTenant(db, TENANT_A), 'ctx-after');
    const after = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.execute(sql`select current_setting(${TENANT_GUC}, true) as v`),
      ),
    );
    for (const rows of after) {
      expect((rows as unknown as { v: string | null }[])[0]?.v ?? '').toBe('');
    }
  });

  it('a statement on a transaction the chokepoint did not open sets the tenant in it', async () => {
    await db.transaction(async (tx) => {
      await insertCapturing(forTenant(tx as unknown as Db, TENANT_B), 'ctx-foreign-tx');
    });
    expect(await capturedFor('ctx-foreign-tx')).toBe(TENANT_B);
  });

  it('events are appended and read under the tenant context from a pool handle', async () => {
    await db.$client.unsafe(`
      CREATE TABLE IF NOT EXISTS tenant_event_streams (
        tenant_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        last_seq bigint NOT NULL DEFAULT 0, truncated_through bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS tenant_events (
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, seq bigint NOT NULL,
        topic text NOT NULL, payload jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, seq));
    `);
    const a = forTenant(db, TENANT_A);
    expect(await a.appendEvents([])).toBeUndefined();
    expect(await a.appendEvents([{ topic: 't', payload: { n: 1 } }])).toEqual({
      firstSeq: 1,
      lastSeq: 1,
    });
    const page = await a.readEventPage({ after: 0, limit: 10 });
    expect(page.events.map((e) => e.topic)).toEqual(['t']);
    expect(await forTenant(db, TENANT_B).readEventPage({ after: 0, limit: 10 })).toMatchObject({
      lastSeq: 0,
      events: [],
    });
  });

  it('a pooled builder still describes its SQL without running, and its failures reject', async () => {
    const built = forTenant(db, TENANT_A).select(schema.journalSteps).all();
    const described = built.toSQL();
    expect(described.sql).toContain('"tenant_id"');
    expect(described.params).toContain(TENANT_A);
    expect(await capturedFor('never-ran')).toBeUndefined();
    // `.execute()` runs it like an await does.
    expect(await forTenant(db, TENANT_A).select(schema.journalSteps).all().execute()).toEqual([]);
    // A failing statement rejects through `.catch` as it does through `await`.
    const caught = await forTenant(db, TENANT_A)
      .insert(schema.journalSteps, { runId: 'missing-required-columns' })
      .catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('on any other pool a chokepoint statement runs on its own, as before', () => {
  /** The statements Drizzle issued through `handle` while `fn` ran, the transaction's included. */
  async function issued(handle: Db, fn: () => Promise<unknown>): Promise<string[]> {
    type Logger = { logQuery(query: string, params: unknown[]): void };
    const session = (
      handle as unknown as { session: { logger: Logger; options: { logger?: Logger } } }
    ).session;
    const previous = session.logger;
    const previousOption = session.options.logger;
    const seen: string[] = [];
    const capture: Logger = { logQuery: (query) => void seen.push(query) };
    session.logger = capture;
    session.options.logger = capture;
    try {
      await fn();
    } finally {
      session.logger = previous;
      session.options.logger = previousOption;
    }
    return seen;
  }

  it('is not marked unless asked, and marking is per pool', () => {
    expect(tenantContextRequired(db)).toBe(false);
    const other = makeDbWithSchema(process.env.DATABASE_URL as string, TEST_SCHEMA);
    try {
      expect(requireTenantContext(other)).toBe(other);
      expect(tenantContextRequired(other)).toBe(true);
      expect(tenantContextRequired(db)).toBe(false);
    } finally {
      void other.$client.end();
    }
  });

  it('a select, insert, update and delete are each one statement with no tenant setting', async () => {
    const a = forTenant(db, TENANT_A);
    const statements = await issued(db, async () => {
      await insertStep(a, 'plain', 'k-plain', 's');
      await a.select(schema.journalSteps).all();
      await a
        .update(schema.journalSteps, { status: 'done' })
        .where(eq(schema.journalSteps.runId, 'plain'));
      await a.delete(schema.journalSteps).where(eq(schema.journalSteps.runId, 'plain'));
    });
    expect(statements).toHaveLength(4);
    expect(statements.some((q) => q.includes('set_config'))).toBe(false);
    // The statement ran with no tenant setting: nothing but the predicate scoped it.
    const seen = await forTenant(db, TENANT_A)
      .select(schema.journalSteps, { guc: sql<string>`current_setting(${TENANT_GUC}, true)` })
      .all();
    expect(seen).toEqual([]);
    await insertStep(a, 'plain-2', 'k-plain-2', 's');
    const withSetting = await forTenant(db, TENANT_A)
      .select(schema.journalSteps, { guc: sql<string>`current_setting(${TENANT_GUC}, true)` })
      .all();
    expect(withSetting.map((r) => r.guc ?? '')).toEqual(['']);
  });

  it('the run ownership probe answers from the plain read alone', async () => {
    await db.$client.unsafe(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id text PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL,
        model text NOT NULL, status text NOT NULL, final_text text, output jsonb,
        cost_usd numeric NOT NULL DEFAULT '0', created_at timestamptz NOT NULL DEFAULT now()
      );
      TRUNCATE runs CASCADE;
    `);
    const statements = await issued(db, async () => {
      expect(await forTenant(db, TENANT_A).runHeaderOwnership('nowhere')).toBe('absent');
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('set_config');
  });

  it('a transaction still sets the tenant first, as it always has', async () => {
    const statements = await issued(db, async () => {
      await forTenant(db, TENANT_A).transaction(async (tx) => {
        await tx.select(schema.journalSteps).all();
      });
    });
    expect(statements[0]).toContain('set_config');
    expect(statements).toHaveLength(2);
  });
});
