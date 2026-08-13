/**
 * The DBOS application version the durable worker boots with — the value that fences a deployment's
 * queue to its OWN document. Pure + DB-free, exactly like the other `*.unit.test.ts` files here.
 */
import { describe, expect, it } from 'vitest';
import { deriveDbosApplicationVersion } from './durable-app-version.js';

describe('deriveDbosApplicationVersion', () => {
  it('gives two different documents two different versions', () => {
    expect(deriveDbosApplicationVersion('product', 'invoice-intake')).not.toBe(
      deriveDbosApplicationVersion('product', 'expense-claim'),
    );
  });

  it('namespaces the profile, so a backend spec and a product with the same name differ', () => {
    expect(deriveDbosApplicationVersion('backend', 'orders')).not.toBe(
      deriveDbosApplicationVersion('product', 'orders'),
    );
  });

  it('is byte-identical for the same identity across calls (a redeploy keeps its own queued work)', () => {
    const a = deriveDbosApplicationVersion('product', 'invoice-intake');
    const b = deriveDbosApplicationVersion('product', 'invoice-intake');
    expect(a).toBe(b);
    expect(a).toBe('doc-d170c139419cbe6e');
  });

  it('is prefixed and short enough for the Postgres application_name DBOS interpolates it into', () => {
    // DBOS builds `dbos_transact_${executorID}_${appVersion}` as the system pool's
    // `application_name` (system_database.js:409-413) and Postgres truncates that identifier at 63
    // bytes, so the version must stay short. 32 is the bound this helper promises.
    for (const identity of ['x', 'a-very-long-product-identifier-that-goes-on-and-on-and-on']) {
      const version = deriveDbosApplicationVersion('product', identity);
      expect(version.startsWith('doc-')).toBe(true);
      expect(version.length).toBeLessThanOrEqual(32);
      expect(`dbos_transact_local_${version}`.length).toBeLessThanOrEqual(63);
    }
  });
});
