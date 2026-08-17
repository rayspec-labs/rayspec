/**
 * deploy pipeline UNIT tests (the gate half of) — NO DB.
 *
 * These exercise the abort-on-fail control flow + the breaking-change GATE-LEVEL proof WITHOUT a
 * database (so they always run in CI, even where DATABASE_URL is absent). The DB-backed END-TO-END
 * breaking-change proof (the migration actually applies safely with the allowlist + clean drift) is
 * in deploy.db.test.ts. Each test is FAIL-THE-FIX: it asserts deploy ABORTS at the
 * exact step (and that LATER steps NEVER ran), not merely "it threw".
 */
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { DeclarativeEngine } from '../app-context.js';
import {
  DeployError,
  type DeployTarget,
  deploy,
  type PlannedMigration,
  type RolloutConfig,
} from './deploy.js';

/** A minimal valid throwaway-shaped YAML (no stores → the verify/drift steps are no-ops). */
const STORELESS_YAML = `
version: '1.0'
metadata:
  name: storeless
`;

/** A valid YAML with ONE store (so verify/migrate steps run). */
const ONE_STORE_YAML = `
version: '1.0'
metadata:
  name: one-store
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
`;

/** A target that records what it was asked to do (so we can assert later steps did NOT run). */
function recordingTarget(
  overrides: Partial<DeployTarget> = {},
): DeployTarget & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    async applyMigration(m: PlannedMigration) {
      applied.push(m.name);
    },
    verifyTenantScoped() {
      /* admitted (registered) by default */
    },
    async query() {
      return [];
    },
    ...overrides,
  };
}

/** A rollout whose `buildApp` returns a sentinel (no real app needed for the control-flow tests). */
function rollout(overrides: Partial<RolloutConfig> = {}): RolloutConfig {
  return {
    productTables: new Map<string, PgTable>(),
    escapeHatchRoot: '/tmp/does-not-matter',
    // No handlers in these specs, so loadHandlers([]) resolves to an empty map without importing.
    buildApp<App>(_engine: DeclarativeEngine): App {
      return { sentinel: true } as App;
    },
    ...overrides,
  };
}

describe('deploy() — abort-on-fail control flow', () => {
  it('VALIDATE: an invalid spec aborts at [validate]; NO migration is applied', async () => {
    const target = recordingTarget();
    await expect(
      deploy({
        specSource: 'version: "9.9"\nmetadata: { name: x }', // unsupported major
        migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
        target,
        rollout: rollout(),
      }),
    ).rejects.toMatchObject({ step: 'validate' });
    expect(target.applied).toEqual([]); // nothing downstream ran
  });

  it('PRODUCT-YAML (valid, NO rollout.productYaml): aborts at [unsupported_spec]; NO migration applied', async () => {
    // a valid Product-YAML doc IS mountable — but ONLY with a deployer-supplied
    // rollout.productYaml composition. Without it, deploy() must keep REJECTING the mount
    // fail-closed (actionable message) — never a silent inert mount, and no migration runs.
    const target = recordingTarget();
    const err = await deploy({
      specSource: 'version: "1.0"\nproduct:\n  id: acme_notes\n  name: Acme Notes\n',
      migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
      target,
      rollout: rollout(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).step).toBe('unsupported_spec');
    expect((err as DeployError).message).toMatch(/rollout\.productYaml/);
    expect(target.applied).toEqual([]); // nothing downstream ran
  });

  it('PRODUCT-YAML (valid, WITH rollout.productYaml, unwired section): aborts at [unsupported_spec] naming it', async () => {
    // partial-unlock honesty through the REAL deploy path: a declared section the composition
    // has no runtime for REJECTS the deploy naming the section (composeProductDeploy's fail-closed
    // rejection mapped onto DeployError) — and nothing downstream runs.
    const target = recordingTarget();
    const err = await deploy({
      specSource:
        'version: "1.0"\nproduct:\n  id: p\n  name: P\ncapabilities:\n' +
        '  - id: knowledge_base\n    tier: B\n    status: available\n    contracts: [knowledge_base.query]\n',
      migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
      target,
      rollout: rollout({
        productYaml: {
          tenantId: '00000000-0000-0000-0000-0000000000d5',
          enqueuer: {
            enqueueWorkflowRun: async () => ({ workflowRunId: 'never', deduped: false }),
          },
        },
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).step).toBe('unsupported_spec');
    expect((err as DeployError).message).toMatch(/knowledge_base/);
    expect(target.applied).toEqual([]); // nothing downstream ran
  });

  it('PRODUCT-YAML: a view route on a RESERVED path aborts at [validate], before MIGRATE', async () => {
    // Issue #441's ordering guarantee, for the profile that never reaches `lintSpec`. A Product-YAML
    // document is parsed by `parseProductSpec` and COMPOSED, so the lint rule that refuses a reserved
    // route never runs on it, and `views[].route.path` is author-controlled. Before this check the
    // only guard was the registrar inside `buildApp` — deploy step 5 ROLL OUT, after step 4 MIGRATE
    // had already committed the product DDL. The `applied` assertion is the whole point: the refusal
    // has to arrive while the database is still untouched, not merely arrive.
    const target = recordingTarget();
    const doc = (path: string): string =>
      'version: "1.0"\nproduct:\n  id: p\n  name: P\n' +
      'contracts:\n  note.response:\n    type: object\n    properties:\n      note_ref: { type: string }\n      note_text: { type: [string, "null"] }\n    required: [note_ref]\n' +
      'stores:\n  - name: notes\n    columns:\n' +
      '      - { name: note_ref, type: text }\n' +
      '      - { name: note_text, type: text, nullable: true }\n' +
      '    key: [note_ref]\n' +
      'views:\n  - id: v\n    route:\n' +
      `      method: GET\n      path: "${path}"\n` +
      '    auth: bearer_tenant\n' +
      '    params:\n      note_ref: { in: path, shape: safe_id }\n' +
      '    source: { kind: store, ref: notes }\n' +
      '    read:\n      mode: single\n' +
      '      filter:\n        note_ref: { param: note_ref }\n' +
      '      shape:\n        fields:\n' +
      '          note_ref: { kind: param, param: note_ref }\n' +
      '          note_text: { kind: column, column: note_text, type: string, default: "" }\n' +
      '      absent:\n        fields:\n' +
      '          note_ref: { kind: param, param: note_ref }\n' +
      '          note_text: { kind: const, value: null }\n' +
      '    absent_state: empty_200\n' +
      '    response_contract: note.response\n';
    // The store the view reads has to be a DECLARED store of the deployment, or the composer refuses
    // at [roll out] before the reserved-path check is reached — which would make this test pass for
    // the wrong reason.
    const productRollout = {
      tenantId: '00000000-0000-0000-0000-0000000000d5',
      enqueuer: {
        enqueueWorkflowRun: async () => ({ workflowRunId: 'never', deduped: false }),
      },
      stores: [
        {
          name: 'notes',
          columns: [
            { name: 'note_ref', type: 'text' as const },
            { name: 'note_text', type: 'text' as const, nullable: true },
          ],
          key: ['note_ref'],
        },
      ],
    };

    const err = await deploy({
      specSource: doc('/health/{note_ref}'),
      migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
      target,
      rollout: rollout({ productYaml: productRollout }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).step).toBe('validate');
    // The refusal rides in `details` because the product view lint reports it as a `SpecError`, which
    // is what puts the SAME sentence in front of `doctor` and `plan` as well.
    const detail = ((err as DeployError).details ?? []) as { code?: string; message?: string }[];
    expect(detail.some((d) => d.code === 'reserved_route_path')).toBe(true);
    expect(detail.map((d) => d.message).join('\n')).toMatch(
      /is under a path this deployment reserves/,
    );
    expect(target.applied, 'refused BEFORE any product DDL was committed').toEqual([]);

    // A leading PARAMETER gets the placeholder sentence here too — the same words the floor uses.
    const viaParam = await deploy({
      specSource: doc('/{note_ref}/notes'),
      migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
      target: recordingTarget(),
      rollout: rollout({ productYaml: productRollout }),
    }).catch((e) => e);
    expect((viaParam as DeployError).step).toBe('validate');
    const paramDetail = ((viaParam as DeployError).details ?? []) as { message?: string }[];
    expect(paramDetail.map((d) => d.message).join('\n')).toMatch(
      /begins with a PARAMETER or WILDCARD/,
    );

    // ACCEPT CONTROL: an ordinary route is NOT refused by this check, so the two arms above are not
    // a guard that refuses everything — which would look identical to a correct one on both of them.
    // Asserted at the STEP the check runs in rather than on a completed deploy: this unit harness
    // supplies an empty `productTables`, so a product deploy that gets past VALIDATE crashes further
    // down for reasons this test is not about. What must hold is that it gets past.
    const okTarget = recordingTarget();
    const okErr = await deploy({
      specSource: doc('/notes/{note_ref}'),
      migrations: [{ name: '0000.sql', sql: 'CREATE TABLE x ();' }],
      target: okTarget,
      rollout: rollout({ productYaml: productRollout }),
    }).catch((e) => e);
    const okStep = okErr instanceof DeployError ? okErr.step : undefined;
    const okMessage = okErr instanceof Error ? okErr.message : '';
    expect(okStep, 'an ordinary product route is not refused at VALIDATE').not.toBe('validate');
    expect(okMessage).not.toMatch(/is under a path this deployment reserves/);
    expect(okMessage).not.toMatch(/begins with a PARAMETER or WILDCARD/);
  });

  it('PRODUCT-YAML (invalid): an invalid Product-YAML doc aborts at [validate] with its SpecError list', async () => {
    // An INVALID product doc surfaces the FULL product validation errors (not the mount rejection).
    // `status: available` is doc-valid now (wiredness moved to the deploy composition); the
    // invalid vehicle here is a DANGLING `requires` ref — a genuine doc-level defect.
    const target = recordingTarget();
    const err = await deploy({
      specSource:
        'version: "1.0"\nproduct:\n  id: p\n  name: P\nrequires:\n  capabilities:\n    - ghost\n',
      migrations: [],
      target,
      rollout: rollout(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).step).toBe('validate');
    const details = (err as DeployError).details ?? [];
    expect(details.some((d) => 'code' in d && d.code === 'dangling_ref')).toBe(true);
    expect(target.applied).toEqual([]);
  });

  it('LINT/GATE: an unreviewed DESTRUCTIVE migration aborts at [lint/gate]; NO migration is applied', async () => {
    const target = recordingTarget();
    await expect(
      deploy({
        specSource: ONE_STORE_YAML,
        migrations: [{ name: '0001_drop.sql', sql: 'ALTER TABLE "widgets" DROP COLUMN "label";' }],
        target,
        rollout: rollout(),
      }),
    ).rejects.toMatchObject({ step: 'lint/gate' });
    expect(target.applied).toEqual([]); // the gate blocked BEFORE migrate
  });

  it('MIGRATE: a migration that FAILS TO APPLY aborts at [migrate]; roll-out NEVER runs', async () => {
    const buildApp = vi.fn(<App>() => ({}) as App);
    const target = recordingTarget({
      async applyMigration() {
        throw new Error('syntax error at or near "FROBNICATE"');
      },
    });
    await expect(
      deploy({
        specSource: ONE_STORE_YAML,
        migrations: [{ name: '0002_bad.sql', sql: 'FROBNICATE;' }], // not destructive (passes gate), fails apply
        target,
        rollout: rollout({ buildApp }),
      }),
    ).rejects.toMatchObject({ step: 'migrate' });
    expect(buildApp).not.toHaveBeenCalled(); // no partial roll-out
  });

  it('ROLL OUT: a store whose table is NOT registered (chokepoint rejects) aborts at [roll out]', async () => {
    const buildApp = vi.fn(<App>() => ({}) as App);
    const target = recordingTarget({
      verifyTenantScoped() {
        throw new Error('TenantDb: table is not registered in TENANT_SCOPED_TABLES');
      },
    });
    await expect(
      deploy({
        specSource: ONE_STORE_YAML,
        migrations: [{ name: '0003_add.sql', sql: 'CREATE TABLE "widgets" ();' }],
        target,
        // productTables present (so the per-store entry exists) but the chokepoint rejects it.
        rollout: rollout({ productTables: new Map([['widgets', {} as PgTable]]), buildApp }),
      }),
    ).rejects.toMatchObject({ step: 'roll out' });
    expect(buildApp).not.toHaveBeenCalled();
  });

  it('ROLL OUT: a declared store with NO supplied product table aborts at [roll out] (fail-closed)', async () => {
    const target = recordingTarget();
    await expect(
      deploy({
        specSource: ONE_STORE_YAML,
        migrations: [{ name: '0004_add.sql', sql: 'CREATE TABLE "widgets" ();' }],
        target,
        rollout: rollout({ productTables: new Map() }), // widgets missing
      }),
    ).rejects.toMatchObject({ step: 'roll out' });
  });

  it('MIGRATE: with [good, bad] migrations, the good one applies, the bad aborts at [migrate], roll-out never runs', async () => {
    // Pins the documented per-migration-tx forward-fix contract: migrations apply
    // SEQUENTIALLY; a later one that throws aborts at [migrate] and the prior (good) one is NOT rolled
    // back (there are no down-migrations — recovery is a new forward migration). buildApp must never be
    // reached. The recordingTarget records each migration it applied (the override records the good one
    // and throws on the bad one), so `applied` proves ONLY the good migration was applied before abort.
    const buildApp = vi.fn(<App>() => ({}) as App);
    const target = recordingTarget({
      async applyMigration(m: PlannedMigration) {
        if (m.name === '0007_bad.sql') throw new Error('syntax error at or near "FROBNICATE"');
        target.applied.push(m.name);
      },
    });
    await expect(
      deploy({
        specSource: ONE_STORE_YAML,
        migrations: [
          { name: '0006_good.sql', sql: 'CREATE TABLE "extra" ();' }, // additive, passes gate + applies
          { name: '0007_bad.sql', sql: 'FROBNICATE;' }, // not destructive (passes gate), fails apply
        ],
        target,
        rollout: rollout({ productTables: new Map([['widgets', {} as PgTable]]), buildApp }),
      }),
    ).rejects.toMatchObject({ step: 'migrate' });
    // ONLY the good migration applied (sequential apply + abort; the prior good apply is NOT undone).
    expect(target.applied).toEqual(['0006_good.sql']);
    // Roll-out never ran (no partial roll-out past a failed migrate).
    expect(buildApp).not.toHaveBeenCalled();
  });

  it('a storeless spec deploys: gate passes, app built, drift empty (verify/migrate/drift no-op)', async () => {
    const buildApp = vi.fn(<App>() => ({ ok: true }) as App);
    const target = recordingTarget();
    const result = await deploy({
      specSource: STORELESS_YAML,
      migrations: [],
      target,
      rollout: rollout({ buildApp }),
    });
    expect(buildApp).toHaveBeenCalledTimes(1);
    expect(result.drift).toEqual([]);
    expect(result.triggers.size).toBe(0);
    expect(result.app).toEqual({ ok: true });
  });
});

describe('deploy — the BREAKING-CHANGE gate proof (gate-level, no DB)', () => {
  // A destructive store change: drop a declared column on the materialized `meetings` table.
  const DROP_COLUMN_SQL = 'ALTER TABLE "meetings" DROP COLUMN "location";';

  it('the destructive migration is BLOCKED unreviewed (deploy aborts at [lint/gate])', async () => {
    const target = recordingTarget();
    const err = await deploy({
      specSource: ONE_STORE_YAML,
      migrations: [{ name: '0005_drop_location.sql', sql: DROP_COLUMN_SQL }], // NO allowlist
      target,
      rollout: rollout(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).step).toBe('lint/gate');
    expect(target.applied).toEqual([]); // never applied
  });

  it('the SAME migration applies ONLY with a reviewed allowlist entry (gate passes, migrate runs)', async () => {
    const target = recordingTarget();
    const result = await deploy({
      specSource: ONE_STORE_YAML,
      migrations: [
        {
          name: '0005_drop_location.sql',
          sql: DROP_COLUMN_SQL,
          // The REVIEWED allowlist entry — full-statement equality, with a reason.
          allowlist: [
            {
              kind: 'drop-column',
              match: DROP_COLUMN_SQL,
              reason: 'location is being removed (reviewed forward migration).',
            },
          ],
        },
      ],
      target,
      // widgets store needs a (registered) table for the verify step to pass.
      rollout: rollout({ productTables: new Map([['widgets', {} as PgTable]]) }),
    });
    // The gate PASSED for the destructive statement (reviewed) and the migration WAS applied.
    expect(result.gateResults[0]?.pass).toBe(true);
    expect(target.applied).toEqual(['0005_drop_location.sql']);
  });

  it('FAIL-THE-FIX: removing the allowlist entry re-blocks the deploy (the gate is load-bearing)', async () => {
    const target = recordingTarget();
    const err = await deploy({
      specSource: ONE_STORE_YAML,
      migrations: [{ name: '0005_drop_location.sql', sql: DROP_COLUMN_SQL, allowlist: [] }],
      target,
      rollout: rollout(),
    }).catch((e) => e);
    expect((err as DeployError).step).toBe('lint/gate');
    expect(target.applied).toEqual([]);
  });
});
