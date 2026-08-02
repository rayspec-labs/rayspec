/**
 * ACCEPTANCE 3, MEASURED against a real database: with the deployment-supplied product backend
 * factory installed, journal attribution, structured-output validation and replay behave IDENTICALLY
 * to the path that receives an embedder-injected Backend. The seam substitutes CONSTRUCTION, not
 * contract — so everything downstream of "which Backend object" must be indistinguishable.
 *
 * ARM 1 — THE REAL BOOT (the embedder reach). `assembleServer` boots the committed conversation
 * fixture with `RAYSPEC_RESPONDER_MODE=live` and NO provider credential anywhere in env, supplying
 * only `productAgentBackendsFactory`. Every model call the deployed document needs is constructed by
 * the factory; the whole live-reply path then runs for real (HTTP → capability → runAgent → journal).
 * It asserts the reply run id against an INDEPENDENTLY RECOMPUTED oracle, the `runs` header, the
 * `journal_steps` `backend` attribution, and the ATTACH/replay convergence of an identical re-POST.
 * RED without the fix in two ways: `productAgentBackendsFactory` is not a property of assembleServer's
 * opts, and the ignored option leaves `RAYSPEC_RESPONDER_MODE=live` with no credential, so the boot
 * itself rejects with `responder 'support_responder': … OPENAI_API_KEY is required …`.
 *
 * ARM 2/3 — THE HEAD-TO-HEAD. Two responders (and two normalizers) are built in ONE process over the
 * SAME database with the SAME scripted Backend INSTANCE: one through the deterministic injection seam,
 * one through the factory seam. Both are then driven through the REAL
 * `ConversationTurnResponder.respond()` / `RecordNormalizer.normalize()` the product path itself calls
 * — never a re-implementation of them, which would compare two invocations of this file's own code and
 * prove nothing about the product path. Compared: the `AgentSpec` the Backend was handed, the persisted
 * `runs` + `journal_steps` rows (modulo the surrogate step id, the deterministic run id and the timing
 * columns) INCLUDING the `backend` column, the run id against the recomputed oracle on both, and the
 * second call's ATTACH with the model-invocation counter unchanged. Comparing ONE shared instance
 * across the two seams is the point: it proves the paths are identical, not merely that each one
 * independently works.
 *
 * ROW ISOLATION INSIDE THE ONE DATABASE: all three arms share a single throwaway database, so the two
 * paths are kept apart by IDENTITY, not by storage. Each path gets its own turn ref / record id
 * (`TURN_REF_A` vs `TURN_REF_B`, `rec-deterministic` vs `rec-factory`), both distinct from the booted
 * arm's `CONV_ID`/`MSG_1`; every run id is therefore distinct and DERIVED from those ids, and every row
 * comparison selects `WHERE run_id = <that path's recomputed id>`. No assertion reads a whole table, so
 * one path's rows can never satisfy the other path's expectation.
 *
 * WHY THERE IS ONE BOOT AND NOT TWO: DBOS is a process-global singleton, `deployProductYamlSpec` starts
 * its durable executor unconditionally, and the boot path never deregisters on shutdown — so a second
 * `assembleServer` product boot in the same process aborts with
 * `Operation (Name: .runAgentJob) is already registered.` (the constraint recorded at
 * packages/compose/product-yaml/src/compose-conditional-mount.test.ts:198), and vitest isolates test
 * FILES, not tests, so two boots cannot share an in-memory Backend instance either. The cost is stated
 * plainly: the deterministic path is NOT driven through its own `assembleServer` + HTTP surface here.
 * That path is covered end-to-end by the committed conversation-e2e.db.test.ts and
 * record-normalize-e2e.db.test.ts, which this change does not touch; what needed measuring here is that
 * the factory path lands on the SAME ground truth, which is what the head-to-head does.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { type Db, makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import {
  bindProductBackends,
  buildRecordNormalizer,
  buildTurnResponder,
  type ProductAgentBackendsFactory,
} from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'product-backend-factory-parity.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the product-backend-factory parity proof.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const CONVERSATION_YAML = resolve(here, '__fixtures__/conversation-intake.product.yaml');
const NORMALIZE_YAML = resolve(here, '__fixtures__/record-normalize/record-normalize.product.yaml');

const SUITE_DB = `rayspec_backend_factory_parity_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c401';
const CONV_ID = 'conv-parity-1';
const MSG_1 = 'msg-parity-1';
/** The two head-to-head turn refs — same input, distinct refs so each path gets its own run id. */
const TURN_REF_A = `${TENANT}:conv-head-to-head:msg-deterministic`;
const TURN_REF_B = `${TENANT}:conv-head-to-head:msg-factory`;
const HEAD_TO_HEAD_INPUT = 'the parity turn: the same assembled input on both paths';
const HEAD_TO_HEAD_RECORD = { title: 'fix the door', priority: 'high' };

/**
 * The INDEPENDENT oracle for the reply run id (product-yaml `replyAttemptRunId(turnRef, 0)`,
 * recomputed on purpose — a derivation drift would break the single-flight attach convergence and
 * must go RED here rather than be followed): v5-shaped UUID over sha256(`conversation-reply:<turnRef>`).
 */
function expectedReplyRunId(turnRef: string): string {
  const h = createHash('sha256').update(`conversation-reply:${turnRef}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The ONE scripted Backend both paths are driven with. It reports id 'openai' (the id both sidecars
 * declare), RECORDS every AgentSpec it is handed (the head-to-head comparand) and COUNTS its
 * invocations (the replay pins). A structured request (an outputSchema — the normalizer) gets a
 * structured `output`; a free-text request (the responder) gets a `finalText` derived from the input,
 * so the reply is observably a function of what the platform assembled, not a constant.
 *
 * It journals ONE `llm` step the way a real adapter does, because the `backend` column on those rows
 * is exactly the attribution acceptance 3 is about — a Backend that journalled nothing would leave
 * the ledger half of this proof vacuous.
 */
class ScriptedBackend implements Backend {
  readonly id = 'openai' as const;
  runCalls = 0;
  readonly specs: AgentSpec[] = [];
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    this.specs.push(spec);
    const structured = spec.outputSchema !== undefined;
    let output: unknown = null;
    if (structured) {
      const raw = JSON.parse(spec.input.slice(spec.input.indexOf('\n\n') + 2)) as Record<
        string,
        unknown
      >;
      output = { title: String(raw.title ?? '').toUpperCase(), priority: raw.priority };
    }
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `scripted:${spec.name}:0`,
      inputHash: createHash('sha256').update(spec.input).digest('hex'),
      output,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'scripted-parity-backend',
      latencyMs: 0,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: 'set-by-run-core',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: structured ? '' : `SCRIPTED agent=${spec.name} model=${spec.model}`,
      output,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      costUsd: 0,
      stepCount: 1,
    } as RunResult;
  }
}

/** Serve every requirement the survey shows with the ONE scripted Backend (the broker stand-in). */
const scripted = new ScriptedBackend();
const scriptedFactory: ProductAgentBackendsFactory = (ctx) =>
  new Map(ctx.requirements.map((r) => [r, scripted as Backend]));

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

function specOf(path: string): ProductSpec {
  const parsed = parseProductSpec(readFileSync(path, 'utf8'));
  if (!parsed.ok) throw new Error(`${path} must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/** The comparable half of a run header — the deterministic run id and the timestamps are excluded. */
interface RunHeaderRow {
  backend: string;
  auth_mode: string;
  agent_name: string;
  model: string;
  status: string;
  final_text: string | null;
  output: unknown;
  cost_usd: string;
  provider_cost_usd: string | null;
  billed_cost_usd: string;
  cost_drift: boolean;
}
/** The comparable half of a journal step — the surrogate step id, run id and timings are excluded. */
interface JournalStepRow {
  backend: string;
  type: string;
  idempotency_key: string;
  input_hash: string;
  output: unknown;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_usd: string;
  provider_cost_usd: string | null;
  billed_cost_usd: string;
  cost_drift: boolean;
  pricing_version: string | null;
  status: string;
  error_class: string | null;
  auth_mode: string;
}

describe.skipIf(!baseUrl)(
  'the product backend factory — parity with the injected-Backend path',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let dbosSysDb = '';
    let tokenA = '';
    let db: Db | undefined;
    const tmpDirs: string[] = [];
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
      // The credential the seam exists to make unnecessary: it must be ABSENT for this boot, or the
      // "no provider credential in env" claim is untrue and the boot could have built its own adapter.
      'OPENAI_API_KEY',
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
      process.env.RAYSPEC_API_KEY_PEPPER = 'parity-pepper';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8813';
      process.env.RAYSPEC_SPEC_PATH = CONVERSATION_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      // A conversation-only doc moves no bytes and runs no stt/agents (the negative env-demand law).
      delete process.env.RAYSPEC_BLOB_ROOT;
      delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
      delete process.env.STT_PROVIDER;
      delete process.env.RAYSPEC_EXTRACTION_MODE;
      // LIVE — the real backend-construction path — with the credential it would demand DELETED.
      delete process.env.OPENAI_API_KEY;
      process.env.RAYSPEC_RESPONDER_MODE = 'live';

      const seed = makeDb(appDbUrl);
      try {
        await applyMigrations(seed);
        await seed.$client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Parity', 'parity')`,
          [TENANT],
        );
      } finally {
        await seed.$client.end();
      }

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
        productAgentBackendsFactory: scriptedFactory,
      });
      db = makeDb(appDbUrl);
      tokenA = await tokenFor(TENANT);
    }, 180_000);

    afterAll(async () => {
      await db?.$client.end().catch(() => {});
      await server?.close();
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
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
    }, 120_000);

    async function tokenFor(tenant: string): Promise<string> {
      const email = `parity-${tenant.slice(-4)}-${Date.now()}@example.com`;
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

    async function runHeader(runId: string): Promise<RunHeaderRow | undefined> {
      const client = postgres(appDbUrl, { max: 2 });
      try {
        const rows = (await client.unsafe(
          `SELECT backend, auth_mode, agent_name, model, status, final_text, output, cost_usd,
                provider_cost_usd, billed_cost_usd, cost_drift
           FROM runs WHERE run_id = $1`,
          [runId],
        )) as unknown as RunHeaderRow[];
        return rows[0];
      } finally {
        await client.end();
      }
    }

    async function journalSteps(runId: string): Promise<JournalStepRow[]> {
      const client = postgres(appDbUrl, { max: 2 });
      try {
        return (await client.unsafe(
          `SELECT backend, type, idempotency_key, input_hash, output, input_tokens, output_tokens,
                total_tokens, cost_usd, provider_cost_usd, billed_cost_usd, cost_drift,
                pricing_version, status, error_class, auth_mode
           FROM journal_steps WHERE run_id = $1 ORDER BY idempotency_key`,
          [runId],
        )) as unknown as JournalStepRow[];
      } finally {
        await client.end();
      }
    }

    /**
     * The run ids one agent produced, oldest first. Used only where the run id is not recomputable
     * from an independent oracle (the normalize id embeds the submit path's canonical payload hash);
     * it asserts EXACTLY the expected cardinality so it can never quietly widen into a table scan.
     */
    async function runIdsForAgent(agentName: string): Promise<string[]> {
      const client = postgres(appDbUrl, { max: 2 });
      try {
        const rows = (await client.unsafe(
          'SELECT run_id FROM runs WHERE agent_name = $1 ORDER BY created_at, run_id',
          [agentName],
        )) as unknown as Array<{ run_id: string }>;
        expect(rows).toHaveLength(2);
        return rows.map((r) => r.run_id);
      } finally {
        await client.end();
      }
    }

    // ── ARM 1: the real boot — every model call constructed by the factory, zero credentials ────────

    it('BOOTS with NO provider credential in env: the factory constructed the responder Backend', () => {
      expect(server).toBeDefined();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(server?.declaredRoutes.some((r) => r.path.includes('/conversations/'))).toBe(true);
    });

    it('a real turn journals under the DECLARED backend and lands on the recomputed run id', async () => {
      const before = scripted.runCalls;
      const created = await server!.app.request(`/conversations/${CONV_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      });
      expect([200, 201]).toContain(created.status);

      const turn = await server!.app.request(`/conversations/${CONV_ID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ message_id: MSG_1, text: 'the parity turn' }),
      });
      expect(turn.status).toBe(200);
      const body = (await turn.json()) as { reply: { message: string; run_id: string } };
      // The reply came from the FACTORY-supplied Backend — nothing else in this process could have
      // produced it, since the env carries no credential the boot could have built an adapter from.
      expect(body.reply.message).toBe('SCRIPTED agent=support_responder model=det-fixture-model');
      expect(scripted.runCalls).toBe(before + 1);
      // The single-flight anchor, INDEPENDENTLY recomputed over the tenant-prefixed ledger turn_ref.
      const runId = expectedReplyRunId(`${TENANT}:${CONV_ID}:${MSG_1}`);
      expect(body.reply.run_id).toBe(runId);

      // JOURNAL ATTRIBUTION: the run header and every step name the DECLARED backend — the seam
      // substituted construction, so the ledger still says exactly what the sidecar declared.
      const header = await runHeader(runId);
      expect(header).toMatchObject({
        backend: 'openai',
        agent_name: 'support_responder',
        model: 'det-fixture-model',
        status: 'completed',
      });
      const steps = await journalSteps(runId);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) expect(s.backend).toBe('openai');
    }, 60_000);

    it('the identical re-POST REPLAYS: same reply, same run id, ZERO new model invocations', async () => {
      const before = scripted.runCalls;
      const again = await server!.app.request(`/conversations/${CONV_ID}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ message_id: MSG_1, text: 'the parity turn' }),
      });
      expect(again.status).toBe(200);
      const body = (await again.json()) as { deduped: boolean; reply: { run_id: string } };
      expect(body.deduped).toBe(true);
      expect(body.reply.run_id).toBe(expectedReplyRunId(`${TENANT}:${CONV_ID}:${MSG_1}`));
      expect(scripted.runCalls).toBe(before);
    }, 60_000);

    // ── ARM 2: the responder head-to-head, ONE shared Backend instance, two seams ───────────────────

    it('responder: the AgentSpec and the persisted rows are IDENTICAL on the deterministic and the factory path', async () => {
      const spec = specOf(CONVERSATION_YAML);
      // PATH A — the embedder-injected Backend (the committed dev/CI seam).
      const deterministic = buildTurnResponder(
        { RAYSPEC_RESPONDER_MODE: 'deterministic' },
        CONVERSATION_YAML,
        spec,
        db!,
        { deterministicResponderBackend: scripted },
      );
      // PATH B — the SAME instance, reached through the factory seam with no credential in env.
      const liveEnv = { RAYSPEC_RESPONDER_MODE: 'live' };
      const source = bindProductBackends(scriptedFactory, {
        env: liveEnv,
        specPath: CONVERSATION_YAML,
        spec,
        withConversationInput: true,
      });
      const factoryBuilt = buildTurnResponder(liveEnv, CONVERSATION_YAML, spec, db!, {}, source);

      const specsBefore = scripted.specs.length;
      const outA = await deterministic(TENANT).respond({
        input: HEAD_TO_HEAD_INPUT,
        turnRef: TURN_REF_A,
      });
      const outB = await factoryBuilt(TENANT).respond({
        input: HEAD_TO_HEAD_INPUT,
        turnRef: TURN_REF_B,
      });

      // (i) The AgentSpec the Backend was handed — instructions, model, input, tools, maxTurns and the
      // absence of an outputSchema (a chat reply is free text) — is deep-equal across the two seams.
      const handed = scripted.specs.slice(specsBefore);
      expect(handed).toHaveLength(2);
      const [specA, specB] = handed;
      expect(specA).toEqual(specB);
      expect(specA?.outputSchema).toBeUndefined();

      // (ii) Each run landed on its own INDEPENDENTLY RECOMPUTED deterministic id, so a bug that moved
      // BOTH paths to the same wrong derivation is still caught.
      const runA = expectedReplyRunId(TURN_REF_A);
      const runB = expectedReplyRunId(TURN_REF_B);
      expect(outA).toEqual({
        status: 'completed',
        runId: runA,
        text: 'SCRIPTED agent=support_responder model=det-fixture-model',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      });
      expect(outB).toEqual({ ...outA, runId: runB });

      // (iii) The ledger — run header and journal steps, INCLUDING the `backend` column, which is what
      // "attribution" means — is equal modulo the surrogate step id, the run id and the timings. The
      // non-empty guard keeps a comparison of two empty sets from reading green.
      const stepsA = await journalSteps(runA);
      expect(stepsA.length).toBeGreaterThan(0);
      expect(stepsA.every((s) => s.backend === 'openai')).toBe(true);
      // Both headers must EXIST before they are compared: two absent rows are equal to each other, so
      // the comparison alone would read green on a path that wrote no header at all.
      const headerA = await runHeader(runA);
      expect(headerA).toBeDefined();
      expect(await runHeader(runB)).toEqual(headerA);
      expect(await journalSteps(runB)).toEqual(stepsA);

      // (iv) Replay: repeating each turn ATTACHes to the persisted header on BOTH paths (the reply is
      // reconstructed from the persisted final_text, so usage is honestly absent), with the shared
      // Backend's invocation counter unchanged.
      const calls = scripted.runCalls;
      const replayA = await deterministic(TENANT).respond({
        input: HEAD_TO_HEAD_INPUT,
        turnRef: TURN_REF_A,
      });
      const replayB = await factoryBuilt(TENANT).respond({
        input: HEAD_TO_HEAD_INPUT,
        turnRef: TURN_REF_B,
      });
      expect(replayA).toEqual({
        status: 'completed',
        runId: runA,
        text: 'SCRIPTED agent=support_responder model=det-fixture-model',
      });
      expect(replayB).toEqual({ ...replayA, runId: runB });
      expect(scripted.runCalls).toBe(calls);
    }, 60_000);

    // ── ARM 3: the normalizer head-to-head — where structured-output validation lives ───────────────

    it('normalizer: structured output, its schema and the persisted rows are IDENTICAL on both paths', async () => {
      const spec = specOf(NORMALIZE_YAML);
      const decl = { agent: 'field_normalizer', output_contract: 'intake.normalized' };
      const deterministic = buildRecordNormalizer(
        { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
        NORMALIZE_YAML,
        spec,
        db!,
        { deterministicNormalizerBackend: scripted },
        decl,
      );
      const liveEnv = { RAYSPEC_NORMALIZE_MODE: 'live' };
      const source = bindProductBackends(scriptedFactory, {
        env: liveEnv,
        specPath: NORMALIZE_YAML,
        spec,
        withConversationInput: false,
        normalizeAgentId: 'field_normalizer',
      });
      const factoryBuilt = buildRecordNormalizer(
        liveEnv,
        NORMALIZE_YAML,
        spec,
        db!,
        {},
        decl,
        source,
      );

      const specsBefore = scripted.specs.length;
      const outA = await deterministic(TENANT).normalize({
        record: HEAD_TO_HEAD_RECORD,
        recordId: 'rec-deterministic',
      });
      const outB = await factoryBuilt(TENANT).normalize({
        record: HEAD_TO_HEAD_RECORD,
        recordId: 'rec-factory',
      });
      // The normalized record is the same transform on both paths.
      expect(outA).toEqual({
        status: 'normalized',
        record: { title: 'FIX THE DOOR', priority: 'high' },
      });
      expect(outB).toEqual(outA);

      // The AgentSpec — including the outputSchema built from the declared `output_contract`, which is
      // what run-core validates the structured output against — is deep-equal across the two seams.
      const handed = scripted.specs.slice(specsBefore);
      expect(handed).toHaveLength(2);
      const [specA, specB] = handed;
      expect(specA).toEqual(specB);
      expect(specA?.outputSchema?.name).toBe('normalized_record');

      // The ledger halves match too, INCLUDING the structured `output` column and the `backend`
      // attribution. The two normalize runs are the only ones this database holds for this agent (the
      // booted arm's document declares no normalizer), and each comparison is scoped to ONE run id.
      const [normRunA, normRunB] = await runIdsForAgent('field_normalizer');
      expect(normRunA).toBeDefined();
      expect(normRunB).toBeDefined();
      expect(normRunA).not.toBe(normRunB);
      const normStepsA = await journalSteps(normRunA!);
      expect(normStepsA.length).toBeGreaterThan(0);
      expect(normStepsA.every((s) => s.backend === 'openai')).toBe(true);
      expect(await runHeader(normRunA!)).toEqual(await runHeader(normRunB!));
      expect(await journalSteps(normRunB!)).toEqual(normStepsA);

      // Replay: repeating each normalize ATTACHes to the completed header with no new model call.
      const calls = scripted.runCalls;
      expect(
        await deterministic(TENANT).normalize({
          record: HEAD_TO_HEAD_RECORD,
          recordId: 'rec-deterministic',
        }),
      ).toEqual(outA);
      expect(
        await factoryBuilt(TENANT).normalize({
          record: HEAD_TO_HEAD_RECORD,
          recordId: 'rec-factory',
        }),
      ).toEqual(outB);
      expect(scripted.runCalls).toBe(calls);
    }, 60_000);

    it('a pi-declared normalizer demanding NATIVE structured output fail-closes IDENTICALLY on both paths', () => {
      // The boot's fork-4 gate reads `capabilitiesFor(backend.id)`. Because the seam PINS the returned
      // Backend's id to the sidecar-declared backend, a factory cannot relabel its way past it — the
      // emulating backend is rejected at boot on the factory path exactly as on the injected path.
      const root = mkdtempSync(join(tmpdir(), 'parity-pi-normalizer-'));
      tmpDirs.push(root);
      mkdirSync(join(root, 'record'), { recursive: true });
      writeFileSync(
        join(root, 'record', 'field_normalizer.normalizer.json'),
        JSON.stringify({
          agent_id: 'field_normalizer',
          instructions: 'Normalize the submitted record.',
          model: 'pi-model',
          backend: 'pi',
        }),
      );
      const specPath = join(root, 'product.yaml');
      const spec = specOf(NORMALIZE_YAML);
      const decl = { agent: 'field_normalizer', output_contract: 'intake.normalized' };
      const piBackend = { id: 'pi' } as unknown as Backend;

      const messageOf = (fn: () => unknown): string => {
        try {
          fn();
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      };
      const injectedMessage = messageOf(() =>
        buildRecordNormalizer(
          { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
          specPath,
          spec,
          db!,
          { deterministicNormalizerBackend: piBackend },
          decl,
        ),
      );
      const liveEnv = { RAYSPEC_NORMALIZE_MODE: 'live' };
      const source = bindProductBackends(
        (ctx) => new Map(ctx.requirements.map((r) => [r, piBackend])),
        {
          env: liveEnv,
          specPath,
          spec,
          withConversationInput: false,
          normalizeAgentId: 'field_normalizer',
        },
      );
      const factoryMessage = messageOf(() =>
        buildRecordNormalizer(liveEnv, specPath, spec, db!, {}, decl, source),
      );
      expect(factoryMessage).toContain("normalizer 'field_normalizer'");
      expect(factoryMessage).toContain("but backend 'pi' only EMULATES it");
      expect(factoryMessage).toBe(injectedMessage);
    });
  },
);
