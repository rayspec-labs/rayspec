/**
 * `docs/workforce-architecture.md` IS GUARDED — the operator page, drift-locked onto the code it
 * names.
 *
 * That page opens by promising "Every guarantee below names the mechanism (and usually the test)
 * that enforces it; a claim without one is a bug in this page." Nothing checked that promise. The
 * page cites code BY SYMBOL rather than by line — a deliberate downgrade it argues for in its own
 * second paragraph, because a line number looks precise, is checked less, and goes wrong silently.
 * A symbol is strictly better, but it is not self-checking: a renamed export, a function moved to
 * another module, or a test whose title changed all leave the page claiming a mechanism a reader
 * cannot find, and every existing drift suite reads a DIFFERENT page.
 *
 * So the page carries a ledger (Appendix A) pinning each cited file to the text it must contain,
 * and this suite checks it in BOTH directions plus the reverse one.
 *
 * WHY BOTH DIRECTIONS. A hand-curated pin list is checked once; a guard is checked every run,
 * including on the merge that moved the code. Checking only ledger → code lets the prose grow new
 * citations that nothing verifies; checking only prose → ledger lets the ledger keep pins for
 * sentences the page no longer makes. The two sets are asserted EQUAL.
 *
 * WHY IT FAILS CLOSED. A reworded page that produced zero citations, or an emptied ledger, would
 * otherwise be reported green by a guard that had simply stopped finding anything — "the property
 * holds" and "the scan stopped finding the code" are the same reading without floors. Every derived
 * set has one.
 *
 * WHY COLLECT-THEN-ASSERT. A `for` loop of `expect()` throws on the FIRST bad entry and reports it
 * as though it were the only one, which turns every fix into a fresh full verification cycle. Each
 * scanning arm below walks its whole input and reports every failure in one run.
 *
 * THE BOUND, STATED RATHER THAN CLAIMED AWAY. `turbo.json` declares no `inputs` for `test`, so this
 * task's hash covers its own package and its dependencies — not `docs/`, and not the other packages
 * it reads off disk. A WARM cache can therefore replay a stale PASS after an edit this suite would
 * have caught. That is true of every doc-drift suite in this repo. What makes it run in practice:
 * CI configures no turbo remote cache, so every CI job starts cold. Locally, force the task.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const PAGE_PATH = 'docs/workforce-architecture.md';
const page = readFileSync(resolve(repoRoot, PAGE_PATH), 'utf8');

/** The tracked roots a citation may point into, and the roots this suite scans for back-references. */
const SCAN_ROOTS = ['packages', 'scripts', 'examples', 'docs', 'deployments', '.github'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.claude']);
const SCAN_EXTENSIONS = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|md|sh|sql|yml|yaml)$/;

interface SourceFile {
  readonly rel: string;
  readonly text: string;
}

/** Every tracked source file under the scan roots, read once. */
const sourceFiles: readonly SourceFile[] = (() => {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTENSIONS.test(name)) continue;
      if (stat.size > 2_000_000) continue;
      out.push({ rel: full.slice(repoRoot.length + 1), text: readFileSync(full, 'utf8') });
    }
  };
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root));
  return out;
})();

/**
 * Comment continuation collapsed away, so a reference that markdown or a jsdoc block WRAPPED across
 * lines still reads as one string. Without this a `→ "Upgrade and rollback notes"` split over two
 * `*`-prefixed lines is invisible to the scan — which reads as "there are none".
 */
function flat(text: string): string {
  return text.replace(/\n[ \t]*\*?[ \t]?/g, ' ').replace(/\s+/g, ' ');
}

/** Every `##`/`###` heading the page declares, by its text. */
const pageHeadings: ReadonlySet<string> = new Set(
  [...page.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => m[1] as string),
);

describe(`${PAGE_PATH} — the reverse direction: what the TREE says about this page`, () => {
  /**
   * FAIL-CLOSED FLOOR for the two arms below. Both are NEGATIVE-shaped scans, and a negative scan
   * that stopped finding its input is indistinguishable from one whose property holds. If the walk
   * broke, or the page stopped being referenced at all, this is what goes red.
   */
  it('FAILS CLOSED: the tree walk found source, and this page is still referenced from it', () => {
    expect(
      sourceFiles.length,
      'the tree walk found almost nothing — every arm below would pass vacuously',
    ).toBeGreaterThan(500);
    const referencing = sourceFiles.filter((f) => f.text.includes('workforce-architecture.md'));
    expect(
      referencing.map((f) => f.rel).length,
      'nothing in the tree references this page any more — the scan below checks nothing',
    ).toBeGreaterThan(4);
  });

  /**
   * NOTHING CITES THIS PAGE BY LINE.
   *
   * The page's own rule is that it prints no line numbers, on the argument that a number is a claim
   * with no mechanism behind it. The same argument runs the other way: a comment that pins this page
   * by line is checked by nothing and rots on the next edit to the page — which is exactly what had
   * happened to the one instance this arm was written against, whose range had drifted off the lock
   * discipline it meant to cite and onto an unrelated paragraph about approvals. Name the section
   * instead; the arm below verifies the section exists.
   *
   * THIS SUITE IS SUBJECT TO ITS OWN RULE. Its own file is scanned like every other, not skipped —
   * so neither this docblock nor the failure text below may spell either forbidden form, and both
   * describe them instead. Skipping the guard's own file would have been the easy fix and the wrong
   * one: a whole-file exemption is exactly the hole this arm exists to deny everyone else.
   */
  it('no file in the tree cites this page by LINE — a line pin into prose is checked by nothing', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const match of file.text.matchAll(/workforce-architecture\.md:(\d+(?:-\d+)?)/g)) {
        const line = file.text.slice(0, match.index).split('\n').length;
        offenders.push(
          `${file.rel}:${line} pins that page at line(s) ${match[1] as string}.\n` +
            '  A line pin into a prose page is verified by nothing and rots on the next edit to the\n' +
            '  page. Replace the colon and the number with the page reference followed by an arrow\n' +
            '  and the SECTION HEADING in double quotes — the convention the arm below verifies.',
        );
      }
    }
    expect(
      offenders,
      `${offenders.length} line-numbered citation(s) into ${PAGE_PATH}:\n\n${offenders.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * EVERY SECTION REFERENCE NAMES A HEADING THE PAGE HAS.
   *
   * This is what makes the de-numbering above a CHECKED fix rather than merely a cheaper one. The
   * `→ "Heading"` convention already existed in the tree; this arm is what stops a heading rename
   * from silently orphaning every reference to it.
   */
  it('every `→ "Heading"` reference to this page names a heading the page declares', () => {
    const refs: { where: string; heading: string }[] = [];
    for (const file of sourceFiles) {
      if (file.rel === PAGE_PATH) continue;
      for (const match of flat(file.text).matchAll(
        /workforce-architecture\.md`?\s*(?:→|->)\s*[“"]([^”"]+)[”"]/g,
      )) {
        refs.push({ where: file.rel, heading: match[1] as string });
      }
    }
    expect(
      refs.length,
      'no section reference was found at all — this arm would verify nothing',
    ).toBeGreaterThan(1);

    const unknown = refs
      .filter((ref) => !pageHeadings.has(ref.heading))
      .map(
        (ref) =>
          `${ref.where} points at ${PAGE_PATH} → ${JSON.stringify(ref.heading)}, which is not a heading on that page.\n` +
          `  The page declares: ${[...pageHeadings].map((h) => JSON.stringify(h)).join(', ')}`,
      );
    expect(
      unknown,
      `${unknown.length} reference(s) name a heading this page does not have:\n\n${unknown.join('\n\n')}\n`,
    ).toEqual([]);
  });
});
