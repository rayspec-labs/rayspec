/**
 * Session-reprocess route tests — DB-backed (real Postgres, isolated schema via the harness) with an
 * INJECTED fake `SessionReprocessor`. Assert the REAL thing:
 *  - POST /v1/sessions/{id}/reprocess (store:write) → 202 + the FRESH run id(s); the reprocessor is
 *    called with the SERVER-DERIVED tenant + the path sessionId (never a client-supplied tenant);
 *  - tenant-scoping: tenant B cannot reprocess tenant A's session — the route threads B's server-derived
 *    tenant, the tenant-scoped reprocessor returns found:false → uniform 404 (no existence leak);
 *  - fail-closed: no auth → 401; no wired reprocessor → 501;
 *  - the optional advisory `reason` reaches the reprocessor (nothing else is trusted from the body).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionReprocessor } from '../app-context.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

/**
 * A tenant-scoped fake reprocessor: it "finds" session `sess-1` ONLY for its configured owner tenant
 * (mirroring the real reprocessor's tenant-scoped store read), so a request from any other tenant gets
 * found:false. Records every call so the test can assert the tenant/sessionId/reason the route passed.
 */
class FakeReprocessor implements SessionReprocessor {
  ownerTenantId = '';
  readonly calls: Array<{ tenantId: string; sessionId: string; reason?: string }> = [];
  async reprocessSession(input: {
    tenantId: string;
    sessionId: string;
    reason?: string;
  }): ReturnType<SessionReprocessor['reprocessSession']> {
    this.calls.push({ ...input });
    if (input.tenantId === this.ownerTenantId && input.sessionId === 'sess-1') {
      return { found: true, enqueued: [{ workflowId: 'process_recording', runId: 'fresh-run-1' }] };
    }
    return { found: false };
  }
}

const reprocessor = new FakeReprocessor();
let h: Harness;

/** Provision a principal (registered user → org → switch → JWT) — the org creator is an owner (store:write). */
async function principal(email: string, orgName: string) {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  const token = (await switchRes.json()).accessToken as string;
  return { orgId, token };
}

describe('POST /v1/sessions/:id/reprocess (the reprocess affordance)', () => {
  beforeAll(async () => {
    h = await createHarness({ sessionReprocessor: reprocessor, schema: 'rayspec_test_reprocess' });
  });
  afterEach(async () => {
    reprocessor.calls.length = 0;
    reprocessor.ownerTenantId = '';
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('enqueues a FRESH reprocess run (202) for the owning tenant, passing the server-derived tenant', async () => {
    const a = await principal('reproc-a@example.test', 'Org A');
    reprocessor.ownerTenantId = a.orgId;
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.sessionId).toBe('sess-1');
    expect(body.enqueued).toEqual([{ workflowId: 'process_recording', runId: 'fresh-run-1' }]);
    // The route threaded the SERVER-DERIVED tenant + the path sessionId (never client-supplied).
    expect(reprocessor.calls).toHaveLength(1);
    expect(reprocessor.calls[0]).toMatchObject({ tenantId: a.orgId, sessionId: 'sess-1' });
  });

  it('tenant-scoped: tenant B cannot reprocess tenant A’s session → 404 (no existence leak)', async () => {
    const a = await principal('reproc-a2@example.test', 'Org A2');
    const b = await principal('reproc-b@example.test', 'Org B');
    reprocessor.ownerTenantId = a.orgId; // session sess-1 belongs to A only
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);
    // The route passed B's OWN server-derived tenant (not A's) — the tenant-scoped reprocessor then
    // could not find A's session for B, so nothing was enqueued.
    expect(reprocessor.calls[0]).toMatchObject({ tenantId: b.orgId, sessionId: 'sess-1' });
  });

  it('forwards the optional advisory reason (nothing else is trusted from the body)', async () => {
    const a = await principal('reproc-reason@example.test', 'Org Reason');
    reprocessor.ownerTenantId = a.orgId;
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${a.token}` },
      body: { reason: 're-run after fix' },
    });
    expect(res.status).toBe(202);
    expect(reprocessor.calls[0]?.reason).toBe('re-run after fix');
  });

  it('rejects an unknown body field (strict — no attacker-controlled passthrough)', async () => {
    const a = await principal('reproc-strict@example.test', 'Org Strict');
    reprocessor.ownerTenantId = a.orgId;
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${a.token}` },
      body: { tenantId: 'attacker-tenant', reason: 'x' },
    });
    expect(res.status).toBe(400);
    expect(reprocessor.calls).toHaveLength(0); // never reached the reprocessor
  });

  it('unauthenticated → 401 (no reprocess without a principal)', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {});
    expect(res.status).toBe(401);
    expect(reprocessor.calls).toHaveLength(0);
  });

  it('rate-limits repeated reprocess of the SAME session (429 after the quota, before the reprocessor)', async () => {
    const a = await principal('reproc-quota@example.test', 'Org Quota');
    reprocessor.ownerTenantId = a.orgId;
    h.deps.rateLimiter.clearAll(); // deterministic: start the reprocess bucket empty
    // The default reprocess quota is 5 per (tenant, session) per window.
    for (let i = 0; i < 5; i++) {
      const ok = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(ok.status).toBe(202);
    }
    const blocked = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('RATE_LIMITED');
    // The 6th call was rejected BEFORE the reprocessor ran — only the 5 in-quota calls reached it.
    expect(reprocessor.calls).toHaveLength(5);
  });

  it('writes an immutable session_reprocessed audit event (actor, tenant, session, reason, run ids)', async () => {
    const a = await principal('reproc-audit@example.test', 'Org Audit');
    reprocessor.ownerTenantId = a.orgId;
    h.deps.rateLimiter.clearAll();
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${a.token}` },
      body: { reason: 're-run after fix' },
    });
    expect(res.status).toBe(202);

    const rows = await h.deps.auditStore.readForTenant(a.orgId);
    const reprocRows = rows.filter((r) => r.event === 'session_reprocessed');
    expect(reprocRows).toHaveLength(1);
    const row = reprocRows[0];
    expect(row?.actorOrgId).toBe(a.orgId); // the server-derived tenant scope
    expect(row?.actorUserId).toBeTruthy(); // the acting user principal
    const meta = row?.meta as Record<string, unknown>;
    expect(meta.sessionId).toBe('sess-1');
    expect(meta.reason).toBe('re-run after fix');
    expect(meta.runIds).toEqual(['fresh-run-1']); // the resulting FRESH run id(s)
  });

  it('writes NO reprocess audit event for a 404 (foreign/absent session — nothing was enqueued)', async () => {
    const a = await principal('reproc-noaudit-a@example.test', 'Org NoAudit A');
    const b = await principal('reproc-noaudit-b@example.test', 'Org NoAudit B');
    reprocessor.ownerTenantId = a.orgId; // sess-1 belongs to A only
    h.deps.rateLimiter.clearAll();
    const res = await jsonRequest(h.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);
    const bRows = await h.deps.auditStore.readForTenant(b.orgId);
    expect(bRows.filter((r) => r.event === 'session_reprocessed')).toHaveLength(0);
  });
});

describe('POST /v1/sessions/:id/reprocess with a reprocessor that found the session but enqueued NOTHING', () => {
  /** A found session MUST match a registered trigger, so found:true + empty enqueue is an internal fault. */
  class EmptyEnqueueReprocessor implements SessionReprocessor {
    async reprocessSession(): ReturnType<SessionReprocessor['reprocessSession']> {
      return { found: true, enqueued: [] };
    }
  }
  let hEmpty: Harness;
  beforeAll(async () => {
    hEmpty = await createHarness({
      sessionReprocessor: new EmptyEnqueueReprocessor(),
      schema: 'rayspec_test_reprocess_empty',
    });
  });
  afterAll(async () => {
    await hEmpty.close();
  });

  it('500 — never a misleading 202 with an empty enqueue for a found session', async () => {
    const reg = await jsonRequest(hEmpty.app, 'POST', '/v1/auth/register', {
      body: { email: 'reproc-empty@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hEmpty.app, 'POST', '/v1/orgs', {
      body: { name: 'Org Empty' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await jsonRequest(hEmpty.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const token = (await switchRes.json()).accessToken as string;
    const res = await jsonRequest(hEmpty.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /v1/sessions/:id/reprocess with NO wired reprocessor (fail-closed 501)', () => {
  let hNo: Harness;
  beforeAll(async () => {
    hNo = await createHarness({ schema: 'rayspec_test_reprocess_off' });
  });
  afterAll(async () => {
    await hNo.close();
  });

  it('501 when no reprocessor is wired (never a silent no-op 202)', async () => {
    const reg = await jsonRequest(hNo.app, 'POST', '/v1/auth/register', {
      body: { email: 'reproc-off@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hNo.app, 'POST', '/v1/orgs', {
      body: { name: 'Org Off' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await jsonRequest(hNo.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const token = (await switchRes.json()).accessToken as string;
    const res = await jsonRequest(hNo.app, 'POST', '/v1/sessions/sess-1/reprocess', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(501);
  });
});
