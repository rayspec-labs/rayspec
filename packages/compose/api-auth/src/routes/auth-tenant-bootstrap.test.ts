/**
 * The OPERATOR-GATED tenant bootstrap — `POST /v1/auth/bootstrap-tenant`, the ONLY HTTP surface on
 * which an org id is client-chosen, driven through the REAL Hono app against Postgres.
 *
 * WHY THE GATE IS LOAD-BEARING. `POST /v1/auth/register` is public and unauthenticated. If a public
 * caller could name the org id, an attacker who learned the UUID an operator INTENDS to deploy
 * against could create that org FIRST, with themselves as owner — and the deployment would then bind
 * `RAYSPEC_PRODUCT_TENANT_ID` to an org the attacker controls. So the chosen-id path is a SEPARATE
 * route that is only REGISTERED when the deployment turned the posture on: on a default deployment it
 * does not exist (404), rather than existing-and-refusing. These arms pin both halves:
 *
 *   - UNGATED: the bootstrap route 404s, and `POST /v1/auth/register` keeps assigning a
 *     server-generated id even when a body tries to name one (the public path can never choose).
 *   - GATED: the chosen id lands on the `orgs` row AND the owner membership exists — in ONE
 *     transaction, so the memberless-org dead end (invites are owner-only) can never arise.
 *   - GATED: a malformed id is a 400, and a taken id is a 409 (never a 500, never a silent
 *     different-id success the operator would deploy against).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthApp } from '../app.js';
import { OrgStore } from '../stores/org-store.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const SCHEMA = 'rayspec_test_apiauth_tenantboot';
const CHOSEN = '00000000-0000-4000-8000-00000000ab01';
const OTHER = '00000000-0000-4000-8000-00000000ab02';

let h: Harness;
/** The SAME deps as the ungated harness, with the org store built in the bootstrap posture. */
let gated: ReturnType<typeof createAuthApp>;

beforeAll(async () => {
  h = await createHarness({ schema: SCHEMA });
  gated = createAuthApp({
    ...h.deps,
    orgStore: new OrgStore(h.db, { tenantBootstrapEnabled: true }),
  });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

async function orgRow(id: string): Promise<{ id: string } | undefined> {
  const rows = (await h.db.$client.unsafe('SELECT id FROM orgs WHERE id = $1', [
    id,
  ])) as unknown as Array<{ id: string }>;
  return rows[0];
}

describe('tenant bootstrap — the public path can never choose an org id', () => {
  it('the bootstrap route does NOT exist on a default deployment (404, not a refusal)', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'ungated@example.com',
        password: 'a-very-long-password',
        orgName: 'Ungated',
        orgId: CHOSEN,
      },
    });
    expect(res.status).toBe(404);
    expect(await orgRow(CHOSEN)).toBeUndefined();
  });

  it('public register ignores an org id in the body — the server assigns it (no takeover vector)', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: {
        email: 'pub@example.com',
        password: 'a-very-long-password',
        orgName: 'Public',
        orgId: CHOSEN,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.activeOrgId).toBeTruthy();
    expect(body.activeOrgId).not.toBe(CHOSEN);
    expect(await orgRow(CHOSEN)).toBeUndefined();
  });

  it('the gated route stays unreachable on the ungated app even with the gate ON elsewhere', async () => {
    // The gated app answers; the SAME path on the ungated app does not exist. Both run against the
    // same database, so this is the route registration — not a data difference.
    const ok = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'both@example.com',
        password: 'a-very-long-password',
        orgName: 'Both',
        orgId: OTHER,
      },
    });
    expect(ok.status).toBe(201);
    const no = await jsonRequest(h.app, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'both2@example.com',
        password: 'a-very-long-password',
        orgName: 'Both2',
        orgId: CHOSEN,
      },
    });
    expect(no.status).toBe(404);
  });
});

describe('tenant bootstrap — the gated posture', () => {
  it('creates the org with the CHOSEN id AND the owner membership in one transaction', async () => {
    const res = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'owner@example.com',
        password: 'a-very-long-password',
        orgName: 'Chosen Workspace',
        orgId: CHOSEN,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.activeOrgId).toBe(CHOSEN);
    expect(body.accessToken).toBeTruthy();

    // Ground truth: the org row carries the chosen id, and it is NOT memberless — an owner exists,
    // which is what keeps the org reachable at all (invites are owner-only).
    const rows = (await h.db.$client.unsafe(
      `SELECT m.role, m.status FROM memberships m
       JOIN orgs o ON o.id = m.org_id
       JOIN users u ON u.id = m.user_id
       WHERE o.id = $1 AND u.email = $2`,
      [CHOSEN, 'owner@example.com'],
    )) as unknown as Array<{ role: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.status).toBe('active');

    // The org-scoped switch the bootstrap CLI performs next accepts the token straight away.
    const sw = await jsonRequest(gated, 'POST', `/v1/orgs/${CHOSEN}/switch`, {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(sw.status).toBe(200);
  });

  it('a malformed org id is a 400 — never a silently server-generated org', async () => {
    const res = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'bad@example.com',
        password: 'a-very-long-password',
        orgName: 'Bad',
        orgId: 'not-a-uuid',
      },
    });
    expect(res.status).toBe(400);
    const rows = (await h.db.$client.unsafe('SELECT id FROM orgs')) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('an already-taken org id is a 409 — the operator learns the id is not theirs to bind', async () => {
    const first = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'first@example.com',
        password: 'a-very-long-password',
        orgName: 'First',
        orgId: CHOSEN,
      },
    });
    expect(first.status).toBe(201);
    const second = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'second@example.com',
        password: 'a-very-long-password',
        orgName: 'Second',
        orgId: CHOSEN,
      },
    });
    expect(second.status).toBe(409);
  });
});
