/**
 * `rayspec deploy --apply-migration` — GROUND-TRUTH acceptance on real Postgres, END-TO-END through the
 * REAL CLI (a spawned `node dist/index.js deploy … --apply-migration …` subprocess). Seven arms, each
 * on its OWN throwaway database:
 *
 *   1. ADDITIVE   — materialize a minimal agent-free backend, SEED rows, then reboot with
 *                   `--apply-migration <additive.sql>`; assert the reviewed delta LANDED (the new column
 *                   exists) and the SEEDED ROWS SURVIVED (an in-place ALTER, not a drop+recreate).
 *   2. DESTRUCTIVE — the SAME materialized+seeded backend, then reboot with a DESTRUCTIVE
 *                   `--apply-migration <drop.sql>` and NO reviewed --allowlist; assert the boot is
 *                   BLOCKED (the subprocess exits non-zero at the EXISTING deploy() gate — "roll-out
 *                   refused"), and the schema + data are INTACT (fail-closed applied nothing).
 *   3. LEFTOVER   — the additive delta applied ONCE, then the IDENTICAL command again: the second boot
 *                   MOUNTS (no 42701 crash-loop) and the column + rows are untouched.
 *   4. HAND-SHAPED — a delta whose only object is an index the `stores` grammar cannot express, so the
 *                   classify is drift-clean either way: it APPLIES while the index is absent and MOUNTS
 *                   once it is there (both read off `pg_indexes`).
 *   5. RECYCLED NAME — a reviewed RENAME that frees a name the SAME delta re-creates. The freed name is
 *                   in the catalog in BOTH states, so it cannot decide anything; the name the rename
 *                   GIVES the table can. Applies while that name is absent, MOUNTS once it is there —
 *                   and the mount is not a formality: re-running `RENAME TO` raises 42P07 and the third
 *                   boot would never become ready.
 *   6. GENERATED SPELLING — arm 5's delta as drizzle-kit really writes it (`CREATE TABLE IF NOT
 *                   EXISTS`). Same three boots, same ground truth: the spelling changes nothing about
 *                   what the delta does and everything about what the boot could read, so arm 5's
 *                   guarantee was hollow against a generated delta until this arm passed.
 *   7. STAGING TABLE — a delta that CREATES a backup table and DROPS it again in the same file. Its
 *                   absence is not evidence the reviewed DROP ran (the delta creates it), and reading
 *                   it as such refused a never-applied delta as HALF LANDED: the boot never served.
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
let rebootRan = 0;
let handShapedRan = 0;
let recycledNameRan = 0;
let generatedSpellingRan = 0;
let stagingTableRan = 0;

const TENANT = '00000000-0000-4000-8000-0000000000ad';
const ADD_DB = `rayspec_cli_applymig_add_${process.pid}`;
const DROP_DB = `rayspec_cli_applymig_drop_${process.pid}`;
const REBOOT_DB = `rayspec_cli_applymig_reboot_${process.pid}`;
const HAND_DB = `rayspec_cli_applymig_hand_${process.pid}`;
const RECYCLE_DB = `rayspec_cli_applymig_recycle_${process.pid}`;
const GENERATED_DB = `rayspec_cli_applymig_generated_${process.pid}`;
const STAGING_DB = `rayspec_cli_applymig_staging_${process.pid}`;
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
// A delta whose ONLY object is a HAND-SHAPED INDEX — an object the `stores` grammar cannot express and
// therefore one `detectDrift` never inspects, so the live schema stays drift-clean against the SAME
// spec whether or not the delta ran. The DO block is the literal decoy: a `;` inside a dollar-quoted
// body is not a statement boundary and the `DROP TABLE` in its NOTICE text is not a DROP.
// Two hand-shaped indexes, in the two shapes a HUMAN writes them: the generator-style quoted name, and
// an UNQUOTED mixed-case one — which Postgres FOLDS, so the catalog holds `parts_label_hand_idx`. A boot
// that probed the name as written would find nothing, re-run the CREATE INDEX and die on 42P07.
const HAND_INDEX_DELTA =
  "DO $tag1$ BEGIN PERFORM 1; RAISE NOTICE 'DROP TABLE scratchpad'; END $tag1$;\n" +
  '--> statement-breakpoint\n' +
  'CREATE INDEX "parts_label_idx" ON "parts" USING btree ("label");\n' +
  '--> statement-breakpoint\n' +
  'CREATE INDEX Parts_Label_Hand_Idx ON "parts" USING btree ("label");\n';

// A reviewed RENAME that FREES a name the SAME delta re-creates — the shape where the freed name proves
// nothing, because it is in the catalog before the delta (the table being renamed away) and after it
// (the table the delta creates in its place). Nothing here is expressible in the `stores` grammar, so
// the classify is drift-clean either way and only the delta's own objects can decide.
const RECYCLED_NAME_DELTA =
  'ALTER TABLE "scratch" RENAME TO "scratch_archive";\n' +
  '--> statement-breakpoint\n' +
  'CREATE TABLE "scratch" ("id" uuid PRIMARY KEY, "note" text);\n';
const RECYCLED_NAME_ALLOWLIST = JSON.stringify(
  [
    {
      kind: 'rename-table',
      match: 'ALTER TABLE "scratch" RENAME TO "scratch_archive"',
      reason: 'reviewed: keep the old scratch rows under an archive name, start a new scratch',
    },
  ],
  null,
  2,
);

// The SAME recycled-name shape as above, written the way drizzle-kit ACTUALLY generates it: the create
// carries `IF NOT EXISTS`. That spelling made no difference to what the delta does to the schema — and
// all the difference to what the boot could read, because the reader that answers "does this delta
// leave that name standing" excluded the idempotent forms. Against that, `scratch` looked un-recycled,
// the rename was read as un-landed on a delta that had FULLY landed, and boot 3 died on 42P07.
const GENERATED_SPELLING_DELTA =
  'ALTER TABLE "scratch" RENAME TO "scratch_archive";\n' +
  '--> statement-breakpoint\n' +
  'CREATE TABLE IF NOT EXISTS "scratch" ("id" uuid PRIMARY KEY, "note" text);\n';

// An ordinary staging-table delta: build a backup table, do the work, drop the backup. The backup is a
// name the delta itself CREATES, so "it is not there" is true BEFORE the delta as much as after it —
// and reading that absence as "the reviewed DROP landed" made a never-applied delta look half-landed
// (one object landed, one not), which REFUSED the boot. No restart cleared it.
const STAGING_DELTA =
  'CREATE TABLE "parts_backup" ("id" uuid PRIMARY KEY, "label" text);\n' +
  '--> statement-breakpoint\n' +
  'CREATE INDEX "parts_label_stage_idx" ON "parts" USING btree ("label");\n' +
  '--> statement-breakpoint\n' +
  'DROP TABLE "parts_backup";\n';
const STAGING_ALLOWLIST = JSON.stringify(
  [
    {
      kind: 'drop-table',
      match: 'DROP TABLE "parts_backup"',
      reason: 'reviewed: the staging table this delta created two statements earlier',
    },
  ],
  null,
  2,
);

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
      writeFileSync(join(workDir, '0002_hand_index.sql'), HAND_INDEX_DELTA);
      writeFileSync(join(workDir, '0003_recycle_scratch.sql'), RECYCLED_NAME_DELTA);
      writeFileSync(join(workDir, '0003_recycle_scratch.allowlist.json'), RECYCLED_NAME_ALLOWLIST);
      writeFileSync(join(workDir, '0004_recycle_generated.sql'), GENERATED_SPELLING_DELTA);
      writeFileSync(
        join(workDir, '0004_recycle_generated.allowlist.json'),
        RECYCLED_NAME_ALLOWLIST,
      );
      writeFileSync(join(workDir, '0005_staging_backup.sql'), STAGING_DELTA);
      writeFileSync(join(workDir, '0005_staging_backup.allowlist.json'), STAGING_ALLOWLIST);
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      pem = await exportPKCS8(privateKey);
      await createDb(ADD_DB);
      await createDb(DROP_DB);
      await createDb(REBOOT_DB);
      await createDb(HAND_DB);
      await createDb(RECYCLE_DB);
      await createDb(GENERATED_DB);
      await createDb(STAGING_DB);
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
          for (const name of [
            ADD_DB,
            DROP_DB,
            REBOOT_DB,
            HAND_DB,
            RECYCLE_DB,
            GENERATED_DB,
            STAGING_DB,
          ]) {
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

    maybe(
      'a LEFTOVER --apply-migration is REBOOT-SAFE — it applies ONCE then MOUNTS (no 42701 crash-loop)',
      async () => {
        rebootRan += 1;
        const appDb = withDbName(baseUrl as string, REBOOT_DB);

        // Boot 1 — materialize the v1 backend, then SEED three rows.
        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 4);
        await waitForBoot(PORT_BASE + 4, 120_000, boot1);
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

        // Boot 2 — APPLY the reviewed additive delta via --apply-migration (the FIRST, legitimate update).
        const boot2 = spawnDeploy(
          ['v2.rayspec.yaml', '--apply-migration', '0001_add_note.sql'],
          appDb,
          PORT_BASE + 5,
        );
        await waitForBoot(PORT_BASE + 5, 120_000, boot2);
        await shutdown(boot2);

        // Boot 3 — the LEFTOVER-ENV REBOOT: the EXACT SAME --apply-migration command against the NOW-
        // migrated DB (as if the operator left --apply-migration in a systemd/docker `Restart=always`
        // unit). Re-applying the non-idempotent `ADD COLUMN note` would raise duplicate_column (42701) and
        // CRASH the boot (exit 1) — an earlier backend-path behavior. The boot CLASSIFIES the live schema
        // FIRST: it now present-matches v2, so the boot MOUNTS (zero migrations) and SERVES cleanly.
        const boot3 = spawnDeploy(
          ['v2.rayspec.yaml', '--apply-migration', '0001_add_note.sql'],
          appDb,
          PORT_BASE + 6,
        );
        await waitForBoot(PORT_BASE + 6, 120_000, boot3); // becomes ready ⇒ NO 42701 crash-loop

        const check = postgres(appDb, { max: 1 });
        try {
          // The delta landed EXACTLY ONCE — the column exists and the seeded rows are intact. (A re-apply
          // would have crashed before serving; a drop+recreate would have lost the rows.)
          const cols = (await check.unsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'parts' AND column_name = 'note'`,
          )) as unknown as { column_name: string }[];
          expect(cols).toHaveLength(1);
          const rows = (await check.unsafe(`SELECT count(*)::int AS n FROM parts`)) as unknown as {
            n: number;
          }[];
          expect(rows[0]?.n).toBe(3);
        } finally {
          await check.end();
        }
        await shutdown(boot3);
      },
      300_000,
    );

    // ── The delta's OWN object decides, not the spec-derived classify (#440) ─────────────────────────
    // A hand-shaped index is not expressible in the `stores` grammar, so `detectDrift` never inspects it
    // and the live schema reads drift-clean against the SAME spec whether or not the delta ran. BOTH
    // directions, on ground truth from `pg_indexes`:
    //   (a) the index is ABSENT  ⇒ the delta is UNAPPLIED ⇒ it APPLIES (RED: the boot mounted, said the
    //       delta "was already applied on a PRIOR boot", told the operator to remove the flag — and
    //       `select count(*) from pg_indexes where indexname='parts_label_idx'` returned 0);
    //   (b) the index is PRESENT ⇒ the delta really did land ⇒ the SAME command MOUNTS (re-applying the
    //       non-idempotent CREATE INDEX raises 42P07 and the boot would never serve).
    // One of the two indexes is written UNQUOTED and mixed-case, the way a human writes one, so (b) also
    // pins that the boot probes the name the CATALOG holds (folded) rather than the name as typed —
    // probing the typed name reads ABSENT on an index that is right there, and boot 3 dies on 42P07.
    maybe(
      'a delta whose only objects are HAND-SHAPED INDEXES APPLIES on a drift-clean schema, and MOUNTS once those objects are really there',
      async () => {
        handShapedRan += 1;
        const appDb = withDbName(baseUrl as string, HAND_DB);

        /** GROUND TRUTH — the exact catalog read the field report used. */
        const indexCount = async (name = 'parts_label_idx'): Promise<number> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const rows = (await c.unsafe(
              `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = $1`,
              [name],
            )) as unknown as { n: number }[];
            return rows[0]?.n ?? -1;
          } finally {
            await c.end();
          }
        };

        // Boot 1 — materialize the backend and seed rows (so a drop+recreate would be visible too).
        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 7);
        await waitForBoot(PORT_BASE + 7, 120_000, boot1);
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
        expect(await indexCount()).toBe(0);

        // Boot 2 — the SAME spec (the index is not expressible in it) + the reviewed delta.
        const boot2 = spawnDeploy(
          ['v1.rayspec.yaml', '--apply-migration', '0002_hand_index.sql'],
          appDb,
          PORT_BASE + 8,
        );
        await waitForBoot(PORT_BASE + 8, 120_000, boot2);
        expect(await indexCount()).toBe(1); // the delta LANDED
        // GROUND TRUTH for the fold: the unquoted `Parts_Label_Hand_Idx` is in the catalog LOWER-CASED,
        // so the name the boot must probe is the folded one — asking for the name as written finds nothing.
        expect(await indexCount('parts_label_hand_idx')).toBe(1);
        expect(await indexCount('Parts_Label_Hand_Idx')).toBe(0);
        // and the operator was NOT told to drop a flag whose delta had not run.
        expect(stderrOf(boot2)).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot2);

        // Boot 3 — the LEFTOVER env on the now-indexed schema: the delta really did land, so the same
        // command must MOUNT. (A re-apply raises 42P07 and this boot would never become ready.)
        const boot3 = spawnDeploy(
          ['v1.rayspec.yaml', '--apply-migration', '0002_hand_index.sql'],
          appDb,
          PORT_BASE + 9,
        );
        await waitForBoot(PORT_BASE + 9, 120_000, boot3);
        expect(await indexCount()).toBe(1); // created ONCE, not twice, not dropped
        expect(await indexCount('parts_label_hand_idx')).toBe(1); // …and so was the unquoted one
        expect(stderrOf(boot3)).toMatch(/parts_label_idx/); // the mount log NAMES what it probed
        expect(stderrOf(boot3)).toMatch(/parts_label_hand_idx/); // by the name the CATALOG holds
        expect(stderrOf(boot3)).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // now it really is stale
        const check = postgres(appDb, { max: 1 });
        try {
          const rows = (await check.unsafe(`SELECT count(*)::int AS n FROM parts`)) as unknown as {
            n: number;
          }[];
          expect(rows[0]?.n).toBe(3); // the seeded rows never moved
        } finally {
          await check.end();
        }
        await shutdown(boot3);
      },
      300_000,
    );

    // ── A RENAME that frees a name the SAME delta re-creates ────────────────────────────────────────
    // `ALTER TABLE "scratch" RENAME TO "scratch_archive"` + `CREATE TABLE "scratch"`: the name the rename
    // frees is back at the end of the delta, so "scratch is still there" is TRUE before the delta and
    // TRUE after it — it cannot tell the two apart, and reading it as "the rename has not run" re-applied
    // a delta that had fully landed. `scratch_archive` is the name that decides. BOTH directions, on
    // ground truth from `information_schema.tables`:
    //   (a) `scratch_archive` ABSENT  ⇒ the delta never ran ⇒ it APPLIES (and the rows move with the
    //       renamed table, which is what makes the rename observable rather than a re-create);
    //   (b) `scratch_archive` PRESENT ⇒ it ran ⇒ the SAME command MOUNTS. (RED on this branch's previous
    //       head: routed to APPLY, `ALTER TABLE "scratch" RENAME TO "scratch_archive"` raised 42P07
    //       "relation already exists", the boot exited before serving and never became ready.)
    maybe(
      'a reviewed RENAME that frees a name the SAME delta re-creates APPLIES once, then MOUNTS (the boot still serves)',
      async () => {
        recycledNameRan += 1;
        const appDb = withDbName(baseUrl as string, RECYCLE_DB);

        /** GROUND TRUTH — is this table in the live catalog, and how many rows does it hold? */
        const tables = async (): Promise<string[]> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const rows = (await c.unsafe(
              `SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('scratch', 'scratch_archive')
                ORDER BY table_name`,
            )) as unknown as { table_name: string }[];
            return rows.map((r) => r.table_name);
          } finally {
            await c.end();
          }
        };
        const rowCount = async (table: string): Promise<number> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const rows = (await c.unsafe(
              `SELECT count(*)::int AS n FROM "${table}"`,
            )) as unknown as { n: number }[];
            return rows[0]?.n ?? -1;
          } finally {
            await c.end();
          }
        };

        // Boot 1 — materialize the backend, then hand-create the `scratch` table the delta renames away
        // and seed it. It is NOT in the spec, so `detectDrift` never inspects it: the classify reads
        // drift-clean before AND after the delta, which is the whole reason this decision needs a probe.
        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 10);
        await waitForBoot(PORT_BASE + 10, 120_000, boot1);
        const seed = postgres(appDb, { max: 1 });
        try {
          await seed.unsafe(`CREATE TABLE "scratch" ("id" uuid PRIMARY KEY, "note" text)`);
          await seed.unsafe(
            `INSERT INTO "scratch" ("id", "note") VALUES (gen_random_uuid(), 'keep me')`,
          );
        } finally {
          await seed.end();
        }
        await shutdown(boot1);
        expect(await tables()).toEqual(['scratch']); // only the old name so far

        // Boot 2 — the SAME spec + the reviewed delta: the delta has NOT run (no `scratch_archive`), so
        // it must APPLY rather than mount and lose the rename.
        const boot2 = spawnDeploy(
          [
            'v1.rayspec.yaml',
            '--apply-migration',
            '0003_recycle_scratch.sql',
            '--allowlist',
            '0003_recycle_scratch.allowlist.json',
          ],
          appDb,
          PORT_BASE + 11,
        );
        await waitForBoot(PORT_BASE + 11, 120_000, boot2);
        expect(await tables()).toEqual(['scratch', 'scratch_archive']); // the delta LANDED
        expect(await rowCount('scratch_archive')).toBe(1); // the seeded row MOVED with the rename
        expect(await rowCount('scratch')).toBe(0); // …and the re-created table is a fresh one
        // The operator was NOT told to drop a flag whose delta had just been applied by this boot.
        expect(stderrOf(boot2)).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot2);

        // Boot 3 — the LEFTOVER env on the schema the delta leaves behind. `scratch` is there again, so
        // the old name says nothing; `scratch_archive` is there, so the delta ran ⇒ MOUNT. Re-applying
        // would raise 42P07 on `scratch_archive` and this boot would never become ready.
        const boot3 = spawnDeploy(
          [
            'v1.rayspec.yaml',
            '--apply-migration',
            '0003_recycle_scratch.sql',
            '--allowlist',
            '0003_recycle_scratch.allowlist.json',
          ],
          appDb,
          PORT_BASE + 12,
        );
        await waitForBoot(PORT_BASE + 12, 120_000, boot3); // becomes ready ⇒ the rename did NOT re-run
        expect(await tables()).toEqual(['scratch', 'scratch_archive']);
        expect(await rowCount('scratch_archive')).toBe(1); // renamed ONCE — the rows never moved again
        expect(stderrOf(boot3)).toMatch(/scratch_archive/); // the mount log NAMES what it probed
        expect(stderrOf(boot3)).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/); // now it really is stale
        await shutdown(boot3);
      },
      300_000,
    );

    // ── The SAME shape in the spelling drizzle-kit generates ────────────────────────────────────────
    // Arm 5 proves the recycled-name reading on a delta whose create is written `CREATE TABLE "scratch"`.
    // A generator writes `CREATE TABLE IF NOT EXISTS "scratch"`, and against that spelling the reading
    // was hollow: the reader that answers "does this delta leave that name standing" excluded every
    // idempotent form, so `scratch` did not look recycled at all and the rename was measured by the name
    // it renames AWAY — which is there in both states. RED end-to-end on this branch's previous head:
    //
    //   Error: deploy subprocess exited early (code 1) before serving
    //   [rayspec deploy] roll-out refused: deploy aborted at [migrate]: migration
    //     '0004_recycle_generated.sql' failed to apply (relation "scratch_archive" already exists).
    //
    // Under `Restart=always` that boot never serves. Same three boots, same ground truth as arm 5.
    maybe(
      'the recycled-name delta in the GENERATED spelling (CREATE TABLE IF NOT EXISTS) applies once, then MOUNTS',
      async () => {
        generatedSpellingRan += 1;
        const appDb = withDbName(baseUrl as string, GENERATED_DB);

        const tables = async (): Promise<string[]> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const rows = (await c.unsafe(
              `SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('scratch', 'scratch_archive')
                ORDER BY table_name`,
            )) as unknown as { table_name: string }[];
            return rows.map((r) => r.table_name);
          } finally {
            await c.end();
          }
        };
        const rowCount = async (table: string): Promise<number> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const rows = (await c.unsafe(
              `SELECT count(*)::int AS n FROM "${table}"`,
            )) as unknown as { n: number }[];
            return rows[0]?.n ?? -1;
          } finally {
            await c.end();
          }
        };
        const flags = [
          'v1.rayspec.yaml',
          '--apply-migration',
          '0004_recycle_generated.sql',
          '--allowlist',
          '0004_recycle_generated.allowlist.json',
        ];

        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 13);
        await waitForBoot(PORT_BASE + 13, 120_000, boot1);
        const seed = postgres(appDb, { max: 1 });
        try {
          await seed.unsafe(`CREATE TABLE "scratch" ("id" uuid PRIMARY KEY, "note" text)`);
          await seed.unsafe(
            `INSERT INTO "scratch" ("id", "note") VALUES (gen_random_uuid(), 'keep me')`,
          );
        } finally {
          await seed.end();
        }
        await shutdown(boot1);
        expect(await tables()).toEqual(['scratch']);

        // Boot 2 — never applied ⇒ APPLY, and the rows move with the renamed table.
        const boot2 = spawnDeploy(flags, appDb, PORT_BASE + 14);
        await waitForBoot(PORT_BASE + 14, 120_000, boot2);
        expect(await tables()).toEqual(['scratch', 'scratch_archive']);
        expect(await rowCount('scratch_archive')).toBe(1);
        expect(await rowCount('scratch')).toBe(0);
        expect(stderrOf(boot2)).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot2);

        // Boot 3 — the identical command on the schema the delta leaves behind. Becoming ready IS the
        // proof: a re-applied `RENAME TO` raises 42P07 and this boot would exit before serving.
        const boot3 = spawnDeploy(flags, appDb, PORT_BASE + 15);
        await waitForBoot(PORT_BASE + 15, 120_000, boot3);
        expect(await tables()).toEqual(['scratch', 'scratch_archive']);
        expect(await rowCount('scratch_archive')).toBe(1); // renamed ONCE — the rows never moved again
        expect(stderrOf(boot3)).toMatch(/scratch_archive/); // the mount log names what it probed
        expect(stderrOf(boot3)).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot3);
      },
      300_000,
    );

    // ── A staging table the delta creates and drops in the same file ────────────────────────────────
    // The `gone` reading had no dual to the guard the `stillThere` reading already had: a DROP target
    // the SAME delta creates is absent BEFORE the delta too, so its absence is not evidence the DROP
    // ran. RED end-to-end on this branch's head — boot 2, on a delta that had plainly never run:
    //
    //   Error: deploy subprocess exited early (code 1) before serving
    //   [rayspec deploy] roll-out refused: … the reviewed delta is only HALF LANDED …
    //     • ALREADY landed: table "parts_backup" — a reviewed DROP in the delta names it, and it is GONE
    //     • NOT landed:     index "parts_label_stage_idx" — a CREATE in the delta names it, and it is NOT there
    //
    // The boot never served, and no restart cleared it.
    maybe(
      'a delta that CREATES and then DROPS a staging table is APPLIED, and the boot serves',
      async () => {
        stagingTableRan += 1;
        const appDb = withDbName(baseUrl as string, STAGING_DB);

        const objects = async (): Promise<{ index: number; backup: number }> => {
          const c = postgres(appDb, { max: 1 });
          try {
            const idx = (await c.unsafe(
              `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'parts_label_stage_idx'`,
            )) as unknown as { n: number }[];
            const bak = (await c.unsafe(
              `SELECT count(*)::int AS n FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'parts_backup'`,
            )) as unknown as { n: number }[];
            return { index: idx[0]?.n ?? -1, backup: bak[0]?.n ?? -1 };
          } finally {
            await c.end();
          }
        };
        const flags = [
          'v1.rayspec.yaml',
          '--apply-migration',
          '0005_staging_backup.sql',
          '--allowlist',
          '0005_staging_backup.allowlist.json',
        ];

        const boot1 = spawnDeploy(['v1.rayspec.yaml'], appDb, PORT_BASE + 16);
        await waitForBoot(PORT_BASE + 16, 120_000, boot1);
        await shutdown(boot1);
        expect(await objects()).toEqual({ index: 0, backup: 0 }); // neither object exists yet

        // Boot 2 — the delta has NEVER run: it must APPLY and the boot must SERVE.
        const boot2 = spawnDeploy(flags, appDb, PORT_BASE + 17);
        await waitForBoot(PORT_BASE + 17, 120_000, boot2);
        // The index landed; the staging table was created and dropped again inside the same delta.
        expect(await objects()).toEqual({ index: 1, backup: 0 });
        expect(stderrOf(boot2)).not.toMatch(/HALF LANDED/);
        expect(stderrOf(boot2)).not.toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot2);

        // Boot 3 — the leftover env on the applied schema: the index is there, so the delta ran ⇒ MOUNT.
        // (A re-applied `CREATE INDEX` raises 42P07 and this boot would never become ready.)
        const boot3 = spawnDeploy(flags, appDb, PORT_BASE + 18);
        await waitForBoot(PORT_BASE + 18, 120_000, boot3);
        expect(await objects()).toEqual({ index: 1, backup: 0 });
        expect(stderrOf(boot3)).toMatch(/parts_label_stage_idx/); // named off the live catalog
        // …and the mount log claims the index and NOT the staging table, whose absence proved nothing.
        expect(stderrOf(boot3)).not.toMatch(/parts_backup/);
        expect(stderrOf(boot3)).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        await shutdown(boot3);
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
  it('ALL apply-migration arms ACTUALLY RAN when the DB is required', () => {
    if (dbRequired) {
      expect(additiveRan).toBe(1);
      expect(destructiveRan).toBe(1);
      expect(rebootRan).toBe(1);
      expect(handShapedRan).toBe(1);
      expect(recycledNameRan).toBe(1);
      expect(generatedSpellingRan).toBe(1);
      expect(stagingTableRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
