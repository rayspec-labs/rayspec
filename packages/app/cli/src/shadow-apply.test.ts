/**
 * Shadow-apply helpers — deterministic unit tests (no Postgres).
 *
 * The URL/name helpers are the structural guarantee that `plan`'s shadow-apply targets a throwaway DB
 * on the SHADOW server (never the real target), so they are pinned directly:
 *  - `withDatabaseName` rewrites ONLY the database name, preserving scheme/credentials/host/port/query;
 *  - `throwawayDbName` yields a fresh, unique, safe SQL identifier each call.
 *
 * The DB-backed apply behavior (clean apply + failure reporting + self-cleanup) is covered in
 * plan.db.test.ts / shadow-apply.db.test.ts (they need a live Postgres).
 */
import { describe, expect, it } from 'vitest';
import { shadowApply, throwawayDbName, withDatabaseName } from './shadow-apply.js';

describe('withDatabaseName', () => {
  it('rewrites only the database name, preserving credentials/host/port', () => {
    const out = withDatabaseName(
      'postgres://u:p@host.example:5433/rayspec_shadow',
      'rayspec_plan_x',
    );
    expect(out).toBe('postgres://u:p@host.example:5433/rayspec_plan_x');
  });

  it('preserves a query string', () => {
    const out = withDatabaseName('postgres://u:p@host:5432/db?sslmode=require', 'tmp');
    expect(out).toBe('postgres://u:p@host:5432/tmp?sslmode=require');
  });
});

describe('throwawayDbName', () => {
  it('is a safe lowercase identifier prefixed rayspec_plan_', () => {
    const name = throwawayDbName();
    expect(name).toMatch(/^rayspec_plan_\d+_[0-9a-f]{12}$/);
  });

  it('is unique across calls', () => {
    const a = throwawayDbName();
    const b = throwawayDbName();
    expect(a).not.toBe(b);
  });
});

describe('shadowApply — a connection failure never leaks host/port/credentials', () => {
  // No DB needed: postgres.js fails to CONNECT to these unreachable hosts (ENOTFOUND/ECONNREFUSED).
  // The returned error must be the FIXED generic message — no postgres://, host, port, user, password.
  const SECRET_HOSTS = [
    'postgres://secretuser:secretpass@nonexistent.invalid.localhost.example:5499/rayspec_shadow',
    'postgres://secretuser:secretpass@127.0.0.1:1/rayspec_shadow', // port 1: connection refused
  ];

  for (const url of SECRET_HOSTS) {
    it(`sanitizes the connect-failure error for ${new URL(url).hostname}`, async () => {
      const r = await shadowApply(url, 'CREATE TABLE "x" ( "id" uuid PRIMARY KEY );');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // The error is the FIXED generic message — no URL/host/port/credential substrings.
        expect(r.error).toBe('could not connect to / authenticate against the shadow database');
        expect(r.error).not.toContain('postgres://');
        expect(r.error).not.toContain('secretuser');
        expect(r.error).not.toContain('secretpass');
        expect(r.error).not.toContain(new URL(url).hostname);
        expect(r.error).not.toContain(new URL(url).port);
      }
    }, 30_000);
  }
});
