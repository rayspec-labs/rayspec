/**
 * ApiKeyStore unit tests — mint/resolve/revoke + the uniform dummy-HMAC resolution path + the
 * m2m_client (client_credentials seam) resolving to one org.
 */
import { mintApiKey } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyStore } from './api-key-store.js';

const SCHEMA = 'rayspec_test_apikey';
const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b1';
let db: Db;
let store: ApiKeyStore;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  if (!process.env.RAYSPEC_API_KEY_PEPPER) {
    process.env.RAYSPEC_API_KEY_PEPPER = 'dev-pepper-for-tests-only';
  }
  db = makeDbWithSchema(url, SCHEMA);
  await db.$client.unsafe(`
    DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
    CREATE SCHEMA ${SCHEMA};
    SET search_path TO ${SCHEMA};
    CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz DEFAULT now());
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      type text NOT NULL DEFAULT 'api_key', key_prefix text NOT NULL, key_hash text NOT NULL,
      scopes text[] NOT NULL DEFAULT '{}', created_by uuid, last_used_at timestamptz,
      expires_at timestamptz, revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);
    INSERT INTO orgs (id, name) VALUES ('${ORG_A}', 'A'), ('${ORG_B}', 'B');
  `);
  store = new ApiKeyStore(db);
});

beforeEach(async () => {
  await db.$client.unsafe(`SET search_path TO ${SCHEMA}; TRUNCATE api_keys;`);
});

afterAll(async () => {
  await db.$client.end();
});

describe('mint + resolve', () => {
  it('mints with HMAC-only storage; the plaintext resolves to the correct org', async () => {
    const minted = mintApiKey();
    await store.mint({
      orgId: ORG_A,
      keyPrefix: minted.prefix,
      keyHash: minted.hash,
      scopes: ['agent:run'],
    });
    const resolved = await store.resolve(minted.plaintext);
    expect(resolved?.orgId).toBe(ORG_A);
    expect(resolved?.scopes).toEqual(['agent:run']);
    // The stored hash is NOT the plaintext.
    const rows = await store.listForOrg(ORG_A);
    expect(rows[0]?.keyHash).not.toContain(minted.plaintext);
  });

  it('a m2m_client key resolves client_id(prefix)+secret to ONE org', async () => {
    const minted = mintApiKey();
    await store.mint({
      orgId: ORG_B,
      type: 'm2m_client',
      keyPrefix: minted.prefix,
      keyHash: minted.hash,
      scopes: ['agent:run', 'agent:read'],
    });
    const resolved = await store.resolve(minted.plaintext);
    expect(resolved?.type).toBe('m2m_client');
    expect(resolved?.orgId).toBe(ORG_B);
  });
});

describe('uniform resolution failures (no observable branch)', () => {
  it('returns undefined for missing-prefix / unknown-prefix / wrong-secret / revoked', async () => {
    const minted = mintApiKey();
    const row = await store.mint({
      orgId: ORG_A,
      keyPrefix: minted.prefix,
      keyHash: minted.hash,
      scopes: ['agent:run'],
    });

    expect(await store.resolve('no-dot-prefix-only')).toBeUndefined();
    expect(await store.resolve('mk_unknown.secret')).toBeUndefined();
    expect(await store.resolve(`${minted.prefix}.wrong-secret`)).toBeUndefined();

    await store.revoke(ORG_A, row.id);
    expect(await store.resolve(minted.plaintext)).toBeUndefined(); // revoked
  });
});

describe('revoke is org-scoped', () => {
  it('revoking with the WRONG org does not revoke the key', async () => {
    const minted = mintApiKey();
    const row = await store.mint({
      orgId: ORG_A,
      keyPrefix: minted.prefix,
      keyHash: minted.hash,
      scopes: ['agent:run'],
    });
    // Org B tries to revoke org A's key → no row affected.
    const revokedByB = await store.revoke(ORG_B, row.id);
    expect(revokedByB).toBe(false);
    // The key still resolves (org A still owns it).
    expect(await store.resolve(minted.plaintext)).toBeDefined();
  });
});
