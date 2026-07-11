/**
 * Golden regression — the backend-profile parse/lint stability guarantee: every backend document must
 * parse BYTE-IDENTICALLY to a captured baseline, so any drift in the backend parse/lint path (the live
 * `rayspec.yaml` + extension-pack path) turns this RED.
 *
 * `__fixtures__/golden/baseline.json` is the DELIBERATELY-regenerated capture of the current built
 * `parseSpec` over the corpus in `__fixtures__/golden/*.yaml` (a representative spread: minimal, a full
 * cross-referenced backend, a stream+extensions backend — all at `version:'1.0'`). This test re-parses
 * each corpus file with the CURRENT `parseSpec` and asserts DEEP EQUALITY against the baseline. The
 * baseline is regenerated with `--write`-style intent whenever the backend parse output legitimately
 * changes.
 *
 * NOTE (honest): this is a REGRESSION-grade test (it pins current behavior), not a red-first test — its
 * job is to prove byte-identity, so a captured-then-asserted baseline is the point.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

const goldenDir = fileURLToPath(new URL('./__fixtures__/golden/', import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL('./__fixtures__/golden/baseline.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const corpus = readdirSync(goldenDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

describe('golden regression — backend specs parse byte-identically to the captured baseline', () => {
  it('the corpus is non-empty and each file has a captured baseline', () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const f of corpus) expect(baseline[f]).toBeDefined();
  });

  for (const f of corpus) {
    it(`${f} parses identically to the frozen main baseline`, () => {
      const raw = readFileSync(`${goldenDir}${f}`, 'utf8');
      const res = parseSpec(raw);
      // Round-trip through JSON so the comparison matches the serialized baseline exactly.
      expect(JSON.parse(JSON.stringify(res))).toEqual(baseline[f]);
    });
  }
});
