/**
 * The task engine's ACCEPTANCE story, end to end, with a REAL process death in the middle — no
 * model anywhere, every turn a registered handler, every assertion on durable artifacts:
 *
 *   create a root task → the dispatcher fans it out to 4 children (each its own workflow) → the
 *   children complete → the join wakes the parent, whose next turn receives the results KEYED BY
 *   CHILD ID → the parent requests an approval and parks in waiting_for_user → the server process
 *   is SIGKILLED (no drain, no cleanup) → a fresh process boots on the same database → the
 *   approval is decided through the REAL CLI (`rayspec workforce approvals approve`, resolved
 *   transport, Bearer key, the route's own authorization) → the root completes with a summary that
 *   is a pure function of the merged child ids.
 *
 * The restart assertions are the point: NO terminal outcome changes across the kill (children keep
 * their statuses, versions, transition counts and turn counts — no duplicated side effect), and
 * the parked approval survives to be decided. The provisioning path is the real one too: the org
 * arrives via `rayspec tenant ensure` (which applies the committed migration chain), the operator
 * account via the invite-accept flow, and the credential via the API-key mint route.
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
const BOOT_SCRIPT = join(here, 'test-support/workforce-e2e-serve.ts');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'workforce-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the acceptance story.',
  );
}

const PID = process.pid;
const E2E_DB = `rayspec_cli_workforce_e2e_${PID}`;
const TENANT = '00000000-0000-4000-8000-0000000000e2';
const PORT1 = 19900 + (PID % 40);
const PORT2 = PORT1 + 40;
const PEPPER = 'workforce-e2e-pepper-not-a-real-secret';
const PASSWORD = 'a-long-enough-password';

const SPEC = `version: '1.0'
metadata:
  name: workforce-acceptance
  description: An agent-free backend whose durable worker runs the task engine acceptance.
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
    ALLOWED_ORIGINS: '',
    PORT: String(port),
  };
}

function bootServer(port: number): ChildProcess {
  // `node --import tsx` runs the loader IN-PROCESS (no wrapper child), so the SIGKILL below hits
  // the actual serving process — killing a shim would orphan the real server and prove nothing.
  const child = spawn(process.execPath, ['--import', 'tsx', BOOT_SCRIPT], {
    // cwd = the repo root so `--import tsx` resolves from the workspace node_modules (the spec
    // path in the environment is absolute; nothing here reads the working directory).
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
  deadlineMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface TaskSnapshot {
  readonly taskId: string;
  readonly status: string;
  readonly version: number;
  readonly transitions: number;
  readonly turnStarts: number;
}

async function snapshotTasks(): Promise<Map<string, TaskSnapshot>> {
  const rows = (await (sql as ReturnType<typeof postgres>)`
    SELECT t.task_id, t.status, t.version,
      (SELECT count(*)::int FROM workforce_task_transitions tr WHERE tr.task_id = t.task_id) AS transitions,
      (SELECT count(*)::int FROM run_events e WHERE e.run_id = t.task_id AND e.type = 'workforce.task.turn_started') AS turn_starts
    FROM workforce_tasks t`) as unknown as Array<{
    task_id: string;
    status: string;
    version: number;
    transitions: number;
    turn_starts: number;
  }>;
  return new Map(
    rows.map((r) => [
      r.task_id,
      {
        taskId: r.task_id,
        status: r.status,
        version: r.version,
        transitions: r.transitions,
        turnStarts: r.turn_starts,
      },
    ]),
  );
}

describe.skipIf(!baseUrl)('workforce acceptance — fan-out, approval, SIGKILL, CLI decision', () => {
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

    workDir = mkdtempSync(join(tmpdir(), 'rayspec-workforce-e2e-'));
    writeFileSync(join(workDir, 'rayspec.yaml'), SPEC);
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(privateKey);

    // Provision the deployment tenant through the REAL path: `tenant ensure` applies the committed
    // migration chain and mints the owner invite (mode-600 file; the token is printed nowhere).
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
        'Workforce Acceptance Org',
        '--owner-email',
        'e2e-owner@example.test',
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
    (globalThis as Record<string, unknown>).__wfInviteToken = inviteToken;

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

  it('runs the whole story and survives the kill with no outcome changed and nothing duplicated', async () => {
    // ── boot #1 ────────────────────────────────────────────────────────────────────────────────
    const first = bootServer(PORT1);
    await waitForBoot(PORT1, first);
    const base1 = `http://127.0.0.1:${PORT1}`;

    // Operator account via the invite flow; the accept mints an org-bound token.
    const accept = await fetch(`${base1}/v1/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: (globalThis as Record<string, unknown>).__wfInviteToken,
        password: PASSWORD,
      }),
    });
    expect([200, 201]).toContain(accept.status);
    const accessToken = ((await accept.json()) as { accessToken: string }).accessToken;

    const mint = await fetch(`${base1}/v1/orgs/${TENANT}/api-keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name: 'workforce-e2e', scopes: ['store:read', 'store:write'] }),
    });
    expect(mint.status).toBe(201);
    const apiKey = ((await mint.json()) as { plaintext: string }).plaintext;

    // ── the root task (task creation is an engine API; the HTTP surface reads/decides/controls) ──
    const tdb = forTenant(engineDb as ReturnType<typeof makeDb>, TENANT);
    const root = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Produce the merged report',
      goal: 'Fan the goal out, merge the results, get a human sign-off.',
      owner: 'coordinator',
      requestedBy: 'user',
    });

    // Fan-out → 4 children complete → join → the approval parks the root.
    await waitUntil('the approval parks the root with all four children completed', async () => {
      const snap = await snapshotTasks();
      const rootRow = snap.get(root.taskId);
      const childRows = [...snap.values()].filter((t) => t.taskId !== root.taskId);
      return (
        rootRow?.status === 'waiting_for_user' &&
        childRows.length === 4 &&
        childRows.every((c) => c.status === 'completed')
      );
    });

    const beforeKill = await snapshotTasks();
    const approvalsBefore = (await (sql as ReturnType<typeof postgres>)`
      SELECT id, status FROM workforce_approvals`) as unknown as Array<{
      id: string;
      status: string;
    }>;
    expect(approvalsBefore).toHaveLength(1);
    expect(approvalsBefore[0]?.status).toBe('pending');

    // ── the kill: a REAL SIGKILL — no drain, no shutdown hook, nothing graceful ───────────────
    first.kill('SIGKILL');
    // A signal-terminated child reports signalCode (exitCode stays null) — wait on either.
    await waitUntil(
      'the killed process exits',
      async () => first.exitCode !== null || first.signalCode !== null,
      10_000,
    );

    // ── boot #2 on the same database ──────────────────────────────────────────────────────────
    const second = bootServer(PORT2);
    await waitForBoot(PORT2, second);
    const base2 = `http://127.0.0.1:${PORT2}`;

    // The restart changed NOTHING: same statuses, same versions, same transition/turn counts.
    const afterBoot = await snapshotTasks();
    expect(afterBoot.size).toBe(beforeKill.size);
    for (const [taskId, before] of beforeKill) {
      expect(afterBoot.get(taskId), `task ${taskId} after restart`).toEqual(before);
    }

    // ── the CLI decision (the real transport: --url + Bearer key, the route's own authz) ──────
    const list = cli(['workforce', 'approvals', 'list', '--url', base2, '--api-key', apiKey]);
    expect(list.code).toBe(0);
    expect(list.json.ok).toBe(true);
    const pending = (list.json.approvals as Array<{ id: string; status: string }>)[0];
    expect(pending?.status).toBe('pending');

    const approve = cli([
      'workforce',
      'approvals',
      'approve',
      pending?.id as string,
      '--reason',
      'looks right',
      '--url',
      base2,
      '--api-key',
      apiKey,
    ]);
    expect(approve.code).toBe(0);
    expect((approve.json.approval as { status: string }).status).toBe('approved');

    // The woken root completes with a summary that is a PURE FUNCTION of the merged child ids.
    await waitUntil('the root completes after the decision', async () => {
      const snap = await snapshotTasks();
      return snap.get(root.taskId)?.status === 'completed';
    });
    const childIds = [...beforeKill.keys()].filter((id) => id !== root.taskId).sort();
    const rootRow = (await (sql as ReturnType<typeof postgres>)`
      SELECT result FROM workforce_tasks WHERE task_id = ${root.taskId}`) as unknown as Array<{
      result: { summary?: string };
    }>;
    expect(rootRow[0]?.result?.summary).toBe(`merged 4 children: ${childIds.join(',')}`);

    // No duplicated side effect ANYWHERE: the terminal children kept their exact counts.
    const final = await snapshotTasks();
    for (const [taskId, before] of beforeKill) {
      if (taskId === root.taskId) continue;
      expect(final.get(taskId), `terminal child ${taskId} at the end`).toEqual(before);
    }
    const joinSignals = (await (sql as ReturnType<typeof postgres>)`
      SELECT count(*)::int AS c FROM workforce_task_signals WHERE kind = 'child_completed'`) as unknown as Array<{
      c: number;
    }>;
    expect(joinSignals[0]?.c).toBe(1);

    // The journal tells the whole story through the CLI too.
    const events = cli(['workforce', 'events', root.taskId, '--url', base2, '--api-key', apiKey]);
    expect(events.code).toBe(0);
    const types = (events.json.events as Array<{ type: string; v: number }>).map((e) => e.type);
    expect(types).toContain('workforce.task.created');
    expect(types).toContain('workforce.approval.requested');
    expect(types).toContain('workforce.approval.decided');
    expect(types).toContain('workforce.task.completed');
    for (const e of events.json.events as Array<{ v: number }>) expect(e.v).toBe(1);

    // And the status view reflects the finished workforce.
    const status = cli([
      'workforce',
      'status',
      '--workforce',
      'wf',
      '--url',
      base2,
      '--api-key',
      apiKey,
    ]);
    expect(status.code).toBe(0);
    expect((status.json.status as { tasks: Record<string, number> }).tasks.completed).toBe(5);
  }, 240_000);
});

// Un-skippable ran-guard: when the DB is REQUIRED, the acceptance story must actually have run.
it('the acceptance story ran when the DB is required (CI / opt-in)', () => {
  if (dbRequired) expect(Boolean(baseUrl)).toBe(true);
});
