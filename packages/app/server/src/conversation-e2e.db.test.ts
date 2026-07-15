/**
 * The conversation_input capability END-TO-END through the REAL
 * composition root: it boots the greenfield CONVERSATION-only fixture
 * (`__fixtures__/conversation-intake.product.yaml` — conversation_input, no
 * audio/record/file/stt/agents) via `assembleServer` from `RAYSPEC_SPEC_PATH` on a throwaway
 * DATABASE + a real DBOS launch, and drives the HTTP surface against MATERIALIZED ground truth
 * (fail-the-fix):
 *
 *   (a)  boot WITHOUT RAYSPEC_BLOB_ROOT / RAYSPEC_MEDIA_SIGNING_KEY / STT_PROVIDER /
 *        RAYSPEC_EXTRACTION_MODE (the whole negative env-demand law: a conversation-only doc is
 *        blob-less, byte-less, agent-less — it demands NONE of the four; deleting them makes the
 *        whole suite the proof, a demand regression aborts boot) → both routes mount with their
 *        DECLARED handler tuples; nothing audio/record/file-shaped mounts;
 *   (b)  PUT create → POST turn → the REAL DBOS workflow runs off-request → EXACTLY ONE
 *        `workflow_runs` row whose PK equals the INDEPENDENTLY-RECOMPUTED deterministic id over
 *        the PER-TURN C10 key `turn_ref:<conversation_id>:<message_id>` (pinning the whole
 *        enqueue-key derivation, not just a row count) → the capability's OWN turn-ledger row
 *        carries the tenant-prefixed authorities (turn_ref / seq_ref) → the declared store row
 *        carries the payload-sourced fields incl. the NUMERIC turn_seq and the message TEXT;
 *   (b2) THE TURN-LOSS PIN at the system level: a SECOND turn of the SAME conversation gets its
 *        OWN durable run (turn_seq 2; key `turn_ref:<conv>:<msg2>`) — a conversation-scoped key
 *        would dedupe it into run 1 (silent turn loss);
 *   (c)  identical re-POST of a persisted message → `deduped: true`, STILL the same runs (C10
 *        single-flight through the whole composed stack);
 *   (d)  divergent-text re-POST of a stored message_id → 409 `conversation_message_conflict`,
 *        the stored turn unchanged, still the same runs (the DUR-1 heal re-emit dedups);
 *   (e)  bounds, typed 413 with ZERO side effects: an over-cap message → `message_too_large`;
 *        a body past the DERIVED whole-turn-body bound → `turn_body_too_large`; no ledger row,
 *        no run either way;
 *   (f)  unauthenticated create + turn → 401;
 *   (g)  cross-tenant: a SECOND org's turn submit reaches the bridge sink's fail-closed
 *        assertion → a clean 403 `conversation_event_rejected` (reason cross_tenant), ZERO
 *        enqueue (runs unchanged). HONEST intermediate state (the arm-(h) mirror): B's turn
 *        row IS persisted before the sink's 403 — persist-then-emit is the crash-recovery order;
 *   (h)  the CONCURRENT double-fire: TWO SIMULTANEOUS POSTs of ONE identical
 *        turn race the dedup read + the ledger's unique authorities for real → exactly ONE
 *        response is the winner (200, deduped false); the other is EITHER the converged
 *        redelivery (200, deduped true) OR the loud lost-race 409 `conversation_turn_conflict` —
 *        never a 5xx. Ground truth: EXACTLY ONE durable run / ledger row / declared row for the
 *        doubled message (C10 single-flight under real concurrency, end-state only — no timing);
 *   (i)  erasure: assert-before-erase, then the boot's `eraseTenantNow`
 *        control seam REALLY deletes tenant A's BOTH capability-owned stores + the declared store
 *        rows (`blobs: 'no-backend'` — this capability moves no bytes), TENANT-SCOPED: B's head +
 *        turn rows stay untouched.
 *
 * THE LIVE-REPLY EXTENSION: the boot now runs `RAYSPEC_RESPONDER_MODE=deterministic`
 * with an INJECTED deterministic reply Backend (the injected-Backend proof: the REAL stack — real
 * assembleServer, real per-product `support_responder.responder.json` resolve, real runAgent
 * journaling, real ledger persistence — with zero LLM creds). Every accepted turn now produces a
 * REAL in-request reply, so the arms below additionally pin:
 *   (b)  the reply block (deterministic run id INDEPENDENTLY recomputed; the reply row's own seq;
 *        run-header ground truth: agent_name/model/final_text in `runs`);
 *   (b2) THE TURN-2-SAW-TURN-1 LAW through real HTTP: the deterministic backend derives its reply
 *        from the RECEIVED input string — the turn-2 reply must attest BOTH turn texts (a
 *        garbled/missing history assembly is RED here);
 *   (c)  C10 at the reply level: the identical re-POST returns the PERSISTED reply with ZERO new
 *        model invocations (the backend counts run() calls);
 *   (g)  ZERO model work on the cross-tenant 403 (the invocation count is unchanged);
 *   (h)  the concurrent double-fire converges on EXACTLY ONE reply row (the honest at-least-once
 *        note: BOTH racers may invoke the model once — end-state asserts only);
 *   (i)  erasure covers the assistant reply rows too (RAW PII — the ledger count doubles);
 *   (j)  TF-F1: a terminally-FAILED first reply attempt → typed 502 carrying the
 *        attempt-0 run id; the same-message_id re-POST walks onto the FRESH deterministic
 *        attempt-1 id (clean header chain: attempt 0 stays 'error', attempt 1 completes; the
 *        reply row records the succeeding attempt) — never a re-run under the failed id.
 * SEQ SHIFT (deliberate): every reply row takes its own ledger sequence, so user turns land at
 * seqs 1/3/5 and replies at 2/4/6 — the S2 arms' seq expectations are updated accordingly.
 *
 * The zero-surface conditional for a NON-conversation doc (HTTP 404 on the conversation routes)
 * lives in product-boot-conditional-env.db.test.ts (no second DBOS launch here); the compose-layer
 * zero-surface halves live in compose-conversation-mount.test.ts. Skips without DATABASE_URL; the
 * un-skippable ran-guard hard-fails a REQUIRED run.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const CONVERSATION_YAML = resolve(here, '__fixtures__/conversation-intake.product.yaml');

const SUITE_DB = `rayspec_w3cv_conv_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c301';
const TENANT_B = '00000000-0000-4000-8000-00000000c302';
const CONV_ID = 'conv-001';
const MSG_1 = 'msg-001';
const MSG_2 = 'msg-002';
const MSG_3 = 'msg-003';
const TEXT_1 = 'hello — my invoice-import keeps failing on step 3';
const TEXT_2 = 'it fails with error E42, right after the upload';
const TEXT_3 = 'the retry hangs too — sending the log excerpt now';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI /
// RAYSPEC_REQUIRE_DB_TESTS) read green after silently skipping this proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The INDEPENDENT oracle for the durable run id (ids.ts `durableWorkflowRunId`, recomputed here on
 * purpose — a derivation/format drift re-keys durable runs on redelivery, so this test must go RED
 * on it rather than follow it): v5-shaped UUID over sha256(`${tenant}:${workflowId}:${key}`).
 */
function expectedRunId(tenantId: string, workflowId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${workflowId}:${idempotencyKey}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The INDEPENDENT oracle for the REPLY run id (product-yaml `replyRunId`, recomputed on purpose
 * — a derivation drift would break the C10 attach convergence on redelivery, RED here): v5-shaped
 * UUID over sha256(`conversation-reply:${ledger turn_ref}`). This is ATTEMPT 0 of the TF-F1 chain.
 */
function expectedReplyRunId(tenantId: string, conversationId: string, messageId: string): string {
  const h = createHash('sha256')
    .update(`conversation-reply:${tenantId}:${conversationId}:${messageId}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The INDEPENDENT oracle for a LATER reply ATTEMPT id (product-yaml `replyAttemptRunId`, n ≥ 1,
 * recomputed on purpose — TF-F1: a retry after a terminally-failed attempt must land on THIS
 * derivation): v5-shaped UUID over sha256(`conversation-reply:${turn_ref}:attempt:${n}`).
 */
function expectedReplyAttemptRunId(
  tenantId: string,
  conversationId: string,
  messageId: string,
  attempt: number,
): string {
  const h = createHash('sha256')
    .update(`conversation-reply:${tenantId}:${conversationId}:${messageId}:attempt:${attempt}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The injected deterministic reply Backend: derives its reply from the RECEIVED input
 * string — `saw1`/`saw2` attest whether the security-assembled history carried the earlier turn
 * texts (the turn-2-saw-turn-1 law fails RED on a garbled/missing assembly) — and COUNTS its
 * invocations (the zero-model-work pins). It journals nothing and emits nothing (run-core persists
 * the header; concurrent same-run-id racers in arm (h) therefore cannot collide on the journal).
 */
class DeterministicReplyBackend implements Backend {
  readonly id = 'openai' as const;
  runCalls = 0;
  /** Arm (j) — TF-F1: fail the NEXT n runs TERMINALLY (run-core persists an 'error' header each). */
  failuresRemaining = 0;
  /**
   * S4 — the opt-in STREAM cardinality knob: text_delta chunks emitted through `ctx.onEvent` BEFORE
   * the outcome (run-core persists each to run_events, then flushes it to the responder's live sink →
   * the SSE stream). Default `[]` models the OpenAI ZERO-DELTA backend (the reply arrives only in the
   * terminal frame); set it to model Pi (token) / Anthropic-Codex (message). Reset per arm.
   */
  deltas: string[] = [];
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return {
        runId: 'set-by-run-core',
        backend: 'openai',
        authMode: 'api-key',
        status: 'error',
        finalText: '',
        output: null,
        error: 'DET-FAIL injected terminal reply failure',
        errorClass: 'upstream_5xx',
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 1,
      } as RunResult;
    }
    // S4: stream any configured deltas through the run's live sink (persist-before-flush by run-core).
    for (let i = 0; i < this.deltas.length; i += 1) {
      await ctx.onEvent({ type: 'text_delta', runId: ctx.runId, text: this.deltas[i]! });
    }
    const finalText =
      `DET-REPLY agent=${spec.name} model=${spec.model} ` +
      `saw1=${spec.input.includes(TEXT_1)} saw2=${spec.input.includes(TEXT_2)}`;
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
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      costUsd: 0,
      stepCount: 1,
    } as RunResult;
  }
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

describe.skipIf(!baseUrl)('conversation — real boot + real DBOS + HTTP + live reply', () => {
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
  const replyBackend = new DeterministicReplyBackend();

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
    process.env.RAYSPEC_API_KEY_PEPPER = 'w3cv-conv-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8809';
    process.env.RAYSPEC_SPEC_PATH = CONVERSATION_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // THE WHOLE negative env-demand law (arm a): a conversation-only doc moves NO bytes and runs
    // NO stt/agents, so it must boot with NONE of the four doc-driven env vars — including
    // RAYSPEC_BLOB_ROOT (unlike the file e2e, which needs it). Deleting all four makes the whole
    // suite the proof: a demand regression aborts this boot.
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    // Arm (i): the operator erasure gate ON — eraseTenantNow must REALLY delete (dry-run otherwise).
    process.env.RAYSPEC_ERASURE_ENABLED = 'true';
    // the conversation-doc-driven demand — the responder runs DETERMINISTIC (the injected
    // Backend below; the per-product responder.json still fully resolves/validates), so the whole
    // reply path is driven with ZERO LLM creds. The four OLD env vars above stay DELETED (arm (a)'s
    // negative-env law is unchanged for them).
    process.env.RAYSPEC_RESPONDER_MODE = 'deterministic';

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      productDeterministicResponderBackend: replyBackend,
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'ConvA', 'conv-a'), ($2, 'ConvB', 'conv-b')`,
        [TENANT, TENANT_B],
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
    const email = `w3cv-${tenant.slice(-4)}-${Date.now()}@example.com`;
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
    token?: string,
    body: unknown = {},
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

  /** S4: submit a turn negotiating an SSE stream (Accept: text/event-stream). */
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

  /** Parse a completed SSE response body into `{ id?, event?, data }` frames (data JSON.parsed). */
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

  /** Poll turn_log until a row for `messageId` appears (the async rail's declared-store ground truth). */
  async function waitForTurnLog(messageId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = (await turnLogRows()).find((r) => r.message_id === messageId);
      if (row) return row;
      if (Date.now() > deadline)
        throw new Error(`turn_log row for ${messageId} never materialized`);
      await new Promise((r) => setTimeout(r, 250));
    }
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
  /** The capability's OWN turn-ledger rows for one tenant (materialized ground truth). */
  async function turnRowsFor(tenant: string): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT conversation_id, message_id, turn_ref, seq_ref, turn_seq, role, message, ' +
          'run_id, state FROM conversation_turns WHERE tenant_id = $1 ORDER BY turn_seq',
        [tenant],
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  /** The reply RUN headers (the platform `runs` table — the S3 runAgent ground truth). */
  async function replyRunRows(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT run_id, agent_name, model, status, final_text FROM runs ORDER BY created_at',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function headRowsFor(tenant: string): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT conversation_id, conversation_ref, state, title FROM conversations WHERE tenant_id = $1',
        [tenant],
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  /** The DECLARED store rows the workflow writes (the async-composition ground truth). */
  async function turnLogRows(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT log_ref, conversation_id, message_id, turn_seq, message, status FROM turn_log ' +
          'ORDER BY turn_seq',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function waitForCompletedRuns(
    expected: number,
  ): Promise<Array<{ workflow_run_id: string; status: string }>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const runs = await workflowRuns();
      if (runs.length >= expected && runs.every((r) => r.status === 'completed')) return runs;
      if (Date.now() > deadline)
        throw new Error(`workflow did not complete: ${JSON.stringify(runs)}`);
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

  const maybe = baseUrl ? it : it.skip;

  maybe(
    '(a) boot: conversation-only doc materializes with NONE of the four doc-driven env vars; both routes mount with their DECLARED tuples',
    () => {
      e2eTestsRan += 1;
      expect(server!.deployMode).toBe('materialized');
      const actions = server!.declaredRoutes.map((r) => `${r.method} ${r.path} → ${r.action}`);
      // WHOLE tuples through the boot surface: both conversation routes are plain handler routes —
      // and nothing audio/record/file-shaped is mounted.
      expect(actions).toContain(
        'PUT /conversations/{conversation_id} → handler:conversation_input_create',
      );
      expect(actions).toContain(
        'POST /conversations/{conversation_id}/turns → handler:conversation_input_turn_submit',
      );
      expect(
        actions.some(
          (a) => a.includes('/sessions/') || a.includes('/records/') || a.includes('/files/'),
        ),
      ).toBe(false);
    },
  );

  maybe(
    '(b) create → turn → ONE durable run keyed turn_ref:<conv>:<msg> → the ledger row + the declared store row',
    async () => {
      e2eTestsRan += 1;
      const created = await createConversation(CONV_ID, tokenA, { title: 'Import trouble' });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        conversation_id: CONV_ID,
        state: 'open',
        deduped: false,
      });

      const turn = await submitTurn(CONV_ID, tokenA, { message_id: MSG_1, text: TEXT_1 });
      expect(turn.status).toBe(200);
      // the response = the intake facts (a SUPERSET — arm-compat) + the REAL reply
      // produced in the same request. The reply run id is INDEPENDENTLY recomputed (C10 anchor).
      expect(await turn.json()).toEqual({
        conversation_id: CONV_ID,
        message_id: MSG_1,
        turn_seq: 1,
        event_id: `${TENANT}:${CONV_ID}:${MSG_1}`,
        deduped: false,
        reply: {
          message: 'DET-REPLY agent=support_responder model=det-fixture-model saw1=true saw2=false',
          turn_seq: 2,
          run_id: expectedReplyRunId(TENANT, CONV_ID, MSG_1),
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
        },
      });
      expect(replyBackend.runCalls).toBe(1);

      const runs = await waitForCompletedRuns(1);
      expect(runs).toHaveLength(1);
      // ★ THE C10 KEY PIN through the WHOLE composed stack: the durable run's PK must equal the
      // independently-recomputed deterministic id over the PER-TURN generic key
      // `turn_ref:<conversation_id>:<message_id>` (a key-format drift — the audio ':finalized'
      // suffix leaking in, or a conversation-scoped key — re-keys durable runs → RED here).
      expect(runs[0]?.workflow_run_id).toBe(
        expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_1}`),
      );

      // MATERIALIZED ground truth 1 — the capability's OWN ledger rows: the user turn carries the
      // tenant-prefixed unique authorities + the verbatim message; the ASSISTANT reply row
      // carries the derived `reply~` refs, its OWN seq, the deterministic run id, state 'replied'.
      const turns = await turnRowsFor(TENANT);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        conversation_id: CONV_ID,
        message_id: MSG_1,
        turn_ref: `${TENANT}:${CONV_ID}:${MSG_1}`,
        seq_ref: `${TENANT}:${CONV_ID}:1`,
        turn_seq: 1,
        role: 'user',
        message: TEXT_1,
        state: 'submitted',
      });
      expect(turns[1]).toMatchObject({
        conversation_id: CONV_ID,
        message_id: `reply~${MSG_1}`,
        turn_ref: `${TENANT}:${CONV_ID}:reply~${MSG_1}`,
        seq_ref: `${TENANT}:${CONV_ID}:2`,
        turn_seq: 2,
        role: 'assistant',
        state: 'replied',
      });

      // Run-header ground truth: the reply run journaled under the deterministic id with the
      // config's agent/model and the reply text (the REAL runAgent path, driven credential-free).
      const runRows = await replyRunRows();
      expect(runRows).toHaveLength(1);
      expect(runRows[0]).toMatchObject({
        run_id: expectedReplyRunId(TENANT, CONV_ID, MSG_1),
        agent_name: 'support_responder',
        model: 'det-fixture-model',
        status: 'completed',
      });
      expect(String(runRows[0]?.final_text)).toContain('saw1=true');

      // MATERIALIZED ground truth 2 — the declared store row carries the payload-sourced fields:
      // the tenant-FREE event turn_ref, the NUMERIC turn_seq, and the message TEXT (the
      // message-rides-the-payload contract consumed through the existing store_write path).
      const logs = await turnLogRows();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        log_ref: `${CONV_ID}:${MSG_1}`,
        conversation_id: CONV_ID,
        message_id: MSG_1,
        turn_seq: 1,
        message: TEXT_1,
        status: 'received',
      });
    },
    120_000,
  );

  maybe(
    '(b2) THE TURN-LOSS PIN + TURN-2-SAW-TURN-1: a SECOND turn gets its OWN durable run AND a reply grounded in the FULL history',
    async () => {
      e2eTestsRan += 1;
      const turn = await submitTurn(CONV_ID, tokenA, { message_id: MSG_2, text: TEXT_2 });
      expect(turn.status).toBe(200);
      const body = (await turn.json()) as Record<string, unknown> & {
        reply: { message: string; turn_seq: number };
      };
      // Seq 3 (the S3 seq shift: turn-1's reply took seq 2).
      expect(body.turn_seq).toBe(3);
      // ★ THE TURN-2-SAW-TURN-1 LAW through real HTTP: the deterministic backend attests BOTH turn
      // texts reached it inside the assembled input — a garbled/missing history assembly is RED.
      expect(body.reply.message).toContain('saw1=true');
      expect(body.reply.message).toContain('saw2=true');
      expect(body.reply.turn_seq).toBe(4);

      const runs = await waitForCompletedRuns(2);
      const runIds = runs.map((r) => r.workflow_run_id).sort();
      // TWO distinct runs, each keyed per-TURN — a conversation-scoped key would have deduped
      // msg-002 into msg-001's run (ONE run: silent turn loss → RED here).
      expect(runIds).toEqual(
        [
          expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_1}`),
          expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_2}`),
        ].sort(),
      );
      expect(await turnLogRows()).toHaveLength(2);
    },
    120_000,
  );

  maybe(
    '(c) identical re-POST → deduped, the PERSISTED reply returned, ZERO new model calls, STILL the same two runs (C10)',
    async () => {
      e2eTestsRan += 1;
      const callsBefore = replyBackend.runCalls;
      const again = await submitTurn(CONV_ID, tokenA, { message_id: MSG_1, text: TEXT_1 });
      expect(again.status).toBe(200);
      const body = (await again.json()) as Record<string, unknown> & {
        reply: Record<string, unknown>;
      };
      expect(body).toMatchObject({
        message_id: MSG_1,
        turn_seq: 1,
        deduped: true,
      });
      // ★ C10 AT THE REPLY LEVEL: the SAME persisted reply (row-served: same run id + text + seq,
      // honestly NO usage) and ZERO additional model invocations through the whole real stack.
      expect(body.reply).toEqual({
        message: 'DET-REPLY agent=support_responder model=det-fixture-model saw1=true saw2=false',
        turn_seq: 2,
        run_id: expectedReplyRunId(TENANT, CONV_ID, MSG_1),
      });
      expect(replyBackend.runCalls).toBe(callsBefore);
      // The idempotent create is deduped too (the head-row half of C10).
      const recreate = await createConversation(CONV_ID, tokenA);
      expect(recreate.status).toBe(200);
      expect(((await recreate.json()) as Record<string, unknown>).deduped).toBe(true);

      await expectRunsQuiesced(2);
      expect(await turnRowsFor(TENANT)).toHaveLength(4);
      expect(await turnLogRows()).toHaveLength(2);
    },
    60_000,
  );

  maybe(
    '(d) divergent-text re-POST → 409 conversation_message_conflict, stored turn unchanged, same runs',
    async () => {
      e2eTestsRan += 1;
      const res = await submitTurn(CONV_ID, tokenA, {
        message_id: MSG_1,
        text: 'totally different text under the same message id',
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as Record<string, unknown>).error).toBe(
        'conversation_message_conflict',
      );

      // The stored turn still carries the ORIGINAL text (never silently replaced)…
      const turns = await turnRowsFor(TENANT);
      expect(turns).toHaveLength(4);
      expect(turns[0]).toMatchObject({ message_id: MSG_1, message: TEXT_1 });
      // …the DECLARED store, asserted DIRECTLY after the rejection (F2): still exactly the two
      // workflow-written rows, msg-001's carrying the ORIGINAL text…
      const logs = await turnLogRows();
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({ message_id: MSG_1, message: TEXT_1 });
      // …and the heal re-emit deduped downstream: STILL exactly two runs.
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    '(e) bounds: over-cap message → 413 message_too_large; over-body → 413 turn_body_too_large; ZERO side effects',
    async () => {
      e2eTestsRan += 1;
      // Over the 32 KiB message cap (but under the derived whole-body bound).
      const overCap = await submitTurn(CONV_ID, tokenA, {
        message_id: 'msg-big',
        text: 'x'.repeat(32 * 1024 + 1),
      });
      expect(overCap.status).toBe(413);
      expect(((await overCap.json()) as Record<string, unknown>).error).toBe('message_too_large');
      // ZERO side effects, DIRECT in the real DB after THIS rejection (F2): the ledger AND the
      // declared store still hold exactly the accepted turns+replies — nothing for the rejected id.
      let turns = await turnRowsFor(TENANT);
      expect(turns).toHaveLength(4);
      expect(turns.some((t) => t.message_id === 'msg-big')).toBe(false);
      expect(await turnLogRows()).toHaveLength(2);

      // Past the DERIVED whole-turn-body bound (cap + 4 KiB envelope headroom) — the whole-body
      // check fires FIRST, typed differently (the BOUNDS-1 discipline made observable).
      const overBody = await submitTurn(CONV_ID, tokenA, {
        message_id: 'msg-huge',
        text: 'x'.repeat(36 * 1024 + 512),
      });
      expect(overBody.status).toBe(413);
      expect(((await overBody.json()) as Record<string, unknown>).error).toBe(
        'turn_body_too_large',
      );
      // The same DIRECT store asserts after the SECOND rejection (F2).
      turns = await turnRowsFor(TENANT);
      expect(turns).toHaveLength(4);
      expect(turns.some((t) => t.message_id === 'msg-huge')).toBe(false);
      expect(await turnLogRows()).toHaveLength(2);
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    '(f) unauthenticated create + turn → 401',
    async () => {
      e2eTestsRan += 1;
      expect((await createConversation('conv-anon')).status).toBe(401);
      expect(
        (await submitTurn('conv-anon', undefined, { message_id: 'm', text: 'x' })).status,
      ).toBe(401);
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    "(g) cross-tenant: a SECOND org's turn is the sink's fail-closed 403, ZERO enqueue",
    async () => {
      e2eTestsRan += 1;
      const callsBefore = replyBackend.runCalls;
      const tokenB = await tokenFor(TENANT_B);
      // The create lands under B's OWN server-derived tenant (tenant-prefixed head ref).
      const created = await createConversation('conv-b', tokenB);
      expect(created.status).toBe(200);
      // The turn submit reaches the bridge sink, whose tenant assertion rejects fail-closed: the
      // dispatcher is bound to the DEPLOYMENT tenant (A), B's event must NEVER enqueue.
      const res = await submitTurn('conv-b', tokenB, { message_id: 'msg-b', text: 'from B' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('conversation_event_rejected');
      expect(String(body.detail)).toContain('cross_tenant');
      // ZERO enqueue: the run set is unchanged (still only tenant A's two runs) and no declared
      // store row appeared for B. HONEST intermediate state (the persist-then-emit mirror): B's turn row IS
      // persisted — persist-then-emit is the crash-recovery order; the 403 fires on the emit.
      // and ZERO MODEL WORK — the reply leg is never reached on a rejected event (the
      // commit-then-403 law), so B gets NO assistant row and the backend count is unchanged.
      await expectRunsQuiesced(2);
      expect(await turnLogRows()).toHaveLength(2);
      const bTurns = await turnRowsFor(TENANT_B);
      expect(bTurns).toHaveLength(1);
      expect(bTurns[0]).toMatchObject({ message_id: 'msg-b', state: 'submitted' });
      expect(replyBackend.runCalls).toBe(callsBefore);
    },
    60_000,
  );

  maybe(
    '(h) CONCURRENT identical double-fire → EXACTLY ONE durable run; each response a legal outcome, never a 5xx',
    async () => {
      e2eTestsRan += 1;
      // TWO SIMULTANEOUS POSTs of the SAME turn (same message_id, same text): both requests race
      // the dedup read and the ledger's unique authorities inside the engine's real tenant
      // transactions (the C10 single-flight law driven concurrently, not sequentially).
      const responses = await Promise.all([
        submitTurn(CONV_ID, tokenA, { message_id: MSG_3, text: TEXT_3 }),
        submitTurn(CONV_ID, tokenA, { message_id: MSG_3, text: TEXT_3 }),
      ]);
      const outcomes = await Promise.all(
        responses.map(async (r) => ({
          status: r.status,
          body: (await r.json()) as Record<string, unknown>,
        })),
      );

      // THE PRECISE DISJUNCTION (nothing looser): EXACTLY ONE response is the winner
      // (200, deduped false, the full intake facts) — one insert must win the unique authorities —
      // and the OTHER is EITHER the converged redelivery (200, deduped true) OR the loud lost-race
      // 409 `conversation_turn_conflict`. Any 5xx fails both branches. Every 200 carries
      // the SAME reply (one reply row — the turn_ref convergence; usage presence may differ:
      // fresh-run vs ledger-served — the honest at-least-once note in reply.ts; both racers MAY
      // have invoked the deterministic model once, so no invocation-count assert here, END-STATE
      // asserts only).
      const intakeFacts = {
        conversation_id: CONV_ID,
        message_id: MSG_3,
        turn_seq: 5,
        event_id: `${TENANT}:${CONV_ID}:${MSG_3}`,
      };
      const expectedReply = {
        message: 'DET-REPLY agent=support_responder model=det-fixture-model saw1=true saw2=true',
        turn_seq: 6,
        run_id: expectedReplyRunId(TENANT, CONV_ID, MSG_3),
      };
      // EXACT-SHAPE body assertions — the ONLY legitimately-varying
      // key is reply.usage (fresh-run vs ledger-served presence), so it is stripped and the
      // REST is toEqual'd (an extra/renamed body key fails here; toMatchObject would let one ride).
      const exactBody = (o: { body: Record<string, unknown> }): Record<string, unknown> => {
        const reply = { ...(o.body.reply as Record<string, unknown>) };
        delete reply.usage;
        return { ...o.body, reply };
      };
      const winners = outcomes.filter((o) => o.status === 200 && o.body.deduped === false);
      expect(winners).toHaveLength(1);
      expect(exactBody(winners[0] as { body: Record<string, unknown> })).toEqual({
        ...intakeFacts,
        deduped: false,
        reply: expectedReply,
      });
      const other = outcomes.find((o) => o !== winners[0]);
      if (other?.status === 200) {
        expect(exactBody(other)).toEqual({ ...intakeFacts, deduped: true, reply: expectedReply });
      } else {
        expect(other?.status).toBe(409);
        expect(other?.body.error).toBe('conversation_turn_conflict');
      }

      // GROUND TRUTH (the invariant that must NEVER fail): the doubled message enqueued EXACTLY
      // ONCE — the full run set is precisely the three per-TURN keys — and stays that way across
      // the quiesce window (no late double-fire). End-state only; no timing asserts.
      const runs = await waitForCompletedRuns(3);
      expect(runs.map((r) => r.workflow_run_id).sort()).toEqual(
        [
          expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_1}`),
          expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_2}`),
          expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_ID}:${MSG_3}`),
        ].sort(),
      );
      await expectRunsQuiesced(3);

      // EXACTLY ONE user ledger row AND EXACTLY ONE reply row for the doubled message (the reply
      // turn_ref unique is the convergence authority — even if both racers ran the model once),
      // and ONE declared-store row (the loser persisted NOTHING intake-side).
      const turns = await turnRowsFor(TENANT);
      expect(turns).toHaveLength(6);
      expect(turns.filter((t) => t.message_id === MSG_3)).toHaveLength(1);
      expect(turns.filter((t) => t.message_id === `reply~${MSG_3}`)).toHaveLength(1);
      expect(turns.find((t) => t.message_id === MSG_3)).toMatchObject({
        turn_ref: `${TENANT}:${CONV_ID}:${MSG_3}`,
        turn_seq: 5,
        message: TEXT_3,
      });
      const logs = await turnLogRows();
      expect(logs).toHaveLength(3);
      expect(logs.filter((l) => l.message_id === MSG_3)).toHaveLength(1);
    },
    120_000,
  );

  maybe(
    "(i) erasure: eraseTenantNow(A) → A's head + ledger + declared rows GONE (blobs: no-backend); B's data UNTOUCHED",
    async () => {
      e2eTestsRan += 1;
      // Ground-truth BASELINE (assert-before-erase): A's head + 6 ledger rows (3 user turns + the
      // 3 S3 assistant replies — the reply rows are RAW PII too) + 3 declared rows, and B's
      // cross-tenant witnesses (the arm-(g) head + sealed turn, NO reply — the 403 preceded the
      // reply leg) are all present.
      expect(await headRowsFor(TENANT)).toHaveLength(1);
      expect(await turnRowsFor(TENANT)).toHaveLength(6);
      expect(await turnLogRows()).toHaveLength(3);
      expect(await headRowsFor(TENANT_B)).toHaveLength(1);
      expect(await turnRowsFor(TENANT_B)).toHaveLength(1);

      // The boot's erasure control seam (operator gate ON in beforeAll): a REAL, tenant-scoped delete.
      // The turn ledger is RAW PII — eraseTenant MUST cover BOTH capability-owned stores (the
      // retention pin) plus the declared store — INCLUDING the assistant reply rows.
      const res = await server!.eraseTenantNow!(TENANT);
      expect(res.mode).toBe('deleted');
      // This capability moves no bytes: no blob backend exists on this deploy — and none is needed.
      expect(res.blobs).toBe('no-backend');
      expect(res.tables).toEqual({ conversations: 1, conversation_turns: 6, turn_log: 3 });

      // (a) A's rows are GONE — head, ledger, and the declared store rows.
      expect(await headRowsFor(TENANT)).toHaveLength(0);
      expect(await turnRowsFor(TENANT)).toHaveLength(0);
      expect(await turnLogRows()).toHaveLength(0);
      // (b) TENANT-SCOPED: B's head + sealed turn row are untouched.
      expect(await headRowsFor(TENANT_B)).toHaveLength(1);
      const bTurns = await turnRowsFor(TENANT_B);
      expect(bTurns).toHaveLength(1);
      expect(bTurns[0]).toMatchObject({ message_id: 'msg-b', state: 'submitted' });
    },
    60_000,
  );

  maybe(
    '(j) TF-F1: a terminally-FAILED first reply attempt → 502 carrying the attempt-0 run id; the re-POST converges on a FRESH attempt id with a CLEAN header chain',
    async () => {
      e2eTestsRan += 1;
      // Runs AFTER erasure (arm i): tenant A's runs/ledger are empty — this arm's rows are the
      // only ones, so the header-chain asserts below are exact. The org shell + membership
      // survive erasure (only DATA is erased), so tokenA still authorizes.
      const CONV_RETRY = 'conv-retry';
      const MSG_R = 'msg-r1';
      const attempt0 = expectedReplyRunId(TENANT, CONV_RETRY, MSG_R);
      const attempt1 = expectedReplyAttemptRunId(TENANT, CONV_RETRY, MSG_R, 1);
      expect((await createConversation(CONV_RETRY, tokenA)).status).toBe(200);

      // The FIRST attempt fails terminally at the model (the injected backend) — the intake is
      // COMMITTED (turn + event), the reply leg maps to the typed 502 CARRYING the attempt-0
      // run id, and run-core has persisted attempt-0's header with status 'error'.
      replyBackend.failuresRemaining = 1;
      const first = await submitTurn(CONV_RETRY, tokenA, { message_id: MSG_R, text: 'retry me' });
      expect(first.status).toBe(502);
      const firstBody = (await first.json()) as Record<string, unknown>;
      expect(firstBody.error).toBe('conversation_reply_failed');
      expect(firstBody.run_id).toBe(attempt0);
      expect(firstBody.intake).toMatchObject({
        conversation_id: CONV_RETRY,
        message_id: MSG_R,
        turn_seq: 1,
      });

      // ★ THE TF-F1 LAW through real HTTP: the same-message_id re-POST dedupes the intake and the
      // responder walks PAST the failed attempt-0 header onto the FRESH deterministic attempt-1
      // id (pre-fix: the retry re-ran under attempt 0 — its header stayed 'error' forever and
      // the fresh events deduped against the failed attempt's seqs).
      const second = await submitTurn(CONV_RETRY, tokenA, {
        message_id: MSG_R,
        text: 'retry me',
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as Record<string, unknown> & {
        reply: Record<string, unknown>;
      };
      expect(body.deduped).toBe(true);
      expect(body.reply.run_id).toBe(attempt1);

      // CLEAN header chain (ground truth in `runs`): attempt 0 keeps its honest terminal
      // failure; attempt 1 is its OWN completed header — never one id with mixed attempts.
      const runRows = await replyRunRows();
      expect(runRows).toHaveLength(2);
      const byId = new Map(runRows.map((r) => [r.run_id, r]));
      expect(byId.get(attempt0)).toMatchObject({
        status: 'error',
        agent_name: 'support_responder',
      });
      expect(byId.get(attempt1)).toMatchObject({
        status: 'completed',
        agent_name: 'support_responder',
      });

      // The persisted reply row records the attempt that SUCCEEDED (run_id = attempt 1).
      const turns = await turnRowsFor(TENANT);
      const reply = turns.find((t) => t.message_id === `reply~${MSG_R}`);
      expect(reply).toMatchObject({
        turn_seq: 2,
        role: 'assistant',
        state: 'replied',
        run_id: attempt1,
      });

      // The intake's durable workflow ran exactly ONCE (the 502 never unwound it; the re-POST's
      // heal re-emit deduped) — erasure cleared the old runs, so the set is exactly this one.
      const runs = await waitForCompletedRuns(1);
      expect(runs.map((r) => r.workflow_run_id)).toEqual([
        expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_RETRY}:${MSG_R}`),
      ]);
    },
    120_000,
  );

  // ── S4 — STREAMING EGRESS through the REAL stack (fresh conversation; distinct ids). ────────
  const CONV_SSE = 'conv-sse';
  const MSG_SSE = 'msg-sse-1';
  const MSG_SSE_ZERO = 'msg-sse-0';

  maybe(
    '(k) SSE turn: content-negotiated stream carries intake + per-backend deltas + a terminal reply; the reply persists; the async workflow ALSO fires; terminal ⟷ re-POST are byte-consistent',
    async () => {
      e2eTestsRan += 1;
      await createConversation(CONV_SSE, tokenA, { title: 'Streaming' });
      // Model a token-streaming backend (Pi/Anthropic-Codex): two deltas flow through the run sink.
      replyBackend.deltas = ['par', 'tial'];
      try {
        const res = await streamTurn(CONV_SSE, tokenA, {
          message_id: MSG_SSE,
          text: 'stream me',
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const frames = await readSseFrames(res);

        // Frame 0 — the intake confirmation (durable; leg1 committed before the stream).
        expect(frames[0]?.event).toBe('conversation_intake');
        expect(frames[0]?.data).toMatchObject({
          conversation_id: CONV_SSE,
          message_id: MSG_SSE,
          turn_seq: 1,
        });
        // The pass-through delta frames (id = the run's seq; honest per-backend cardinality).
        const deltas = frames.filter((f) => f.event === 'text_delta');
        expect(deltas.map((f) => (f.data as { text: string }).text)).toEqual(['par', 'tial']);
        expect(deltas.map((f) => f.id)).toEqual(['0', '1']);
        // The terminal frame — the GUARANTEED complete reply (run_id + whole text + reply seq).
        const terminal = frames.at(-1);
        expect(terminal?.event).toBe('conversation_reply');
        const streamed = terminal?.data as { run_id: string; text: string; turn_seq: number };
        expect(streamed.run_id).toBe(expectedReplyRunId(TENANT, CONV_SSE, MSG_SSE));
        expect(streamed.text).toContain('DET-REPLY agent=support_responder');
        expect(streamed.turn_seq).toBe(2);
        expect(replyBackend.runCalls).toBeGreaterThan(0);

        // The reply PERSISTED server-side regardless of the stream (leg3): the assistant row exists.
        const turns = await turnRowsFor(TENANT);
        const replyRow = turns.find((t) => t.message_id === `reply~${MSG_SSE}`);
        expect(replyRow).toMatchObject({ role: 'assistant', state: 'replied', turn_seq: 2 });

        // STREAMING × ASYNC representation-independence: the streamed turn ALSO emitted turn_submitted
        // and enqueued the durable workflow → the declared turn_log row + the C10-keyed workflow_run.
        const logRow = await waitForTurnLog(MSG_SSE);
        expect(logRow).toMatchObject({
          conversation_id: CONV_SSE,
          message_id: MSG_SSE,
          message: 'stream me',
          status: 'received',
        });
        const wfPk = expectedRunId(TENANT, 'log_turn', `turn_ref:${CONV_SSE}:${MSG_SSE}`);
        expect((await workflowRuns()).map((r) => r.workflow_run_id)).toContain(wfPk);

        // TERMINAL ⟷ RE-POST consistency (PM sharpening 3): a C10 JSON re-POST of the SAME message
        // returns the persisted reply, byte-equal to the stream's terminal {run_id, text, turn_seq}.
        const repost = await submitTurn(CONV_SSE, tokenA, {
          message_id: MSG_SSE,
          text: 'stream me',
        });
        expect(repost.status).toBe(200);
        const reposted = (await repost.json()).reply as {
          run_id: string;
          message: string;
          turn_seq: number;
        };
        expect({
          run_id: streamed.run_id,
          text: streamed.text,
          turn_seq: streamed.turn_seq,
        }).toEqual({
          run_id: reposted.run_id,
          text: reposted.message,
          turn_seq: reposted.turn_seq,
        });
      } finally {
        replyBackend.deltas = [];
      }
    },
    120_000,
  );

  maybe(
    '(l) ZERO-DELTA backend (OpenAI-shape): the stream emits NO text_delta, yet the terminal frame still carries the whole reply',
    async () => {
      e2eTestsRan += 1;
      await createConversation(`${CONV_SSE}-0`, tokenA, { title: 'Zero-delta' });
      replyBackend.deltas = []; // OpenAI emits nothing through the run sink (non-streaming overload).
      const res = await streamTurn(`${CONV_SSE}-0`, tokenA, {
        message_id: MSG_SSE_ZERO,
        text: 'no deltas',
      });
      expect(res.status).toBe(200);
      const frames = await readSseFrames(res);
      expect(frames.some((f) => f.event === 'text_delta')).toBe(false);
      const terminal = frames.at(-1);
      expect(terminal?.event).toBe('conversation_reply');
      expect((terminal?.data as { text: string }).text).toContain(
        'DET-REPLY agent=support_responder',
      );
      expect((terminal?.data as { run_id: string }).run_id).toBe(
        expectedReplyRunId(TENANT, `${CONV_SSE}-0`, MSG_SSE_ZERO),
      );
    },
    120_000,
  );

  maybe(
    '(m) security framing: a hostile delta cannot forge a second SSE event through the REAL Hono wire — it round-trips inside one JSON-escaped data payload',
    async () => {
      e2eTestsRan += 1;
      const CONV_INJ = 'conv-inj';
      const MSG_INJ = 'msg-inj-1';
      await createConversation(CONV_INJ, tokenA, { title: 'Injection' });
      // A delta engineered to break out of a naive `data: <text>` frame (blank line + a forged
      // event + a forged data line, LF and CRLF separators) — the attacker-influenced model output.
      const HOSTILE = 'x\n\nevent: forged\ndata: {"pwned":true}\r\n\r\nevent: forged2\ndata: y';
      replyBackend.deltas = [HOSTILE];
      try {
        const res = await streamTurn(CONV_INJ, tokenA, { message_id: MSG_INJ, text: 'inject' });
        expect(res.status).toBe(200);
        const frames = await readSseFrames(res);
        // NO forged event materialized: the REAL wire carries EXACTLY the three legit events in order
        // (the producer's JSON.stringify + Hono's per-line `data:` prefixing are the two framing layers).
        expect(frames.map((f) => f.event)).toEqual([
          'conversation_intake',
          'text_delta',
          'conversation_reply',
        ]);
        // The hostile text ROUND-TRIPS intact inside the single JSON-escaped delta data payload.
        const delta = frames.find((f) => f.event === 'text_delta');
        expect((delta?.data as { text: string }).text).toBe(HOSTILE);
      } finally {
        replyBackend.deltas = [];
      }
    },
    120_000,
  );
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run
// SKIPPED the conversation arms (a lost DATABASE_URL would otherwise read GREEN).
describe('conversation e2e — ran-guard', () => {
  it('all 14 e2e arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(14);
    else expect(true).toBe(true);
  });
});
