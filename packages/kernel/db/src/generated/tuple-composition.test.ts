/**
 * RUNTIME pin for the product-table tuple composition.
 *
 * The COMPILE-TIME half (a product table's literal type is a member of the composed union; the
 * empty baseline leaves the union == the core union) lives in `tuple-composition-typepin.ts`, which
 * `tsc -b` checks (failing `pnpm typecheck` on a regression). This test pins the RUNTIME shape:
 * the platform main line's TENANT_SCOPED_TABLES == CORE ⊕ PRODUCT, product-empty on the main line.
 */
import { describe, expect, it } from 'vitest';
import { CORE_TENANT_SCOPED_TABLES, TENANT_SCOPED_TABLES } from '../schema.js';
import { POPULATED_COMPOSITION_TYPEPINS } from './__fixtures__/populated-composition-typepin.js';
import { PRODUCT_TENANT_SCOPED_TABLES } from './product-schema.js';
import { TUPLE_COMPOSITION_TYPEPINS } from './tuple-composition-typepin.js';

describe('product-table tuple composition (runtime shape)', () => {
  it('the platform baseline ships ZERO product tables', () => {
    expect(PRODUCT_TENANT_SCOPED_TABLES.length).toBe(0);
  });

  it('TENANT_SCOPED_TABLES == CORE ⊕ PRODUCT (product-empty on the main line)', () => {
    expect(TENANT_SCOPED_TABLES.length).toBe(
      CORE_TENANT_SCOPED_TABLES.length + PRODUCT_TENANT_SCOPED_TABLES.length,
    );
    expect(TENANT_SCOPED_TABLES.length).toBe(CORE_TENANT_SCOPED_TABLES.length);
  });

  it('the compile-time tuple type-pins are present (a tsc failure would block the build)', () => {
    // 5 pins: no-widening, product-member, core-member, deny-by-default-negative, empty-baseline.
    expect(TUPLE_COMPOSITION_TYPEPINS).toEqual([true, true, true, true, true]);
  });

  it('the POPULATED-deployment composition typechecks (a real deployment compiles)', () => {
    // The fixture composes a POPULATED product tuple against the real core tuple; that this module
    // imports + compiles is the proof a populated deployment typechecks (the original empty-baseline bug
    // would have failed tsc here). 3 pins: notebooks-member, entries-member, no-widening.
    expect(POPULATED_COMPOSITION_TYPEPINS).toEqual([true, true, true]);
  });
});
