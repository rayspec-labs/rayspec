/**
 * Shadow-apply — DB-backed behavior tests (non-vacuity of the apply check + self-cleanup).
 *
 * Proves `shadowApply` actually APPLIES the SQL (not merely connects) and cleans up after itself:
 *  - clean SQL → { ok:true } AND the throwaway DB is gone afterward;
 *  - broken SQL → { ok:false, error } (so a real apply failure surfaces, not a false green) AND the
 *    throwaway DB is still gone afterward;
 *  - the error never contains the connection URL / credentials.
 *
 * Self-skips when no DB. Uses the SHADOW server (SHADOW_DATABASE_URL, else the `_shadow` sibling of
 * DATABASE_URL — the docker-compose convention).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shadowApply, withDatabaseName } from './shadow-apply.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.SHADOW_DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves shadow-apply actually APPLIES the SQL (non-vacuity
// + credential-safe errors) — it must never silently self-skip to a false green. When the DB (or the
// shadow DB) is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'shadow-apply.db.test: DATABASE_URL or SHADOW_DATABASE_URL is required (CI / ' +
      'RAYSPEC_REQUIRE_DB_TESTS) but both are absent — refusing to silently skip this DB-backed suite.',
  );
}

function shadowUrl(): string {
  if (process.env.SHADOW_DATABASE_URL) return process.env.SHADOW_DATABASE_URL;
  const dbUrl = process.env.DATABASE_URL as string;
  const name = new URL(dbUrl).pathname.replace(/^\//, '');
  return withDatabaseName(dbUrl, `${name}_shadow`);
}

describe.skipIf(!hasDb)('shadowApply — applies + cleans up', () => {
  let admin: postgres.Sql;

  beforeAll(() => {
    admin = postgres(shadowUrl(), { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin.end();
  });

  /** Does a SPECIFIC throwaway DB still exist? (concurrency-safe vs a global `rayspec_plan_%` check). */
  async function dbExists(name: string): Promise<boolean> {
    const rows = await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    return rows.length > 0;
  }

  it('applies clean generated-shape SQL → ok:true and drops the throwaway DB', async () => {
    // A minimal additive migration in the generated shape (with breakpoint markers + the injected
    // tenant_id FK to the seeded orgs root).
    const sql = [
      'CREATE TABLE "widgets" (',
      '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
      '\t"tenant_id" uuid NOT NULL,',
      '\t"label" text NOT NULL',
      ');',
      '--> statement-breakpoint',
      'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_tenant_id_orgs_id_fk" ' +
        'FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;',
    ].join('\n');

    const r = await shadowApply(shadowUrl(), sql);
    expect(r.ok).toBe(true);
    expect(r.dbName).toBeDefined();
    // The SPECIFIC throwaway DB this run created is gone (concurrency-safe — not a global pattern).
    expect(await dbExists(r.dbName as string)).toBe(false);
  }, 60_000);

  it('reports a failure on broken SQL → ok:false with a secret-free error, and still cleans up', async () => {
    const r = await shadowApply(shadowUrl(), 'CREATE TABLE bad ( this is not valid sql );');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0);
      // The error describes the SQL/syntax, never the connection URL/credentials.
      expect(r.error).not.toContain('postgres://');
      expect(r.error).not.toMatch(/password/i);
      expect(r.dbName).toBeDefined();
      expect(await dbExists(r.dbName as string)).toBe(false);
    }
  }, 60_000);

  it('SL-1: an AUTH failure (bad password) → sanitized generic error, no host/credential leak', async () => {
    // Same real shadow host/port, but a wrong password → PostgresError 28P01. SL-1 must collapse it to
    // the fixed generic message — never echoing the host/port/user/password.
    const good = new URL(shadowUrl());
    const bad = new URL(shadowUrl());
    bad.username = 'rayspec';
    bad.password = 'definitely-the-wrong-password-xyz';
    const r = await shadowApply(bad.toString(), 'CREATE TABLE "x" ( "id" uuid PRIMARY KEY );');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('could not connect to / authenticate against the shadow database');
      expect(r.error).not.toContain('postgres://');
      expect(r.error).not.toContain(good.hostname);
      expect(r.error).not.toContain(good.port);
      expect(r.error).not.toContain('definitely-the-wrong-password-xyz');
      // No throwaway DB was created (the admin connect failed before CREATE).
      expect(r.dbName).toBeUndefined();
    }
  }, 60_000);
});
