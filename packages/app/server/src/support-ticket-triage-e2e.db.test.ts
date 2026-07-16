/**
 * The support-ticket-triage e2e (the shipping gate, hardened into merge-gated coverage).
 * It boots the greenfield NON-audio, NO-AGENT `examples/support-ticket-triage/` product through the
 * REAL server entrypoint (`assembleServer` from
 * `RAYSPEC_SPEC_PATH`) on a throwaway DATABASE + a real DBOS launch, and drives it end-to-end over REAL
 * HTTP against MATERIALIZED ground truth (fail-the-fix). It is the fully-working LIVE data-plane
 * (no extraction agent ⇒ NO RAYSPEC_EXTRACTION_MODE, NO deterministic executor, no LLM in the path):
 *   record_submitted trigger · declared stores + store_read (FILTERED catalog) → store_write ·
 *   record_input ingress · conditional-no-audio-no-agent (demands NEITHER blob/media/stt NOR
 *   extraction env).
 *
 * Arm: boot (deployMode 'materialized', no extraction/audio env) → POST /records/{id}/submit → the REAL
 * DBOS workflow runs store_read(filter product_area) → store_write OFF-REQUEST → EXACTLY ONE
 * workflow_runs row (C10) → the triaged_tickets row carries the submitted fields + status + the FILTERED
 * routing snapshot (one row — proving the store_read filter) → the DECLARED views serve it over HTTP →
 * a byte-identical re-submit → deduped (still one run/row, C10 single-flight) → an unauth submit → 401.
 *
 * Skips without DATABASE_URL; a real DBOS launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const TICKET_YAML = resolve(
  here,
  '../../../../examples/support-ticket-triage/support-ticket-triage.product.yaml',
);

const SUITE_DB = `rayspec_sample_ticket_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000d001';
const RECORD = 'ticket-4242';

// Ran-guard: the suite skipIf(!baseUrl)s so a credential-free dev run skips, but a
// REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost DATABASE_URL would SILENTLY
// SKIP this proof and still read GREEN. The separate NON-skipped describe at the bottom hard-fails on
// exactly that.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('support-ticket-triage e2e — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_PRODUCT_TENANT_ID',
    'RAYSPEC_EXTRACTION_MODE',
    'STT_PROVIDER',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
  ] as const;

  async function drop(admin: postgres.Sql): Promise<void> {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await drop(admin);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'sample-ticket-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
    process.env.RAYSPEC_SPEC_PATH = TICKET_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // NO agent ⇒ the doc-driven boot demands NO RAYSPEC_EXTRACTION_MODE — prove it by leaving it unset.
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    // NON-audio ⇒ no blob/media/stt env demanded — leave them unset.
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Support', 'support')`, [
        TENANT,
      ]);
      // Seed the routing catalog (two areas). The store_read FILTERS by the submitted product_area,
      // so a 'billing' ticket must snapshot ONLY the billing row.
      await client.unsafe(
        `INSERT INTO routing_policies (tenant_id, product_area, owning_team, default_priority)
         VALUES ($1, 'billing', 'billing-ops', 'high'), ($1, 'auth', 'identity-team', 'urgent')`,
        [TENANT],
      );
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function tokenFor(tenant: string): Promise<string> {
    const email = `sample-${tenant.slice(-4)}-${Date.now()}@example.com`;
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = postgres(appDbUrl, { max: 2 });
    try {
      const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
        email,
      ])) as unknown as Array<{ id: string }>;
      await client.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [tenant, rows[0]!.id],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${tenant}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  function submit(recordId: string, body: unknown, token?: string): Promise<Response> {
    return server!.app.request(`/records/${recordId}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function triagedTickets(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT ticket_ref, requester_email, subject, product_area, status, routing FROM triaged_tickets',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function workflowRuns(): Promise<Array<{ status: string }>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe('SELECT status FROM workflow_runs')) as unknown as Array<{
        status: string;
      }>;
    } finally {
      await client.end();
    }
  }
  async function waitForOneCompletedRun(): Promise<Array<{ status: string }>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const runs = await workflowRuns();
      if (runs.length > 0 && runs.every((r) => r.status === 'completed')) return runs;
      if (Date.now() > deadline)
        throw new Error(`workflow did not complete: ${JSON.stringify(runs)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    'boot → submit → store_read(filtered)→store_write → views → C10 → 401',
    async () => {
      e2eTestsRan += 1;
      // The boot dispatched to the Product-YAML path and MATERIALIZED with NO extraction/audio env.
      expect(server!.deployMode).toBe('materialized');

      const t = await tokenFor(TENANT);

      // Submit a BILLING ticket → the durable workflow runs off-request.
      const res = await submit(
        RECORD,
        {
          requester_email: 'user@acme.example',
          subject: 'Invoice double-charged',
          body: 'I was billed twice for March.',
          product_area: 'billing',
        },
        t,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        record_id: string;
        event_id: string;
        deduped: boolean;
      };
      expect(body.record_id).toBe(RECORD);
      expect(body.event_id).toBe(`${TENANT}:${RECORD}`);
      expect(body.deduped).toBe(false);

      const runs = await waitForOneCompletedRun();
      expect(runs).toHaveLength(1); // C10 single-flight

      // MATERIALIZED ground truth: one triaged row with the submitted fields + status + the FILTERED
      // routing snapshot (ONLY the billing row — proving the store_read `filter: product_area` worked).
      const rows = await triagedTickets();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.ticket_ref).toBe(RECORD);
      expect(row.requester_email).toBe('user@acme.example');
      expect(row.subject).toBe('Invoice double-charged');
      expect(row.product_area).toBe('billing');
      expect(row.status).toBe('triaged');
      expect(Array.isArray(row.routing)).toBe(true);
      expect((row.routing as unknown[]).length).toBe(1); // FILTERED to the one matching area
      expect((row.routing as Array<Record<string, unknown>>)[0]).toMatchObject({
        product_area: 'billing',
        owning_team: 'billing-ops',
        default_priority: 'high',
      });

      // The declared views serve the triaged ticket over HTTP (detail + list).
      const detail = await server!.app.request(`/tickets/${RECORD}`, {
        headers: { authorization: `Bearer ${t}` },
      });
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as Record<string, unknown>;
      expect(detailBody.ticket_ref).toBe(RECORD);
      expect(detailBody.product_area).toBe('billing');
      expect(detailBody.status).toBe('triaged');
      expect((detailBody.routing as Array<Record<string, unknown>>)[0]).toMatchObject({
        owning_team: 'billing-ops',
      });

      const list = await server!.app.request('/tickets', {
        headers: { authorization: `Bearer ${t}` },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { tickets: Array<Record<string, unknown>> };
      expect(listBody.tickets).toHaveLength(1);
      expect(listBody.tickets[0]).toMatchObject({
        ticket_ref: RECORD,
        product_area: 'billing',
        status: 'triaged',
      });

      // Re-submit the SAME ticket with an IDENTICAL payload (reordered) → deduped → STILL one run + one
      // row (C10 single-flight). NOTE: the payload MUST be byte-identical after canonicalization — a
      // DIVERGENT re-submit (a dropped/changed field) is correctly rejected 409 by the sha256 guard.
      const again = await submit(
        RECORD,
        {
          product_area: 'billing',
          body: 'I was billed twice for March.',
          subject: 'Invoice double-charged',
          requester_email: 'user@acme.example',
        },
        t,
      );
      expect(again.status).toBe(200);
      expect((await again.json()).deduped).toBe(true);
      const quiesceDeadline = Date.now() + 3_000;
      for (;;) {
        expect(await workflowRuns()).toHaveLength(1);
        if (Date.now() > quiesceDeadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(await triagedTickets()).toHaveLength(1);

      // An unauthenticated submit → 401.
      const noauth = await submit('ticket-9999', {
        product_area: 'auth',
        subject: 'x',
        requester_email: 'a@b.c',
      });
      expect(noauth.status).toBe(401);
    },
    120_000,
  );
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run
// SKIPPED the acceptance arm (a lost DATABASE_URL would otherwise read GREEN).
describe('support-ticket-triage e2e — ran-guard', () => {
  it('the e2e arm actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(1);
    else expect(true).toBe(true);
  });
});
