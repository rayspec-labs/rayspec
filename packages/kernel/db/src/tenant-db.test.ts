/**
 * TenantDb chokepoint — fail-closed, auto-stamp, auto-inject, deny-by-default.
 *
 * Uses a real Postgres (DATABASE_URL) with a minimal throwaway schema covering one registered
 * tenant-scoped table (journal_steps) + orgs (the FK root). The deny-by-default case targets a
 * GLOBAL table (users) that is deliberately NOT in TENANT_SCOPED_TABLES.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Db, forTenant, schema, TENANT_GUC, type TenantDb } from './index.js';
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
      latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL, auth_mode text NOT NULL,
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
