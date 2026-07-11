/**
 * The scheduled-cleanup orchestrator — DB-backed test.
 *
 * Drives `runScheduledCleanup` against a REAL Postgres isolated schema (NEVER `public`) and proves the
 * WHOLE invariant, fail-the-fix, not pass-the-shape:
 *
 *  1. OIDC PRUNE (LIVE): seed expired + non-expired + NULL-expiry oidc_models → ONLY the expired rows are
 *     gone (non-expired + null-expiry survive); the result reports the deleted count. RED-first: a no-op
 *     prune would leave the expired rows → the count + survivor assertions both fail.
 *  2. GDPR GATE — THE load-bearing test. Flag OFF (the default): a user tombstone older than retention is
 *     NOT deleted (it survives) AND the dry-run result reports it WOULD (count ≥1, mode 'disabled'). Flag
 *     ON: the SAME old tombstone IS deleted; a YOUNGER tombstone is NOT; a MEMBERSHIP tombstone whose org
 *     retention EXCEEDS its age is NOT (per-org retention honored); one past its org retention IS.
 *
 * RED-first proof (the gate has teeth): inverting the orchestrator's gate (making the OFF branch DELETE)
 * flips BOTH "GATE OFF" tests below to RED — verified empirically during the build (revert-the-fix → red).
 * Here we assert both directions on the real (correct) code.
 *
 * Self-contained schema (the api-auth store-test convention) — no harness dependency; one isolated schema.
 */
import type { Db } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runScheduledCleanup } from './index.js';
import { MS_PER_DAY } from './retention.js';

const SCHEMA = 'rayspec_test_cleanup';
const ORG_DEFAULT = '00000000-0000-0000-0000-0000000000c1'; // org with NULL retention_days (flat default)
const ORG_LONG = '00000000-0000-0000-0000-0000000000c2'; // org with retention_days = 90 (long window)
const ORG_SHORT = '00000000-0000-0000-0000-0000000000c3'; // org with retention_days = 1 (short window)
const ORG_NEGATIVE = '00000000-0000-0000-0000-0000000000c4'; // org with retention_days = -10 (invalid → default)

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite gates the GDPR retention-delete policy — it must never
// silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'cleanup.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

let db: Db;

/** A fixed "now" so retention math is deterministic across the suite. */
const NOW = new Date('2026-06-26T12:00:00.000Z');
/** Helper: a Date `days` before NOW. */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function buildSchemaSql(schema: string): string {
  return `
  DROP SCHEMA IF EXISTS ${schema} CASCADE;
  CREATE SCHEMA ${schema};

  CREATE TABLE orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, slug text NOT NULL,
    region text NOT NULL DEFAULT 'eu', retention_days integer, external_idp_id text,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL, email_verified_at timestamptz, password_hash text,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE deleted_at IS NULL;
  CREATE TABLE memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL, status text NOT NULL DEFAULT 'active',
    scim_provisioned boolean NOT NULL DEFAULT false, invited_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE UNIQUE INDEX memberships_user_org_idx ON memberships (user_id, org_id);
  CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_org_id uuid REFERENCES orgs(id) ON DELETE CASCADE,
    token_hash text NOT NULL, family_id uuid NOT NULL,
    rotated_at timestamptz, replaced_by uuid, expires_at timestamptz NOT NULL,
    revoked_at timestamptz, revoked_reason text, ua text, ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE oidc_models (
    model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
    grant_id text, user_code text, uid text, consumed_at timestamptz, expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT oidc_models_model_id_pk PRIMARY KEY (model, id)
  );
`;
}

/** Seed an oidc_models row (model+id), optionally with an explicit expires_at (NULL ⇒ never expires). */
async function seedOidc(model: string, id: string, expiresAt: Date | null): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO oidc_models (model, id, payload, expires_at) VALUES ($1, $2, '{}'::jsonb, $3)`,
    [model, id, expiresAt === null ? null : expiresAt.toISOString()],
  );
}

/** Seed a USER tombstone (deleted_at stamped). Returns the user id. */
async function seedUserTombstone(deletedAt: Date): Promise<string> {
  const rows = (await db.$client.unsafe(
    `INSERT INTO users (email, deleted_at) VALUES ($1, $2) RETURNING id`,
    [`deleted+${Math.random().toString(36).slice(2)}@invalid`, deletedAt.toISOString()],
  )) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

/** Seed a LIVE user (no tombstone) — never purged. Returns the id (for membership FK). */
async function seedLiveUser(email: string): Promise<string> {
  const rows = (await db.$client.unsafe(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
    email,
  ])) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

/** Seed a MEMBERSHIP tombstone (status='revoked' + deleted_at) for (org,user). */
async function seedMembershipTombstone(
  orgId: string,
  userId: string,
  deletedAt: Date,
): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO memberships (org_id, user_id, role, status, deleted_at) VALUES ($1, $2, 'member', 'revoked', $3)`,
    [orgId, userId, deletedAt.toISOString()],
  );
}

async function countUsers(): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM users');
  return rows.length;
}
async function countUserTombstones(): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM users WHERE deleted_at IS NOT NULL');
  return rows.length;
}
async function countMembershipTombstones(): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM memberships WHERE deleted_at IS NOT NULL');
  return rows.length;
}
async function countOidc(): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM oidc_models');
  return rows.length;
}

describe.skipIf(!hasDb)('scheduled cleanup — OIDC prune (LIVE) + GDPR purge (gated)', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = makeDbWithSchema(url, SCHEMA);
    await db.$client.unsafe(buildSchemaSql(SCHEMA));
  }, 60_000);

  beforeEach(async () => {
    await db.$client.unsafe('TRUNCATE oidc_models, memberships, sessions, users, orgs CASCADE');
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name, slug, retention_days) VALUES
        ($1, 'default', 'default', NULL),
        ($2, 'long', 'long', 90),
        ($3, 'short', 'short', 1),
        ($4, 'negative', 'negative', -10)`,
      [ORG_DEFAULT, ORG_LONG, ORG_SHORT, ORG_NEGATIVE],
    );
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // ── 1. OIDC prune (LIVE) ──────────────────────────────────────────────────────────────────────
  it('OIDC prune deletes ONLY expired rows — non-expired + NULL-expiry survive (RED-first: a no-op leaves them)', async () => {
    await seedOidc('AccessToken', 'expired-1', daysAgo(1)); // expired (past)
    await seedOidc('Session', 'expired-2', new Date(NOW.getTime() - 60_000)); // expired (a minute ago)
    await seedOidc('RefreshToken', 'live-1', new Date(NOW.getTime() + 3_600_000)); // not expired (future)
    await seedOidc('Client', 'never-expires', null); // NULL expiry — NEVER pruned (semantics preserved)
    expect(await countOidc()).toBe(4);

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: false, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    // Exactly the 2 expired rows were pruned; the future + null-expiry rows survive.
    expect(result.oidcPruned).toBe(2);
    expect(await countOidc()).toBe(2);
    const survivors = (await db.$client.unsafe(
      'SELECT id FROM oidc_models ORDER BY id',
    )) as unknown as Array<{ id: string }>;
    expect(survivors.map((r) => r.id).sort()).toEqual(['live-1', 'never-expires']);
  });

  // ── 2. GDPR GATE — the load-bearing test ────────────────────────────────────────────────────────
  it('GATE OFF (default): an OLD user tombstone is NOT deleted but the dry-run reports it WOULD (mode=disabled, count≥1)', async () => {
    await seedUserTombstone(daysAgo(40)); // 40d old, default retention 30 ⇒ eligible
    expect(await countUserTombstones()).toBe(1);

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: false, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    // ZERO deletes — the tombstone SURVIVES.
    expect(await countUserTombstones()).toBe(1);
    expect(await countUsers()).toBe(1);
    // The dry-run REPORTS it would purge (so an operator sees the backlog).
    expect(result.gdpr.mode).toBe('disabled');
    expect(result.gdpr.users).toBe(1);
    expect(result.gdpr.oldestTombstoneAgeDays).toBe(40);
  });

  it('GATE ON: the SAME old user tombstone IS deleted; a YOUNGER one is NOT (retention honored)', async () => {
    await seedUserTombstone(daysAgo(40)); // eligible (>30)
    await seedUserTombstone(daysAgo(10)); // NOT eligible (<30) — must survive
    expect(await countUserTombstones()).toBe(2);

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: true, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    expect(result.gdpr.mode).toBe('enabled');
    expect(result.gdpr.users).toBe(1); // exactly the old one deleted
    expect(await countUserTombstones()).toBe(1); // the young one remains
    // And the survivor is the 10-day-old one.
    const remaining = (await db.$client.unsafe(
      'SELECT deleted_at FROM users WHERE deleted_at IS NOT NULL',
    )) as unknown as Array<{ deleted_at: Date }>;
    expect(new Date(remaining[0].deleted_at).getTime()).toBe(daysAgo(10).getTime());
  });

  it('GATE ON: a LIVE user (no tombstone) is NEVER touched', async () => {
    await seedLiveUser('alive@example.com');
    await seedUserTombstone(daysAgo(40));

    await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: true, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    // The tombstone is gone; the live user remains.
    expect(await countUsers()).toBe(1);
    expect(await countUserTombstones()).toBe(0);
    const live = await db.$client.unsafe('SELECT 1 FROM users WHERE deleted_at IS NULL');
    expect(live).toHaveLength(1);
  });

  it('GATE ON: MEMBERSHIP per-org retention — a tombstone past its org window IS deleted; one within a LONGER org window is NOT', async () => {
    // ORG_SHORT retention=1: a 5-day tombstone is PAST it ⇒ delete.
    const uShort = await seedLiveUser('m-short@example.com');
    await seedMembershipTombstone(ORG_SHORT, uShort, daysAgo(5));
    // ORG_LONG retention=90: a 40-day tombstone is WITHIN it ⇒ keep (per-org override beats the 30 default).
    const uLong = await seedLiveUser('m-long@example.com');
    await seedMembershipTombstone(ORG_LONG, uLong, daysAgo(40));
    // ORG_DEFAULT NULL retention → flat default 30: a 40-day tombstone is PAST it ⇒ delete.
    const uDef = await seedLiveUser('m-default@example.com');
    await seedMembershipTombstone(ORG_DEFAULT, uDef, daysAgo(40));
    expect(await countMembershipTombstones()).toBe(3);

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: true, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    // ORG_SHORT(5d>1) + ORG_DEFAULT(40d>30) deleted; ORG_LONG(40d<90) kept.
    expect(result.gdpr.memberships).toBe(2);
    expect(await countMembershipTombstones()).toBe(1);
    const survivor = (await db.$client.unsafe(
      'SELECT org_id FROM memberships WHERE deleted_at IS NOT NULL',
    )) as unknown as Array<{ org_id: string }>;
    expect(survivor[0].org_id).toBe(ORG_LONG);
  });

  it('GATE ON: a NEGATIVE per-org retention falls back to the default (fail-closed) — a FRESH membership tombstone is NOT over-deleted', async () => {
    // RET-1 fail-the-fix: ORG_NEGATIVE has retention_days = -10. WITHOUT the clamp, `now - (-10 days)` is a
    // FUTURE cutoff so `deleted_at < cutoff` is TRUE for a tombstone deleted seconds ago → it over-deletes a
    // FRESH tombstone (the irreversible over-purge bug). WITH the clamp, negative falls back to the 30-day
    // default, so a 1-day-old tombstone is WITHIN the window and MUST survive.
    const uNeg = await seedLiveUser('m-negative@example.com');
    await seedMembershipTombstone(ORG_NEGATIVE, uNeg, daysAgo(1)); // only 1 day old — must survive
    expect(await countMembershipTombstones()).toBe(1);

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: true, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    // The negative retention was clamped to the 30-day default ⇒ a 1-day-old tombstone is NOT eligible.
    expect(result.gdpr.mode).toBe('enabled');
    expect(result.gdpr.memberships).toBe(0); // nothing deleted
    expect(await countMembershipTombstones()).toBe(1); // the fresh tombstone SURVIVES
    const survivor = (await db.$client.unsafe(
      'SELECT org_id FROM memberships WHERE deleted_at IS NOT NULL',
    )) as unknown as Array<{ org_id: string }>;
    expect(survivor[0].org_id).toBe(ORG_NEGATIVE);
  });

  it('GATE OFF: the membership dry-run honors per-org retention too (counts the eligible, deletes none)', async () => {
    const uShort = await seedLiveUser('m2-short@example.com');
    await seedMembershipTombstone(ORG_SHORT, uShort, daysAgo(5)); // eligible (5>1)
    const uLong = await seedLiveUser('m2-long@example.com');
    await seedMembershipTombstone(ORG_LONG, uLong, daysAgo(40)); // NOT eligible (40<90)

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: false, gdprRetentionDays: 30 },
      now: () => NOW,
    });

    expect(result.gdpr.mode).toBe('disabled');
    expect(result.gdpr.memberships).toBe(1); // only ORG_SHORT's is eligible
    expect(await countMembershipTombstones()).toBe(2); // BUT zero deleted — both survive
  });

  it('oldestTombstoneAgeDays is the MAX age across users+memberships', async () => {
    await seedUserTombstone(daysAgo(40));
    const u = await seedLiveUser('m3@example.com');
    await seedMembershipTombstone(ORG_DEFAULT, u, daysAgo(55)); // older than the user tombstone

    const result = await runScheduledCleanup({
      db,
      config: { gdprPurgeEnabled: false, gdprRetentionDays: 30 },
      now: () => NOW,
    });
    expect(result.gdpr.oldestTombstoneAgeDays).toBe(55);
  });
});
