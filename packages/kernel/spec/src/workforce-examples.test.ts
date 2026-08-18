/**
 * The shipped workforce examples are EXECUTABLE TRUTH, pinned in CI: both parse and lint clean
 * with the experimental section enabled (no errors, no warnings — a rule keyed on a policy label
 * nobody holds is now an ERROR, `workforce_label_unheld`, so the parse below is what catches it),
 * and both are refused typed without it, at the same entry point an author's document takes. That
 * is the FULL scope of what CI guarantees for BOTH examples — parse/lint clean, refused without
 * the flag.
 *
 * The STARTER carries two gates the maintainers example does NOT: the acceptance story deploys it
 * byte-for-byte end to end (`workforce-story-e2e.db.test.ts`), and the spec-reference doc quotes its
 * `workforce:` block byte-for-byte (`workforce-docs-drift.test.ts`). The maintainers example is not
 * quoted in the docs and is not driven end to end, so it has no docs byte-identity gate — and this
 * header, not a byte comparison, is what says so.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintSpecWarnings } from './lint.js';
import { parseSpec } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleYaml = (slug: string): string =>
  readFileSync(resolve(here, `../../../../examples/${slug}/rayspec.yaml`), 'utf8');

const EXAMPLES = ['workforce-starter', 'workforce-maintainers'] as const;

describe('the shipped workforce examples', () => {
  for (const slug of EXAMPLES) {
    it(`${slug} parses and lints clean with the section enabled`, () => {
      const parsed = parseSpec(exampleYaml(slug), { experimentalWorkforce: true });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.workforce).toBeDefined();
      expect(lintSpecWarnings(parsed.value)).toEqual([]);
    });

    it(`${slug} is refused without the opt-in, with the typed experimental code`, () => {
      const parsed = parseSpec(exampleYaml(slug));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.map((e) => e.code)).toContain('experimental_section_disabled');
    });
  }

  it('the starter declares the shape its documentation and acceptance story rely on', () => {
    // The story's cast, pinned: a change here is a docs + acceptance-story change, not a tweak.
    const parsed = parseSpec(exampleYaml('workforce-starter'), { experimentalWorkforce: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const workforce = parsed.value.workforce;
    expect(workforce?.id).toBe('starter');
    expect(workforce?.departments.map((d) => d.id)).toEqual(['eng', 'growth']);
    expect(workforce?.employees).toHaveLength(7);
    expect(workforce?.teams.map((t) => t.id)).toEqual(['release_crew']);
    expect(workforce?.reviewPolicies.map((p) => p.id)).toEqual(['eng_quality']);
    expect(workforce?.approvalPolicies.map((a) => a.id)).toEqual(['public_statement_signoff']);
  });
});
