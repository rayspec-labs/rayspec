/**
 * The pure rules of a bundle deploy: the binding revision key of an environment that has none yet,
 * revision ids that change with a value and never carry it, and which plans need a reviewed digest.
 */
import { bindingRevisionId, type PrepareData } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import { bindingRevisions, initialBindingRevisionKey, planNeedsReview } from './bundle-deploy.js';

describe('initialBindingRevisionKey', () => {
  it('is 32 bytes, stable for one pepper and different for another', () => {
    const key = initialBindingRevisionKey('a-pepper-of-some-length');
    expect(key).toHaveLength(32);
    expect(initialBindingRevisionKey('a-pepper-of-some-length').equals(key)).toBe(true);
    expect(initialBindingRevisionKey('another-pepper').equals(key)).toBe(false);
    // The key is not the pepper, and does not contain it.
    expect(key.toString('utf8')).not.toContain('pepper');
  });

  it('refuses an empty pepper', () => {
    expect(() => initialBindingRevisionKey('')).toThrow(RangeError);
  });
});

describe('bindingRevisions', () => {
  const key = initialBindingRevisionKey('pepper');

  it('computes the contract revision id for each value, sorted by name', () => {
    const values = new Map([
      ['ZETA', 'z-value'],
      ['OPENAI_API_KEY', 'sk-canary-9f3a'],
    ]);
    const revisions = bindingRevisions(values, key);
    expect(revisions.map((r) => r.name)).toEqual(['OPENAI_API_KEY', 'ZETA']);
    expect(revisions[0]?.revisionId).toBe(
      bindingRevisionId(key, 'OPENAI_API_KEY', 'sk-canary-9f3a'),
    );
    expect(JSON.stringify(revisions)).not.toContain('canary');
  });

  it('changes when a value changes, and only then', () => {
    const one = bindingRevisions(new Map([['TOKEN', 'first']]), key);
    const same = bindingRevisions(new Map([['TOKEN', 'first']]), key);
    const other = bindingRevisions(new Map([['TOKEN', 'second']]), key);
    expect(same).toEqual(one);
    expect(other[0]?.revisionId).not.toBe(one[0]?.revisionId);
  });
});

describe('planNeedsReview', () => {
  const base = (): PrepareData => ({
    plan: {
      bundleSha256: 'a'.repeat(64),
      applicationId: 'probe-app',
      applicationVersion: '1.0.0',
      requiredBindings: [],
      schemaImpact: {
        from: { platform: '0014_product_migration_ledger', product: 'b'.repeat(64) },
        to: { platform: '0014_product_migration_ledger', product: 'b'.repeat(64) },
        productDeltaSha256: null,
        destructive: false,
        allowlisted: false,
      },
      permissionChanges: {
        executionFrom: 'none',
        executionTo: 'none',
        egressAdded: [],
        egressRemoved: [],
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
      },
      storageRequirements: { bundleBytes: 1, extractedBytes: 1 },
      blockers: [],
      warnings: [],
    },
    planDigest: 'c'.repeat(64),
    preparedAt: '2026-09-30T12:00:00Z',
    expiresAt: '2026-09-30T12:30:00Z',
    environmentRevision: 3,
  });

  it('is false for a new version of the same schema and grants', () => {
    expect(planNeedsReview(base())).toBe(false);
  });

  it('is true for an empty database, a schema change or any grant change', () => {
    const empty = base();
    empty.plan.schemaImpact.from = null;
    expect(planNeedsReview(empty)).toBe(true);

    const product = base();
    product.plan.schemaImpact.to = { ...product.plan.schemaImpact.to, product: 'd'.repeat(64) };
    expect(planNeedsReview(product)).toBe(true);

    const platform = base();
    platform.plan.schemaImpact.to = { ...platform.plan.schemaImpact.to, platform: '0015_next' };
    expect(planNeedsReview(platform)).toBe(true);

    const execution = base();
    execution.plan.permissionChanges.executionTo = 'in-process';
    expect(planNeedsReview(execution)).toBe(true);

    const egress = base();
    egress.plan.permissionChanges.egressAdded = ['api.example.com'];
    expect(planNeedsReview(egress)).toBe(true);

    const capability = base();
    capability.plan.permissionChanges.capabilitiesRemoved = ['custom-handlers'];
    expect(planNeedsReview(capability)).toBe(true);
  });
});
