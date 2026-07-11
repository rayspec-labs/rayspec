/**
 * Unit tests for `classifyProductSchema` (the mount-without-deploy classifier). PURE:
 * stores + detectDrift findings → state, so this is exhaustive over hand-built finding arrays (no DB,
 * no fake queryFn). The three states drive the boot decision: 'absent'→materialize (first roll-out),
 * 'present-matching'→MOUNT (no DDL, data survives), 'drifted'→FAIL CLOSED.
 *
 * Non-blind: each case asserts the EXACT state, and the partial/mixed cases are the load-bearing ones
 * (a partial materialization MUST classify 'drifted' so the boot never auto-materializes/drops on a
 * non-clean DB).
 */
import type { StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { classifyProductSchema, type DriftFinding } from './generated/drift-detect.js';

const store = (name: string): StoreSpec => ({
  name,
  columns: [{ name: 'body', type: 'text', nullable: true, unique: false }],
  foreignKeys: [],
});

const missingTable = (table: string): DriftFinding => ({
  table,
  kind: 'missing_table',
  expected: 'table present',
  actual: 'table absent',
});

describe('classifyProductSchema (mount-without-deploy)', () => {
  it('empty stores → present-matching (nothing to materialize)', () => {
    expect(classifyProductSchema([], [])).toBe('present-matching');
    // Even with stray findings, no stores means nothing to materialize.
    expect(classifyProductSchema([], [missingTable('ghost')])).toBe('present-matching');
  });

  it('stores present, NO findings → present-matching (live schema matches; MOUNT)', () => {
    expect(classifyProductSchema([store('notes')], [])).toBe('present-matching');
    expect(classifyProductSchema([store('a'), store('b')], [])).toBe('present-matching');
  });

  it('EVERY store table missing (distinct tables === stores.length) → absent (first roll-out)', () => {
    expect(classifyProductSchema([store('notes')], [missingTable('notes')])).toBe('absent');
    expect(
      classifyProductSchema(
        [store('a'), store('b'), store('c')],
        [missingTable('a'), missingTable('b'), missingTable('c')],
      ),
    ).toBe('absent');
  });

  it('PARTIAL — 2 stores but only 1 missing_table → drifted (fail closed, never auto-materialize)', () => {
    expect(classifyProductSchema([store('a'), store('b')], [missingTable('a')])).toBe('drifted');
  });

  it('MIXED — one table missing + one present table has a missing_column → drifted', () => {
    const findings: DriftFinding[] = [
      missingTable('a'),
      { table: 'b', kind: 'missing_column', column: 'body', expected: 'present', actual: 'absent' },
    ];
    expect(classifyProductSchema([store('a'), store('b')], findings)).toBe('drifted');
  });

  it('a single drifted column (column_type) on a present table → drifted', () => {
    const findings: DriftFinding[] = [
      { table: 'notes', kind: 'column_type', column: 'body', expected: 'text', actual: 'integer' },
    ];
    expect(classifyProductSchema([store('notes')], findings)).toBe('drifted');
  });

  it('a column_nullability difference → drifted', () => {
    const findings: DriftFinding[] = [
      {
        table: 'notes',
        kind: 'column_nullability',
        column: 'body',
        expected: 'not null',
        actual: 'nullable',
      },
    ];
    expect(classifyProductSchema([store('notes')], findings)).toBe('drifted');
  });

  it('a tenant-FK / unique / product-FK drift → drifted (any non-missing_table finding fails closed)', () => {
    for (const kind of [
      'missing_unique',
      'missing_tenant_fk',
      'tenant_fk_not_cascade',
      'missing_product_fk',
      'product_fk_policy',
    ] as const) {
      const findings: DriftFinding[] = [{ table: 'notes', kind, expected: 'x', actual: 'y' }];
      expect(classifyProductSchema([store('notes')], findings)).toBe('drifted');
    }
  });

  it('all-missing_table BUT a duplicate table (distinct count !== stores.length) → drifted', () => {
    // Defensive: detectDrift emits one finding per store, but a duplicate must not be miscounted as
    // a clean DB. Two stores, two missing_table findings BUT both for the same table → distinct=1 → drifted.
    expect(
      classifyProductSchema([store('a'), store('b')], [missingTable('a'), missingTable('a')]),
    ).toBe('drifted');
  });
});
