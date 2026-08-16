/**
 * A SERVICE IS CONFIGURED BY ITS OWN PACK'S GRAMMAR, NEVER BY ITS NEIGHBOUR'S.
 *
 * The validated section map the boot carries is keyed by section key alone, so it cannot say who owns
 * what; the resolved CLAIMS can, because each one names the pack that made it. `sectionsOwnedBy` is
 * the few lines that turn the one into the other, and handing a service the whole map instead would
 * make one pack's configuration another pack's implicit dependency — the exact coupling the claim
 * mechanism exists to prevent.
 *
 * WHY THIS IS A UNIT SUITE AND NOT A BOOT ARM. Every deployment in this repository boots exactly ONE
 * claiming pack, and with one pack the filter and a plain pass-through return the same map: the
 * property is invisible from a boot, whatever the boot asserts. Two packs are the smallest input that
 * can tell them apart, so the smallest honest measurement is this one, taken directly on the function
 * the boot calls (`bootExtensionServices` passes `sectionsOwnedBy(...)` as each context's `sections`).
 */
import { describe, expect, it } from 'vitest';
import { sectionsOwnedBy } from './composition-root.js';

/** Two packs, each claiming one key, and one key written by neither — the union a boot resolves. */
const SECTIONS = {
  auditing: { retentionDays: 30 },
  billing: { currency: 'EUR' },
};
const CLAIMS = [
  { key: 'auditing', packId: 'audit-pack' },
  { key: 'billing', packId: 'billing-pack' },
];

describe('sectionsOwnedBy — each pack is handed its own claimed sections and no others', () => {
  it('gives a pack ONLY the key it claims, out of a union that holds both', () => {
    expect(sectionsOwnedBy(SECTIONS, CLAIMS, 'audit-pack')).toEqual({
      auditing: { retentionDays: 30 },
    });
    expect(sectionsOwnedBy(SECTIONS, CLAIMS, 'billing-pack')).toEqual({
      billing: { currency: 'EUR' },
    });
  });

  it('FAIL-THE-FIX: the neighbour’s key is ABSENT, not merely un-asserted', () => {
    // This is what a pass-through would break: with one pack in the boot the two are identical, so
    // the assertion has to be that the OTHER key is gone.
    const audit = sectionsOwnedBy(SECTIONS, CLAIMS, 'audit-pack');
    expect('billing' in audit).toBe(false);
    expect(Object.keys(audit)).toEqual(['auditing']);
  });

  it('a pack that claims NOTHING is handed an empty map — never the union by default', () => {
    expect(sectionsOwnedBy(SECTIONS, CLAIMS, 'quiet-pack')).toEqual({});
  });

  it('a claim whose key the document never wrote invents nothing', () => {
    // The map holds what the document wrote; a claim is an ownership statement, not a default. A
    // filter that reached for the claim instead of the map would materialize `reporting: undefined`,
    // which a service reading `ctx.sections.reporting` cannot tell from a section it was given.
    const withUnwritten = [...CLAIMS, { key: 'reporting', packId: 'audit-pack' }];
    const audit = sectionsOwnedBy(SECTIONS, withUnwritten, 'audit-pack');
    expect(audit).toEqual({ auditing: { retentionDays: 30 } });
    expect('reporting' in audit).toBe(false);
  });

  it('two packs claiming under the same id both arrive — the filter is by owner, not by count', () => {
    const claims = [
      { key: 'auditing', packId: 'audit-pack' },
      { key: 'billing', packId: 'audit-pack' },
    ];
    expect(sectionsOwnedBy(SECTIONS, claims, 'audit-pack')).toEqual(SECTIONS);
  });
});
