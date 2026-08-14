/**
 * The declared-workforce ROLES story, end to end, across mixed backend bindings — a real composed
 * server (the production spec parse under the experimental flag, the redeploy gate, the derived
 * budgets, the real agent registry, the role toolsets, the engine, the DBOS scheduler) whose only
 * injection is scripted backends behind the ordinary `agentBackendsFactory` seam:
 *
 *   the orchestrator (openai) delegates to TWO departments in one turn → each manager (anthropic /
 *   codex) sub-delegates to its two workers → the pi worker's low-confidence submission triggers
 *   the declared review policy, which dispatches the reviewer (anthropic) → the reviewer REJECTS
 *   round 1 → the rework resubmits → the reviewer ACCEPTS round 2 → the high-confidence workers
 *   complete without review → both managers merge their streams → the orchestrator requests a
 *   human approval and the root parks → the decision arrives through the REAL CLI
 *   (`rayspec workforce approvals approve`) → the orchestrator submits the synthesis and the root
 *   completes.
 *
 * Every assertion reads durable artifacts: task statuses and turn counts, delegation rows with
 * their original targets, both review rounds with their verdicts, the buffered message, the
 * journal, and the CLI's own status rollup.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forTenant, makeDb } from '@rayspec/db';
import { createRootTask } from '@rayspec/tasks';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const BOOT_SCRIPT = join(here, 'test-support/workforce-roles-e2e-serve.ts');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
/** Bumped at the story's LAST line — the ran-guard below fails a required run that skipped it. */
let storyArmsRan = 0;
if (dbRequired && !baseUrl) {
  throw new Error(
    'workforce-roles-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the roles story.',
  );
}

const PID = process.pid;
const E2E_DB = `rayspec_cli_workforce_roles_e2e_${PID}`;
const TENANT = '00000000-0000-4000-8000-0000000000e3';
const PORT = 20100 + (PID % 40);
const PEPPER = 'workforce-roles-e2e-pepper-not-a-real-secret';
const PASSWORD = 'a-long-enough-password';

/** Mixed bindings: every backend carries at least one worker; decision roles stay native. */
const SPEC = `version: '1.0'
metadata:
  name: workforce-roles-acceptance
  description: A declared workforce driving the task engine across mixed backend bindings.
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: model-x
    instructions: Coordinate the whole report.
  - id: eng_mgr_agent
    name: eng_mgr_agent
    backend: anthropic
    model: model-x
    instructions: Run engineering.
  - id: growth_mgr_agent
    name: growth_mgr_agent
    backend: codex
    model: model-x
    instructions: Run growth.
  - id: qa_agent
    name: qa_agent
    backend: anthropic
    model: model-x
    instructions: Review submissions.
  - id: dev_pi_agent
    name: dev_pi_agent
    backend: pi
    model: model-x
    instructions: Build the backend.
  - id: dev_oai_agent
    name: dev_oai_agent
    backend: openai
    model: model-x
    instructions: Build the frontend.
  - id: copy_claude_agent
    name: copy_claude_agent
    backend: anthropic
    model: model-x
    instructions: Write the copy.
  - id: copy_codex_agent
    name: copy_codex_agent
    backend: codex
    model: model-x
    instructions: Cut the assets.
workforce:
  id: story_wf
  name: Roles Story
  orchestrator: lead
  budgets:
    workforce:
      usd: 50
    task:
      usd: 5
      turns: 25
  execution:
    maxReviewRounds: 3
  departments:
    - id: eng
      name: Engineering
      manager: mgr_eng
      mission: Deliver the engineering half.
      members: [dev_pi, dev_oai]
    - id: growth
      name: Growth
      manager: mgr_growth
      mission: Deliver the growth half.
      members: [copy_claude, copy_codex]
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
    - id: mgr_eng
      agent: eng_mgr_agent
      title: Engineering Manager
      department: eng
      reportsTo: lead
      role: manager
    - id: mgr_growth
      agent: growth_mgr_agent
      title: Growth Manager
      department: growth
      reportsTo: lead
      role: manager
    - id: dev_pi
      agent: dev_pi_agent
      title: Backend Developer
      department: eng
      reportsTo: mgr_eng
      role: worker
    - id: dev_oai
      agent: dev_oai_agent
      title: Frontend Developer
      department: eng
      reportsTo: mgr_eng
      role: worker
    - id: copy_claude
      agent: copy_claude_agent
      title: Copywriter
      department: growth
      reportsTo: mgr_growth
      role: worker
    - id: copy_codex
      agent: copy_codex_agent
      title: Asset Producer
      department: growth
      reportsTo: mgr_growth
      role: worker
    - id: qa
      agent: qa_agent
      title: Quality Reviewer
      reportsTo: lead
      role: reviewer
  reviewPolicies:
    - id: eng_quality
      appliesTo: { department: eng }
      reviewer: qa
      requireWhen: { confidenceBelow: 0.75 }
      onReject: rework
      maxRounds: 3
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
let sql: ReturnType<typeof postgres> | undefined;
let engineDb: ReturnType<typeof makeDb> | undefined;
const children: ChildProcess[] = [];
const stderrByPid = new Map<number, string>();

function childEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAYSPEC_SKIP_DOTENV: '1',
    DATABASE_URL: e2eUrl,
    RAYSPEC_JWT_SIGNING_KEY: pem,
    RAYSPEC_API_KEY_PEPPER: PEPPER,
    RAYSPEC_SPEC_PATH: join(workDir, 'rayspec.yaml'),
    RAYSPEC_CRON_TENANT_ID: TENANT,
    RAYSPEC_EXPERIMENTAL_WORKFORCE: '1',
    ALLOWED_ORIGINS: '',
    PORT: String(port),
  };
}

function bootServer(port: number): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
    cwd: repoRoot,
    env: childEnv(port),
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

async function waitUntil(
  what: string,
  predicate: () => Promise<boolean>,
  deadlineMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface TaskRow {
  readonly task_id: string;
  readonly parent_task_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
  readonly department: string | null;
  readonly turns_used: number;
  readonly confidence: string | null;
  readonly result: { summary?: string } | null;
}

async function allTasks(): Promise<TaskRow[]> {
  return (await (sql as ReturnType<typeof postgres>)`
    SELECT task_id, parent_task_id, title, status, owner, department, turns_used, confidence, result
    FROM workforce_tasks ORDER BY created_at`) as unknown as TaskRow[];
}

describe.skipIf(!baseUrl)('workforce roles story — delegation, review loop, CLI approval', () => {
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

    workDir = mkdtempSync(join(tmpdir(), 'rayspec-workforce-roles-e2e-'));
    writeFileSync(join(workDir, 'rayspec.yaml'), SPEC);
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
        'Workforce Roles Org',
        '--owner-email',
        'roles-owner@example.test',
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
    const inviteToken = readFileSync(invitePath, 'utf8').trim();
    expect(inviteToken.length).toBeGreaterThan(10);
    (globalThis as Record<string, unknown>).__wfRolesInviteToken = inviteToken;

    engineDb = makeDb(e2eUrl);
  }, 120_000);

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
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

  it('runs the whole story: plural delegation, both review rounds, and the human decision', async () => {
    const server = bootServer(PORT);
    await waitForBoot(PORT, server);
    const base = `http://127.0.0.1:${PORT}`;

    // Operator account + API key through the real provisioning path.
    const accept = await fetch(`${base}/v1/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: (globalThis as Record<string, unknown>).__wfRolesInviteToken,
        password: PASSWORD,
      }),
    });
    expect([200, 201]).toContain(accept.status);
    const accessToken = ((await accept.json()) as { accessToken: string }).accessToken;
    const mint = await fetch(`${base}/v1/orgs/${TENANT}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: 'workforce-roles-e2e', scopes: ['store:read', 'store:write'] }),
    });
    expect(mint.status).toBe(201);
    const apiKey = ((await mint.json()) as { plaintext: string }).plaintext;

    // The root task, owned by the declared orchestrator.
    const tdb = forTenant(engineDb as ReturnType<typeof makeDb>, TENANT);
    const root = await createRootTask(tdb, {
      workforceId: 'story_wf',
      title: 'Produce the combined report',
      goal: 'Split the report across departments, review the risky half, get a human sign-off.',
      owner: 'lead',
      requestedBy: 'user',
    });

    // ── phase A: the whole delegation + review story runs until the approval parks the root ──────
    await waitUntil('the approval parks the root with the whole subtree completed', async () => {
      const rows = await allTasks();
      const rootRow = rows.find((r) => r.task_id === root.taskId);
      const others = rows.filter((r) => r.task_id !== root.taskId);
      return (
        rootRow?.status === 'waiting_for_user' &&
        others.length === 8 &&
        others.every((r) => r.status === 'completed')
      );
    });

    const tasks = await allTasks();
    const byOwner = (owner: string) => tasks.filter((r) => r.owner === owner);

    // The tree: root + 2 managers + 4 workers + 2 review tasks (one per round).
    expect(tasks).toHaveLength(9);
    expect(byOwner('mgr_eng')).toHaveLength(1);
    expect(byOwner('mgr_growth')).toHaveLength(1);
    for (const worker of ['dev_pi', 'dev_oai', 'copy_claude', 'copy_codex']) {
      expect(byOwner(worker), worker).toHaveLength(1);
    }
    const reviewTasks = byOwner('qa');
    expect(reviewTasks).toHaveLength(2);
    for (const review of reviewTasks) {
      expect(review.parent_task_id).toBe(byOwner('dev_pi')[0]?.task_id);
      expect(review.turns_used).toBe(1);
    }

    // The REWORK is visible on the reviewed task: two turns, the reworked summary, the low
    // confidence it kept submitting.
    const devPi = byOwner('dev_pi')[0] as TaskRow;
    expect(devPi.turns_used).toBe(2);
    expect(devPi.result?.summary).toBe('Backend slice reworked per review.');
    // The high-confidence eng worker completed WITHOUT review: one turn, no review child.
    const devOai = byOwner('dev_oai')[0] as TaskRow;
    expect(devOai.turns_used).toBe(1);
    expect(tasks.filter((r) => r.parent_task_id === devOai.task_id)).toHaveLength(0);

    // Both review rounds are durable rows with their verdicts.
    const reviews = (await (sql as ReturnType<typeof postgres>)`
      SELECT round, verdict, reviewer, required_changes FROM workforce_reviews ORDER BY round`) as unknown as Array<{
      round: number;
      verdict: string;
      reviewer: string;
      required_changes: string[];
    }>;
    expect(reviews.map((r) => [r.round, r.verdict, r.reviewer])).toEqual([
      [1, 'reject', 'qa'],
      [2, 'accept', 'qa'],
    ]);
    expect(reviews[0]?.required_changes).toEqual(['Address the review notes and resubmit.']);

    // Delegation rows keep the ORIGINAL targets: departments from the orchestrator, employees
    // from the managers. Review dispatch is not delegation — exactly six rows.
    const delegations = (await (sql as ReturnType<typeof postgres>)`
      SELECT delegated_by, delegated_to, resolved_owner, depth FROM workforce_delegations
      ORDER BY delegated_to`) as unknown as Array<{
      delegated_by: string;
      delegated_to: string;
      resolved_owner: string;
      depth: number;
    }>;
    expect(
      delegations.map((d) => [d.delegated_by, d.delegated_to, d.resolved_owner, d.depth]),
    ).toEqual([
      ['lead', 'department:eng', 'mgr_eng', 1],
      ['lead', 'department:growth', 'mgr_growth', 1],
      ['mgr_growth', 'employee:copy_claude', 'copy_claude', 2],
      ['mgr_growth', 'employee:copy_codex', 'copy_codex', 2],
      ['mgr_eng', 'employee:dev_oai', 'dev_oai', 2],
      ['mgr_eng', 'employee:dev_pi', 'dev_pi', 2],
    ]);

    // The buffered message landed beside the delegation, journaled on the sender's task.
    const messages = (await (sql as ReturnType<typeof postgres>)`
      SELECT task_id, sender, recipient, body FROM workforce_messages`) as unknown as Array<{
      task_id: string;
      sender: string;
      recipient: string;
      body: string;
    }>;
    expect(messages).toEqual([
      {
        task_id: root.taskId,
        sender: 'lead',
        recipient: 'mgr_eng',
        body: 'Coordinate with growth on timing.',
      },
    ]);

    // ── phase B: the human decision through the real CLI ────────────────────────────────────────
    const list = cli(['workforce', 'approvals', 'list', '--url', base, '--api-key', apiKey]);
    expect(list.code).toBe(0);
    const pending = (list.json.approvals as Array<{ id: string; status: string }>)[0];
    expect(pending?.status).toBe('pending');

    const approve = cli([
      'workforce',
      'approvals',
      'approve',
      pending?.id as string,
      '--reason',
      'publish it',
      '--url',
      base,
      '--api-key',
      apiKey,
    ]);
    expect(approve.code, JSON.stringify(approve.json)).toBe(0);
    expect((approve.json.approval as { status: string }).status).toBe('approved');

    // ── phase C: the synthesis completes the root ───────────────────────────────────────────────
    await waitUntil('the root completes after the decision', async () => {
      const rows = await allTasks();
      return rows.find((r) => r.task_id === root.taskId)?.status === 'completed';
    });
    const finalRoot = (await allTasks()).find((r) => r.task_id === root.taskId) as TaskRow;
    expect(finalRoot.result?.summary).toBe('Both department reports merged and approved.');
    expect(finalRoot.turns_used).toBe(3);

    // The journal tells the story on the root task.
    const events = cli(['workforce', 'events', root.taskId, '--url', base, '--api-key', apiKey]);
    expect(events.code).toBe(0);
    const types = (events.json.events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('workforce.task.created');
    expect(types).toContain('workforce.message.sent');
    expect(types).toContain('workforce.approval.requested');
    expect(types).toContain('workforce.approval.decided');
    expect(types).toContain('workforce.task.completed');

    // And the review journal lives on the reviewed task.
    const devPiEvents = cli([
      'workforce',
      'events',
      devPi.task_id,
      '--url',
      base,
      '--api-key',
      apiKey,
    ]);
    expect(devPiEvents.code).toBe(0);
    const devPiTypes = (devPiEvents.json.events as Array<{ type: string }>).map((e) => e.type);
    expect(devPiTypes.filter((t) => t === 'workforce.review.requested')).toHaveLength(2);

    // The CLI rollup sees the finished workforce: all nine tasks completed.
    const status = cli([
      'workforce',
      'status',
      '--workforce',
      'story_wf',
      '--url',
      base,
      '--api-key',
      apiKey,
    ]);
    expect(status.code).toBe(0);
    expect((status.json.status as { tasks: Record<string, number> }).tasks.completed).toBe(9);
    storyArmsRan++;
  }, 360_000);
});

// Un-skippable ran-guard: when the DB is REQUIRED, the roles story must have run TO ITS END.
it('the roles story ran when the DB is required (CI / opt-in)', () => {
  if (dbRequired) expect(storyArmsRan).toBe(1);
});
