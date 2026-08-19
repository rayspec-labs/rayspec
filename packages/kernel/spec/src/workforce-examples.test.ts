/**
 * The shipped workforce examples are EXECUTABLE TRUTH, pinned in CI: both parse with the
 * experimental section enabled (no errors — a rule keyed on a policy label nobody holds is now an
 * ERROR, `workforce_label_unheld`, so the parse below is what catches it), both raise exactly the
 * advisories their own declarations imply, and both are refused typed without the flag, at the same
 * entry point an author's document takes. That is the FULL scope of what CI guarantees for BOTH
 * examples.
 *
 * "No warnings" was the older, stronger statement and it is deliberately gone: the maintainers
 * example declares `onTimeout: 'escalate'`, which now raises `workforce_escalation_unreachable`
 * (B-017k). That advisory is CORRECT about a shipped example — an escalated approval there is
 * resolvable only by break-glass — and quietly editing the example to silence it would have
 * suppressed exactly the finding the rule exists to surface. So the expectation below is DERIVED
 * from each document instead of asserted flat.
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
      // The section raises exactly one advisory — `workforce_escalation_unreachable`, on every
      // `onTimeout: 'escalate'` policy — and whether it fires is a property of the DOCUMENT. So the
      // expectation is DERIVED from the document rather than written down: an example that adds or
      // drops an escalating policy moves this with it, and any OTHER advisory still turns it red.
      const expected = (parsed.value.workforce?.approvalPolicies ?? []).flatMap((policy, i) =>
        policy.onTimeout === 'escalate'
          ? [
              {
                code: 'workforce_escalation_unreachable',
                path: `workforce.approvalPolicies[${i}].onTimeout`,
              },
            ]
          : [],
      );
      expect(lintSpecWarnings(parsed.value).map((w) => ({ code: w.code, path: w.path }))).toEqual(
        expected,
      );
    });

    it(`${slug} is refused without the opt-in, with the typed experimental code`, () => {
      const parsed = parseSpec(exampleYaml(slug));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.map((e) => e.code)).toContain('experimental_section_disabled');
    });
  }

  it('the two examples exercise BOTH sides of the escalation advisory — the derived check is not vacuous', () => {
    // A derived expectation passes trivially when the thing it derives from disappears. The shipped
    // pair covers both cells on purpose: the starter declares `onTimeout: fail` and raises nothing,
    // the maintainers example declares `escalate` and raises one. If that ever collapses to one
    // cell, the check above stops proving the advisory fires at all — so it is asserted here.
    const counts = EXAMPLES.map((slug) => {
      const parsed = parseSpec(exampleYaml(slug), { experimentalWorkforce: true });
      expect(parsed.ok).toBe(true);
      return parsed.ok ? lintSpecWarnings(parsed.value).length : -1;
    });
    expect(
      counts.some((n) => n === 0),
      'one example must raise NO advisory',
    ).toBe(true);
    expect(
      counts.some((n) => n > 0),
      'one example must RAISE the advisory',
    ).toBe(true);
  });

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
