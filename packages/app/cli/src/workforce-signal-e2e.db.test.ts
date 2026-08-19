/**
 * THE OPERATOR TRAP, reproduced on a real database, and its release through the real CLI.
 *
 * A live acceptance run found this: a review that spends its declared round budget parks its task
 * in `waiting_for_user` with `status_reason = NULL` and writes **no approval row** (@rayspec/tasks
 * apply-intents.ts, case `review_rounds_exhausted` — the transition passes no `reason`). So
 * `rayspec workforce approvals list`, the documented inbox, shows the operator NOTHING, while a
 * task sits waiting on a human forever. The HTTP route that releases it has always existed; the
 * console had no verb for it.
 *
 * Everything here is real: a real Postgres database provisioned through the committed migration
 * chain (`rayspec tenant ensure`), a real composed server in its own process, a real API key minted
 * through the mint route, the park built by the engine's OWN review path (`applyTurnOutcome` under
 * a `maxRounds` policy, then `applyReviewVerdict` with a reject — never a hand-written row), and
 * the release taken by the real `runWorkforce` over real HTTP.
 *
 * DETERMINISM: the workforce is PAUSED before the park is built, so the live dispatcher never
 * races the story. That is sound rather than convenient — `deliverSignal` records the signal row
 * and takes the wake transition with no reference to the control state (signals.ts), so pausing
 * removes the dispatcher without touching the mechanism under test. Every assertion afterwards is
 * on DURABLE artifacts: the signal row, the transition row, and the task row.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forTenant, makeDb } from '@rayspec/db';
import {
  applyReviewVerdict,
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkforce, WorkforceCliError } from './workforce.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const BOOT_SCRIPT = join(here, 'test-support/workforce-signal-e2e-serve.ts');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
/** Bumped at the story's LAST line — the ran-guard below counts completed arms, so an `it.skip`
 * (or a story that never reached its end) fails the required run instead of passing silently. */
let storyArmsRan = 0;
if (dbRequired && !baseUrl) {
  throw new Error(
    'workforce-signal-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the signal-release story.',
  );
}

const PID = process.pid;
const E2E_DB = `rayspec_cli_wf_signal_e2e_${PID}`;
const TENANT = '00000000-0000-4000-8000-0000000000e7';
const PORT = 20300 + (PID % 40);
const PEPPER = 'workforce-signal-e2e-pepper-not-a-real-secret';
const PASSWORD = 'a-long-enough-password';
const WORKFORCE_ID = 'wf';
const OWNER = 'analyst';
const REVIEWER = 'qa';

const NO_BUDGETS = workforceBudgetsSchema.parse({});

const SPEC = `version: '1.0'
metadata:
  name: workforce-signal-release
  description: An agent-free backend whose durable worker carries the task engine.
deployment:
  durableWorker: true
`;

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

let workDir = '';
let pem = '';
let e2eUrl = '';
let inviteToken = '';
let sql: ReturnType<typeof postgres> | undefined;
let engineDb: ReturnType<typeof makeDb> | undefined;
let child: ChildProcess | undefined;
let childStderr = '';

function bootServer(port: number): ChildProcess {
  const proc = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAYSPEC_SKIP_DOTENV: '1',
      DATABASE_URL: e2eUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: PEPPER,
      RAYSPEC_SPEC_PATH: join(workDir, 'rayspec.yaml'),
      RAYSPEC_CRON_TENANT_ID: TENANT,
      ALLOWED_ORIGINS: '',
      PORT: String(port),
    },
  });
  proc.stderr?.on('data', (d) => {
    childStderr += String(d);
  });
  proc.stdout?.on('data', () => {});
  return proc;
}

async function waitForBoot(port: number, proc: ChildProcess, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(
        `server subprocess exited early (code ${proc.exitCode})\n--- stderr ---\n${childStderr}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready\n--- stderr ---\n${childStderr}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!baseUrl)('the signal-parked task an operator could not release', () => {
  beforeAll(async () => {
    const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}"`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}_dbos_sys"`);
      await admin.unsafe(`CREATE DATABASE "${E2E_DB}"`);
    } finally {
      await admin.end();
    }
    e2eUrl = withDbName(baseUrl as string, E2E_DB);
    sql = postgres(e2eUrl, { max: 2 });

    workDir = mkdtempSync(join(tmpdir(), 'rayspec-wf-signal-e2e-'));
    writeFileSync(join(workDir, 'rayspec.yaml'), SPEC);
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(privateKey);

    // The REAL provisioning path: `tenant ensure` applies the committed migration chain and mints
    // the owner invite (mode-600 file; the token is printed nowhere).
    const invitePath = join(workDir, 'owner-invite.txt');
    const ensure = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        'tenant',
        'ensure',
        '--org-id',
        TENANT,
        '--name',
        'Signal Release Org',
        '--owner-email',
        'signal-e2e-owner@example.test',
        '--owner-invite-out',
        invitePath,
      ],
      {
        env: {
          ...process.env,
          RAYSPEC_SKIP_DOTENV: '1',
          DATABASE_URL: e2eUrl,
          RAYSPEC_API_KEY_PEPPER: PEPPER,
        },
        encoding: 'utf8',
      },
    );
    if (ensure.status !== 0) {
      throw new Error(`tenant ensure failed (${ensure.status}): ${ensure.stdout} ${ensure.stderr}`);
    }
    inviteToken = readFileSync(invitePath, 'utf8').trim();
    expect(inviteToken.length).toBeGreaterThan(10);

    engineDb = makeDb(e2eUrl);
  }, 120_000);

  afterAll(async () => {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await engineDb?.$client.end();
    await sql?.end();
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}_dbos_sys" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  it('is invisible in the approvals inbox, and the CLI releases it', async () => {
    child = bootServer(PORT);
    await waitForBoot(PORT, child);
    const base = `http://127.0.0.1:${PORT}`;

    // Operator account via the invite flow; the accept mints an org-bound token.
    const accept = await fetch(`${base}/v1/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
    });
    expect([200, 201]).toContain(accept.status);
    const accessToken = ((await accept.json()) as { accessToken: string }).accessToken;

    const mint = await fetch(`${base}/v1/orgs/${TENANT}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        name: 'workforce-signal-e2e',
        scopes: ['store:read', 'store:write'],
      }),
    });
    expect(mint.status).toBe(201);
    const apiKey = ((await mint.json()) as { plaintext: string }).plaintext;
    const FLAGS = ['--url', base, '--api-key', apiKey];

    // ── pause, so the live dispatcher never races the story (see the header) ──────────────────
    const paused = await runWorkforce(['pause', '--workforce', WORKFORCE_ID, ...FLAGS]);
    expect(paused.ok, `pause refused: ${JSON.stringify(paused)}`).toBe(true);

    // ── build the park through the engine's OWN review path, never by hand ────────────────────
    const tdb = forTenant(engineDb as ReturnType<typeof makeDb>, TENANT);
    const root = await createRootTask(tdb, {
      workforceId: WORKFORCE_ID,
      title: 'Produce the quarterly analysis',
      goal: 'Analyse the quarter and write it up.',
      owner: OWNER,
      requestedBy: 'user',
    });
    const turnId = `wf-task-turn:${root.taskId}:1`;
    const queued = await applyTransition(tdb, {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb, {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId,
    });
    // A low-confidence completion under a ONE-ROUND policy: the policy intercepts it, stores the
    // result, and parks the task for review on round 1.
    const reviewed = await applyTurnOutcome(tdb, {
      taskId: root.taskId,
      turnId,
      turnNumber: 1,
      intent: {
        kind: 'complete',
        result: { status: 'completed', summary: 'A first pass.', confidence: 0.6 },
      },
      reviewPolicy: { reviewer: REVIEWER, dispatchReviewer: false, maxRounds: 1 },
      budgets: NO_BUDGETS,
    });
    expect(reviewed.task?.status).toBe('waiting_for_review');

    const reviewRows = (await (sql as ReturnType<typeof postgres>)`
      SELECT id FROM workforce_reviews WHERE task_id = ${root.taskId} AND round = 1`) as unknown as {
      id: string;
    }[];
    expect(reviewRows).toHaveLength(1);

    // The reject spends the one declared round. There is no second round to run, so the engine
    // parks the task for a HUMAN — this is the park under test.
    const decided = await applyReviewVerdict(tdb, NO_BUDGETS, {
      reviewId: (reviewRows[0] as { id: string }).id,
      verdict: 'reject',
      reasons: ['thin evidence'],
      requiredChanges: ['add the measurements'],
      actor: REVIEWER,
    });
    expect(decided.status).toBe('waiting_for_user');

    // ── THE TRAP, part 1: the park's shape on the row ─────────────────────────────────────────
    const parkedRows = (await (sql as ReturnType<typeof postgres>)`
      SELECT status, status_reason FROM workforce_tasks WHERE task_id = ${root.taskId}`) as unknown as {
      status: string;
      status_reason: string | null;
    }[];
    expect(parkedRows[0]?.status).toBe('waiting_for_user');
    expect(parkedRows[0]?.status_reason, 'the park carries a reason after all').toBeNull();

    // ── THE TRAP, part 2: there is no approval row, so the inbox structurally cannot show it ──
    const approvalRows = (await (sql as ReturnType<typeof postgres>)`
      SELECT count(*)::int AS c FROM workforce_approvals WHERE task_id = ${root.taskId}`) as unknown as {
      c: number;
    }[];
    expect(approvalRows[0]?.c, 'the park wrote an approval row after all').toBe(0);

    // ── THE TRAP, part 3: the documented inbox is empty — and now SAYS SO ─────────────────────
    const inbox = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(inbox.ok).toBe(true);
    expect(inbox.approvals, 'the inbox found an approval that does not exist').toEqual([]);
    // The half of the fix that makes the verb findable: the console that has nothing to decide now
    // names what IS waiting, and the command that releases it.
    expect(inbox.signalParked).toEqual([
      {
        taskId: root.taskId,
        title: 'Produce the quarterly analysis',
        owner: OWNER,
        workforceId: WORKFORCE_ID,
        release: `rayspec workforce signal ${root.taskId} --kind user_reply`,
      },
    ]);

    // ── THE RELEASE, through the real CLI over real HTTP ──────────────────────────────────────
    const released = await runWorkforce([
      'signal',
      root.taskId,
      '--kind',
      'user_reply',
      '--payload',
      '{"decision":"ship it"}',
      '--signal-key',
      'op-release-1',
      ...FLAGS,
    ]);
    expect(released.ok, `signal refused: ${JSON.stringify(released)}`).toBe(true);
    expect(released.command).toBe('workforce signal');
    expect(released.result).toEqual({ delivered: true, woke: true });

    // The durable artifacts, not a transient status: the signal row the operator's key wrote, and
    // the transition OUT of the park.
    const signalRows = (await (sql as ReturnType<typeof postgres>)`
      SELECT kind, signal_key, payload, consumed_at FROM workforce_task_signals
      WHERE task_id = ${root.taskId}`) as unknown as {
      kind: string;
      signal_key: string;
      payload: Record<string, unknown>;
      consumed_at: Date | null;
    }[];
    expect(signalRows).toHaveLength(1);
    expect(signalRows[0]?.kind).toBe('user_reply');
    expect(signalRows[0]?.signal_key, '--signal-key never reached the engine').toBe('op-release-1');
    expect(signalRows[0]?.payload, '--payload never reached the engine').toEqual({
      decision: 'ship it',
    });
    expect(signalRows[0]?.consumed_at, 'the signal was recorded but never consumed').not.toBeNull();

    const wake = (await (sql as ReturnType<typeof postgres>)`
      SELECT from_status, to_status FROM workforce_task_transitions
      WHERE task_id = ${root.taskId} AND from_status = 'waiting_for_user'`) as unknown as {
      from_status: string;
      to_status: string;
    }[];
    expect(wake, 'the park was never left').toHaveLength(1);
    expect(wake[0]?.to_status).toBe('queued');

    const after = (await (sql as ReturnType<typeof postgres>)`
      SELECT status FROM workforce_tasks WHERE task_id = ${root.taskId}`) as unknown as {
      status: string;
    }[];
    expect(after[0]?.status).toBe('queued');

    // ── the re-send collapses: the idempotency key is the engine's, not a CLI invention ───────
    const resent = await runWorkforce([
      'signal',
      root.taskId,
      '--kind',
      'user_reply',
      '--signal-key',
      'op-release-1',
      ...FLAGS,
    ]);
    expect(resent.ok).toBe(true);
    expect(resent.result).toEqual({ delivered: false, woke: false });
    const afterResend = (await (sql as ReturnType<typeof postgres>)`
      SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = ${root.taskId}`) as unknown as {
      c: number;
    }[];
    expect(afterResend[0]?.c, 'the re-send wrote a second signal row').toBe(1);

    // ── the structural park stays structural: the CLI opened no new door ──────────────────────
    // `awaiting_children` is a fan-out join, whose exit is a child task's terminal. The route
    // refuses to dissolve it (invariant 4.10) and the CLI relays that refusal rather than
    // softening it — proof the verb is a typed client of the existing door, not a bypass.
    const versionRows = (await (sql as ReturnType<typeof postgres>)`
      SELECT version FROM workforce_tasks WHERE task_id = ${root.taskId}`) as unknown as {
      version: number;
    }[];
    const blocked = await applyTransition(tdb, {
      taskId: root.taskId,
      expectedVersion: (versionRows[0] as { version: number }).version,
      to: 'blocked',
      reason: 'awaiting_children',
      actor: 'scheduler',
    });
    expect(blocked.statusReason).toBe('awaiting_children');
    const refused = await runWorkforce([
      'signal',
      root.taskId,
      '--kind',
      'manual_unblock',
      '--signal-key',
      'op-structural-1',
      ...FLAGS,
    ]);
    // Delivered as a row, but it does NOT wake the join — the park is answered by the child's
    // terminal and by nothing else.
    expect(refused.ok).toBe(true);
    expect(refused.result).toEqual({ delivered: true, woke: false });
    const stillBlocked = (await (sql as ReturnType<typeof postgres>)`
      SELECT status, status_reason FROM workforce_tasks WHERE task_id = ${root.taskId}`) as unknown as {
      status: string;
      status_reason: string | null;
    }[];
    expect(stillBlocked[0]?.status, 'an operator signal dissolved a structural park').toBe(
      'blocked',
    );
    expect(stillBlocked[0]?.status_reason).toBe('awaiting_children');

    storyArmsRan++;
  }, 180_000);

  it('a mechanism signal kind is refused as usage, and never reaches the deployment', async () => {
    // The CLI's closed-set check only NARROWS what the route accepts. Asserted against a REAL
    // deployment so the refusal is provably local: nothing was posted for the server to reject.
    await expect(
      runWorkforce([
        'signal',
        '00000000-0000-4000-8000-000000000001',
        '--kind',
        'child_completed',
        '--url',
        `http://127.0.0.1:${PORT}`,
        '--api-key',
        'rk_never_used.secret',
      ]),
    ).rejects.toBeInstanceOf(WorkforceCliError);
    storyArmsRan++;
  });
});

it('the signal-release story ran when the DB is required (CI / opt-in)', () => {
  if (!dbRequired) return;
  expect(storyArmsRan, 'the DB was required but the signal-release story did not run').toBe(2);
});
