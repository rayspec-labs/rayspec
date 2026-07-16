/**
 * THE SUPPORT-INTAKE-CHAT LIVE SMOKE (real provider). The SAME Support-Intake-Chat
 * product the merge-gated deterministic e2e proves, booted on
 * the REAL composed stack with BOTH RAYSPEC_RESPONDER_MODE=live and RAYSPEC_EXTRACTION_MODE=live, and
 * driven with a REAL multi-turn conversation:
 *   create → turn-1 (a login issue) → a REAL gpt-5 reply grounded in the SEEDED catalog (through the
 *   responder + the bounded store-context read) + the async workflow extracts a ticket through the
 *   generic branch (read_catalog → REAL gpt-5 → validation.check → store_write) → turn-2 (a billing
 *   issue, multi-turn) → a reply grounded in the FULL history + an UPSERT of the conversation ticket.
 *
 * Asserts the replies are non-empty free text (the model actually answered) and the extracted tickets
 * are GROUNDED: turn-1 routes to the catalog's authentication row, turn-2 UPSERTs to the billing row —
 * the suggested_routing comes from the SEEDED catalog (never invented), proving the match is real.
 *
 * GATED (the live-extraction-smoke pattern): skips unless BOTH DATABASE_URL and OPENAI_API_KEY are set
 * — CI has no LLM creds ⇒ it self-skips there; it runs locally. Cost-conscious: TWO short
 * turns, a handful of gpt-5 calls (2 replies + 2 extractions); the journaled token/cost is logged.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';
import { logRedactedRunFailure } from './live-smoke-diagnostics.js';

const baseUrl = process.env.DATABASE_URL;
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const canRun = Boolean(baseUrl) && hasKey;

if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !canRun) {
  throw new Error(
    'packages/app/server/src/support-intake-chat-live.smoke.db.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but the live prerequisites (API creds / DB) are absent — refusing to silently skip the live suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const SUPPORT_YAML = resolve(
  here,
  '../../../../examples/support-intake-chat/support-intake-chat.product.yaml',
);

const SUITE_DB = `rayspec_support_chat_live_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c581';
const CONV = 'conv-live-001';
const MSG_1 = 'msg-live-001';
const MSG_2 = 'msg-live-002';
const TEXT_1 =
  'Hi — I keep getting locked out of my account. My login fails right after I enter my password. Can you help?';
const TEXT_2 =
  'Actually, the more urgent problem is that I was double-charged on last month’s invoice and need a refund.';

/** The independent run-id oracle (same derivation the deterministic e2e pins). */
function expectedRunId(tenantId: string, workflowId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${workflowId}:${idempotencyKey}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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

describe.skipIf(!canRun)(
  'Support-Intake-Chat LIVE smoke — real gpt-5 responder + extractor through the composed stack',
  () => {
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
      'RAYSPEC_RESPONDER_MODE',
    ] as const;

    async function drop(admin: postgres.Sql): Promise<void> {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    }

    beforeAll(async () => {
      if (!canRun) return;
      appDbUrl = withDbName(baseUrl as string, SUITE_DB);
      dbosSysDb = `${SUITE_DB}_dbos_sys`;
      const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
      try {
        await drop(admin);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }

      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'support-chat-live-pepper';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8816';
      process.env.RAYSPEC_SPEC_PATH = SUPPORT_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      // THE LIVE PATH: both executors run real gpt-5 (the responder.json + extractor.json backends).
      process.env.RAYSPEC_RESPONDER_MODE = 'live';
      process.env.RAYSPEC_EXTRACTION_MODE = 'live';
      delete process.env.RAYSPEC_BLOB_ROOT;
      delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
      delete process.env.STT_PROVIDER;

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      });

      const client = postgres(appDbUrl, { max: 2 });
      try {
        await client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'SupportLive', 'support-live')`,
          [TENANT],
        );
        await client.unsafe(
          `INSERT INTO support_catalog
             (tenant_id, category, keywords, owning_team, default_severity, suggested_routing)
           VALUES
             ($1, 'authentication', 'login,password,locked out,sign in,mfa,2fa', 'identity-team', 'high', 'identity-team'),
             ($1, 'billing', 'invoice,charge,charged,refund,payment,billed,double-charged', 'billing-ops', 'normal', 'billing-ops'),
             ($1, 'data_import', 'import,upload,csv,sync,integration,export', 'data-platform', 'normal', 'data-platform'),
             ($1, 'other', '', 'triage-desk', 'low', 'triage-desk')`,
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
      if (canRun) {
        const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
        try {
          await drop(admin);
        } finally {
          await admin.end();
        }
      }
    }, 60_000);

    async function tokenFor(tenant: string): Promise<string> {
      const email = `support-chat-live-${Date.now()}@example.com`;
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

    async function waitForRun(runId: string): Promise<{ status: string; error: unknown }> {
      const deadline = Date.now() + 150_000;
      for (;;) {
        const client = postgres(appDbUrl, { max: 1 });
        try {
          const rows = (await client.unsafe(
            'SELECT status, error FROM workflow_runs WHERE workflow_run_id = $1',
            [runId],
          )) as unknown as Array<{ status: string; error: unknown }>;
          const run = rows[0];
          if (run && (run.status === 'completed' || run.status === 'terminal_failure')) {
            // A non-completed terminal fails the caller's assertion — surface WHY (redacted) first,
            // reusing the open connection before it is closed by the finally below.
            if (run.status !== 'completed') await logRedactedRunFailure(client, runId);
            return run;
          }
        } finally {
          await client.end();
        }
        if (Date.now() > deadline) {
          const diag = postgres(appDbUrl, { max: 1 });
          try {
            await logRedactedRunFailure(diag, runId);
          } finally {
            await diag.end();
          }
          throw new Error(`live run ${runId} did not reach a terminal status`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    async function ticketFor(conv: string): Promise<Record<string, unknown> | undefined> {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        const rows = (await client.unsafe(
          'SELECT ticket_ref, last_message_id, ticket, status FROM support_tickets WHERE ticket_ref = $1',
          [conv],
        )) as unknown as Array<Record<string, unknown>>;
        return rows[0];
      } finally {
        await client.end();
      }
    }

    (canRun ? it : it.skip)(
      'REAL multi-turn conversation: two grounded gpt-5 replies + two grounded ticket extractions (UPSERTed)',
      async () => {
        const token = await tokenFor(TENANT);
        expect(
          (
            await server!.app.request(`/conversations/${CONV}`, {
              method: 'PUT',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'Live support chat' }),
            })
          ).status,
        ).toBe(200);

        // ── TURN 1 — a real grounded reply + a real ticket extraction. ──────────────────────────
        const t1 = await server!.app.request(`/conversations/${CONV}/turns`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message_id: MSG_1, text: TEXT_1 }),
        });
        expect(t1.status).toBe(200);
        const reply1 = ((await t1.json()) as { reply: { message: string } }).reply;
        // eslint-disable-next-line no-console
        console.log('[support-live] reply-1:', JSON.stringify(reply1.message));
        expect(reply1.message.trim().length).toBeGreaterThan(0);

        const run1 = await waitForRun(
          expectedRunId(TENANT, 'extract_ticket', `turn_ref:${CONV}:${MSG_1}`),
        );
        // eslint-disable-next-line no-console
        console.log('[support-live] extract-1 run:', run1.status, run1.error ?? '');
        expect(run1.status).toBe('completed');
        const ticket1 = await ticketFor(CONV);
        // eslint-disable-next-line no-console
        console.log('[support-live] ticket-1:', JSON.stringify(ticket1?.ticket));
        expect(ticket1?.status).toBe('extracted');
        const coded1 = ticket1?.ticket as Record<string, unknown>;
        // Catalog-grounded: the login turn routes to the SEEDED authentication row (never invented).
        expect(coded1.category).toBe('authentication');
        expect(coded1.suggested_routing).toBe('identity-team');

        // ── TURN 2 — multi-turn; the ticket UPSERTs to the billing row. ─────────────────────────
        const t2 = await server!.app.request(`/conversations/${CONV}/turns`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message_id: MSG_2, text: TEXT_2 }),
        });
        expect(t2.status).toBe(200);
        const reply2 = ((await t2.json()) as { reply: { message: string } }).reply;
        // eslint-disable-next-line no-console
        console.log('[support-live] reply-2:', JSON.stringify(reply2.message));
        expect(reply2.message.trim().length).toBeGreaterThan(0);

        const run2 = await waitForRun(
          expectedRunId(TENANT, 'extract_ticket', `turn_ref:${CONV}:${MSG_2}`),
        );
        // eslint-disable-next-line no-console
        console.log('[support-live] extract-2 run:', run2.status, run2.error ?? '');
        expect(run2.status).toBe('completed');
        const ticket2 = await ticketFor(CONV);
        // eslint-disable-next-line no-console
        console.log('[support-live] ticket-2:', JSON.stringify(ticket2?.ticket));
        expect(ticket2?.last_message_id).toBe(MSG_2); // the SAME conversation ticket, UPSERTed.
        const coded2 = ticket2?.ticket as Record<string, unknown>;
        expect(coded2.category).toBe('billing');
        expect(coded2.suggested_routing).toBe('billing-ops');

        // The REAL provider calls journaled NONZERO token usage under the tenant (the metering signal).
        const client = postgres(appDbUrl, { max: 1 });
        try {
          const steps = (await client.unsafe(
            'SELECT count(*)::int AS n, coalesce(max(total_tokens),0)::numeric AS max_tokens FROM journal_steps',
          )) as unknown as Array<{ n: number; max_tokens: string }>;
          // eslint-disable-next-line no-console
          console.log(
            '[support-live] journal_steps:',
            steps[0]?.n,
            'max_tokens:',
            Number(steps[0]?.max_tokens ?? 0),
          );
          expect(Number(steps[0]?.max_tokens ?? 0)).toBeGreaterThan(0);
        } finally {
          await client.end();
        }

        // …and the detail view serves the UPSERTed ticket over HTTP.
        const detail = await server!.app.request(`/tickets/${CONV}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(detail.status).toBe(200);
        expect(((await detail.json()) as Record<string, unknown>).ticket).toMatchObject({
          category: 'billing',
        });
      },
      300_000,
    );
  },
);
