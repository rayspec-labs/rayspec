/**
 * THE ACCEPTANCE STORY — the shipped starter example (`examples/workforce-starter/rayspec.yaml`,
 * deployed byte-for-byte, never a fixture twin) driven end to end with a REAL process death in
 * the middle and every assertion on durable artifacts or real command output:
 *
 *   the goal is POSTed to the production intake route → the orchestrator's turn classifies and
 *   fans out to the engineering TEAM (`team:release_crew`) and the growth department in one call
 *   (the classification 'team', journaled from the typed intent) → the team resolves to its lead,
 *   which splits the work across the team's members → the principal's low-confidence submission
 *   trips the declared review policy → the reviewer REJECTS round 1 → the rework resubmits →
 *   accepted round 2 → the copywriter drafts the announcement and the GROWTH MANAGER (the seat
 *   holding both the public_statement label and the request_approval tool) hits the declared
 *   approval — the growth stream parks in waiting_for_user → the server is SIGKILLED here, at a
 *   QUIESCENT PARK (nothing is mid-turn — a wait is a row), and a fresh process boots on the same
 *   database, where the reboot ORACLE (each task's status, version, transition count and turn-start
 *   count — not a whole-row byte compare, which timestamps would defeat) is identical across the
 *   kill → the approval is decided through the REAL CLI → the orchestrator wakes with its
 *   children's results KEYED BY ID and submits a synthesis that is a pure function of those ids →
 *   `rayspec workforce tasks --tree` renders the whole story from the DURABLE `workforce_tasks`
 *   rows (the engine's own projection — not "the journal alone"), byte-exact, costs included. The
 *   byte-exactness rests on a DETERMINISTIC sibling order (createdAt, title, taskId): the random
 *   task-id hashes never leak into the render, so a parallel fan-out reads the same every run.
 *
 * THE POLLS ASSERT NOTHING. Every fact a `waitUntil` predicate mentions is re-asserted
 * afterwards, and the waits fail FAST with the task table on a story that already cannot finish.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const CLI_DIST = join(repoRoot, 'packages', 'app', 'cli', 'dist', 'index.js');
const BOOT_SCRIPT = join(here, 'test-support/workforce-story-e2e-serve.ts');
const STARTER_SPEC = join(repoRoot, 'examples', 'workforce-starter', 'rayspec.yaml');

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
/** Bumped at the story's LAST line — the ran-guard below fails a required run that skipped it. */
let storyArmsRan = 0;
if (dbRequired && !baseUrl) {
  throw new Error(
    'workforce-story-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the acceptance story.',
  );
}

const PID = process.pid;
const E2E_DB = `rayspec_cli_workforce_story_e2e_${PID}`;
const TENANT = '00000000-0000-4000-8000-0000000000e4';
const PORT1 = 20200 + (PID % 40);
const PORT2 = PORT1 + 40;
const PEPPER = 'workforce-story-e2e-pepper-not-a-real-secret';
const PASSWORD = 'a-long-enough-password';

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
let sql: ReturnType<typeof postgres> | undefined;
const children: ChildProcess[] = [];
const stderrByPid = new Map<number, string>();

function childEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAYSPEC_SKIP_DOTENV: '1',
    DATABASE_URL: e2eUrl,
    RAYSPEC_JWT_SIGNING_KEY: pem,
    RAYSPEC_API_KEY_PEPPER: PEPPER,
    // THE SHIPPED EXAMPLE ITSELF — the story's subject, not a copy of it.
    RAYSPEC_SPEC_PATH: STARTER_SPEC,
    RAYSPEC_CRON_TENANT_ID: TENANT,
    RAYSPEC_EXPERIMENTAL_WORKFORCE: '1',
    ALLOWED_ORIGINS: '',
    PORT: String(port),
  };
}

function bootServer(port: number, env: NodeJS.ProcessEnv = childEnv(port)): ChildProcess {
  // `node --import tsx` runs the loader IN-PROCESS (no wrapper child), so the SIGKILL below hits
  // the actual serving process — killing a shim would orphan the real server and prove nothing.
  const child = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
    cwd: repoRoot,
    env,
  });
  children.push(child);
  stderrByPid.set(child.pid ?? -1, '');
  child.stderr?.on('data', (d) => {
    stderrByPid.set(child.pid ?? -1, (stderrByPid.get(child.pid ?? -1) ?? '') + String(d));
  });
  child.stdout?.on('data', () => {});
  return child;
}

async function waitForBoot(port: number, child: ChildProcess, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `server subprocess exited early (code ${child.exitCode})\n--- stderr ---\n${stderrByPid.get(child.pid ?? -1) ?? ''}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `server did not become ready\n--- stderr ---\n${stderrByPid.get(child.pid ?? -1) ?? ''}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Run the built CLI, capture ONE stdout JSON object; usage errors surface stderr. */
function cli(args: string[]): { code: number; json: Record<string, unknown> } {
  const out = spawnSync(process.execPath, [CLI_DIST, ...args], {
    env: { ...process.env, RAYSPEC_SKIP_DOTENV: '1' },
    encoding: 'utf8',
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(out.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `CLI emitted no parseable JSON (exit ${out.status})\nstdout: ${out.stdout}\nstderr: ${out.stderr}`,
    );
  }
  return { code: out.status ?? -1, json };
}

/** Run the built CLI and capture RAW stdout — how the rendered tree is read, byte-for-byte. */
function cliText(args: string[]): { code: number; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [CLI_DIST, ...args], {
    env: { ...process.env, RAYSPEC_SKIP_DOTENV: '1' },
    encoding: 'utf8',
  });
  return { code: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

interface TaskRow {
  readonly task_id: string;
  readonly parent_task_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly owner: string;
  readonly turns_used: number;
  readonly confidence: string | null;
  readonly cost_usd: string;
  readonly result: { summary?: string } | null;
}

async function allTasks(): Promise<TaskRow[]> {
  return (await (sql as ReturnType<typeof postgres>)`
    SELECT task_id, parent_task_id, title, status, status_reason, owner, turns_used, confidence,
           cost_usd, result
    FROM workforce_tasks ORDER BY created_at, task_id`) as unknown as TaskRow[];
}

async function describeState(): Promise<string> {
  const rows = await allTasks();
  const lines = rows.map(
    (r) =>
      `  ${r.owner.padEnd(14)} ${r.title.padEnd(18)} ${r.status.padEnd(18)} turns=${r.turns_used} ` +
      `$${r.cost_usd} ${JSON.stringify(r.result?.summary ?? null)}`,
  );
  // A FAILED task's own journal is the difference between a diagnosis and a guess.
  for (const failed of rows.filter((r) => r.status === 'failed')) {
    const events = (await (sql as ReturnType<typeof postgres>)`
      SELECT type, data FROM run_events WHERE run_id = ${failed.task_id}
      ORDER BY seq::numeric`) as unknown as Array<{ type: string; data: unknown }>;
    lines.push(
      `  --- journal of FAILED ${failed.owner} (${failed.task_id}):`,
      ...events.map((e) => `      ${e.type} ${JSON.stringify(e.data)}`),
    );
  }
  return `${rows.length} task row(s):\n${lines.join('\n')}`;
}

async function waitUntil(
  what: string,
  predicate: () => Promise<boolean>,
  deadlineMs = 150_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const failed = (await allTasks()).filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      throw new Error(
        `while waiting for: ${what}\n` +
          `${failed.length} task(s) FAILED — this will never become true:\n${await describeState()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}\n${await describeState()}`);
}

/** The restart oracle: per task — status, version, transition count, turn-start count. */
async function snapshotTasks(): Promise<Record<string, unknown>> {
  const rows = (await (sql as ReturnType<typeof postgres>)`
    SELECT t.task_id, t.status, t.status_reason, t.version, t.turns_used, t.cost_usd,
      (SELECT count(*)::int FROM workforce_task_transitions x WHERE x.task_id = t.task_id) AS transitions,
      (SELECT count(*)::int FROM run_events e
        WHERE e.run_id = t.task_id AND e.type = 'workforce.task.turn_started') AS turn_starts
    FROM workforce_tasks t ORDER BY t.task_id`) as unknown as Array<Record<string, unknown>>;
  return Object.fromEntries(rows.map((r) => [r.task_id as string, r]));
}

async function eventTypes(taskId: string): Promise<string[]> {
  const rows = (await (sql as ReturnType<typeof postgres>)`
    SELECT type FROM run_events WHERE run_id = ${taskId} ORDER BY seq::numeric`) as unknown as Array<{
    type: string;
  }>;
  return rows.map((r) => r.type);
}

describe.skipIf(!baseUrl)(
  'the workforce acceptance story — the shipped starter, end to end',
  () => {
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

      workDir = mkdtempSync(join(tmpdir(), 'rayspec-workforce-story-e2e-'));
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      pem = await exportPKCS8(privateKey);

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
          'Workforce Story Org',
          '--owner-email',
          'story-owner@example.test',
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
        throw new Error(
          `tenant ensure failed (${ensure.status}): ${ensure.stdout} ${ensure.stderr}`,
        );
      }
      const inviteToken = readFileSync(invitePath, 'utf8').trim();
      expect(inviteToken.length).toBeGreaterThan(10);
      (globalThis as Record<string, unknown>).__wfStoryInviteToken = inviteToken;
    }, 120_000);

    afterAll(async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await new Promise((r) => setTimeout(r, 300));
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

    it('refuses to deploy the starter WITHOUT the flag — the typed refusal at the serve entry point', async () => {
      const env = childEnv(PORT1);
      delete env.RAYSPEC_EXPERIMENTAL_WORKFORCE;
      const refused = bootServer(PORT1, env);
      const deadline = Date.now() + 60_000;
      while (refused.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(refused.exitCode).not.toBeNull();
      expect(refused.exitCode).not.toBe(0);
      expect(stderrByPid.get(refused.pid ?? -1) ?? '').toContain('experimental_section_disabled');
    }, 90_000);

    it('runs the ten-step story on the shipped starter example, survives the kill, and renders the tree', async () => {
      const first = bootServer(PORT1);
      await waitForBoot(PORT1, first);
      const base1 = `http://127.0.0.1:${PORT1}`;

      // Operator account + API key through the real provisioning path.
      const accept = await fetch(`${base1}/v1/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: (globalThis as Record<string, unknown>).__wfStoryInviteToken,
          password: PASSWORD,
        }),
      });
      expect([200, 201]).toContain(accept.status);
      const accessToken = ((await accept.json()) as { accessToken: string }).accessToken;
      const mint = await fetch(`${base1}/v1/orgs/${TENANT}/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          name: 'workforce-story-e2e',
          scopes: ['store:read', 'store:write'],
        }),
      });
      expect(mint.status).toBe(201);
      const apiKey = ((await mint.json()) as { plaintext: string }).plaintext;

      // ── step 2: POST the goal to the production intake ───────────────────────────────────────
      const submitted = await fetch(`${base1}/v1/workforce/starter/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          goal: 'Analyze our onboarding friction and draft the fix announcement.',
        }),
      });
      expect(submitted.status).toBe(202);
      const submittedBody = (await submitted.json()) as {
        tasks: Array<{ taskId: string; owner: string }>;
      };
      expect(submittedBody.tasks).toHaveLength(1);
      const rootId = (submittedBody.tasks[0] as { taskId: string }).taskId;
      expect((submittedBody.tasks[0] as { owner: string }).owner).toBe('lead');

      // ── phase A: the story runs until the GROWTH stream parks on the approval (the manager —
      //    the seat holding the label and the tool — asked for the sign-off after the copywriter's
      //    draft), with the whole engineering stream (reject → rework → accept) already landed ───
      await waitUntil(
        'the approval parks the growth stream with engineering fully landed',
        async () => {
          const rows = await allTasks();
          const growth = rows.find((r) => r.title === 'Growth');
          const principal = rows.find((r) => r.owner === 'principal_eng');
          const engineering = rows.find((r) => r.title === 'Engineering');
          return (
            growth?.status === 'waiting_for_user' &&
            principal?.status === 'completed' &&
            engineering?.status === 'completed'
          );
        },
      );

      // The predicate's own facts, ASSERTED — a poll that stops being false proves nothing alone.
      const tasksA = await allTasks();
      const byOwner = (owner: string) => tasksA.filter((r) => r.owner === owner);
      const byTitle = (title: string) => tasksA.find((r) => r.title === title) as TaskRow;
      expect(tasksA).toHaveLength(8); // root + 2 department streams + 3 leaf tasks + 2 review tasks
      const root = tasksA.find((r) => r.task_id === rootId) as TaskRow;

      // step 3 — ONE orchestrator turn fanned out to the engineering TEAM and the growth department;
      // the parent holds the join park with no process attached, and the classification is journaled
      // from the TYPED intent (see the team-leg assertions at step 9).
      expect(root).toMatchObject({ status: 'blocked', status_reason: 'awaiting_children' });
      const departmentTasks = tasksA.filter((r) => r.parent_task_id === rootId);
      expect(departmentTasks.map((r) => r.title).sort()).toEqual(['Engineering', 'Growth']);
      const rootJoin = (await (sql as ReturnType<typeof postgres>)`
      SELECT join_policy FROM workforce_tasks WHERE task_id = ${rootId}`) as unknown as Array<{
        join_policy: { policy: string; childTaskIds?: string[] };
      }>;
      expect(rootJoin[0]?.join_policy.policy).toBe('all');
      expect([...(rootJoin[0]?.join_policy.childTaskIds ?? [])].sort()).toEqual(
        departmentTasks.map((r) => r.task_id).sort(),
      );
      const rootEventsA = await eventTypes(rootId);
      expect(rootEventsA).toContain('workforce.delegation.accepted');
      const turnEnded = (await (sql as ReturnType<typeof postgres>)`
      SELECT data FROM run_events WHERE run_id = ${rootId}
        AND type = 'workforce.task.turn_ended' ORDER BY seq::numeric`) as unknown as Array<{
        data: Record<string, unknown>;
      }>;
      expect(turnEnded[0]?.data).toMatchObject({
        v: 1,
        outcome: 'fan_out',
        // The fan-out addressed a TEAM (team:release_crew) alongside a department, so the derived
        // class is 'team' — read from the resolver-written delegatedTo, not from prose.
        classification: 'team',
      });

      // steps 4–5 — the worker results and the whole review loop, on durable rows.
      expect(byOwner('devops')[0]).toMatchObject({ status: 'completed', turns_used: 1 });
      expect(Number(byOwner('devops')[0]?.confidence)).toBeCloseTo(0.9, 5);
      const principal = byOwner('principal_eng')[0] as TaskRow;
      expect(principal).toMatchObject({ status: 'completed', turns_used: 2 });
      expect(principal.result?.summary).toContain('Reworked');
      const reviews = (await (sql as ReturnType<typeof postgres>)`
      SELECT round, verdict, reviewer FROM workforce_reviews ORDER BY round`) as unknown as Array<{
        round: number;
        verdict: string | null;
        reviewer: string;
      }>;
      expect(reviews.map((r) => [r.round, r.verdict, r.reviewer])).toEqual([
        [1, 'reject', 'qa'],
        [2, 'accept', 'qa'],
      ]);

      // step 6 — the capability-matched approval parked the GROWTH stream with the DECLARED
      // window; the copywriter's draft is already landed (one turn, completed).
      const growthTask = byTitle('Growth');
      expect(growthTask).toMatchObject({
        status: 'waiting_for_user',
        status_reason: 'approval_pending',
      });
      expect(byOwner('copywriter')[0]).toMatchObject({ status: 'completed', turns_used: 1 });
      const approvals = (await (sql as ReturnType<typeof postgres>)`
      SELECT id, status, extract(epoch FROM (timeout_at - created_at)) AS window_s
      FROM workforce_approvals`) as unknown as Array<{
        id: string;
        status: string;
        window_s: string;
      }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('pending');
      expect(Number(approvals[0]?.window_s)).toBeCloseTo(2 * 3600, -1); // the starter's declared 2h
      const approvalId = (approvals[0] as { id: string }).id;

      // ── step 7: the kill — a REAL SIGKILL, no drain, nothing graceful — and boot #2 ──────────
      const beforeKill = await snapshotTasks();
      first.kill('SIGKILL');
      await waitUntil(
        'the killed process exits',
        async () => first.exitCode !== null || first.signalCode !== null,
        10_000,
      );
      const second = bootServer(PORT2);
      await waitForBoot(PORT2, second);
      const base2 = `http://127.0.0.1:${PORT2}`;
      expect(await snapshotTasks()).toEqual(beforeKill); // nothing lost, nothing duplicated

      // ── step 8: the human decision, through the REAL CLI transport ───────────────────────────
      const approve = cli([
        'workforce',
        'approvals',
        'approve',
        approvalId,
        '--reason',
        'Ship it.',
        '--url',
        base2,
        '--api-key',
        apiKey,
      ]);
      expect(approve.code).toBe(0);
      const decidedRow = (await (sql as ReturnType<typeof postgres>)`
      SELECT status, decided_by FROM workforce_approvals WHERE id = ${approvalId}`) as unknown as Array<{
        status: string;
        decided_by: string;
      }>;
      expect(decidedRow[0]?.status).toBe('approved');
      expect(decidedRow[0]?.decided_by).toMatch(/^api-key:/); // the VERIFIED principal, never asserted
      expect(await eventTypes(growthTask.task_id)).toContain('workforce.approval.decided');

      // ── step 9: the synthesis — the orchestrator wakes with results keyed by id ──────────────
      await waitUntil('the root completes on the synthesis', async () => {
        const rows = await allTasks();
        return rows.find((r) => r.task_id === rootId)?.status === 'completed';
      });
      const tasksZ = await allTasks();
      const finalRoot = tasksZ.find((r) => r.task_id === rootId) as TaskRow;
      const childIds = tasksZ
        .filter((r) => r.parent_task_id === rootId)
        .map((r) => r.task_id)
        .sort();
      expect(finalRoot.result?.summary).toBe(`Synthesis of ${childIds.join(',')}`);
      expect(finalRoot.turns_used).toBe(2);
      expect(Number(finalRoot.confidence)).toBeCloseTo(0.97, 5);
      expect(tasksZ.every((r) => r.status === 'completed')).toBe(true);
      expect(tasksZ.find((r) => r.title === 'Growth')).toMatchObject({ status: 'completed' });

      // ── DoD-4: the TEAM leg, end to end ──────────────────────────────────────────────────────
      // The orchestrator delegated the engineering work to team:release_crew; the run drove the
      // whole `team:` path — resolution to the lead, the lead's member fan-out, and the join.
      const engTask = tasksZ.find((r) => r.title === 'Engineering') as TaskRow;
      const teamDelegation = (await (sql as ReturnType<typeof postgres>)`
      SELECT delegated_to, resolved_owner, status FROM workforce_delegations
        WHERE child_task_id = ${engTask.task_id}`) as unknown as Array<{
        delegated_to: string;
        resolved_owner: string;
        status: string;
      }>;
      // (a) TEAM RESOLUTION: what was ADDRESSED is the team; it resolved to the team's lead. By this
      // point in the story the engineering child has reached its terminal status, and
      // `afterTaskTerminal` settles the opening delegation row to that status (settlementStatus),
      // so the record reads 'completed' here — it was 'accepted' when the fan-out opened it at step 3.
      expect(teamDelegation[0]).toMatchObject({
        delegated_to: 'team:release_crew',
        resolved_owner: 'mgr_eng',
        status: 'completed',
      });
      // (b) the member FAN-OUT BINDING: the team lead opened tasks for the team's members.
      const memberOwners = (await (sql as ReturnType<typeof postgres>)`
      SELECT resolved_owner FROM workforce_delegations
        WHERE parent_task_id = ${engTask.task_id} ORDER BY resolved_owner`) as unknown as Array<{
        resolved_owner: string;
      }>;
      expect(memberOwners.map((d) => d.resolved_owner)).toEqual(['devops', 'principal_eng']);
      // (c) the JOIN: the lead woke with BOTH members' results and completed on a synthesis turn.
      expect(engTask).toMatchObject({ status: 'completed', turns_used: 2 });
      expect(Number(engTask.confidence)).toBeCloseTo(0.95, 5);

      // The journal narrates the whole root lifecycle from one stream.
      const rootEvents = await eventTypes(rootId);
      for (const expected of [
        'workforce.task.created',
        'workforce.task.queued',
        'workforce.task.turn_started',
        'workforce.budget.reserved',
        'workforce.delegation.accepted',
        'workforce.task.turn_ended',
        'workforce.task.transitioned',
        'workforce.budget.settled',
        'workforce.task.completed',
      ]) {
        expect(rootEvents, `root journal misses ${expected}`).toContain(expected);
      }

      // ── step 10: the tree, from the REAL CLI, byte-exact — states, confidence, costs ─────────
      const tree = cliText([
        'workforce',
        'tasks',
        '--tree', // no --root: exactly one root exists, and the auto-select rule is part of the story
        '--url',
        base2,
        '--api-key',
        apiKey,
      ]);
      expect(tree.code).toBe(0);
      const reviewTasks = tasksZ
        .filter((r) => r.owner === 'qa')
        .sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
      const expectRow = (label: string, conf: string, cost: string) =>
        new RegExp(
          `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[completed\\] ${conf}\\s+\\$${cost}$`,
          'm',
        );
      // The goal line: the whole subtree's settled dollars against the starter's declared per-task
      // ceiling, and every turn the story spent — exact sums of the scripted per-employee rates.
      expect(tree.stdout).toContain(
        `Goal: Analyze our onboarding friction and draft the fix announcement.  (${rootId} · $0.43 / $2.50 · 13 turns)`,
      );
      expect(tree.stdout).toMatch(expectRow('lead', '0\\.97', '0\\.10'));
      expect(tree.stdout).toMatch(/├─ Engineering \[completed\] 0\.95\s+\$0\.08$/m);
      expect(tree.stdout).toMatch(/└─ Growth \[completed\] 0\.90\s+\$0\.12$/m);
      expect(tree.stdout).toMatch(/Deep analysis \[completed\] 0\.75\s+\$0\.06$/m);
      expect(tree.stdout).toMatch(/Release pipeline \[completed\] 0\.90\s+\$0\.02$/m);
      expect(tree.stdout).toMatch(/Announcement \[completed\] 0\.90\s+\$0\.03$/m);
      expect(reviewTasks).toHaveLength(2);
      expect(tree.stdout).not.toContain('truncated');

      // The SAME bytes on a second render — the tree is a pure function of the durable rows.
      const treeAgain = cliText([
        'workforce',
        'tasks',
        '--tree',
        '--url',
        base2,
        '--api-key',
        apiKey,
      ]);
      expect(treeAgain.stdout).toBe(tree.stdout);

      // --json keeps the machine shape beside the rendering.
      const machine = cli([
        'workforce',
        'tasks',
        '--tree',
        '--json',
        '--url',
        base2,
        '--api-key',
        apiKey,
      ]);
      expect(machine.code).toBe(0);
      expect(Array.isArray(machine.json.tree)).toBe(true);
      expect((machine.json.tree as unknown[]).length).toBe(8);
      expect(machine.json.budgets).toEqual({ taskUsd: 2.5, taskTurns: 20 });

      // Cost grouped by employee reconciles EXACTLY with the scripted per-turn rates.
      const cost = cli([
        'workforce',
        'cost',
        '--by',
        'employee',
        '--url',
        base2,
        '--api-key',
        apiKey,
      ]);
      expect(cost.code).toBe(0);
      const groups = (cost.json.cost as { groups: Array<Record<string, unknown>> }).groups;
      const groupById = Object.fromEntries(groups.map((g) => [g.id as string, g]));
      expect(groupById.lead).toMatchObject({ settledUsd: 0.1, settledTurns: 2, tasks: 1 });
      expect(groupById.mgr_eng).toMatchObject({ settledUsd: 0.08, settledTurns: 2, tasks: 1 });
      expect(groupById.mgr_growth).toMatchObject({ settledUsd: 0.12, settledTurns: 3, tasks: 1 });
      expect(groupById.principal_eng).toMatchObject({
        settledUsd: 0.06,
        settledTurns: 2,
        tasks: 1,
      });
      expect(groupById.devops).toMatchObject({ settledUsd: 0.02, settledTurns: 1, tasks: 1 });
      expect(groupById.copywriter).toMatchObject({ settledUsd: 0.03, settledTurns: 1, tasks: 1 });
      expect(groupById.qa).toMatchObject({ settledUsd: 0.02, settledTurns: 2, tasks: 2 });

      storyArmsRan += 1;
    }, 480_000);

    // Un-skippable ran-guard: when the DB is REQUIRED, the acceptance story must have run TO ITS
    // END — a suite that green-skips in CI is a hole shaped exactly like the guarantee it carries.
    it('the acceptance story ran when the DB is required (CI / opt-in)', () => {
      if (dbRequired) expect(storyArmsRan).toBe(1);
    });
  },
);
