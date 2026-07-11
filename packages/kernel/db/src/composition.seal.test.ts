/**
 * `sealProductStores()` shuts the sanctioned door: a subsequent `registerProductStores` throws. This
 * lives in its OWN test file so the module-local seal flag starts fresh (vitest isolates modules per
 * file) — sealing it here cannot leak into the other composition suites.
 */
import type { StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  ProductStoreCompositionError,
  registerProductStores,
  sealProductStores,
} from './composition.js';
import { buildProductTables } from './generated/build-product-tables.js';

function goodTable() {
  const stores: StoreSpec[] = [
    {
      name: 'sealed_store',
      columns: [{ name: 'label', type: 'text', nullable: false, unique: false }],
      foreignKeys: [],
    },
  ];
  return buildProductTables(stores);
}

describe('sealProductStores', () => {
  it('registration works BEFORE the seal and is REFUSED after', () => {
    const first = registerProductStores(goodTable());
    expect(typeof first).toBe('function'); // the unregister thunk
    first();

    sealProductStores();

    expect(() => registerProductStores(goodTable())).toThrow(ProductStoreCompositionError);
    expect(() => registerProductStores(goodTable())).toThrow(/already sealed/);
  });
});
