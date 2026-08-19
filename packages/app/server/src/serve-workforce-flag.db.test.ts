/**
 * The experimental `workforce:` opt-in at the `rayspec-serve` ENTRYPOINT.
 *
 * The CLI arms (doctor, plan, deploy --dry-run) are covered in-process by
 * `packages/app/cli/src/workforce-flag.test.ts`, and the parse gate's own message names serve
 * alongside them — but nothing exercised serve itself, and serve is the only entry point that
 * reaches the gate through `deployDeclaredSpec` rather than through a CLI command's own parse call.
 * Every arm of the CLI suite would stay green against a serve path that never threaded the flag.
 *
 * WHY A SPAWNED ENTRYPOINT (and a database). `serve.ts` guards on `isProcessEntrypoint()` and exits
 * the process, so it cannot be driven in-process; and its workforce gate sits inside the deploy
 * pipeline, AFTER the config load and the migration chain — so unlike the tracing suite next door
 * this one needs a real DATABASE_URL to reach the step under test at all.
 *
 * The two arms DISCRIMINATE rather than merely refusing: with the flag unset the boot stops at the
 * parse with the one typed code, and with the flag set the same spawn walks PAST the parse and
 * stops at the next gate (the workforce's task-tenant precondition). Without the second arm the
 * first would also pass against an entrypoint that refuses every boot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SECOND SUITE IN THIS FILE — THE EMERGENCY DISABLE, on a database that holds live work.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Everything above refuses against an EMPTY database, which proves the refusal and says nothing at
 * all about the promise the refusal is made in service of. Migrations are forward-only — there are no
 * down-migration files and no rollback claim anywhere (`docs/workforce-architecture.md` → "Upgrade
 * and rollback notes") — so the runtime has exactly ONE emergency lever, and this is it: unset
 * `RAYSPEC_EXPERIMENTAL_WORKFORCE`, the boot refuses
 * workforce authoring and dispatch, and the durable rows are PRESERVED UNTOUCHED. The flag is read
 * in exactly one place (`packages/kernel/spec/src/experimental.ts:9`) and enforced in exactly one
 * (`packages/kernel/spec/src/parse.ts:152`); nothing in `@rayspec/tasks` consults it — so nothing in
 * the engine could preserve or destroy anything on the flag's account, and nothing proved it did not.
 *
 * The second suite is that proof, and it is deliberately a SEQUENCE rather than an assertion:
 * a live flag-ON deployment → real workforce state written by the real engine writers → a clean
 * shutdown → a flag-OFF boot → a byte-level census comparison → a flag-ON boot again → the parked
 * work resuming on the CAS token it was parked with. The last step is the one that matters most:
 * rows can be present and still be useless, and only a resume that succeeds on the PRE-flag-off
 * version proves the data survived usefully rather than merely numerically.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forTenant, makeDb } from '@rayspec/db';
import {
  appendWorkforceEvents,
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  deliverSignal,
  type TaskRecord,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'serve-workforce-flag.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');
const SERVE = join(here, 'serve.ts');

/** The gate AFTER the one under test — reaching it proves the parse accepted the section. */
const NEXT_GATE = 'the spec declares a workforce but RAYSPEC_CRON_TENANT_ID is unset';

const WORKFORCE_YAML = `version: '1.0'
metadata:
  name: serve-workforce-flag
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

/** The same document with the section removed — the byte-identity control. */
const PLAIN_YAML = WORKFORCE_YAML.slice(0, WORKFORCE_YAML.indexOf('workforce:\n'));

function specPath(name: string, yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-serve-wf-'));
  const file = join(dir, name);
  writeFileSync(file, yaml, 'utf8');
  return file;
}

/**
 * Boot the shipped entrypoint with the three secrets and a database, but deliberately WITHOUT
 * `RAYSPEC_CRON_TENANT_ID` — the next gate along, which is what the accept control lands on. The
 * child runs with `RAYSPEC_SKIP_DOTENV=1` and a minimal environment so the repo-root `.env` cannot
 * hand it anything this test did not choose.
 */
function boot(
  specFile: string,
  flag?: string,
  opts: { readonly backendKey?: boolean } = {},
): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAYSPEC_SKIP_DOTENV: '1',
    RAYSPEC_SPEC_PATH: specFile,
    DATABASE_URL: process.env.DATABASE_URL,
    RAYSPEC_API_KEY_PEPPER: 'serve-flag-test-pepper',
    RAYSPEC_JWT_SIGNING_KEY: process.env.RAYSPEC_JWT_SIGNING_KEY,
  };
  if (opts.backendKey !== false) {
    // The declared agent's backend must be configured or the boot stops one gate EARLIER, before
    // the spec parse this suite is about. The key is never used: no boot here reaches a run.
    env.OPENAI_API_KEY = 'sk-not-a-real-key-no-call-is-made';
  }
  if (flag !== undefined) env.RAYSPEC_EXPERIMENTAL_WORKFORCE = flag;
  const r = spawnSync(TSX, [SERVE], { env, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe.skipIf(!hasDb)('rayspec-serve — the experimental workforce opt-in (db)', () => {
  it('refuses a workforce document with the ONE typed code when the flag is unset', () => {
    const { status, stderr } = boot(specPath('workforce.yaml', WORKFORCE_YAML));
    expect(status).toBe(1);
    expect(stderr).toContain('experimental_section_disabled');
    expect(stderr).toContain('"path": "workforce"');
    // Ordering, not just outcome: the boot stopped AT the parse, so it never reached the gate
    // the accept control below stops at.
    expect(stderr).not.toContain(NEXT_GATE);
  }, 240_000);

  it('walks past the parse when the flag is set — the accept control', () => {
    const { status, stderr } = boot(specPath('workforce.yaml', WORKFORCE_YAML), '1');
    expect(status).toBe(1);
    expect(stderr).toContain(NEXT_GATE);
    expect(stderr).not.toContain('experimental_section_disabled');
  }, 240_000);

  it('a document WITHOUT the section refuses identically with the flag set or unset', () => {
    // A workforce-free boot SUCCEEDS and then listens forever, so the arms are taken one gate
    // short of that: the declared agent's backend key is withheld, and both spawns must stop on
    // the same refusal — neither mentioning the parse gate nor the workforce gate. That is the
    // flag's no-op claim measured where it can actually be observed at this entry point.
    const off = boot(specPath('plain.yaml', PLAIN_YAML), undefined, { backendKey: false });
    const on = boot(specPath('plain.yaml', PLAIN_YAML), '1', { backendKey: false });
    expect(off.status).toBe(1);
    expect(off.stderr).toContain("select backend 'openai', which is not configured");
    expect(on.stderr).toBe(off.stderr);
    for (const { stderr } of [off, on]) {
      expect(stderr).not.toContain('experimental_section_disabled');
      expect(stderr).not.toContain(NEXT_GATE);
    }
  }, 240_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The emergency disable: flag-off preserves the durable rows
// ───────────────────────────────────────────────────────────────────────────────────────────────

const PRESERVE_DB = `rayspec_flag_off_preserve_${process.pid}`;
const PRESERVE_TENANT = '00000000-0000-4000-8000-0000000000f9';
const PRESERVE_PORT = '8849';
const WORKFORCE_ID = 'helpdesk';

/** The nine tables migration 0012 creates — the whole tenant task graph. */
const WORKFORCE_TABLES = [
  'workforce_tasks',
  'workforce_task_transitions',
  'workforce_task_signals',
  'workforce_delegations',
  'workforce_approvals',
  'workforce_reviews',
  'workforce_messages',
  'workforce_budget_ledger',
  'workforce_runtime',
] as const;

/** A full deployment: a durable worker (the dispatcher's precondition) and a declared workforce. */
const LIVE_WORKFORCE_YAML = `version: '1.0'
metadata:
  name: flag-off-preservation
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: ${WORKFORCE_ID}
  name: Helpdesk
  orchestrator: lead
  budgets:
    workforce:
      usd: 40
    task:
      usd: 2.5
      turns: 12
  execution:
    maxTaskWallClock: 45m
  departments:
    - id: eng
      name: Engineering
      manager: mgr
      mission: Own the fixes.
      members: [dev]
      budgets:
        usd: 10
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
    - id: mgr
      agent: lead_agent
      title: Manager
      role: manager
      department: eng
      reportsTo: lead
    - id: dev
      agent: lead_agent
      title: Developer
      role: worker
      department: eng
`;

/** Per-table `count(*)` plus an md5 over the ORDERED full row text — "unchanged" means byte-equal. */
interface Census {
  readonly counts: Record<string, number>;
  readonly digests: Record<string, string>;
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

describe.skipIf(!hasDb)(
  'rayspec-serve — the emergency disable preserves live workforce rows (db)',
  () => {
    let dbUrl = '';
    let db: ReturnType<typeof makeDb> | undefined;
    let specFile = '';
    let jwtKey = '';
    let liveCensus: Census | undefined;
    /** The clarification-parked task, and the version it was parked at BEFORE the flag-off boot. */
    let parked: TaskRecord | undefined;
    let parkedVersion = -1;
    let armsRan = 0;

    beforeAll(async () => {
      if (!hasDb) return;
      const base = process.env.DATABASE_URL as string;
      dbUrl = withDbName(base, PRESERVE_DB);
      const admin = postgres(adminUrl(base), { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${PRESERVE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${PRESERVE_DB}" WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE "${PRESERVE_DB}"`);
      } finally {
        await admin.end();
      }
      // The tenant row must exist before the boot: `ensureDeclaredWorkforceRuntime` inserts into
      // `workforce_runtime`, whose only FK is `tenant_id -> orgs(id)`. Provisioning an org against a
      // migrated database ahead of the deployment is the shipped operator order (`provisionTenant`).
      db = makeDb(dbUrl, 2);
      await applyMigrations(db);
      await db.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ('${PRESERVE_TENANT}', 'FlagOff', 'flagoff')`,
      );
      specFile = specPath('live-workforce.yaml', LIVE_WORKFORCE_YAML);
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      jwtKey = await exportPKCS8(privateKey);
    }, 240_000);

    afterAll(async () => {
      await db?.$client.end();
      if (!hasDb) return;
      const admin = postgres(adminUrl(process.env.DATABASE_URL as string), {
        max: 1,
        onnotice: () => {},
      });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${PRESERVE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${PRESERVE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }, 120_000);

    function liveEnv(flag: boolean): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RAYSPEC_SKIP_DOTENV: '1',
        RAYSPEC_SPEC_PATH: specFile,
        DATABASE_URL: dbUrl,
        RAYSPEC_API_KEY_PEPPER: 'flag-off-preserve-pepper',
        RAYSPEC_JWT_SIGNING_KEY: jwtKey,
        OPENAI_API_KEY: 'sk-not-a-real-key-no-call-is-made',
        RAYSPEC_CRON_TENANT_ID: PRESERVE_TENANT,
        PORT: PRESERVE_PORT,
      };
      if (flag) env.RAYSPEC_EXPERIMENTAL_WORKFORCE = '1';
      return env;
    }

    /**
     * Boot the shipped entrypoint WITH the flag, wait until it is genuinely serving, then SIGTERM it
     * and wait for a clean exit.
     *
     * TWO readiness signals, both required, and each is load-bearing for a different reason.
     *
     *   1. `workforce_runtime.budgets.declaredAt` — written by exactly one caller
     *      (`ensureDeclaredWorkforceRuntime`, wired at composition-root.ts:3324-3331 behind the
     *      durable-worker + task-tenant preconditions), so its appearance means this boot got all the
     *      way through deploy and wired the dispatcher. This is the fact that makes the boot a LIVE
     *      workforce deployment rather than merely a process. It is read off the DATABASE rather than
     *      off a banner line so the suite is not coupled to boot copy other work is editing.
     *   2. `GET /health` answering 200 — the process is listening. This used to be load-bearing for a
     *      reason that has since been FIXED, and the reason is worth keeping: a SIGTERM sent after (1)
     *      but before (2) was not honoured at all (on the certification host that boot ran a further
     *      415 s, and only a second signal after it was listening ended it, in 50 ms, exit 0). The
     *      swallower was never DBOS: `@openai/agents-core`'s trace provider and `signal-exit` both
     *      register SIGTERM handlers at import time, and each exits/re-raises ONLY when it is the sole
     *      listener — so with both loaded and no handler of the entrypoint's own, the signal was a
     *      no-op. `serve.ts` now installs its own handlers as the first statement of `main()`, ahead
     *      of the awaited assemble, and `serve-boot-signal.test.ts` pins that directly by signalling a
     *      mid-boot process. Waiting for (2) here is now belt-and-braces: this arm is about the
     *      SERVING shutdown, so it should still signal a serving process.
     *
     * The SIGKILL fallback exists so a hang is reported as a failed assertion on the exit code rather
     * than as a suite that never returns, and so a stuck server is never left behind for the next arm.
     */
    async function bootLiveAndShutDown(): Promise<{ code: number | null; output: string }> {
      // `node --import tsx <file>` and NOT the `tsx` bin: the bin is a wrapper process that does not
      // forward SIGTERM to the node process it spawns, so `child.kill()` would signal the wrapper and
      // leave the server running.
      const child = spawn(process.execPath, ['--import', 'tsx', SERVE], { env: liveEnv(true) });
      let output = '';
      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      let exited: number | null | undefined;
      child.on('exit', (code) => {
        exited = code;
      });
      const fail = async (what: string): Promise<never> => {
        if (exited === undefined) child.kill('SIGKILL');
        throw new Error(`${what} (exit=${String(exited)}):\n${output.slice(-4000)}`);
      };

      const markerDeadline = Date.now() + 180_000;
      let marker: string | null = null;
      while (Date.now() < markerDeadline && exited === undefined) {
        await new Promise((r) => setTimeout(r, 500));
        const rows = (await (db as ReturnType<typeof makeDb>).$client.unsafe(
          `SELECT budgets->>'declaredAt' AS m FROM workforce_runtime WHERE workforce_id = '${WORKFORCE_ID}'`,
        )) as unknown as { m: string | null }[];
        if (rows[0]?.m) {
          marker = rows[0].m;
          break;
        }
      }
      if (marker === null)
        await fail('the flag-ON boot never stamped the workforce declaration marker');

      const listenDeadline = Date.now() + 120_000;
      let serving = false;
      while (Date.now() < listenDeadline && exited === undefined) {
        try {
          const res = await fetch(`http://127.0.0.1:${PRESERVE_PORT}/health`);
          if (res.ok) {
            serving = true;
            break;
          }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!serving) await fail('the flag-ON boot never started serving');

      child.kill('SIGTERM');
      const code = await Promise.race([
        new Promise<number | null>((resolve) => {
          child.on('exit', (c) => resolve(c));
        }),
        new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 60_000)),
      ]);
      if (code === -1) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.on('exit', resolve));
      }
      return { code, output };
    }

    /** The closed-world snapshot: nine tables plus BOTH `run_events` namespaces. */
    async function census(): Promise<Census> {
      const client = (db as ReturnType<typeof makeDb>).$client;
      const counts: Record<string, number> = {};
      const digests: Record<string, string> = {};
      for (const table of WORKFORCE_TABLES) {
        const rows = (await client.unsafe(
          `SELECT count(*)::int AS c,
                  md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d
             FROM ${table} t WHERE t.tenant_id = '${PRESERVE_TENANT}'`,
        )) as unknown as { c: number; d: string }[];
        counts[table] = rows[0]?.c ?? -1;
        digests[table] = rows[0]?.d ?? '';
      }
      // The journal, split by the two run_id namespaces the engine writes under
      // (`<taskId>` for task events, `workforce:<id>` for control events — events.ts:97).
      for (const [key, predicate] of [
        ['run_events.task', "run_id NOT LIKE 'workforce:%'"],
        ['run_events.workforce', "run_id LIKE 'workforce:%'"],
      ] as const) {
        const rows = (await client.unsafe(
          `SELECT count(*)::int AS c,
                  md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d
             FROM run_events t WHERE t.tenant_id = '${PRESERVE_TENANT}' AND ${predicate}`,
        )) as unknown as { c: number; d: string }[];
        counts[key] = rows[0]?.c ?? -1;
        digests[key] = rows[0]?.d ?? '';
      }
      return { counts, digests };
    }

    it('phase 1+2 — a live flag-ON deployment, real workforce state, and a clean shutdown', async () => {
      const first = await bootLiveAndShutDown();
      expect(first.code).toBe(0); // a graceful shutdown, not a crash: the rows below are a survivor's.

      // Everything below is written by the SHIPPED engine writers, never by hand-rolled INSERTs —
      // a preservation proof over rows the engine would never produce proves nothing about the engine.
      const tdb = forTenant(db as ReturnType<typeof makeDb>, PRESERVE_TENANT);
      const budgets = workforceBudgetsSchema.parse({
        workforce: { usd: 40 },
        task: { usd: 2.5, turns: 12 },
        departments: { eng: { usd: 10 } },
        execution: { estimateUsdPerTurn: 0.2 },
      });
      const RESULT = { status: 'completed', summary: 'Done.', confidence: 0.9 };
      const turnIdFor = (taskId: string, n: number) => `wf-task-turn:${taskId}:${n}`;

      const newRoot = (over: Record<string, unknown>) =>
        createRootTask(tdb, {
          workforceId: WORKFORCE_ID,
          title: 'Work',
          goal: 'Do it',
          owner: 'dev',
          requestedBy: 'user',
          department: 'eng',
          ...over,
        });
      const toWorking = async (task: TaskRecord, n = 1) => {
        const queued = await applyTransition(tdb, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'queued',
          actor: 'scheduler',
        });
        return applyTransition(tdb, {
          taskId: task.taskId,
          expectedVersion: queued.version,
          to: 'working',
          actor: 'scheduler',
          turnId: turnIdFor(task.taskId, n),
        });
      };
      const turn = (taskId: string, n: number, intent: unknown, extra: object = {}) =>
        applyTurnOutcome(tdb, {
          taskId,
          turnId: turnIdFor(taskId, n),
          turnNumber: n,
          intent,
          budgets,
          actualUsd: 0.05,
          ...extra,
        });

      // A completed task, carrying a task-scoped message.
      const done = await newRoot({ title: 'Closed work' });
      await toWorking(done);
      const doneOut = await turn(
        done.taskId,
        1,
        { kind: 'complete', result: RESULT },
        { messages: [{ recipient: 'lead', body: 'Closing out.' }] },
      );
      expect(doneOut.task?.status).toBe('completed');

      // A task parked on an APPROVAL — the approval row is the one an operator would come back to.
      const approval = await newRoot({ title: 'Approval park' });
      await toWorking(approval);
      const approvalOut = await turn(approval.taskId, 1, {
        kind: 'request_approval',
        question: 'Ship the fix to production?',
        options: ['yes', 'no'],
        approver: 'user',
        timeoutMs: 3_600_000,
        onTimeout: 'fail',
      });
      expect(approvalOut.task?.statusReason).toBe('approval_pending');

      // A fan-out: a STRUCTURAL park on the join, two child tasks and a delegation record.
      const fan = await newRoot({ title: 'Fan out', owner: 'lead' });
      await toWorking(fan);
      const fanOut = await turn(fan.taskId, 1, {
        kind: 'fan_out',
        children: [
          { title: 'Part one', goal: 'Do part one.', owner: 'dev', delegatedTo: 'department:eng' },
          { title: 'Part two', goal: 'Do part two.', owner: 'mgr' },
        ],
      });
      expect(fanOut.task?.statusReason).toBe('awaiting_children');

      // A review park.
      const review = await newRoot({ title: 'Under review' });
      await toWorking(review);
      const reviewOut = await turn(review.taskId, 1, { kind: 'request_review', reviewer: 'mgr' });
      expect(reviewOut.task?.status).toBe('waiting_for_review');

      // THE RESUME SUBJECT: a clarification park. Its exit is a `user_reply` operator signal, so the
      // resume in phase 5 runs entirely through the shipped signal + transition doors.
      const clarify = await newRoot({ title: 'Clarification park' });
      await toWorking(clarify);
      const clarifyOut = await turn(clarify.taskId, 1, {
        kind: 'request_clarification',
        question: 'Which quarter does the report cover?',
      });
      expect(clarifyOut.task?.statusReason).toBe('clarification_pending');
      parked = clarifyOut.task as TaskRecord;
      parkedVersion = (clarifyOut.task as TaskRecord).version;

      // A failed task — the third terminal shape.
      const failed = await newRoot({ title: 'Failed work' });
      await toWorking(failed);
      const failedOut = await turn(failed.taskId, 1, {
        kind: 'fail',
        message: 'The upstream API is gone.',
      });
      expect(failedOut.task?.status).toBe('failed');

      // An UNCONSUMED operator signal, and a journal event in the workforce CONTROL namespace.
      await deliverSignal(tdb, {
        taskId: fan.taskId,
        kind: 'manual_unblock',
        signalKey: 'operator-unblock-1',
        actor: 'user',
      });
      await appendWorkforceEvents(tdb, WORKFORCE_ID, [
        { type: 'workforce.paused', payload: { by: 'user' } },
      ]);

      liveCensus = await census();
      // ANTI-VACUITY. A census of eleven zeroes (the nine tables plus the two journal namespaces)
      // would compare equal after the flag-off boot and prove nothing whatsoever, so every table and
      // BOTH journal namespaces must carry rows first.
      for (const [key, count] of Object.entries(liveCensus.counts)) {
        expect(
          count,
          `${key} was never seeded — the preservation oracle would be vacuous`,
        ).toBeGreaterThan(0);
      }
      // …and the graph really is in several shapes, including three distinct parks.
      const shapes = (await (db as ReturnType<typeof makeDb>).$client.unsafe(
        `SELECT DISTINCT status, coalesce(status_reason, '') AS reason FROM workforce_tasks
          WHERE tenant_id = '${PRESERVE_TENANT}' ORDER BY 1, 2`,
      )) as unknown as { status: string; reason: string }[];
      expect(shapes.map((s) => `${s.status}(${s.reason})`)).toEqual([
        'blocked(awaiting_children)',
        'blocked(clarification_pending)',
        'completed()',
        'failed()',
        'planned()',
        'waiting_for_review(review_pending)',
        'waiting_for_user(approval_pending)',
      ]);
      armsRan += 1;
    }, 400_000);

    it('phase 3+4 — the flag-OFF boot refuses at the parse and every durable row is byte-identical', async () => {
      expect(liveCensus, 'phase 1+2 did not run').toBeDefined();
      const refused = spawnSync(TSX, [SERVE], {
        env: liveEnv(false),
        encoding: 'utf8',
        timeout: 300_000,
      });

      // The refusal itself, on a database that is anything but empty.
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('experimental_section_disabled');
      expect(refused.stderr).toContain('"path": "workforce"');
      // Ordering, not just outcome: it stopped AT the parse, so nothing downstream of it ran. The
      // banner is the first thing a successful boot prints, and this boot never printed one.
      expect(refused.stdout).not.toContain('Declared agents');

      // THE ORACLE. Byte-for-byte, not merely equinumerous: the digest is an md5 over the ordered
      // full row text of every column, so a rewritten timestamp or a re-numbered seq fails it.
      const after = await census();
      expect(after).toEqual(liveCensus);
      // Stated separately as well, because "no table was truncated" is the sentence the emergency
      // lever actually promises, and a reader should not have to derive it from a deep-equal.
      for (const table of WORKFORCE_TABLES) {
        expect(after.counts[table], `${table} lost rows across the flag-off boot`).toBe(
          (liveCensus as Census).counts[table],
        );
      }
      expect(after.counts['run_events.task']).toBe(
        (liveCensus as Census).counts['run_events.task'],
      );
      expect(after.counts['run_events.workforce']).toBe(
        (liveCensus as Census).counts['run_events.workforce'],
      );
      armsRan += 1;
    }, 400_000);

    it('phase 5 — re-enabling the flag boots again and the parked work resumes on its PRESERVED token', async () => {
      expect(parked, 'phase 1+2 did not run').toBeDefined();
      const again = await bootLiveAndShutDown();
      expect(again.code).toBe(0);
      // The boot walked the redeploy gate over the preserved rows and agreed the document still
      // carries every declaration they reference — a removed employee would have refused here.

      const task = parked as TaskRecord;
      const tdb = forTenant(db as ReturnType<typeof makeDb>, PRESERVE_TENANT);
      // The park is still the park it was, at the version it was parked at.
      const before = (await (db as ReturnType<typeof makeDb>).$client.unsafe(
        `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${task.taskId}'`,
      )) as unknown as { status: string; status_reason: string; version: number }[];
      expect(before[0]?.status).toBe('blocked');
      expect(before[0]?.status_reason).toBe('clarification_pending');
      expect(Number(before[0]?.version)).toBe(parkedVersion);

      // The exit the park declares: the requester's reply. It wakes the task to `queued`.
      const wake = await deliverSignal(tdb, {
        taskId: task.taskId,
        kind: 'user_reply',
        signalKey: 'operator-reply-1',
        actor: 'user',
        payload: { body: 'Q3 2026.' },
      });
      expect(wake).toEqual({ delivered: true, woke: true });

      // THE CAS PROOF. The claim presents `parkedVersion + 1` — computed from the version recorded
      // BEFORE the flag-off boot plus the one bump the wake makes — instead of re-reading the row.
      // Any write the flag-off boot had made to this task would have moved the version and this
      // compare-and-swap would throw instead of claiming the turn.
      const claimed = await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: parkedVersion + 1,
        to: 'working',
        actor: 'scheduler',
        turnId: `wf-task-turn:${task.taskId}:2`,
      });
      expect(claimed.status).toBe('working');

      // And the work actually finishes: a second turn applies over the preserved row and completes it.
      const resumed = await applyTurnOutcome(tdb, {
        taskId: task.taskId,
        turnId: `wf-task-turn:${task.taskId}:2`,
        turnNumber: 2,
        intent: {
          kind: 'complete',
          result: { status: 'completed', summary: 'Q3.', confidence: 1 },
        },
        budgets: workforceBudgetsSchema.parse({
          task: { usd: 2.5, turns: 12 },
          execution: { estimateUsdPerTurn: 0.2 },
        }),
        actualUsd: 0.02,
      });
      expect(resumed.task?.status).toBe('completed');
      expect(resumed.plan?.kind).toBe('complete');
      armsRan += 1;
    }, 400_000);

    it('ran-guard: all three phases ran (a required DB run may not silently skip)', () => {
      expect(armsRan).toBe(3);
    });
  },
);
