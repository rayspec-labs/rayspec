/**
 * `shadowApplyBaselineUpdate` — DB-backed NON-VACUITY of the baseline-seeded update shadow.
 *
 * Proves the update-mode shadow is a REAL oracle, not a rubber stamp, fail-the-fix:
 *  1. HAPPY PATH: baseline(old) + delta(diff old→new) applied in order ⇒ ok:true, drift:[] — the delta
 *     genuinely produced the NEW spec's schema (asserted by the SAME `detectDrift` the boot path uses).
 *  2. UNAPPLIABLE DELTA (RED): a hand-broken delta statement that cannot apply onto the baseline ⇒
 *     ok:false with the VERBATIM SQL error (the diagnosable case) — the apply arm is non-vacuous.
 *  3. WRONG END STATE (RED): a delta that applies but does NOT reach the NEW spec (a missing column) ⇒
 *     ok:false with a drift finding — the drift oracle is non-vacuous.
 * Every run drops its throwaway DB (self-cleanup verified in shadow-apply.db.test.ts).
 *
 * UN-SKIPPABLE RAN-GUARD: a separate, NON-skipped describe hard-FAILS when the DB is
 * REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the scenarios did not run.
 */
import { diffProductStores, generateProductSql, type StoreConflictKeys } from '@rayspec/db';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { shadowApplyBaselineUpdate, withDatabaseName } from './shadow-apply.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.SHADOW_DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let scenariosRan = 0;

/** The shadow server URL: SHADOW_DATABASE_URL if set, else the `_shadow` sibling of DATABASE_URL. */
function shadowUrl(): string {
  if (process.env.SHADOW_DATABASE_URL) return process.env.SHADOW_DATABASE_URL;
  const dbUrl = process.env.DATABASE_URL as string;
  const name = new URL(dbUrl).pathname.replace(/^\//, '');
  return withDatabaseName(dbUrl, `${name}_shadow`);
}

/** Parse a 0.1 spec's `stores[]` (used to build baseline/delta from real, validated store shapes). */
function stores(spec: string): StoreSpec[] {
  const parsed = parseSpec(spec);
  if (!parsed.ok) throw new Error(`fixture spec must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value.stores;
}

const OLD = stores(`
version: '1.0'
metadata: { name: shadow-baseline }
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
`);
const NEW_DROP_QTY = stores(`
version: '1.0'
metadata: { name: shadow-baseline }
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
`);
const NEW_ADD_COLOR = stores(`
version: '1.0'
metadata: { name: shadow-baseline }
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
      - { name: color, type: text, nullable: true }
`);

describe.skipIf(!hasDb)(
  'shadowApplyBaselineUpdate — baseline+delta is a real, non-vacuous oracle',
  () => {
    it('HAPPY: a valid drop-column delta applies onto the old baseline and ends DRIFT-CLEAN vs the new spec', async () => {
      const baseline = generateProductSql(OLD);
      const delta = diffProductStores(OLD, NEW_DROP_QTY).migrationSql;
      const r = await shadowApplyBaselineUpdate(shadowUrl(), baseline, delta, NEW_DROP_QTY);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.drift).toEqual([]);
      scenariosRan++;
    }, 60_000);

    it('RED (unappliable delta): a hand-broken DROP of a non-existent column surfaces the verbatim SQL error', async () => {
      const baseline = generateProductSql(OLD);
      const brokenDelta = 'ALTER TABLE "widgets" DROP COLUMN "does_not_exist";';
      const r = await shadowApplyBaselineUpdate(shadowUrl(), baseline, brokenDelta, OLD);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // The apply error is surfaced verbatim (it describes the SQL, never the URL).
        expect(r.error).toMatch(/does_not_exist|does not exist/i);
        expect(r.error).not.toContain('postgres://');
      }
      scenariosRan++;
    }, 60_000);

    it('RED (wrong end state): an EMPTY delta leaves the added column missing ⇒ drift is reported', async () => {
      // The new spec expects `color`, but an empty delta never adds it ⇒ the end state DRIFTS from new.
      const baseline = generateProductSql(OLD);
      const r = await shadowApplyBaselineUpdate(shadowUrl(), baseline, '', NEW_ADD_COLOR);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.drift?.some((d) => d.kind === 'missing_column' && d.column === 'color')).toBe(
          true,
        );
        expect(r.error).toMatch(/drift/i);
      }
      scenariosRan++;
    }, 60_000);

    it('the ARMED plan-time oracle flags a stale single-column GLOBAL unique index (stale_global_unique); the LENIENT boot oracle does NOT refuse it', async () => {
      // A LEGACY deployment: `code` was a durable conflict KEY, so its unique index is a single-column
      // GLOBAL `(code)`. The NEW spec makes `code` a plain author-unique (tenant-scoped compound now
      // expected). Seed the live shape by materializing the baseline WITH `code` as a conflict key.
      const legacy = stores(`
version: '1.0'
metadata: { name: shadow-stale }
stores:
  - name: catalog
    columns:
      - { name: code, type: text, unique: true }
`);
      const oldKeysCodeIsKey: StoreConflictKeys = new Map([['catalog', new Set(['code'])]]);
      const newKeysCodeAuthorUnique: StoreConflictKeys = new Map([['catalog', new Set<string>()]]);
      const baselineSingleGlobal = generateProductSql(legacy, oldKeysCodeIsKey); // single-column index

      // ARMED (the `plan` path passes the NEW conflict keys): the oracle sees the stale single GLOBAL
      // index where a tenant-scoped compound is now expected → stale_global_unique. This is the fail-the-
      // fix: drop the `newConflictKeys` threading and the armed call falls back to lenient → ok:true → RED.
      const armed = await shadowApplyBaselineUpdate(
        shadowUrl(),
        baselineSingleGlobal,
        '',
        legacy,
        newKeysCodeAuthorUnique,
      );
      expect(armed.ok).toBe(false);
      expect(
        armed.drift?.some(
          (d) => d.kind === 'stale_global_unique' && d.table === 'catalog' && d.column === 'code',
        ),
      ).toBe(true);

      // LENIENT (no conflict keys — the boot/deploy posture): a covering unique index exists → NO drift,
      // so a working legacy deployment is MOUNTED, never refused (the documented no-forced-migration rule).
      const lenient = await shadowApplyBaselineUpdate(
        shadowUrl(),
        baselineSingleGlobal,
        '',
        legacy,
      );
      expect(lenient.ok).toBe(true);
      if (lenient.ok) expect(lenient.drift).toEqual([]);
      scenariosRan++;
    }, 60_000);

    it('the CORRECT old→new reindex delta (baseline seeded with OLD keys) ends DRIFT-CLEAN under the armed oracle', async () => {
      // The seeding companion: baseline is generated with the OLD conflict keys (single, live shape); the
      // delta is computed with BOTH old+new keys → a real DROP+CREATE reindex → the armed oracle passes.
      const legacy = stores(`
version: '1.0'
metadata: { name: shadow-reindex }
stores:
  - name: catalog
    columns:
      - { name: code, type: text, unique: true }
`);
      const oldKeys: StoreConflictKeys = new Map([['catalog', new Set(['code'])]]);
      const newKeys: StoreConflictKeys = new Map([['catalog', new Set<string>()]]);
      const baseline = generateProductSql(legacy, oldKeys); // reproduces the LIVE single-column index
      const reindexDelta = diffProductStores(legacy, legacy, {
        oldConflictKeys: oldKeys,
        newConflictKeys: newKeys,
      }).migrationSql;
      const r = await shadowApplyBaselineUpdate(
        shadowUrl(),
        baseline,
        reindexDelta,
        legacy,
        newKeys,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.drift).toEqual([]);
      scenariosRan++;
    }, 60_000);
  },
);

describe('shadowApplyBaselineUpdate — ran-guard (the non-vacuity proofs must not silently skip in CI)', () => {
  it('the scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(scenariosRan).toBe(5);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
