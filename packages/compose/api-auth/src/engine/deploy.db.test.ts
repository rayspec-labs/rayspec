/**
 * EXIT-GATE CRITERION 2 — the BREAKING-SCHEMA-CHANGE PROOF, DB-backed end-to-end.
 *
 * A destructive store change (DROP a declared column) is:
 *   1. BLOCKED by the migration gate (`scanMigrationSql`) when applied UNREVIEWED → deploy() aborts
 *      at [lint/gate], and the destructive statement is NEVER applied (the live table is unchanged);
 *   2. applied SAFELY ONLY with a REVIEWED allowlist entry — and AFTER it applies, the live schema
 *      matches the spec (CLEAN drift-detect) because the contract migration accompanies a spec that
 * removed the column (the honest expand-contract forward-fix; — no down-migrations);
 *   3. drift-detect is NON-VACUOUS — deploying the ORIGINAL spec (still declaring the column) against
 *      the now-dropped live schema FLAGS a missing-column drift (proving the gate compares spec↔live).
 *
 * This drives the REAL `deploy()` GitOps pipeline against a live, isolated-schema Postgres (the SAME
 * pipeline the throwaway acceptance run uses). NOT pass-the-shape: the BLOCKED arm
 * asserts the column is STILL THERE after the abort (the destructive SQL really didn't run); the
 * APPLIED arm asserts the column is GONE + drift is clean; the non-vacuity arm asserts drift FLAGS the
 * mismatch. The whole lifecycle runs as ONE ordered flow so there is no fragile cross-test schema
 * coupling (each step's precondition is the previous step's asserted postcondition).
 *
 * Skips when DATABASE_URL is absent.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend, BackendId } from '@rayspec/core';
import { generateProductSql } from '@rayspec/db';
import { typeStrippingImporter } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createDeployHarness, type DeployHarness } from '../test-support/harness.js';
import { DeployError, deploy } from './deploy.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the breaking-schema-change migration gate — it
// must never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail here.
if (requireDb && !hasDb) {
  throw new Error(
    'deploy.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const ACME_DIR = resolve(here, '../../../../../examples/acme-notes-backend');
const YAML_PATH = resolve(ACME_DIR, 'rayspec.yaml');

function loadSpec(): RaySpec {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe.skipIf(!hasDb)('breaking-schema-change proof (REAL deploy() end-to-end)', () => {
  let h: DeployHarness;
  const SCHEMA = 'rayspec_test_deploy_breaking';
  const baseSpec = loadSpec();
  const ORIGINAL_YAML = readFileSync(YAML_PATH, 'utf8');
  const DROP_SUBTITLE_SQL = 'ALTER TABLE "notebooks" DROP COLUMN "subtitle";';

  /** The throwaway YAML with the `notebooks.subtitle` column LINE removed (the contract spec). */
  const CONTRACT_YAML = ORIGINAL_YAML.replace(
    /\n\s*-\s*\{ name: subtitle, type: text, nullable: true \}/,
    '',
  );

  /** Count `notebooks.subtitle` columns in the isolated schema (1 = present, 0 = dropped). */
  async function subtitleColumnCount(): Promise<number> {
    const rows = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS c FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='notebooks' AND column_name='subtitle'`,
      [SCHEMA],
    )) as unknown as Array<{ c: number }>;
    return rows[0]?.c ?? -1;
  }

  /** A deploy() call with the common rollout (product tables already registered by the harness). */
  function runDeploy(args: {
    specSource: string;
    migrations: Parameters<typeof deploy>[0]['migrations'];
  }) {
    return deploy({
      specSource: args.specSource,
      migrations: args.migrations,
      target: h.target,
      rollout: {
        productTables: h.productTables,
        escapeHatchRoot: ACME_DIR,
        // The throwaway declares an {agent} route (summarizer) + a tool whose handler the loader
        // resolves; supply the backend so the engine builds the agent registry (the breaking-change
        // proof itself does not RUN the agent — it only needs the deploy to roll out successfully).
        agentBackends: backends,
        buildApp: h.buildApp,
        // The throwaway ships un-built `.ts` example handlers; opt into the type-stripping importer seam
        // (production loads compiled `.js` only — this is the single, explicit source seam).
        importer: typeStrippingImporter,
      },
    });
  }

  const backends: ReadonlyMap<BackendId, Backend> = new Map<BackendId, Backend>([
    ['openai', new FakeRunBackend()],
  ]);

  beforeAll(async () => {
    h = await createDeployHarness({ stores: baseSpec.stores, schema: SCHEMA });
  });
  afterAll(async () => {
    await h.close();
  });

  it('the full breaking-change lifecycle: materialize → BLOCK unreviewed → APPLY reviewed → drift non-vacuous', async () => {
    // --- STEP 0: materialize the throwaway (notebooks WITH subtitle) via the real deploy() ---------
    await runDeploy({
      specSource: ORIGINAL_YAML,
      migrations: [
        {
          name: '0000_product_stores.sql',
          sql: generateProductSql(baseSpec.stores),
          allowlist: [],
        },
      ],
    });
    expect(await subtitleColumnCount()).toBe(1); // starting state: column present

    // --- STEP 1: BLOCKED unreviewed — the DROP COLUMN aborts at [lint/gate], column NOT dropped ---
    const blockedErr = await runDeploy({
      specSource: CONTRACT_YAML,
      migrations: [{ name: '0001_drop_subtitle.sql', sql: DROP_SUBTITLE_SQL }], // NO allowlist
    }).catch((e) => e);
    expect(blockedErr).toBeInstanceOf(DeployError);
    expect((blockedErr as DeployError).step).toBe('lint/gate');
    // GROUND TRUTH: the destructive SQL was NEVER applied — the column is still there.
    expect(await subtitleColumnCount()).toBe(1);

    // --- STEP 2: APPLIES safely with a REVIEWED allowlist → column dropped + drift CLEAN ----------
    const applied = await runDeploy({
      specSource: CONTRACT_YAML,
      migrations: [
        {
          name: '0001_drop_subtitle.sql',
          sql: DROP_SUBTITLE_SQL,
          allowlist: [
            {
              kind: 'drop-column',
              match: DROP_SUBTITLE_SQL,
              reason:
                'notebooks.subtitle removed via a reviewed forward migration ' +
                '(expand-contract; no down-migrations).',
            },
          ],
        },
      ],
    });
    expect(applied.gateResults[0]?.pass).toBe(true); // the gate PASSED for the reviewed statement
    expect(await subtitleColumnCount()).toBe(0); // GROUND TRUTH: the migration really applied
    // DRIFT CLEAN: the live schema (subtitle dropped) matches the contract spec (no subtitle).
    expect(applied.drift).toEqual([]);
    expect(
      applied.spec.stores
        .find((s) => s.name === 'notebooks')
        ?.columns.some((c) => c.name === 'subtitle'),
    ).toBe(false);

    // --- STEP 3: drift-detect is NON-VACUOUS — the ORIGINAL spec (WITH subtitle) now FLAGS drift --
    // Re-deploy the original spec (still declares subtitle) with NO migration against the live schema
    // (column gone). Drift MUST report the mismatch (report-only — the deploy still succeeds). This
    // proves drift-detect actually compares the spec to the live schema, not a vacuous pass.
    const reverted = await runDeploy({ specSource: ORIGINAL_YAML, migrations: [] });
    expect(reverted.drift.some((d) => d.table === 'notebooks' && d.column === 'subtitle')).toBe(
      true,
    );
  });
});
