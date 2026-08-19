/**
 * THE THREAT MODEL'S EVIDENCE IS GUARDED, not hand-checked.
 *
 * `docs/workforce-threat-model.md` is the OC-004 sign-off artifact, and every sentence in it rests
 * on either a `file:line` citation or a named test. Both rot, and both rot INVISIBLY.
 *
 * A citation LOOKS verified because it has a number attached. On an earlier item in this program a
 * first pass confirmed 35 of 38 citations resolved to an existing file and an in-range line — and
 * 17 were stale anyway, because the line still existed and still held code, just not the code the
 * argument was about. Most of that rot was SELF-inflicted (the author's own edits shifting a file
 * by ~100 lines), which is precisely the case nobody re-checks. A named test rots the same way: a
 * renamed `it(...)` leaves the page claiming a proof that no longer exists under that name.
 *
 * So the page carries TWO ledgers — Appendix A pins each code citation to THE SUBSTRING ITS LINE
 * MUST CONTAIN, Appendix B pins each cited suite to a test title it must still declare — and this
 * guard checks values, never ranges or mere existence. Seven arms:
 *
 *   1. every Appendix A entry resolves AND its line contains the recorded substring;
 *   2. every citation in the PROSE is in Appendix A — otherwise a citation added later is verified
 *      by nothing, which is how six bare citations once slipped past a guard that matched only full
 *      paths, two of them already stale;
 *   3. every prose citation is a full repo-relative path naming exactly ONE line — a bare
 *      `context.ts:72` or a `:163-188` range cannot be value-checked, so it is refused outright
 *      rather than half-checked;
 *   4. every Appendix B entry's suite still declares the recorded test title;
 *   5. every `*.test.ts` path in the PROSE is in Appendix B — the same both-directions rule;
 *   6. every test title QUOTED IN THE PROSE beside its suite really exists in that suite;
 *   7. the scan FAILS CLOSED. A reworded page that produced zero citations, or an emptied ledger,
 *      would otherwise be reported green by a guard that had simply stopped finding anything —
 *      "the property holds" and "the scan stopped finding the code" are the same reading without
 *      this arm.
 *
 * Arm 6 exists because the mutation battery for this guard found it missing: renaming a test title
 * in the PROSE went green, since only Appendix B's copy of the title was being checked. Appendix B
 * was a parallel universe the page could drift away from silently. Arm 6 checks the sentence a
 * reader actually reads.
 *
 * Directions 2 and 5 matter as much as 1 and 4: a hand-curated list is checked once; a guard is
 * checked every run, including on the merge that moved the code.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const PAGE_PATH = 'docs/workforce-threat-model.md';
const page = readFileSync(resolve(repoRoot, PAGE_PATH), 'utf8');

/** The two ledger headings. Everything above the FIRST of them is PROSE. */
const CODE_LEDGER_HEADING = '## Appendix A — citation ledger';
const TEST_LEDGER_HEADING = '## Appendix B — test ledger';

/** Repo-relative roots a citation may point into. A path outside them is not a repo file. */
const CITABLE_ROOTS = ['packages/', 'scripts/', 'docs/', 'examples/', 'deployments/'];

/**
 * A citation token as it may appear anywhere in the page. Deliberately PERMISSIVE about the path
 * (it matches a bare `context.ts:72` too) so arm 3 can REFUSE the bare form rather than silently
 * not matching it — a regex that accepted only full paths would report the bare ones as absent,
 * which reads as "there are none".
 */
const CITATION_RE =
  /[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:ts|mts|mjs|sql|json|yml|yaml|md):\d+(?:-\d+)?/g;

/** A cited suite: any `*.test.ts` path, including the `.db.test.ts` spelling. */
const TEST_PATH_RE = /[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.test\.ts/g;

/**
 * THE PAGE'S CONVENTION for naming a proof: a backticked suite path, a comma, then the backticked
 * test title — `<path>`, `<title>`. Written that way the pair is machine-checkable, which is the
 * whole reason the convention exists. A line break between the two is allowed (the page wraps).
 */
const PROSE_PROOF_RE = /`([A-Za-z0-9_./-]+\.test\.ts)`,\s*`([^`]+)`/g;

/** Whitespace-insensitive containment: the page wraps titles that the source holds on one line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

function sectionBounds(): { prose: string; codeLedger: string; testLedger: string } {
  const codeAt = page.indexOf(CODE_LEDGER_HEADING);
  const testAt = page.indexOf(TEST_LEDGER_HEADING);
  if (codeAt < 0) throw new Error(`heading ${JSON.stringify(CODE_LEDGER_HEADING)} moved`);
  if (testAt < codeAt) throw new Error(`heading ${JSON.stringify(TEST_LEDGER_HEADING)} moved`);
  return {
    prose: page.slice(0, codeAt),
    codeLedger: page.slice(codeAt, testAt),
    testLedger: page.slice(testAt),
  };
}
const { prose, codeLedger, testLedger } = sectionBounds();

/** Split the ONE fenced `text` block of a section into `left | right` rows. */
function fencedRows(section: string, what: string): readonly { left: string; right: string }[] {
  const fenced = /```text\n([\s\S]*?)```/.exec(section);
  if (fenced === null) throw new Error(`the ${what} fence (\`\`\`text) is missing`);
  const rows: { left: string; right: string }[] = [];
  for (const raw of (fenced[1] as string).split('\n')) {
    const row = raw.trim();
    if (row.length === 0 || row.startsWith('#')) continue;
    const bar = row.indexOf('|');
    if (bar <= 0) throw new Error(`${what} row has no '|' delimiter: ${JSON.stringify(row)}`);
    rows.push({ left: row.slice(0, bar).trim(), right: row.slice(bar + 1).trim() });
  }
  return rows;
}

interface CodeEntry {
  readonly citation: string;
  readonly path: string;
  readonly line: number;
  readonly expected: string;
}

const codeEntries: readonly CodeEntry[] = fencedRows(codeLedger, 'citation ledger').map((row) => {
  const colon = row.left.lastIndexOf(':');
  if (colon <= 0) throw new Error(`citation ledger row is not <path>:<line>: ${row.left}`);
  return {
    citation: row.left,
    path: row.left.slice(0, colon),
    line: Number.parseInt(row.left.slice(colon + 1), 10),
    expected: row.right,
  };
});
const testEntries = fencedRows(testLedger, 'test ledger');

const codeCitations = new Set(codeEntries.map((entry) => entry.citation));
const testPathsInLedger = new Set(testEntries.map((entry) => entry.left));
const proseCitations = [...new Set(prose.match(CITATION_RE) ?? [])];
const proseTestPaths = [...new Set(prose.match(TEST_PATH_RE) ?? [])];
const proseProofs = [...prose.matchAll(PROSE_PROOF_RE)].map((m) => ({
  path: m[1] as string,
  title: m[2] as string,
}));

/** Cache: a file is read once however many entries point into it. */
const fileText = new Map<string, string>();
function textOf(path: string): string {
  const cached = fileText.get(path);
  if (cached !== undefined) return cached;
  const read = readFileSync(resolve(repoRoot, path), 'utf8');
  fileText.set(path, read);
  return read;
}

describe(`${PAGE_PATH} — the evidence ledgers`, () => {
  it('FAILS CLOSED: the page still cites code and tests, and both ledgers still carry entries', () => {
    // Without this, a reworded page that stopped producing citations would pass every other arm
    // vacuously — "the property holds" and "the scan stopped finding the code" read identically.
    expect(
      codeEntries.length,
      'the citation ledger is EMPTY — the guard would verify nothing',
    ).toBeGreaterThan(30);
    expect(
      testEntries.length,
      'the test ledger is EMPTY — no named proof is checked',
    ).toBeGreaterThan(10);
    expect(
      proseCitations.length,
      'the page cites no file:line at all — it stopped being evidence',
    ).toBeGreaterThan(30);
    expect(
      proseTestPaths.length,
      'the page names no test — it stopped being evidence',
    ).toBeGreaterThan(10);
    expect(
      proseProofs.length,
      'the page quotes no test TITLE beside a suite — arm 6 checks nothing',
    ).toBeGreaterThan(20);
  });

  it('every citation resolves AND the cited line CONTAINS the recorded text', () => {
    // The whole point: an in-range citation is not a verified one. Only the VALUE settles it.
    //
    // COLLECT-THEN-ASSERT, deliberately — this was a `for` loop of `expect()`, which throws on the
    // FIRST bad entry and reports it as though it were the only one. It is not a style preference:
    // the last time this ledger drifted the loop named ONE rotted pin while fourteen were rotted,
    // and the program has now paid for one-at-a-time rediscovery across four separate rounds
    // (`planning/knowledge/repo-facts.md` → "ONE RED IS NOT ONE DEFECT"). A guard that
    // under-reports its own findings turns every fix into a new full verification cycle, so the
    // whole ledger is walked and every failure is reported in one run.
    const failures: string[] = [];
    for (const entry of codeEntries) {
      const lines = textOf(entry.path).split('\n');
      if (entry.line > lines.length) {
        failures.push(
          `${entry.citation}: line ${entry.line} is past the end of the file (${lines.length} lines)`,
        );
        continue;
      }
      if (entry.expected.length === 0) {
        failures.push(`${entry.citation}: the ledger records no expected text`);
        continue;
      }
      const actual = lines[entry.line - 1] ?? '';
      if (!actual.includes(entry.expected)) {
        // Where the token DOES live now, so a re-pin does not need a second tool to find out.
        const found = lines
          .map((l, i) => (l.includes(entry.expected) ? i + 1 : 0))
          .filter((n) => n > 0);
        failures.push(
          `${entry.citation} has ROTTED.\n  expected the line to contain: ${entry.expected}\n` +
            `  the line actually reads:      ${actual.trim()}\n` +
            `  the text is now at line(s):   ${found.length > 0 ? found.join(', ') : '(nowhere in the file)'}`,
        );
      }
    }
    expect(
      failures,
      `${failures.length} of ${codeEntries.length} ledger entries have rotted:\n\n${failures.join('\n\n')}\n`,
    ).toEqual([]);
  });

  it('every citation in the PROSE is in the ledger — none is verified by nothing', () => {
    const missing = proseCitations.filter((citation) => !codeCitations.has(citation));
    expect(
      missing,
      'these citations appear in the page but not in Appendix A, so nothing checks them',
    ).toEqual([]);
  });

  it('every prose citation is a FULL repo-relative path naming exactly ONE line', () => {
    const bare = proseCitations.filter(
      (citation) => !CITABLE_ROOTS.some((root) => citation.startsWith(root)),
    );
    expect(
      bare,
      'a bare-filename citation cannot be resolved, so it is verified by nothing',
    ).toEqual([]);
    const ranges = proseCitations.filter((citation) => /:\d+-\d+$/.test(citation));
    expect(ranges, 'a line RANGE cannot be value-checked — cite the one load-bearing line').toEqual(
      [],
    );
  });

  it('every test title QUOTED IN THE PROSE really exists in the suite beside it', () => {
    // Arm 4 checks Appendix B's copy of a title. This arm checks the sentence a READER reads —
    // without it, a title renamed in the prose alone goes green, which is how this hole was found.
    for (const proof of proseProofs) {
      expect(
        flat(textOf(proof.path)).includes(flat(proof.title)),
        `the page claims ${proof.path} contains a test titled:\n  ${flat(proof.title)}\n` +
          'It does not. A reader who greps for that title finds nothing.',
      ).toBe(true);
    }
  });

  it('every named test still EXISTS under the title the page claims for it', () => {
    for (const entry of testEntries) {
      expect(
        textOf(entry.left).includes(entry.right),
        `${entry.left} no longer declares the cited test.\n  expected the file to contain: ` +
          `${entry.right}\n  A renamed test leaves the page claiming a proof nobody can find.`,
      ).toBe(true);
    }
  });

  it('every suite named in the PROSE is in the test ledger', () => {
    const missing = proseTestPaths.filter((path) => !testPathsInLedger.has(path));
    expect(
      missing,
      'these suites are cited as proof in the page but pinned by nothing in Appendix B',
    ).toEqual([]);
  });
});
