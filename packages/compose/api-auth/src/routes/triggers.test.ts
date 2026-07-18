/**
 * Manual-trigger fire route tests — DB-backed (real Postgres, isolated schema via the harness) with an
 * INJECTED fake `ManualTriggerFirer`. Assert the REAL thing:
 *  - POST /v1/triggers/{name}/fire (store:write) → 202 + `{ name, fired }`; the firer is called with the
 *    SERVER-DERIVED tenant + the path name (never a client-supplied tenant);
 *  - a deduped no-op (already fired this firing key) still returns 202 with `fired:false`;
 *  - tenant-scoping: tenant B cannot fire tenant A's trigger — the route threads B's server-derived
 *    tenant, the tenant-scoped firer returns notFound → uniform 404 (no existence leak);
 *  - fail-closed: an unknown / non-manual trigger → 404; no auth → 401; no wired firer → 501;
 *  - the fire is rate-limited (cost-DoS bound), and it writes an immutable audit trail.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ManualTriggerFirer } from '../app-context.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

/**
 * A tenant-scoped fake firer: it "has" the MANUAL trigger `manual-refresh` ONLY for its configured
 * owner tenant (mirroring the real firer's tenant reconciliation + kind:'manual' restriction), so a
 * request from any other tenant — or for any other name — gets notFound. `firedFlag` toggles the
 * won-the-reserve (`true`) vs deduped-no-op (`false`) outcome. Records every call so the test can
 * assert the tenant/name the route passed.
 */
class FakeManualTriggerFirer implements ManualTriggerFirer {
  ownerTenantId = '';
  firedFlag = true;
  readonly calls: Array<{ tenantId: string; name: string }> = [];
  async fireManual(input: {
    tenantId: string;
    name: string;
  }): ReturnType<ManualTriggerFirer['fireManual']> {
    this.calls.push({ ...input });
    if (input.tenantId === this.ownerTenantId && input.name === 'manual-refresh') {
      return { notFound: false, fired: this.firedFlag };
    }
    return { notFound: true };
  }
}

const firer = new FakeManualTriggerFirer();
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

describe('POST /v1/triggers/:name/fire (the manual-trigger fire control path)', () => {
  beforeAll(async () => {
    h = await createHarness({ manualTriggerFirer: firer, schema: 'rayspec_test_trigfire' });
  });
  afterEach(async () => {
    firer.calls.length = 0;
    firer.ownerTenantId = '';
    firer.firedFlag = true;
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('fires the manual trigger (202) for the owning tenant, passing the server-derived tenant + name', async () => {
    const a = await principal('trig-a@example.test', 'Org A');
    firer.ownerTenantId = a.orgId;
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ name: 'manual-refresh', fired: true });
    // The route threaded the SERVER-DERIVED tenant + the path name (never client-supplied).
    expect(firer.calls).toHaveLength(1);
    expect(firer.calls[0]).toEqual({ tenantId: a.orgId, name: 'manual-refresh' });
  });

  it('a deduped no-op (already fired this firing key) still returns 202 with fired:false', async () => {
    const a = await principal('trig-dedup@example.test', 'Org Dedup');
    firer.ownerTenantId = a.orgId;
    firer.firedFlag = false; // the firer reports the reserve was already taken (a no-op)
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ name: 'manual-refresh', fired: false });
  });

  it('tenant-scoped: tenant B cannot fire tenant A’s manual trigger → 404 (no existence leak)', async () => {
    const a = await principal('trig-a2@example.test', 'Org A2');
    const b = await principal('trig-b@example.test', 'Org B');
    firer.ownerTenantId = a.orgId; // manual-refresh belongs to A only
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);
    // The route passed B's OWN server-derived tenant (not A's) — the tenant-scoped firer then could not
    // fire A's trigger for B, so nothing dispatched.
    expect(firer.calls[0]).toEqual({ tenantId: b.orgId, name: 'manual-refresh' });
  });

  it('an unknown / non-manual trigger → 404 (the firer restricts to kind:manual fail-closed)', async () => {
    const a = await principal('trig-unknown@example.test', 'Org Unknown');
    firer.ownerTenantId = a.orgId;
    // 'nightly-cron' is not the fake's manual trigger → notFound (mirrors a cron/webhook/unknown name).
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/nightly-cron/fire', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(404);
    expect(firer.calls[0]).toEqual({ tenantId: a.orgId, name: 'nightly-cron' });
  });

  it('unauthenticated → 401 (no fire without a principal)', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {});
    expect(res.status).toBe(401);
    expect(firer.calls).toHaveLength(0);
  });

  it('rate-limits repeated fires of the SAME trigger (429 after the quota, before the firer)', async () => {
    const a = await principal('trig-quota@example.test', 'Org Quota');
    firer.ownerTenantId = a.orgId;
    h.deps.rateLimiter.clearAll(); // deterministic: start the trigger-fire bucket empty
    // The default trigger-fire quota is 30 per (tenant, trigger) per window.
    for (let i = 0; i < 30; i++) {
      const ok = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(ok.status).toBe(202);
    }
    const blocked = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('RATE_LIMITED');
    // The over-quota call was rejected BEFORE the firer ran — only the 30 in-quota calls reached it.
    expect(firer.calls).toHaveLength(30);
  });

  it('writes an immutable manual_trigger_fired audit event (actor, tenant, trigger, fired flag)', async () => {
    const a = await principal('trig-audit@example.test', 'Org Audit');
    firer.ownerTenantId = a.orgId;
    h.deps.rateLimiter.clearAll();
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202);

    const rows = await h.deps.auditStore.readForTenant(a.orgId);
    const fireRows = rows.filter((r) => r.event === 'manual_trigger_fired');
    expect(fireRows).toHaveLength(1);
    const row = fireRows[0];
    expect(row?.actorOrgId).toBe(a.orgId); // the server-derived tenant scope
    expect(row?.actorUserId).toBeTruthy(); // the acting user principal
    const meta = row?.meta as Record<string, unknown>;
    expect(meta.triggerName).toBe('manual-refresh');
    expect(meta.fired).toBe(true);
  });

  it('writes NO fire audit event for a 404 (foreign/unknown trigger — nothing dispatched)', async () => {
    const a = await principal('trig-noaudit-a@example.test', 'Org NoAudit A');
    const b = await principal('trig-noaudit-b@example.test', 'Org NoAudit B');
    firer.ownerTenantId = a.orgId; // manual-refresh belongs to A only
    h.deps.rateLimiter.clearAll();
    const res = await jsonRequest(h.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);
    const bRows = await h.deps.auditStore.readForTenant(b.orgId);
    expect(bRows.filter((r) => r.event === 'manual_trigger_fired')).toHaveLength(0);
  });
});

describe('POST /v1/triggers/:name/fire with NO wired firer (fail-closed 501)', () => {
  let hNo: Harness;
  beforeAll(async () => {
    hNo = await createHarness({ schema: 'rayspec_test_trigfire_off' });
  });
  afterAll(async () => {
    await hNo.close();
  });

  it('501 when no manual-trigger firer is wired (never a silent no-op 202)', async () => {
    const reg = await jsonRequest(hNo.app, 'POST', '/v1/auth/register', {
      body: { email: 'trig-off@example.test', password: 'a-long-enough-password' },
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
    const res = await jsonRequest(hNo.app, 'POST', '/v1/triggers/manual-refresh/fire', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(501);
  });
});
