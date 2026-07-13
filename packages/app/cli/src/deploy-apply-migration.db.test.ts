/**
 * `rayspec deploy --apply-migration` — GROUND-TRUTH acceptance on real Postgres, END-TO-END through the
 * REAL CLI (a spawned `node dist/index.js deploy … --apply-migration …` subprocess). Two arms, each on
 * its OWN throwaway database:
 *
 *   1. ADDITIVE   — materialize a minimal agent-free backend, SEED rows, then reboot with
 *                   `--apply-migration <additive.sql>`; assert the reviewed delta LANDED (the new column
 *                   exists) and the SEEDED ROWS SURVIVED (an in-place ALTER, not a drop+recreate).
 *   2. DESTRUCTIVE — the SAME materialized+seeded backend, then reboot with a DESTRUCTIVE
 *                   `--apply-migration <drop.sql>` and NO reviewed --allowlist; assert the boot is
 *                   BLOCKED (the subprocess exits non-zero at the EXISTING deploy() gate — "roll-out
 *                   refused"), and the schema + data are INTACT (fail-closed applied nothing).
 *
 * This proves the CLI FLAG reaches the EXISTING gated migration engine (no new engine): arg parse →
 * read-spec jail → RAYSPEC_UPDATE_MIGRATION env → serve-opts updateMigrations → deploy()'s gated
 * DeployConfig.migrations. RED against a revert of the env-wiring: no delta reaches deploy(), so the
 * ADDITIVE column never appears (arm 1 fails).
 *
 * Skips without DATABASE_URL; a required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost it FAILS the
 * ran-guard at the bottom rather than silently skipping the ground-truth proof.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let additiveRan = 0;
let destructiveRan = 0;

const TENANT = '00000000-0000-4000-8000-0000000000ad';
const ADD_DB = `rayspec_cli_applymig_add_${process.pid}`;
const DROP_DB = `rayspec_cli_applymig_drop_${process.pid}`;
const PORT_BASE = 19000 + (process.pid % 900);

// A minimal AGENT-FREE backend: one store + one declarative read route (no agents, no durable worker,
// so the boot launches no off-request machinery). v2 adds a nullable column matching the additive delta.
const SPEC_V1 = `version: '1.0'
metadata:
  name: parts-backend
  description: A minimal agent-free backend for the apply-migration acceptance.
stores:
  - name: parts
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/parts', action: { kind: store, store: parts, op: list } }
`;
const SPEC_V2 = `version: '1.0'
metadata:
  name: parts-backend
  description: A minimal agent-free backend for the apply-migration acceptance.
stores:
  - name: parts
    columns:
      - { name: label, type: text }
      - { name: note, type: text, nullable: true }
api:
  - { method: GET, path: '/parts', action: { kind: store, store: parts, op: list } }
`;
const ADDITIVE_DELTA = 'ALTER TABLE parts ADD COLUMN note text;\n';
const DESTRUCTIVE_DELTA = 'ALTER TABLE parts DROP COLUMN label;\n';

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
const children: ChildProcess[] = [];
const stderrByPid = new Map<number, string>();

/** Spawn `rayspec deploy <args>` against `appDbUrl`, capturing stderr. cwd = workDir (the jail root). */
function spawnDeploy(args: string[], appDbUrl: string, port: number): ChildProcess {
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', ...args, '--port', String(port)], {
    cwd: workDir,
    env: {
      ...process.env,
      RAYSPEC_SKIP_DOTENV: '1',
      DATABASE_URL: appDbUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: 'apply-migration-pepper-only',
      ALLOWED_ORIGINS: '',
    },
  });
  children.push(child);
  stderrByPid.set(child.pid ?? -1, '');
  child.stderr?.on('data', (d) => {
    stderrByPid.set(child.pid ?? -1, (stderrByPid.get(child.pid ?? -1) ?? '') + String(d));
  });
  child.stdout?.on('data', () => {});
  return child;
}
function stderrOf(child: ChildProcess): string {
  return stderrByPid.get(child.pid ?? -1) ?? '';
}

/** Poll GET /health until 200 (booted + DB reachable), or throw (surfacing the child's stderr). */
async function waitForBoot(port: number, deadlineMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `deploy subprocess exited early (code ${child.exitCode}) before serving\n` +
          `--- stderr ---\n${stderrOf(child)}`,
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
        `deploy did not become ready before the deadline\n--- stderr ---\n${stderrOf(child)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Wait for the child to EXIT and return its code (used for the fail-closed destructive boot). */
async function waitForExit(child: ChildProcess, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) return child.exitCode;
    if (Date.now() > deadline) {
      throw new Error(
        `subprocess did not exit before the deadline\n--- stderr ---\n${stderrOf(child)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** SIGTERM a serving child + await its clean exit (SIGKILL as a last resort). */
async function shutdown(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 15_000);
  } catch {
    child.kill('SIGKILL');
  }
}

async function createDb(name: string): Promise<void> {
  const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}_dbos_sys" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

describe.skipIf(!baseUrl)(
  'rayspec deploy --apply-migration — reviewed forward delta on a real DB',
  () => {
    beforeAll(async () => {
      if (!baseUrl) return;
      // realpathSync so the CWD passed to the subprocess is the REAL path (macOS /var → /private/var),
      // else the read-spec symlink jail would reject the spec as escaping the CWD.
      workDir = realpathSync(mkdtempSync(join(tmpdir(), 'rayspec-apply-mig-')));
      writeFileSync(join(workDir, 'v1.rayspec.yaml'), SPEC_V1);
      writeFileSync(join(workDir, 'v2.rayspec.yaml'), SPEC_V2);
      writeFileSync(join(workDir, '0001_add_note.sql'), ADDITIVE_DELTA);
      writeFileSync(join(workDir, '0001_drop_label.sql'), DESTRUCTIVE_DELTA);
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      pem = await exportPKCS8(privateKey);
      await createDb(ADD_DB);
      await createDb(DROP_DB);
    }, 120_000);

    afterAll(async () => {
      for (const c of children) {
        if (c.exitCode === null) {
          c.kill('SIGKILL');
        }
      }
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      if (baseUrl) {
        const admin = postgres(adminUrl(baseUrl), { max: 1 });
        try {
          for (const name of [ADD_DB, DROP_DB]) {
            await admin.unsafe(`DROP DATABASE IF EXISTS "${name}_dbos_sys" WITH (FORCE)`);
            await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          }
        } finally {
          await admin.end();
        }
      }
    }, 60_000);

    const maybe = baseUrl ? it : it.skip;

    maybe(
      'an ADDITIVE delta via --apply-migration is APPLIED and EXISTING DATA SURVIVES',
      async () => {
        additiveRan += 1;
        const appDb = withDbName(baseUrl as string, ADD_DB);

        // Boot 1 — materialize the v1 backend, then SEED three rows through the raw DB.
        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE);
        await waitForBoot(PORT_BASE, 120_000, boot1);
        const seed = postgres(appDb, { max: 1 });
        try {
          await seed.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Org', 'org')`, [
            TENANT,
          ]);
          await seed.unsafe(
            `INSERT INTO parts (tenant_id, label) VALUES ($1,'a'),($1,'b'),($1,'c')`,
            [TENANT],
          );
        } finally {
          await seed.end();
        }
        await shutdown(boot1);

        // Boot 2 — apply the reviewed ADDITIVE delta via the CLI flag (spec v2 declares the new column).
        const boot2 = spawnDeploy(
          ['v2.rayspec.yaml', '--apply-migration', '0001_add_note.sql'],
          appDb,
          PORT_BASE + 1,
        );
        await waitForBoot(PORT_BASE + 1, 120_000, boot2);

        const check = postgres(appDb, { max: 1 });
        try {
          const cols = (await check.unsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'parts' AND column_name = 'note'`,
          )) as unknown as { column_name: string }[];
          expect(cols).toHaveLength(1); // the delta LANDED
          const rows = (await check.unsafe(`SELECT count(*)::int AS n FROM parts`)) as unknown as {
            n: number;
          }[];
          expect(rows[0]?.n).toBe(3); // the seeded rows SURVIVED the in-place ALTER
        } finally {
          await check.end();
        }
        await shutdown(boot2);
      },
      300_000,
    );

    maybe(
      'a DESTRUCTIVE delta via --apply-migration with NO covering allowlist is BLOCKED (fail-closed)',
      async () => {
        destructiveRan += 1;
        const appDb = withDbName(baseUrl as string, DROP_DB);

        // Boot 1 — materialize + seed one row.
        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 2);
        await waitForBoot(PORT_BASE + 2, 120_000, boot1);
        const seed = postgres(appDb, { max: 1 });
        try {
          await seed.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Org', 'org')`, [
            TENANT,
          ]);
          await seed.unsafe(`INSERT INTO parts (tenant_id, label) VALUES ($1,'keep')`, [TENANT]);
        } finally {
          await seed.end();
        }
        await shutdown(boot1);

        // Boot 2 — a DESTRUCTIVE delta with NO reviewed allowlist → the EXISTING deploy() gate BLOCKS the
        // boot (the subprocess exits non-zero; "roll-out refused" is printed only for that gate's
        // DeployError). No new engine — the identical fail-closed behavior the wrapper path already has.
        const boot2 = spawnDeploy(
          ['v1.rayspec.yaml', '--apply-migration', '0001_drop_label.sql'],
          appDb,
          PORT_BASE + 3,
        );
        const code = await waitForExit(boot2, 120_000);
        expect(code).not.toBe(0);
        expect(stderrOf(boot2)).toMatch(/roll-out refused/i);

        // Fail-closed: the destructive statement applied NOTHING — label + the row are intact.
        const check = postgres(appDb, { max: 1 });
        try {
          const cols = (await check.unsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'parts' AND column_name = 'label'`,
          )) as unknown as { column_name: string }[];
          expect(cols).toHaveLength(1);
          const rows = (await check.unsafe(`SELECT count(*)::int AS n FROM parts`)) as unknown as {
            n: number;
          }[];
          expect(rows[0]?.n).toBe(1);
        } finally {
          await check.end();
        }
      },
      300_000,
    );
  },
);

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that FAILS the run when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the arms did not run (a lost DATABASE_URL silently skipping the
 * ground-truth apply-migration proof). Local dev with no DB skips ergonomically.
 */
describe('rayspec deploy --apply-migration — ran-guard (must not silently skip in CI)', () => {
  it('BOTH apply-migration arms ACTUALLY RAN when the DB is required', () => {
    if (dbRequired) {
      expect(additiveRan).toBe(1);
      expect(destructiveRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
