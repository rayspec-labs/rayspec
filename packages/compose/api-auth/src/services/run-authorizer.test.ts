/**
 * The execution-time authorization check the durable worker runs before an agent run starts: it
 * answers from the live membership and key rows, so a requester removed, demoted below `agent:run`,
 * or a key revoked, expired or narrowed after the enqueue is refused.
 */
import type { RunJob } from '@rayspec/platform';
import { describe, expect, it } from 'vitest';
import type { ApiKeyRow } from '../stores/api-key-store.js';
import { makeRunAuthorizer } from './run-authorizer.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-01-01T00:00:00Z');

function job(requestedBy?: RunJob['requestedBy']): RunJob {
  return {
    runId: 'run-1',
    tenantId: TENANT,
    agentId: 'agent',
    input: 'x',
    ...(requestedBy ? { requestedBy } : {}),
  };
}

function key(over: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'key-1',
    orgId: TENANT,
    type: 'api_key',
    keyPrefix: 'rk_x',
    keyHash: 'h',
    scopes: ['agent:run'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...over,
  };
}

function authorizer(opts: { members?: Record<string, string>; keys?: ApiKeyRow[] }) {
  const lookups: string[] = [];
  const check = makeRunAuthorizer({
    identityStore: {
      liveMembership: async (userId: string, orgId: string) => {
        lookups.push(`member:${userId}@${orgId}`);
        const role = orgId === TENANT ? opts.members?.[userId] : undefined;
        return role === undefined
          ? undefined
          : { id: 'm', orgId, userId, role, status: 'active' as const };
      },
    },
    apiKeyStore: {
      findById: async (orgId: string, keyId: string) => {
        lookups.push(`key:${keyId}@${orgId}`);
        return opts.keys?.find((k) => k.id === keyId && k.orgId === orgId);
      },
    },
    now: () => NOW,
  });
  return { check, lookups };
}

describe('the durable run authorizer', () => {
  it('runs a job for a member who still holds agent:run in the job tenant', async () => {
    const { check, lookups } = authorizer({ members: { u1: 'member' } });
    expect(await check(job({ kind: 'user', userId: 'u1' }))).toBe(true);
    // Looked up in the JOB's tenant, never another.
    expect(lookups).toEqual([`member:u1@${TENANT}`]);
  });

  it('refuses a member removed since the enqueue, and a role that does not grant agent:run', async () => {
    const { check } = authorizer({ members: { viewer: 'viewer' } });
    expect(await check(job({ kind: 'user', userId: 'removed' }))).toBe(false);
    expect(await check(job({ kind: 'user', userId: 'viewer' }))).toBe(false);
  });

  it('refuses a member of another tenant', async () => {
    const { check } = authorizer({ members: {} });
    const foreign = { ...job({ kind: 'user', userId: 'u1' }), tenantId: OTHER };
    expect(await check(foreign)).toBe(false);
  });

  it('runs a job for an active key that carries agent:run', async () => {
    const { check } = authorizer({ keys: [key()] });
    expect(await check(job({ kind: 'apikey', apiKeyId: 'key-1' }))).toBe(true);
  });

  it('refuses a key that was revoked, has expired, lacks the scope, or is gone', async () => {
    const past = new Date(NOW.getTime() - 1);
    const cases: ApiKeyRow[] = [
      key({ revokedAt: past }),
      key({ expiresAt: NOW }),
      key({ scopes: ['store:read'] }),
    ];
    for (const row of cases) {
      const { check } = authorizer({ keys: [row] });
      expect(await check(job({ kind: 'apikey', apiKeyId: 'key-1' }))).toBe(false);
    }
    const { check } = authorizer({ keys: [] });
    expect(await check(job({ kind: 'apikey', apiKeyId: 'key-1' }))).toBe(false);
  });

  it('runs system jobs and jobs enqueued before jobs recorded a requester, without a lookup', async () => {
    const { check, lookups } = authorizer({});
    expect(await check(job({ kind: 'system' }))).toBe(true);
    expect(await check(job())).toBe(true);
    expect(lookups).toEqual([]);
  });

  it('refuses a requester kind it does not know', async () => {
    const { check } = authorizer({});
    const odd = job({ kind: 'robot' } as unknown as RunJob['requestedBy']);
    expect(await check(odd)).toBe(false);
  });

  it('propagates a lookup failure instead of answering', async () => {
    const check = makeRunAuthorizer({
      identityStore: {
        liveMembership: async () => {
          throw new Error('database unreachable');
        },
      },
      apiKeyStore: { findById: async () => undefined },
    });
    await expect(check(job({ kind: 'user', userId: 'u1' }))).rejects.toThrow(
      'database unreachable',
    );
  });
});
