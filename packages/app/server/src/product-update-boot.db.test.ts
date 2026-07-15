/**
 * PRODUCT-FAMILY (0.2) UPDATE-SEAM acceptance — the ENV-DRIVEN Product-YAML
 * update-apply seam (product-boot.ts), end-to-end on GROUND TRUTH through the REAL composition root +
 * the REAL `deploy()` gate, against throwaway DATABASEs. This is the 0.2 analog of the composition-root
 * S3 proof (update-mode.db.test.ts): a neutral product (the acme-notes.v1/v2 fixture — NOT the shipped
 * examples/acme-notes anchor) EVOLVES its Tier-A store set; the derived-store delta is reproduced
 * in-process via the SAME `deriveProductStores` + `diffProductStores` the CLI (`rayspec plan <new>
 * --against <old>`) uses; the env-driven update boot (`RAYSPEC_UPDATE_MIGRATION`) applies it, existing
 * data survives, the post-update drift GATE fails closed on an under-reconciling delta, and the deploy
 * gate blocks an unreviewed destructive statement.
 *
 * ── Headline: a pure-SUBSET (removal) update on its FIRST boot MUST APPLY, not MOUNT ─────────────
 * detectDrift is SUPERSET-BLIND (it introspects only the NEW spec's stores), so a live SUPERSET schema
 * (v2) present-matches a smaller NEW spec (v1) — the SAME classification a genuine leftover env yields.
 * An earlier `planUpdateBoot` MOUNTED both, SILENTLY LOSING the operator's reviewed DROP forever. The boot
 * PROBES the delta's destructive targets live to discriminate: a target that STILL EXISTS ⇒ the delta is
 * UNAPPLIED ⇒ APPLY; all targets GONE ⇒ a genuine leftover ⇒ MOUNT.
 *
 * ── DBOS-SINGLETON CONSTRAINT (why only ONE arm boots to launch) ────────────────────────────────
 * Every Product-YAML boot launches the process-global DBOS singleton, and a SECOND `DBOS.launch()` in
 * one process (after a NON-deregistering shutdown, which the live boot uses) is unsafe — the hard-won
 * safe-half lesson (executor-safe-half.db.test.ts). So this file completes exactly ONE full product
 * boot: the SUBSET-DESTRUCTIVE update boot (the novel surface). v-schemas are materialized DIRECTLY
 * via the EXACT production first-materialization SQL (`generateProductSql`) + the committed platform
 * migration chain — DBOS-launch is orthogonal to schema materialization. Every OTHER boot()-driven arm
 * THROWS before `executor.start()` (no launch): the incomplete-delta arm on the post-update drift GATE,
 * the blocked arm on deploy()'s lint/gate, the absent-schema arm on the classify preflight. A full
 * product BOOT + workflow (deployMode 'materialized', real grounded rows) is proven independently by
 * product-yaml-boot.db.test.ts; THIS file's novel surface is the UPDATE.
 *
 * ── The arms (a SEPARATE throwaway DB per arm — no cross-arm schema coupling) ────────────────────
 *   1.  INCOMPLETE delta — a v1-materialized DB → UPDATE boot (spec v2) with a delta that creates only
 *                          pinned_moments (under-reconciles v2, which also wants highlights) → the delta
 *                          applies (pinned_moments live) but the post-update drift GATE FAILS CLOSED with
 *                          a ProductBootError (STILL DRIFTED) BEFORE any launch — NOT a green 'updated'
 *                          boot that would brick the next reboot. Mid-state asserted on the real catalog.
 *   2.  SUBSET-DESTRUCTIVE — (the ONE launch) a v2-materialized DB (the SUPERSET) + a seeded
 *       APPLIES through   — note_artifacts row → env-driven UPDATE boot with SPEC v1 (the SUBSET) and
 *       the REAL boot()     the reviewed v2→v1 pure-DROP delta (drops pinned_moments + highlights) + its
 *                          reviewed allowlist. present-matching (superset-blind) BUT the drop targets
 *                          STILL EXIST → planUpdateBoot PROBES them → APPLY: deployMode 'updated', both
 *                          targets DROPPED, the SEEDED ROW SURVIVES, drift-clean vs v1. (RED against the
 *                          earlier boot: this MOUNTED, targets intact, the drop silently lost.)
 *                          Tails, launch-free: (2b) a plain reboot present-matches v1 → would MOUNT;
 *                          (2c, case-(A)) a LEFTOVER env is reboot-safe — (RED) re-applying the drop to
 *                          the now-v1 schema CRASHES 42P01; (GREEN) planUpdateBoot over the REAL
 *                          present-matching classify + a REAL live probe sees the targets GONE → MOUNTS.
 *   3.  BLOCKED (no      — (through boot) the SAME v2→v1 drop delta but env carries NO reviewed
 *       allowlist)         allowlist → planUpdateBoot routes present-matching+target-exists to APPLY →
 *                          deploy()'s lint/gate REFUSES the DROP → boot throws a DeployError BEFORE
 *                          executor.start() (launch-free), the schema INTACT. The through-boot replacement
 *                          for the old hand-rolled direct-gate arm (that workaround existed only because
 *                          an earlier boot MOUNTED a subset drop instead of routing it to the gate).
 *   4.  ABSENT + env     — a FULL boot() with the update env against a DB with NO product stores →
 *                          the boot classifies 'absent' → throws the actionable ProductBootError BEFORE
 *                          deploy()/launch (remove the env for a first materialization). Launch-free.
 *
 * UN-SKIPPABLE RAN-GUARD (the false-green class): a separate, NON-skipped
 * describe hard-FAILS when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms did not run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { DeployError } from '@rayspec/api-auth';
import { AUDIO_STORE_NAMES, audioCapabilityStores } from '@rayspec/audio-runtime';
import {
  classifyProductSchema,
  detectDrift,
  diffProductStores,
  generateProductSql,
  makeDb,
} from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { deriveProductStores } from '@rayspec/product-yaml';
import { type ProductSpec, parseProductSpec, type StoreSpec } from '@rayspec/spec';
import { FakeSttAdapter } from '@rayspec/stt-port';
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
  LEFTOVER_UPDATE_ENV_MOUNT_LOG,
  makeSchemaProbe,
  ProductBootError,
  planUpdateBoot,
  readProductUpdateMigrations,
} from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const V1_YAML = resolve(here, '__fixtures__/product-update/acme-notes.v1.product.yaml');
const V2_YAML = resolve(here, '__fixtures__/product-update/acme-notes.v2.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_product_update_${process.pid}`;
const INCOMPLETE_DB = `rayspec_product_update_inc_${process.pid}`;
const DEST_DB = `rayspec_product_update_dest_${process.pid}`;
const ABSENT_DB = `rayspec_product_update_absent_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000e4';

function specOf(path: string): ProductSpec {
  const parsed = parseProductSpec(readFileSync(path, 'utf8'));
  if (!parsed.ok) throw new Error(`fixture invalid (${path}): ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/** The FULL composed Tier-A store set the boot derives for a fixture (audio capability's own + derived). */
function composedStores(spec: ProductSpec): StoreSpec[] {
  return [...audioCapabilityStores(), ...deriveProductStores(spec, AUDIO_STORE_NAMES).stores];
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

/**
 * A deterministic extractor registry. deploy() fail-closed-verifies the declared agent HAS a registered
 * executor at rollout, so we register one — but it is NEVER invoked here (the update boot composes the
 * node registry; it does not run the workflow). The acme fixture declares `note_extractor`.
 */
function deterministicAgents(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', () => {
    throw new Error('deterministic extractor is not invoked in the update-seam acceptance');
  });
  return registry;
}

describe.skipIf(!baseUrl)(
  'Product-YAML (0.2) env-driven update seam — real composition root + real deploy() gate',
  () => {
    let appDbUrl = '';
    let incompleteDbUrl = '';
    let destDbUrl = '';
    let absentDbUrl = '';
    let dbosSysDb = '';
    let blobDir = '';
    let tmpDir = '';
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
      'STT_PROVIDER',
      'RAYSPEC_EXTRACTION_MODE',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
      'RAYSPEC_UPDATE_MIGRATION',
      'RAYSPEC_UPDATE_ALLOWLIST',
    ] as const;

    /** Materialize a fresh throwaway DB with the platform chain + the given product stores, and an org row. */
    async function materialize(
      dbUrl: string,
      stores: StoreSpec[],
      opts: { seedRow: boolean },
    ): Promise<string | undefined> {
      const db = makeDb(dbUrl);
      let seededId: string | undefined;
      try {
        await applyMigrations(db); // committed platform chain (orgs/users/… — bootstraps clean)
        const ddl = generateProductSql(stores).replace(/-->\s*statement-breakpoint/g, '');
        await db.$client.begin(async (tx) => {
          await tx.unsafe(ddl);
        });
        await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [
          TENANT,
        ]);
        if (opts.seedRow) {
          // A REAL collection row (the canonical Tier-A shape) — its survival across the update is the proof.
          const rows = (await db.$client.unsafe(
            `INSERT INTO note_artifacts
               (tenant_id, session_id, artifact_kind, payload, human_edited, dismissed, artifact_ref)
             VALUES ($1, 'sess-1', 'digest', $2, false, false, $3)
             RETURNING id`,
            [TENANT, JSON.stringify({ headline: 'survive me' }), `${TENANT}:sess-1:digest:0`],
          )) as unknown as Array<{ id: string }>;
          seededId = rows[0]?.id;
        }
      } finally {
        await db.$client.end();
      }
      return seededId;
    }

    /** Materialize the v1 (old) schema — the starting point every additive-update arm evolves from. */
    async function materializeV1(
      dbUrl: string,
      opts: { seedRow: boolean },
    ): Promise<string | undefined> {
      return materialize(dbUrl, composedStores(specOf(V1_YAML)), opts);
    }

    /** Bring a throwaway DB to the platform chain + an org row ONLY — NO product stores (⇒ 'absent'). */
    async function materializeEmpty(dbUrl: string): Promise<void> {
      const db = makeDb(dbUrl);
      try {
        await applyMigrations(db); // committed platform chain — orgs exists, product stores do NOT
        await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [
          TENANT,
        ]);
      } finally {
        await db.$client.end();
      }
    }

    /** Write the diff(oldStores→newStores) migration SQL to a temp file; return its path. */
    function writeDelta(oldStores: StoreSpec[], newStores: StoreSpec[], name: string): string {
      const diff = diffProductStores(oldStores, newStores, { label: name });
      const p = join(tmpDir, `${name}.sql`);
      writeFileSync(p, diff.migrationSql, 'utf8');
      return p;
    }

    /** Boot the real composition root for a fixture; `updateMigrationPath` present ⇒ env-driven UPDATE mode. */
    async function boot(
      specPath: string,
      dbUrl: string,
      updateMigrationPath?: string,
      allowlistPath?: string,
    ): Promise<BootedServer> {
      process.env.DATABASE_URL = dbUrl;
      process.env.RAYSPEC_SPEC_PATH = specPath;
      if (updateMigrationPath) process.env.RAYSPEC_UPDATE_MIGRATION = updateMigrationPath;
      else delete process.env.RAYSPEC_UPDATE_MIGRATION;
      if (allowlistPath) process.env.RAYSPEC_UPDATE_ALLOWLIST = allowlistPath;
      else delete process.env.RAYSPEC_UPDATE_ALLOWLIST;
      const config = loadServerConfig();
      return assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
        productDeterministicAgents: deterministicAgents(),
        productSttAdapter: new FakeSttAdapter({ fixtures: [] }),
      });
    }

    /** Is a table present in the live public schema? (ground truth for CREATE / drift). */
    async function tableExists(dbUrl: string, table: string): Promise<boolean> {
      const c = postgres(dbUrl, { max: 1 });
      try {
        const rows = await c`
          select 1 from information_schema.tables
          where table_schema = 'public' and table_name = ${table}`;
        return rows.length > 0;
      } finally {
        await c.end();
      }
    }

    beforeAll(async () => {
      if (!baseUrl) return;
      appDbUrl = withDbName(baseUrl, SUITE_DB);
      incompleteDbUrl = withDbName(baseUrl, INCOMPLETE_DB);
      destDbUrl = withDbName(baseUrl, DEST_DB);
      absentDbUrl = withDbName(baseUrl, ABSENT_DB);
      dbosSysDb = `${SUITE_DB}_dbos_sys`;

      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const d of [dbosSysDb, SUITE_DB, INCOMPLETE_DB, DEST_DB, ABSENT_DB]) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
        }
        for (const d of [SUITE_DB, INCOMPLETE_DB, DEST_DB, ABSENT_DB]) {
          await admin.unsafe(`CREATE DATABASE "${d}"`);
        }
      } finally {
        await admin.end();
      }

      blobDir = mkdtempSync(join(tmpdir(), 'rayspec-product-update-'));
      tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-product-update-sql-'));
      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'product-update-pepper-only';
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8804';
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      process.env.STT_PROVIDER = 'fake';
      process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
      process.env.RAYSPEC_BLOB_ROOT = blobDir;
      process.env.RAYSPEC_MEDIA_SIGNING_KEY = 'product-update-media-secret-at-least-32-bytes-x';
      delete process.env.RAYSPEC_UPDATE_MIGRATION;
      delete process.env.RAYSPEC_UPDATE_ALLOWLIST;
    }, 180_000);

    afterAll(async () => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (blobDir) rmSync(blobDir, { recursive: true, force: true });
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      if (baseUrl) {
        const admin = postgres(adminUrl(baseUrl), { max: 1 });
        try {
          for (const d of [dbosSysDb, SUITE_DB, INCOMPLETE_DB, DEST_DB, ABSENT_DB]) {
            await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
          }
        } finally {
          await admin.end();
        }
      }
    }, 120_000);

    const maybe = baseUrl ? it : it.skip;

    // ── Arm 2 (no launch — runs FIRST so the ONE DBOS launch is the last DBOS action in the file) ──
    maybe(
      'INCOMPLETE delta under-reconciles the NEW spec → the post-update drift GATE fails closed (no green boot)',
      async () => {
        armsRan += 1;
        const v1 = composedStores(specOf(V1_YAML));
        const v2 = composedStores(specOf(V2_YAML));
        // v2-partial = v2 minus `highlights` — the delta the operator would author to add ONLY pinned_moments.
        const v2Partial = v2.filter((s) => s.name !== 'highlights');
        await materializeV1(incompleteDbUrl, { seedRow: false });
        // The delta creates pinned_moments only; the NEW spec (v2) also declares highlights ⇒ residual drift.
        const incompletePath = writeDelta(v1, v2Partial, '0001_incomplete_add_pinned');

        // Boot v2 (target) in UPDATE mode with the incomplete delta. deploy() applies CREATE pinned_moments
        // (committed), then the post-migrate drift check finds highlights still missing → the S4 gate throws
        // a ProductBootError BEFORE executor.start() (no DBOS launch). Against the UNGATED product-boot this
        // resolves to a BootedServer (deployMode 'updated', non-empty drift) — the delayed-brick RED.
        const err = await boot(V2_YAML, incompleteDbUrl, incompletePath).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProductBootError);
        expect((err as Error).message).toMatch(/STILL DRIFTED/);
        // GROUND TRUTH: the delta really committed a MID-STATE — pinned_moments applied, highlights did not.
        expect(await tableExists(incompleteDbUrl, 'pinned_moments')).toBe(true);
        expect(await tableExists(incompleteDbUrl, 'highlights')).toBe(false);
      },
      180_000,
    );

    // ── Arm 2: the SUBSET-DESTRUCTIVE update through the REAL boot() — the ONE product boot / launch ──
    maybe(
      'SUBSET-DESTRUCTIVE delta (v2→v1) APPLIES through boot(): present-matching + target-exists → deployMode "updated", targets DROPPED, the seeded row SURVIVES, drift-clean vs v1; a leftover env is then REBOOT-SAFE',
      async () => {
        armsRan += 1;
        const v1 = composedStores(specOf(V1_YAML));
        const v2 = composedStores(specOf(V2_YAML));
        // Materialize v2 (the SUPERSET) + seed a row in note_artifacts (a store that SURVIVES v1).
        const seededId = await materialize(appDbUrl, v2, { seedRow: true });
        expect(seededId).toBeTruthy();
        // Pre-update GROUND TRUTH: both extra stores (the reviewed drop targets) exist.
        expect(await tableExists(appDbUrl, 'pinned_moments')).toBe(true);
        expect(await tableExists(appDbUrl, 'highlights')).toBe(true);

        // Probe-SQL ground truth: makeSchemaProbe resolves EVERY superset-blind kind correctly
        // against the LIVE v2 schema (a wrong probe that reports a PRESENT target as GONE would route an
        // unapplied subset update to MOUNT — the exact silent-loss the fix guards against). Index +
        // constraint names are discovered from the catalog so this never hardcodes generator naming.
        const pdb = postgres(appDbUrl, { max: 1 });
        try {
          const q = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
            (await pdb.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
          const probe = makeSchemaProbe(q, 'public');
          const [idxRow] = (await pdb`
            select i.relname from pg_class i join pg_namespace ns on ns.oid = i.relnamespace
            where i.relkind in ('i', 'I') and ns.nspname = 'public' limit 1`) as unknown as Array<{
            relname: string;
          }>;
          const [conRow] = (await pdb`
            select rel.relname as tbl, con.conname from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
            join pg_namespace ns on ns.oid = rel.relnamespace
            where ns.nspname = 'public' and con.contype = 'f' limit 1`) as unknown as Array<{
            tbl: string;
            conname: string;
          }>;
          expect(idxRow?.relname).toBeTruthy();
          expect(conRow?.conname).toBeTruthy();
          // drop-table
          expect(await probe({ kind: 'drop-table', table: 'highlights' })).toBe(true);
          expect(await probe({ kind: 'drop-table', table: 'no_such_table_xyz' })).toBe(false);
          // drop-column (tenant_id is injected on every product store)
          expect(
            await probe({ kind: 'drop-column', table: 'highlights', column: 'tenant_id' }),
          ).toBe(true);
          expect(
            await probe({ kind: 'drop-column', table: 'highlights', column: 'no_such_col' }),
          ).toBe(false);
          // drop-index
          expect(await probe({ kind: 'drop-index', index: idxRow!.relname })).toBe(true);
          expect(await probe({ kind: 'drop-index', index: 'no_such_index_xyz' })).toBe(false);
          // drop-constraint
          expect(
            await probe({
              kind: 'drop-constraint',
              table: conRow!.tbl,
              constraint: conRow!.conname,
            }),
          ).toBe(true);
          expect(
            await probe({
              kind: 'drop-constraint',
              table: conRow!.tbl,
              constraint: 'no_such_constraint_xyz',
            }),
          ).toBe(false);
        } finally {
          await pdb.end();
        }

        // The reviewed v2→v1 pure-DROP delta (drops pinned_moments + highlights) + its machine-proposed
        // reviewed allowlist — exactly what `rayspec plan v1 --against v2` would author for a removal.
        const diff = diffProductStores(v2, v1, { label: '0002_drop_pinned_and_highlights' });
        expect(diff.destructive).toBe(true);
        expect(diff.proposedAllowlist.length).toBeGreaterThan(0);
        const deltaPath = join(tmpDir, '0002_drop_pinned_and_highlights.sql');
        const allowlistPath = join(tmpDir, '0002_drop_pinned_and_highlights.allowlist.json');
        writeFileSync(deltaPath, diff.migrationSql, 'utf8');
        writeFileSync(allowlistPath, JSON.stringify(diff.proposedAllowlist), 'utf8');

        // Boot spec v1 (the SUBSET) with the drop delta. present-matching (superset-blind) BUT the drop
        // targets STILL EXIST → planUpdateBoot PROBES them and routes to APPLY. (Against an earlier
        // boot this MOUNTED green, targets intact — deployMode 'mounted', the reviewed drop silently lost.)
        const server = await boot(V1_YAML, appDbUrl, deltaPath, allowlistPath);
        try {
          expect(server.deployMode).toBe('updated'); // APPLIES — not 'mounted' (the RED against the earlier boot)
          expect(server.drift).toEqual([]); // the drops fully reconcile the superset to the v1 subset
          // GROUND TRUTH: both reviewed drop targets are GONE.
          expect(await tableExists(appDbUrl, 'pinned_moments')).toBe(false);
          expect(await tableExists(appDbUrl, 'highlights')).toBe(false);
          // The seeded row in the SURVIVING store is intact (the delta only DROPPED the removed stores).
          const c = postgres(appDbUrl, { max: 1 });
          try {
            const rows = (await c`
              select payload from note_artifacts where id = ${seededId!}`) as unknown as Array<{
              payload: { headline?: string };
            }>;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.payload?.headline).toBe('survive me');
          } finally {
            await c.end();
          }
        } finally {
          await server.close();
        }

        // Arm 2b: a plain reboot (no update env) present-matches v1 → it would MOUNT (drift-clean),
        // proven through the REAL classifier the reboot path uses, without a second DBOS launch.
        const c = postgres(appDbUrl, { max: 1 });
        let schemaState: ReturnType<typeof classifyProductSchema>;
        try {
          const queryFn = async (
            sql: string,
            params: unknown[],
          ): Promise<Record<string, unknown>[]> =>
            (await c.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
          const drift = await detectDrift(v1, 'public', queryFn);
          schemaState = classifyProductSchema(v1, drift);
          expect(schemaState).toBe('present-matching');
        } finally {
          await c.end();
        }

        // ── Arm 2c (case-(A), leftover-env reboot-safety preserved): a LEFTOVER env after the destructive update is
        // REBOOT-SAFE. The env is PERSISTENT (docker-compose/.env-prod), re-read on every restart. Both
        // facts launch-free (the ONE DBOS launch above is spent — a second is unsafe, see the file header):
        //
        //  (RED — the crash-loop the mount prevents) re-applying the SAME reviewed DROP delta to the now-v1
        //  schema — where the targets are already GONE — CRASHES with Postgres 42P01 (relation "highlights"
        //  does not exist): the delta is non-idempotent and deploy() keeps no applied-ledger.
        const reapplyDdl = readFileSync(deltaPath, 'utf8').replace(
          /-->\s*statement-breakpoint/g,
          '',
        );
        const rdb = makeDb(appDbUrl);
        try {
          const reapplyErr = await rdb.$client
            .begin(async (tx) => {
              await tx.unsafe(reapplyDdl);
            })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
          expect(reapplyErr).toBeInstanceOf(Error);
          // 42P01 = undefined_table; postgres.js surfaces the code + "does not exist".
          expect(String((reapplyErr as { code?: string })?.code ?? '')).toBe('42P01');
          expect((reapplyErr as Error).message).toMatch(/does not exist/i);
        } finally {
          await rdb.$client.end();
        }

        //  (GREEN — the boot discriminates via the live probe) planUpdateBoot over the REAL present-matching
        //  classify + a REAL live-schema probe sees BOTH drop targets GONE → routes to MOUNT (ZERO
        //  migrations, no re-apply) + the loud log. This is the exact decision the live boot makes on the
        //  next restart with the env still set — a genuine leftover, NOT an unapplied subset update.
        const pc = postgres(appDbUrl, { max: 1 });
        try {
          const queryFn = async (
            sql: string,
            params: unknown[],
          ): Promise<Record<string, unknown>[]> =>
            (await pc.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
          const warnings: string[] = [];
          const leftoverDelta = readProductUpdateMigrations({
            migrationPath: deltaPath,
            allowlistPath,
          });
          const plan = await planUpdateBoot(
            schemaState,
            leftoverDelta!,
            V1_YAML,
            (m) => warnings.push(m),
            makeSchemaProbe(queryFn, 'public'),
          );
          expect(plan.deployMode).toBe('mounted'); // MOUNTS — the drop targets are gone (a genuine leftover)
          expect(plan.migrations).toEqual([]); // the non-idempotent drop delta is NOT re-applied
          expect(warnings).toEqual([LEFTOVER_UPDATE_ENV_MOUNT_LOG]); // the operator is told to clear the env
        } finally {
          await pc.end();
        }
      },
      180_000,
    );

    // ── Arm 3 (through boot): the SUBSET-DESTRUCTIVE gate BLOCKS when the reviewed allowlist is ABSENT ──
    // The SAME v2→v1 drop delta, but the env carries NO RAYSPEC_UPDATE_ALLOWLIST (readReviewedAllowlist ⇒
    // []). planUpdateBoot routes present-matching+target-exists to APPLY → deploy()'s lint/gate REFUSES the
    // DROP (a destructive statement with no covering reviewed entry) → boot throws a DeployError BEFORE
    // executor.start() (launch-free), the schema INTACT. This is the through-boot replacement for the old
    // hand-rolled direct-gate arm (that workaround existed only because an earlier boot MOUNTED a subset
    // drop instead of routing it to deploy()'s gate).
    maybe(
      'SUBSET-DESTRUCTIVE delta with NO reviewed allowlist → boot()’s deploy() gate BLOCKS it (DeployError at lint/gate), schema INTACT, no launch',
      async () => {
        armsRan += 1;
        const v1 = composedStores(specOf(V1_YAML));
        const v2 = composedStores(specOf(V2_YAML));
        await materialize(destDbUrl, v2, { seedRow: false }); // v2 schema — both drop targets present
        const diff = diffProductStores(v2, v1, { label: '0002_drop_blocked' });
        expect(diff.destructive).toBe(true);
        const deltaPath = join(tmpDir, '0002_drop_blocked.sql');
        writeFileSync(deltaPath, diff.migrationSql, 'utf8');

        // Boot with the delta but NO allowlist path → deploy()'s gate blocks the DROP fail-closed.
        const err = await boot(V1_YAML, destDbUrl, deltaPath /* no allowlistPath */).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(DeployError);
        expect((err as DeployError).step).toBe('lint/gate');
        // GROUND TRUTH: fail-closed at the gate — the DROP never applied, the schema is INTACT.
        expect(await tableExists(destDbUrl, 'highlights')).toBe(true);
        expect(await tableExists(destDbUrl, 'pinned_moments')).toBe(true);
      },
      180_000,
    );

    // ── Arm 4: update env on an ABSENT schema (a first boot) REFUSES actionably, fail-closed ──
    // A FULL boot() with RAYSPEC_UPDATE_MIGRATION set against a DB that has NO product stores yet.
    // The classify preflight sees 'absent' and throws the actionable ProductBootError BEFORE deploy()
    // and BEFORE executor.start() — launch-free. RED-first: against an earlier boot this proceeds into
    // deploy() (migrations = updateMigrations), applies a PARTIAL schema, and the post-update drift gate
    // throws "STILL DRIFTED" instead — a different, non-actionable error. The assertion pins the boot's actionable
    // message (a first-materialization operator is told to REMOVE the env), which only the fix produces.
    maybe(
      'ABSENT schema + update env (a first boot) → REFUSES actionably (remove the env for a first materialization)',
      async () => {
        armsRan += 1;
        await materializeEmpty(absentDbUrl); // platform chain + org, NO product stores
        const v1 = composedStores(specOf(V1_YAML));
        const v2 = composedStores(specOf(V2_YAML));
        const deltaPath = writeDelta(v1, v2, '0001_add_pinned_and_highlights_absent');

        const err = await boot(V2_YAML, absentDbUrl, deltaPath).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProductBootError);
        expect((err as Error).message).toMatch(/NO product schema is materialized yet/);
        expect((err as Error).message).toMatch(/REMOVE RAYSPEC_UPDATE_MIGRATION/);
        // GROUND TRUTH: fail-closed — the delta was NEVER applied (no partial materialization).
        expect(await tableExists(absentDbUrl, 'pinned_moments')).toBe(false);
        expect(await tableExists(absentDbUrl, 'highlights')).toBe(false);
      },
      180_000,
    );
  },
);

/**
 * Ran-guard (the false-green class): a SEPARATE, NON-skipped describe that
 * FAILS the run when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms did NOT run.
 * Registered with NO beforeAll dependency, so a suite whose setup throws-and-skips still leaves `armsRan`
 * at 0 and THIS fails. A local dev with no DB skips ergonomically. FOUR arms: INCOMPLETE, SUBSET-DESTRUCTIVE
 * APPLIES-through-boot (+ the leftover-env reboot-safety tail), BLOCKED-through-boot, ABSENT-refuse.
 */
describe('Product-YAML update seam — ran-guard (the 0.2 update-seam arms must not silently skip)', () => {
  it('the four update-seam arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(4);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
