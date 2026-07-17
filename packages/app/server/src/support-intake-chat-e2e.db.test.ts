/**
 * The greenfield CONVERSATION-declaring Support-Intake-Chat product, authored in
 * `examples/support-intake-chat/`, boots through the REAL server entrypoint (`assembleServer` from
 * `RAYSPEC_SPEC_PATH`) on a throwaway DATABASE + a real DBOS launch, and is driven end-to-end over
 * REAL HTTP against MATERIALIZED ground truth (fail-the-fix). It composes
 * the WHOLE conversational chain in ONE doc:
 *   conversation identity + a per-turn ledger + `turn_submitted` (per-TURN single-flight key) · the
 *   conditional conversation mount + the responder demand (no blob/media/STT env) · the in-request
 *   multi-turn responder (bounded history window + a bounded store-context read of the seeded catalog)
 *   · content-negotiated SSE egress + the async-follow-up seam · (this doc) the async workflow:
 *   read the seeded catalog → extract+classify a ticket from the turn → validation.check → store_write
 *   UPSERT into support_tickets (keyed on conversation_id) → GET views.
 *
 * TWO DETERMINISTIC injections drive the whole product with ZERO LLM creds (the platform is
 * product-free — it ships neither):
 *   • the RESPONDER (RAYSPEC_RESPONDER_MODE=deterministic): a Backend that DERIVES its reply from the
 *     REAL security-assembled input — `saw1`/`saw2` attest whether the history window carried the earlier
 *     turns (the multi-turn law) and `sawCatalog` attests whether the store-context read fed the
 *     seeded catalog into the model input (the grounding law); it COUNTS its invocations (the
 *     zero-model-work pins). A garbled/missing history or an unwired store-context read fails RED.
 *   • the EXTRACTOR (RAYSPEC_EXTRACTION_MODE=deterministic): an agent handler that DERIVES the ticket
 *     from the REAL turn text (`context.input_event.payload.message` — the message rides the trigger
 *     payload) matched against the REAL catalog rows (`input.artifact_inputs` — the store_read
 *     artifact). It hard-fails on a missing message OR a missing/empty catalog, so a broken
 *     payload-plumbing or store_read regression goes RED here rather than being masked by a canned
 *     object — and the multi-turn UPSERT arm proves the derivation is real (turn-1 codes
 *     'authentication', turn-2 codes 'billing' — a canned category could not).
 *
 * Arms (the ran-guard pins the count):
 *   (a) boot: conversation+agent doc materializes; BOTH conversation routes + the ticket views mount;
 *       NO blob/media/STT env demanded (a chat turn moves no bytes); it demands RAYSPEC_RESPONDER_MODE
 *       AND RAYSPEC_EXTRACTION_MODE (deleting the four byte/media/stt vars makes the boot the proof);
 *   (b) THE ASYNC TICKET EXTRACTION END-TO-END + MULTI-TURN GROUNDING: create → turn-1 (login) →
 *       a grounded reply (saw1=true, sawCatalog=true) + the async workflow runs off-request
 *       (read_catalog → agent → validation → store_write) → the support_tickets row is DERIVED from
 *       the real turn text + the catalog (category 'authentication' → routing 'identity-team') → the
 *       detail view serves it; turn-2 (billing) → a reply grounded in the FULL history (saw1=true,
 *       saw2=true) + the async workflow UPSERTs the SAME conversation ticket (category now 'billing');
 *   (c) SSE transport: a turn via Accept: text/event-stream → the intake + per-backend delta frames +
 *       a terminal conversation_reply; the reply persists AND the async workflow ALSO fires
 *       (representation-independence — a streamed turn extracts a ticket too);
 *   (d) single-flight turn dedup: an identical re-POST → deduped, the PERSISTED reply row-served with ZERO new
 *       model calls, and NO second workflow run / NO double UPSERT;
 *   (e) concurrent-turn conflict (the exactly-one-winner rule): two DIFFERENT turns racing one conversation → EXACTLY
 *       ONE 200 winner and the other EITHER a serialized 200 OR the loud typed 409
 *       `conversation_turn_conflict` (never a 5xx); the loser converges on retry → two runs, one ticket;
 *   (f) bounds: a fresh conversation's first turn oversized — an over-cap message → 413
 *       message_too_large; an over-body → 413 turn_body_too_large; ZERO ledger row, ZERO run, and NO
 *       ticket keyed on that conversation (ticket_ref = conversation_id — the key a successful turn
 *       WOULD have produced; a ticket_ref is never a message_id);
 *   (g) cross-tenant WRITE: a SECOND org's turn reaches the bridge sink's fail-closed 403
 *       `conversation_event_rejected` (cross_tenant), ZERO enqueue, ZERO model work, NO ticket for B;
 *   (g2) cross-tenant READ: B GETs A's ticket detail + list over the SAME routes → the tenant-scoped
 *       absent shape (empty_200), NEVER A's row (A is the positive control on the same routes);
 *   (h) the conditional-mount law: this conversation product mounts ONLY its declared surface — a
 *       capability it does NOT declare (file/record/audio) is 404 over HTTP;
 *   (i) erasure: assert-before-erase, then eraseTenantNow(A) REALLY deletes A's
 *       conversation ledger + the product stores (support_catalog + support_tickets) + the core
 *       run-journal — TENANT-SCOPED: B's cross-tenant witness rows stay untouched.
 * The INVERSE zero-surface 404 (a doc NOT declaring conversation_input → 404 on both conversation
 * routes) is proven generically in product-boot-conditional-env.db.test.ts — a second full DBOS launch
 * in ONE process is unsupported (DBOS registers workflows on a global registry), so it lives there.
 *
 * DETERMINISTIC BY DESIGN: CI has no LLM creds, so the merge gate runs both deterministic modes with
 * the injected seams above. The REAL-LLM proof of the SAME product is the self-skipping sibling
 * `support-intake-chat-live.smoke.db.test.ts` (runs locally with OPENAI_API_KEY; self-skips in CI).
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const SUPPORT_YAML = resolve(
  here,
  '../../../../examples/support-intake-chat/support-intake-chat.product.yaml',
);

const SUITE_DB = `rayspec_support_chat_0_2_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c501';
const TENANT_B = '00000000-0000-4000-8000-00000000c502';

const CONV_A = 'conv-a-001';
const MSG_1 = 'msg-a-001';
const MSG_2 = 'msg-a-002';
const TEXT_1 = 'Hi, I keep getting locked out — my login fails right after I type my password.';
const TEXT_2 = "Actually the bigger issue is I was double-charged on last month's invoice.";

const CONV_SSE = 'conv-sse-001';
const MSG_SSE = 'msg-sse-001';
const TEXT_SSE = 'My CSV import keeps failing to sync about halfway through the upload.';

const CONV_RACE = 'conv-race-001';
const MSG_R1 = 'msg-r-001';
const MSG_R2 = 'msg-r-002';

const CONV_BOUNDS = 'conv-bounds-001';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI /
// RAYSPEC_REQUIRE_DB_TESTS) read green after silently skipping this acceptance proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The DETERMINISTIC support-ticket EXTRACTOR (the platform ships none — product-free). It DERIVES the
 * ticket from the REAL inputs it receives:
 *  - the turn TEXT via `context.input_event.payload.message` (the message rides the trigger payload —
 *    the payload contract; the live path reaches it via input_context.payload_fields). A missing
 *    message THROWS, so a payload-plumbing regression is RED here, not masked.
 *  - the CATALOG via `input.artifact_inputs` (`support.catalog_rows` — the store_read artifact). An
 *    absent/empty catalog THROWS, so a store_read regression is RED here.
 * The category is the FIRST catalog row whose ANY keyword is a substring of the turn (the 'other'
 * fallback when nothing matches); the routing is that row's suggested_routing; the severity derives
 * from the turn's urgency signal OR the matched row's default. A canned category could not produce
 * 'authentication' for turn-1 AND 'billing' for turn-2 — the multi-turn UPSERT arm is the derive proof.
 */
function supportExtractor(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.support_extractor', (input, context) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'support.ticket');
    if (!output) throw new Error('declared output artifact missing');
    const catalogArt = input.artifact_inputs.find((a) => a.ref === 'support.catalog_rows');
    if (!catalogArt) throw new Error('declared catalog input artifact missing');
    const rows = catalogArt.value as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('the support catalog rows never reached the extractor');
    }
    const message = context.input_event.payload.message;
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('the turn message never reached the extractor (payload.message absent)');
    }
    const lower = message.toLowerCase();
    const fallback = rows.find((r) => String(r.category) === 'other');
    const matched =
      rows.find((r) => {
        if (String(r.category) === 'other') return false;
        return String(r.keywords ?? '')
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0)
          .some((k) => lower.includes(k));
      }) ?? fallback;
    if (!matched) throw new Error('no catalog category matched and no "other" fallback row exists');
    const urgent = /\b(urgent|asap|immediately|outage|blocked|can'?t work)\b/.test(lower);
    const value = {
      category: String(matched.category),
      severity: urgent ? 'urgent' : String(matched.default_severity ?? 'normal'),
      summary: message.slice(0, 140),
      suggested_routing: String(matched.suggested_routing ?? ''),
    };
    return [{ ...output, value }];
  });
  return registry;
}

/**
 * The injected deterministic RESPONDER Backend: derives its reply from the RECEIVED security-framed
 * input string — `saw1`/`saw2` attest whether the assembled history carried the earlier turn texts
 * (the multi-turn law), `sawCatalog` attests whether the bounded store-context read fed the seeded
 * catalog into the input (the grounding law) — and COUNTS its invocations (the zero-model-work pins).
 */
class DeterministicResponderBackend implements Backend {
  readonly id = 'openai' as const;
  runCalls = 0;
  /** Stream cardinality: deltas emitted through `ctx.onEvent` before the terminal outcome. */
  deltas: string[] = [];
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    for (let i = 0; i < this.deltas.length; i += 1) {
      await ctx.onEvent({ type: 'text_delta', runId: ctx.runId, text: this.deltas[i]! });
    }
    // 'identity-team' rides the seeded catalog's authentication row (owning_team + suggested_routing);
    // its presence in the assembled input proves the bounded store-context read fed the catalog.
    const sawCatalog = spec.input.includes('identity-team');
    const finalText =
      `DET-REPLY agent=${spec.name} model=${spec.model} ` +
      `saw1=${spec.input.includes(TEXT_1)} saw2=${spec.input.includes(TEXT_2)} ` +
      `sawCatalog=${sawCatalog}`;
    return {
      runId: 'set-by-run-core',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
      costUsd: 0,
      stepCount: 1,
    } as RunResult;
  }
}

/**
 * The INDEPENDENT oracle for the durable run id (ids.ts `durableWorkflowRunId`, recomputed on purpose
 * — a derivation/format drift re-keys durable runs on redelivery, so this test must go RED on it
 * rather than follow it): v5-shaped UUID over sha256(`${tenant}:${workflowId}:${key}`).
 */
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

describe.skipIf(!baseUrl)('Support-Intake-Chat acceptance — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tokenA = '';
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
    'RAYSPEC_ERASURE_ENABLED',
    'RAYSPEC_RESPONDER_MODE',
  ] as const;
  const replyBackend = new DeterministicResponderBackend();

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
    process.env.RAYSPEC_API_KEY_PEPPER = 'support-chat-0-2-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8814';
    process.env.RAYSPEC_SPEC_PATH = SUPPORT_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // THE NEGATIVE env-demand law (arm a): a conversation+agent doc moves NO bytes and runs NO stt,
    // so it must boot with NONE of the four byte/media/stt vars — deleting them makes the boot the
    // proof. It DOES demand the two executor modes below.
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;
    process.env.RAYSPEC_ERASURE_ENABLED = 'true'; // arm (i): eraseTenantNow must REALLY delete.
    // BOTH executor modes deterministic — the full config path (responder.json + extractor.json
    // backend validation) still runs; only the neutral executors are injected (zero LLM creds).
    process.env.RAYSPEC_RESPONDER_MODE = 'deterministic';
    process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      productDeterministicResponderBackend: replyBackend,
      productDeterministicAgents: supportExtractor(),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'SupportA', 'support-a'), ($2, 'SupportB', 'support-b')`,
        [TENANT, TENANT_B],
      );
      // Seed the known-issues/routing catalog the responder grounds in AND the workflow reads
      // (incl. the 'other' fallback row). The keywords drive the deterministic category match.
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
    tokenA = await tokenFor(TENANT);
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
    const email = `support-chat-${tenant.slice(-4)}-${Date.now()}@example.com`;
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

  function createConversation(
    conversationId: string,
    token?: string,
    body?: unknown,
  ): Promise<Response> {
    return server!.app.request(`/conversations/${conversationId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function submitTurn(
    conversationId: string,
    token: string | undefined,
    body: unknown,
  ): Promise<Response> {
    return server!.app.request(`/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Submit a turn negotiating an SSE stream (Accept: text/event-stream). */
  function streamTurn(conversationId: string, token: string, body: unknown): Promise<Response> {
    return server!.app.request(`/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  interface SseFrame {
    id?: string;
    event?: string;
    data: unknown;
  }
  async function readSseFrames(res: Response): Promise<SseFrame[]> {
    const text = await res.text();
    const frames: SseFrame[] = [];
    for (const block of text.split('\n\n')) {
      if (!block.trim()) continue;
      const frame: { id?: string; event?: string; data?: string } = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:'))
          frame.data = (frame.data ?? '') + line.slice(5).replace(/^ /, '');
      }
      if (frame.data === undefined) continue;
      frames.push({
        ...(frame.id !== undefined ? { id: frame.id } : {}),
        ...(frame.event !== undefined ? { event: frame.event } : {}),
        data: JSON.parse(frame.data),
      });
    }
    return frames;
  }

  async function workflowRuns(): Promise<Array<{ workflow_run_id: string; status: string }>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT workflow_run_id, status FROM workflow_runs',
      )) as unknown as Array<{ workflow_run_id: string; status: string }>;
    } finally {
      await client.end();
    }
  }
  async function supportTickets(tenant: string): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT ticket_ref, conversation_id, last_message_id, last_turn_seq, last_message, ' +
          'ticket, catalog_snapshot, status FROM support_tickets WHERE tenant_id = $1 ORDER BY ticket_ref',
        [tenant],
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function turnRowsFor(tenant: string): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT conversation_id, message_id, turn_seq, role, message, state ' +
          'FROM conversation_turns WHERE tenant_id = $1 ORDER BY turn_seq',
        [tenant],
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function headRowsFor(tenant: string): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT conversation_id, state FROM conversations WHERE tenant_id = $1',
        [tenant],
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  /** Wait for ONE specific workflow run to reach a TERMINAL status. */
  async function waitForRun(
    runId: string,
  ): Promise<{ workflow_run_id: string; status: string; error: unknown }> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        const rows = (await client.unsafe(
          'SELECT workflow_run_id, status, error FROM workflow_runs WHERE workflow_run_id = $1',
          [runId],
        )) as unknown as Array<{ workflow_run_id: string; status: string; error: unknown }>;
        const run = rows[0];
        if (run && (run.status === 'completed' || run.status === 'terminal_failure')) return run;
      } finally {
        await client.end();
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal status`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  /** Assert run count stays `expected` across a short quiesce window (no late double-fire). */
  async function expectRunsQuiesced(expected: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      expect(await workflowRuns()).toHaveLength(expected);
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const ticketRunId = (conv: string, msg: string): string =>
    expectedRunId(TENANT, 'extract_ticket', `turn_ref:${conv}:${msg}`);

  const maybe = baseUrl ? it : it.skip;

  maybe(
    '(a) boot: conversation+agent doc materializes; both conversation routes + the ticket views mount; NO byte/media/stt surface',
    () => {
      e2eTestsRan += 1;
      expect(server!.deployMode).toBe('materialized');
      const actions = server!.declaredRoutes.map((r) => `${r.method} ${r.path} → ${r.action}`);
      expect(actions).toContain(
        'PUT /conversations/{conversation_id} → handler:conversation_input_create',
      );
      expect(actions).toContain(
        'POST /conversations/{conversation_id}/turns → handler:conversation_input_turn_submit',
      );
      expect(actions.some((a) => a.startsWith('GET /tickets/{ticket_ref} → handler:'))).toBe(true);
      expect(actions.some((a) => a.startsWith('GET /tickets → handler:'))).toBe(true);
      // Nothing audio/record/file-shaped mounts for a conversation-only doc.
      expect(
        actions.some(
          (a) => a.includes('/sessions/') || a.includes('/records/') || a.includes('/files/'),
        ),
      ).toBe(false);
    },
  );

  maybe(
    '(b) THE ASYNC TICKET EXTRACTION + MULTI-TURN GROUNDING: turn-1 codes authentication; turn-2 (grounded in turn-1) UPSERTs the conversation ticket to billing',
    async () => {
      e2eTestsRan += 1;
      const created = await createConversation(CONV_A, tokenA, { title: 'Login + billing' });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        conversation_id: CONV_A,
        state: 'open',
        deduped: false,
      });

      // ── TURN 1 — a grounded reply + the async ticket extraction. ────────────────────────────
      const turn1 = await submitTurn(CONV_A, tokenA, { message_id: MSG_1, text: TEXT_1 });
      expect(turn1.status).toBe(200);
      const body1 = (await turn1.json()) as Record<string, unknown> & {
        reply: { message: string; turn_seq: number; run_id: string };
      };
      expect(body1).toMatchObject({
        conversation_id: CONV_A,
        message_id: MSG_1,
        turn_seq: 1,
        event_id: `${TENANT}:${CONV_A}:${MSG_1}`,
        deduped: false,
      });
      // The reply is GROUNDED (sawCatalog — the store-context read fed the catalog) and this is the
      // FIRST turn (saw1=true, saw2=false).
      expect(body1.reply.message).toBe(
        'DET-REPLY agent=support_responder model=gpt-5 saw1=true saw2=false sawCatalog=true',
      );
      expect(body1.reply.turn_seq).toBe(2); // the reply row takes its own seq.

      // The async workflow runs OFF-REQUEST (read_catalog → agent → validation → store_write).
      const run1 = await waitForRun(ticketRunId(CONV_A, MSG_1));
      expect(run1.status).toBe('completed');

      // MATERIALIZED ground truth: ONE ticket for the conversation, DERIVED from the real turn text
      // (category from the catalog keyword match) + the catalog snapshot (read feeds write).
      let tickets = await supportTickets(TENANT);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        ticket_ref: CONV_A,
        conversation_id: CONV_A,
        last_message_id: MSG_1,
        last_turn_seq: 1,
        last_message: TEXT_1,
        status: 'extracted',
      });
      expect(tickets[0]?.ticket).toMatchObject({
        category: 'authentication',
        severity: 'high',
        suggested_routing: 'identity-team',
      });
      // summary is a faithful slice of the REAL turn (never fabricated).
      expect(String((tickets[0]?.ticket as Record<string, unknown>).summary)).toContain(
        'locked out',
      );
      expect(Array.isArray(tickets[0]?.catalog_snapshot)).toBe(true);
      expect((tickets[0]?.catalog_snapshot as unknown[]).length).toBe(4);

      // The detail view serves the ticket over HTTP.
      const detail1 = await server!.app.request(`/tickets/${CONV_A}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail1.status).toBe(200);
      expect((await detail1.json()) as Record<string, unknown>).toMatchObject({
        ticket_ref: CONV_A,
        conversation_id: CONV_A,
        last_message_id: MSG_1,
        status: 'extracted',
        ticket: { category: 'authentication', suggested_routing: 'identity-team' },
      });

      // ── TURN 2 — the MULTI-TURN law: the reply saw BOTH turns; the async workflow UPSERTs. ────
      const turn2 = await submitTurn(CONV_A, tokenA, { message_id: MSG_2, text: TEXT_2 });
      expect(turn2.status).toBe(200);
      const body2 = (await turn2.json()) as Record<string, unknown> & {
        reply: { message: string; turn_seq: number };
      };
      expect(body2.turn_seq).toBe(3); // seq 2 was turn-1's reply.
      // ★ THE MULTI-TURN HISTORY LAW: turn-2's reply attests BOTH turn texts reached the model
      // (a garbled/missing history assembly would be saw1=false → RED).
      expect(body2.reply.message).toBe(
        'DET-REPLY agent=support_responder model=gpt-5 saw1=true saw2=true sawCatalog=true',
      );

      const run2 = await waitForRun(ticketRunId(CONV_A, MSG_2));
      expect(run2.status).toBe('completed');

      // The SAME conversation ticket is UPSERTed (still ONE row) and now reflects turn-2's category
      // — proving the derivation is per-turn-real, not canned (billing, not authentication).
      tickets = await supportTickets(TENANT);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        ticket_ref: CONV_A,
        last_message_id: MSG_2,
        last_turn_seq: 3,
        status: 'extracted',
      });
      expect(tickets[0]?.ticket).toMatchObject({
        category: 'billing',
        severity: 'normal',
        suggested_routing: 'billing-ops',
      });

      // TWO durable ticket runs (one per turn — the per-TURN key), the list view serves the ONE ticket.
      await expectRunsQuiesced(2);
      const list = await server!.app.request('/tickets', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(list.status).toBe(200);
      expect((await list.json()) as { tickets: unknown[] }).toEqual({
        tickets: [{ ticket_ref: CONV_A, status: 'extracted' }],
      });
    },
    180_000,
  );

  maybe(
    '(c) SSE transport: a streamed turn carries intake + delta + terminal reply frames AND the async workflow ALSO extracts a ticket',
    async () => {
      e2eTestsRan += 1;
      await createConversation(CONV_SSE, tokenA, { title: 'Streaming' });
      // SYNTHETIC deltas: the deterministic responder EMITS these two chunks through ctx.onEvent, so
      // this arm exercises the SSE TRANSPORT RELAY (intake → deltas → terminal), NOT live per-backend
      // token streaming. The real openai/gpt-5 responder emits its reply only in the TERMINAL frame
      // (non-streaming SDK overload — the README streaming-honesty note); token-incremental deltas
      // are a Pi-only property. The terminal conversation_reply always carries the complete reply.
      replyBackend.deltas = ['par', 'tial'];
      try {
        const res = await streamTurn(CONV_SSE, tokenA, { message_id: MSG_SSE, text: TEXT_SSE });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const frames = await readSseFrames(res);

        expect(frames[0]?.event).toBe('conversation_intake');
        expect(frames[0]?.data).toMatchObject({ conversation_id: CONV_SSE, message_id: MSG_SSE });
        const deltas = frames.filter((f) => f.event === 'text_delta');
        expect(deltas.map((f) => (f.data as { text: string }).text)).toEqual(['par', 'tial']);
        const terminal = frames.at(-1);
        expect(terminal?.event).toBe('conversation_reply');
        expect((terminal?.data as { text: string }).text).toContain(
          'DET-REPLY agent=support_responder',
        );
      } finally {
        replyBackend.deltas = [];
      }

      // Representation-independence: the streamed turn ALSO emitted turn_submitted → the async
      // workflow extracted a ticket for CONV_SSE (category derived from the CSV-import turn text).
      const run = await waitForRun(ticketRunId(CONV_SSE, MSG_SSE));
      expect(run.status).toBe('completed');
      const ticket = (await supportTickets(TENANT)).find((t) => t.ticket_ref === CONV_SSE);
      expect(ticket).toMatchObject({ last_message_id: MSG_SSE, status: 'extracted' });
      expect(ticket?.ticket).toMatchObject({
        category: 'data_import',
        suggested_routing: 'data-platform',
      });
      await expectRunsQuiesced(3);
    },
    180_000,
  );

  maybe(
    '(d) single-flight turn dedup: an identical re-POST → deduped, the PERSISTED reply row-served with ZERO new model calls / NO second run / NO double UPSERT',
    async () => {
      e2eTestsRan += 1;
      const callsBefore = replyBackend.runCalls;
      const again = await submitTurn(CONV_A, tokenA, { message_id: MSG_1, text: TEXT_1 });
      expect(again.status).toBe(200);
      const body = (await again.json()) as Record<string, unknown> & {
        reply: Record<string, unknown>;
      };
      expect(body).toMatchObject({ message_id: MSG_1, turn_seq: 1, deduped: true });
      // The SAME persisted reply (row-served: same text + seq, honestly no usage) and ZERO new model
      // invocations through the whole real stack.
      expect(body.reply).toMatchObject({
        message:
          'DET-REPLY agent=support_responder model=gpt-5 saw1=true saw2=false sawCatalog=true',
        turn_seq: 2,
      });
      expect(typeof body.reply.run_id).toBe('string');
      expect(body.reply.usage).toBeUndefined();
      expect(replyBackend.runCalls).toBe(callsBefore);

      // No second workflow run (the re-emit deduped downstream) and NO double UPSERT: CONV_A's ticket
      // still reflects turn-2 (billing), not re-written by the re-POST of turn-1.
      await expectRunsQuiesced(3);
      const ticket = (await supportTickets(TENANT)).find((t) => t.ticket_ref === CONV_A);
      expect(ticket).toMatchObject({ last_message_id: MSG_2 });
      expect(ticket?.ticket).toMatchObject({ category: 'billing' });
    },
    60_000,
  );

  maybe(
    '(e) concurrent-turn conflict: two DIFFERENT turns race → EXACTLY one 200; the other a serialized 200 OR the loud typed 409 conversation_turn_conflict, never a 5xx; converges to two runs / one ticket',
    async () => {
      e2eTestsRan += 1;
      expect((await createConversation(CONV_RACE, tokenA, { title: 'Race' })).status).toBe(200);
      const [rA, rB] = await Promise.all([
        submitTurn(CONV_RACE, tokenA, {
          message_id: MSG_R1,
          text: 'I cannot sign in at all today.',
        }),
        submitTurn(CONV_RACE, tokenA, {
          message_id: MSG_R2,
          text: 'My data export never finishes.',
        }),
      ]);
      const textFor = (msg: string): string =>
        msg === MSG_R1 ? 'I cannot sign in at all today.' : 'My data export never finishes.';
      const outcomes = [
        { status: rA.status, body: (await rA.json()) as Record<string, unknown> },
        { status: rB.status, body: (await rB.json()) as Record<string, unknown> },
      ];
      // THE DISJUNCTION (nothing looser, never a 5xx — the savepoint law): every outcome is EITHER a
      // 200 (accepted, deduped false — a fresh distinct turn) OR the loud lost-seq-race 409
      // conversation_turn_conflict. RACED → one 200 + one 409; SERIALIZED (higher load) → two 200s.
      expect(outcomes.every((o) => o.status === 200 || o.status === 409)).toBe(true);
      const accepted = new Set(
        outcomes.filter((o) => o.status === 200).map((o) => String(o.body.message_id)),
      );
      expect(accepted.size).toBeGreaterThanOrEqual(1);
      for (const o of outcomes) {
        if (o.status === 200) expect(o.body.deduped).toBe(false);
        else expect(o.body.error).toBe('conversation_turn_conflict');
      }
      // The loud loser (if any) stored + enqueued NOTHING — retry with the SAME message_id converges.
      for (const msg of [MSG_R1, MSG_R2]) {
        if (accepted.has(msg)) continue;
        const retry = await submitTurn(CONV_RACE, tokenA, {
          message_id: msg,
          text: textFor(msg),
        });
        expect(retry.status).toBe(200);
      }

      // BOTH turns now accepted → EXACTLY two ticket runs for CONV_RACE, ONE UPSERTed ticket (the
      // conversation IS the ticket).
      await waitForRun(ticketRunId(CONV_RACE, MSG_R1));
      await waitForRun(ticketRunId(CONV_RACE, MSG_R2));
      await expectRunsQuiesced(5);
      const ticket = (await supportTickets(TENANT)).find((t) => t.ticket_ref === CONV_RACE);
      expect(ticket).toMatchObject({ ticket_ref: CONV_RACE, status: 'extracted' });
    },
    180_000,
  );

  maybe(
    '(f) bounds: over-cap message → 413 message_too_large; over-body → 413 turn_body_too_large; ZERO ledger row, ZERO run, ZERO ticket for the rejected conversation',
    async () => {
      e2eTestsRan += 1;
      // A REAL conversation (CONV_BOUNDS) whose FIRST user turn is oversized: a successful turn on it
      // WOULD have UPSERTed a ticket keyed on ticket_ref = conversation_id (arm b's law). We assert
      // the rejection leaked NOTHING for it — no ledger row, no run, no ticket keyed on CONV_BOUNDS.
      expect((await createConversation(CONV_BOUNDS, tokenA, { title: 'Bounds' })).status).toBe(200);

      const overCap = await submitTurn(CONV_BOUNDS, tokenA, {
        message_id: 'msg-big',
        text: 'x'.repeat(32 * 1024 + 1),
      });
      expect(overCap.status).toBe(413);
      expect(((await overCap.json()) as Record<string, unknown>).error).toBe('message_too_large');

      const overBody = await submitTurn(CONV_BOUNDS, tokenA, {
        message_id: 'msg-huge',
        text: 'x'.repeat(36 * 1024 + 512),
      });
      expect(overBody.status).toBe(413);
      expect(((await overBody.json()) as Record<string, unknown>).error).toBe(
        'turn_body_too_large',
      );

      // ZERO side effects. (1) Neither rejected id has a ledger row.
      const turns = await turnRowsFor(TENANT);
      expect(turns.some((t) => t.message_id === 'msg-big' || t.message_id === 'msg-huge')).toBe(
        false,
      );
      // (2) No new run overall, and specifically NO durable extract_ticket run keyed on either
      // rejected turn (the per-turn single-flight key a successful extraction WOULD have used).
      await expectRunsQuiesced(5);
      const runs = await workflowRuns();
      expect(runs.some((r) => r.workflow_run_id === ticketRunId(CONV_BOUNDS, 'msg-big'))).toBe(
        false,
      );
      expect(runs.some((r) => r.workflow_run_id === ticketRunId(CONV_BOUNDS, 'msg-huge'))).toBe(
        false,
      );
      // (3) NO ticket for the rejected conversation. The real ticket key is ticket_ref =
      // conversation_id (CONV_BOUNDS) — NOT the message_id: a ticket_ref is NEVER a message_id, so
      // the earlier `ticket_ref === 'msg-big'` assertion checked a key space no leak could ever
      // occupy (vacuously green). This queries the key a SUCCESSFUL turn WOULD have produced.
      expect((await supportTickets(TENANT)).some((t) => t.ticket_ref === CONV_BOUNDS)).toBe(false);
    },
    60_000,
  );

  maybe(
    "(g) cross-tenant: a SECOND org's turn is the sink's fail-closed 403, ZERO enqueue, ZERO model work, NO ticket for B",
    async () => {
      e2eTestsRan += 1;
      const callsBefore = replyBackend.runCalls;
      const tokenB = await tokenFor(TENANT_B);
      // B's create lands under B's OWN server-derived tenant.
      expect((await createConversation('conv-b', tokenB)).status).toBe(200);
      // The turn submit reaches the bridge sink, whose tenant assertion rejects fail-closed: the
      // dispatcher is bound to the DEPLOYMENT tenant (A), so B's event must NEVER enqueue.
      const res = await submitTurn('conv-b', tokenB, { message_id: 'msg-b', text: 'from B' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('conversation_event_rejected');
      expect(String(body.detail)).toContain('cross_tenant');
      // ZERO enqueue + ZERO model work (the reply leg is never reached on a rejected event).
      await expectRunsQuiesced(5);
      expect(replyBackend.runCalls).toBe(callsBefore);
      expect(await supportTickets(TENANT_B)).toHaveLength(0);
      // HONEST intermediate state: B's turn row IS persisted (persist-then-emit).
      const bTurns = await turnRowsFor(TENANT_B);
      expect(bTurns).toHaveLength(1);
      expect(bTurns[0]).toMatchObject({ message_id: 'msg-b', state: 'submitted' });
    },
    60_000,
  );

  maybe(
    "(g2) cross-tenant view READ isolation: B GETs A's ticket detail + list over the SAME routes → the tenant-scoped absent shape, NEVER A's row",
    async () => {
      e2eTestsRan += 1;
      const tokenB = await tokenFor(TENANT_B);
      // POSITIVE CONTROL — the SAME routes DO serve A's real data to A (so B's empty result below is
      // tenant isolation, not an unrelated miss): A has CONV_A's extracted ticket + a non-empty list.
      const aDetail = await server!.app.request(`/tickets/${CONV_A}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(aDetail.status).toBe(200);
      expect((await aDetail.json()) as Record<string, unknown>).toMatchObject({
        ticket_ref: CONV_A,
        status: 'extracted',
      });
      const aList = (await (
        await server!.app.request('/tickets', { headers: { authorization: `Bearer ${tokenA}` } })
      ).json()) as { tickets: Array<{ ticket_ref: string }> };
      expect(aList.tickets.length).toBe(3);
      expect(aList.tickets.map((t) => t.ticket_ref)).toContain(CONV_A);

      // B GETs A's ticket by the SAME key: the view read is tenant-scoped, so B gets the declared
      // ABSENT shape (absent_state: empty_200 — all-null, ticket_ref echoed), NEVER A's row. No 404
      // here (the product declares empty_200), but B still cannot read A's classification.
      const bDetail = await server!.app.request(`/tickets/${CONV_A}`, {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(bDetail.status).toBe(200);
      expect(await bDetail.json()).toEqual({
        ticket_ref: CONV_A,
        conversation_id: null,
        last_message_id: null,
        status: null,
        ticket: null,
      });
      // B's list is empty (B owns no tickets) — A's three rows are invisible to B.
      const bList = await server!.app.request('/tickets', {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(bList.status).toBe(200);
      expect(await bList.json()).toEqual({ tickets: [] });
    },
    60_000,
  );

  maybe(
    '(h) the conditional-mount law: this conversation product mounts ONLY its declared surface — undeclared capabilities (file/record/audio) are 404',
    async () => {
      e2eTestsRan += 1;
      // The CONVERSATION surface IS mounted (arm a proved the whole tuples); a capability this doc
      // does NOT declare mounts NOTHING — a real zero-surface 404 over HTTP. The INVERSE (a doc NOT
      // declaring conversation_input → 404 on both conversation routes) is proven generically in
      // product-boot-conditional-env.db.test.ts (a second full DBOS launch in ONE process is
      // unsupported — DBOS registers workflows on a global registry — so that inverse lives there).
      const fileGet = await server!.app.request('/files/f-h', {
        method: 'PUT',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'text/plain' },
        body: 'x',
      });
      expect(fileGet.status).toBe(404);
      const recordSubmit = await server!.app.request('/records/r-h/submit', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(recordSubmit.status).toBe(404);
      expect(
        (
          await server!.app.request('/sessions/s-h', {
            headers: { authorization: `Bearer ${tokenA}` },
          })
        ).status,
      ).toBe(404);
    },
  );

  maybe(
    "(i) erasure: eraseTenantNow(A) → A's ledger + product stores + core run-journal GONE; B's cross-tenant witness UNTOUCHED",
    async () => {
      e2eTestsRan += 1;
      // Ground-truth BASELINE (assert-before-erase).
      expect(await headRowsFor(TENANT)).toHaveLength(4); // CONV_A + CONV_SSE + CONV_RACE + CONV_BOUNDS
      expect((await supportTickets(TENANT)).length).toBe(3); // CONV_BOUNDS never got a ticket (its turns 413'd)
      expect(await headRowsFor(TENANT_B)).toHaveLength(1);
      expect(await turnRowsFor(TENANT_B)).toHaveLength(1);

      const res = await server!.eraseTenantNow!(TENANT);
      expect(res.mode).toBe('deleted');
      expect(res.blobs).toBe('no-backend'); // a chat product moves no bytes.
      // The turn ledger + the product stores are RAW PII — eraseTenant MUST cover ALL of them
      // (the capability-owned conversations/conversation_turns AND the declared support_* stores).
      expect(res.tables.conversations).toBe(4); // CONV_A + CONV_SSE + CONV_RACE + CONV_BOUNDS
      expect(res.tables.support_tickets).toBe(3);
      expect(res.tables.support_catalog).toBe(4); // the seeded reference catalog is tenant-scoped too.
      expect(res.tables.conversation_turns).toBeGreaterThan(0);
      // The core run-journal (workflow_runs) is erased too — DISTINCT from the product stores.
      expect(res.coreTables.workflow_runs).toBeGreaterThan(0);

      // (a) A's rows are GONE.
      expect(await headRowsFor(TENANT)).toHaveLength(0);
      expect(await turnRowsFor(TENANT)).toHaveLength(0);
      expect(await supportTickets(TENANT)).toHaveLength(0);
      // (b) TENANT-SCOPED: B's head + turn row are untouched.
      expect(await headRowsFor(TENANT_B)).toHaveLength(1);
      const bTurns = await turnRowsFor(TENANT_B);
      expect(bTurns).toHaveLength(1);
      expect(bTurns[0]).toMatchObject({ message_id: 'msg-b', state: 'submitted' });
    },
    60_000,
  );
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run
// SKIPPED the acceptance arms (a lost DATABASE_URL would otherwise read GREEN).
describe('Support-Intake-Chat acceptance — ran-guard (must not silently skip in CI)', () => {
  it('all 10 acceptance arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(10);
    else expect(dbRequired).toBe(false);
  });
});
