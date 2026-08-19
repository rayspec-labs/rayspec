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
 * sentences the page no longer makes. So three arms close the loop, and the precise claim is:
 * every FILE and every SYMBOL the prose names has a ledger row, AND every ledger row is anchored by
 * a file or a token the prose still names. Not literal set equality — one file legitimately carries
 * several rows, and a symbol's row may pin a file the page never names — but no member of either
 * side is unaccounted for.
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const PAGE_PATH = 'docs/workforce-architecture.md';
const page = readFileSync(resolve(repoRoot, PAGE_PATH), 'utf8');

/** The tracked roots a citation may point into, and the roots this suite scans for back-references. */
const SCAN_ROOTS = ['packages', 'scripts', 'examples', 'docs', 'deployments', '.github'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.claude']);
const SCAN_EXTENSIONS = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|md|sh|sql|json|yml|yaml)$/;

/** The ledger heading. EVERYTHING above it is prose; everything from it down is the pin table. */
const LEDGER_HEADING = '## Appendix A — citation ledger';

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

/** Basename → every tracked path carrying it. Names only, so nothing is read to build it. */
const nameIndex: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
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
      out.set(name, [...(out.get(name) ?? []), full.slice(repoRoot.length + 1)]);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root));
  return out;
})();

/** The page split at the ledger heading. A moved heading throws here rather than reading vacuous. */
const { prose, ledgerSection } = (() => {
  const at = page.indexOf(LEDGER_HEADING);
  if (at < 0) throw new Error(`heading ${JSON.stringify(LEDGER_HEADING)} moved or was deleted`);
  return { prose: page.slice(0, at), ledgerSection: page.slice(at) };
})();

interface LedgerRow {
  /** Repo-relative path, without the `:NN` a line-pinned row carries. */
  readonly path: string;
  /** Present only on the value-checked line pin. */
  readonly line: number | undefined;
  /** The text the file (or that one line) must still contain. */
  readonly token: string;
  /** The row exactly as the page writes it, for failure messages. */
  readonly raw: string;
}

/** The ONE fenced `text` block of the appendix, split into `left | right` rows. */
const ledgerRows: readonly LedgerRow[] = (() => {
  const fenced = /```text\n([\s\S]*?)```/.exec(ledgerSection);
  if (fenced === null) throw new Error('the citation ledger fence (```text) is missing');
  const rows: LedgerRow[] = [];
  for (const line of (fenced[1] as string).split('\n')) {
    const row = line.trim();
    if (row.length === 0 || row.startsWith('#')) continue;
    const bar = row.indexOf('|');
    if (bar <= 0) throw new Error(`ledger row has no '|' delimiter: ${JSON.stringify(row)}`);
    const left = row.slice(0, bar).trim();
    const token = row.slice(bar + 1).trim();
    const colon = left.lastIndexOf(':');
    const lineSuffix = colon > 0 ? left.slice(colon + 1) : '';
    const isLinePin = /^\d+$/.test(lineSuffix);
    rows.push({
      path: isLinePin ? left.slice(0, colon) : left,
      line: isLinePin ? Number.parseInt(lineSuffix, 10) : undefined,
      token,
      raw: left,
    });
  }
  return rows;
})();

/**
 * Every backticked file-shaped token in the PROSE, with the `:NN` it carried (if any).
 *
 * Deliberately PERMISSIVE about the path — it matches a bare `context.ts` and a line-numbered
 * `x.ts:99` too — so the arms below can REFUSE those forms rather than silently not matching them.
 * A regex that accepted only the good shape would report the bad ones as absent, which reads as
 * "there are none": the exact false green this suite exists to close.
 */
const PROSE_FILE_RE =
  /`([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:ts|tsx|mts|cts|mjs|cjs|js|sql|sh|json|yml|yaml|md))(?::(\d+(?:-\d+)?))?`/g;

/**
 * Every backticked identifier written in MIXED CASE — at least one upper and one lower, no
 * separators. That shape is what makes the set MACHINE-DECIDABLE, which is the only reason the arm
 * below can demand a pin for the WHOLE set instead of for a hand-picked subset of it.
 *
 * THE BOUND, NAMED. Four families of backticked token fall outside deliberately, because none of
 * them is a symbol a reader would go looking for in a file: `snake_case` columns and status
 * literals (`awaiting_children`), `UPPER_SNAKE` constants and env vars, all-caps words that are not
 * identifiers at all (`SIGKILL`, `NULL`, a SQLSTATE), and anything containing a space or bracket.
 * A cited symbol that somehow used one of those spellings would be checked by nothing here — that
 * is a real gap, it is bounded, and it is written down rather than left to be discovered.
 */
const PROSE_IDENT_RE = /`([A-Za-z][A-Za-z0-9]{2,})`/g;
const isMixedCase = (token: string): boolean => /[a-z]/.test(token) && /[A-Z]/.test(token);

const proseCitations = [...prose.matchAll(PROSE_FILE_RE)].map((m) => ({
  file: m[1] as string,
  line: m[2],
}));
const proseFiles = [...new Set(proseCitations.map((c) => c.file))];
const proseIdents = [
  ...new Set([...prose.matchAll(PROSE_IDENT_RE)].map((m) => m[1] as string).filter(isMixedCase)),
];

const ledgerPaths = new Set(ledgerRows.map((row) => row.path));
const ledgerTokens = new Set(ledgerRows.map((row) => row.token));
const ledgerByBase = new Map<string, string[]>();
for (const path of ledgerPaths) {
  const base = basename(path);
  ledgerByBase.set(base, [...(ledgerByBase.get(base) ?? []), path]);
}

/** Cache: a file is read once however many rows point into it. */
const fileText = new Map<string, string | null>();
function textOf(path: string): string | null {
  const cached = fileText.get(path);
  if (cached !== undefined) return cached;
  let read: string | null;
  try {
    read = readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    read = null;
  }
  fileText.set(path, read);
  return read;
}

/**
 * Does `text` still carry the pinned token?
 *
 * A bare IDENTIFIER is matched on WORD BOUNDARIES, not as a substring — and that distinction is not
 * a nicety. The mutation battery for this suite caught it: renaming `computeTurnFacts` to
 * `computeTurnFactsV2` throughout its module left a plain `includes()` check GREEN, because the new
 * name contains the old one. A rename that APPENDS is the ordinary shape of a rename (`…V2`,
 * `…Internal`, `…Unsafe`), so substring containment would have missed the most common way the thing
 * this suite exists to catch actually happens.
 *
 * Anything that is not a bare identifier — a test title, a docblock heading, a fragment of code with
 * spaces or punctuation — is matched as a substring, which is correct for it: the page quotes those
 * as prose and the source wraps them differently.
 */
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function carries(text: string, token: string): boolean {
  if (!BARE_IDENTIFIER.test(token)) return text.includes(token);
  return new RegExp(`(?<![A-Za-z0-9_$])${token}(?![A-Za-z0-9_$])`).test(text);
}

/** Where a token lives NOW, so a re-pin needs no second tool. */
function whereItLivesNow(token: string): string {
  const homes = sourceFiles.filter((f) => carries(f.text, token)).map((f) => f.rel);
  if (homes.length === 0) return '(nowhere in the tree — it was renamed or deleted)';
  return homes.slice(0, 5).join(', ') + (homes.length > 5 ? ` (+${homes.length - 5} more)` : '');
}

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

describe(`${PAGE_PATH} — the citation ledger`, () => {
  /**
   * FAILS CLOSED.
   *
   * Without this arm, a reworded page that produced zero citations — or an emptied ledger — passes
   * every other arm here vacuously, because "nothing failed" and "nothing was checked" are the same
   * reading. This is the arm that catches the guard being quietly turned off, which is a strictly
   * more likely failure than any single pin rotting.
   */
  it('FAILS CLOSED: the ledger, the prose and the derived sets all still carry entries', () => {
    expect(
      ledgerRows.length,
      'the citation ledger is EMPTY or nearly so — this suite would verify nothing',
    ).toBeGreaterThan(40);
    expect(
      proseFiles.length,
      'the page names almost no file — it stopped citing its own mechanisms',
    ).toBeGreaterThan(25);
    expect(
      proseIdents.length,
      'the page names almost no symbol — the symbol arm below checks nothing',
    ).toBeGreaterThan(15);
    expect(
      ledgerRows.filter((row) => row.line !== undefined).length,
      'the value-checked line pin vanished — its exception is now unguarded',
    ).toBe(1);
    const blank = ledgerRows.filter((row) => row.token.length === 0).map((row) => row.raw);
    expect(blank, 'these ledger rows record no text, so they check nothing').toEqual([]);
    const keys = ledgerRows.map((row) => `${row.raw} | ${row.token}`);
    const duplicated = keys.filter((key, at) => keys.indexOf(key) !== at);
    expect(duplicated, 'these ledger rows are duplicates — one of each is dead weight').toEqual([]);
  });

  /**
   * LEDGER → CODE. The property the page's whole citation style rests on: a named symbol still
   * exists, and still lives in the file the sentence sends you to.
   *
   * The failure message NAMES WHERE THE TEXT LIVES NOW. A symbol that moved house is the common
   * case — far more common than one deleted outright — and a guard that only says "not here" makes
   * the reader re-derive what the guard already computed.
   *
   * COLLECT-THEN-ASSERT: the whole ledger is walked and every rot is reported in one run. A `for`
   * loop of `expect()` throws on the first bad row and reports it as though it were the only one,
   * which turns a single fix-and-re-run into as many cycles as there are rotted pins.
   */
  it('every ledger row still finds its text where the ledger says — and says where it moved', () => {
    const failures: string[] = [];
    for (const row of ledgerRows) {
      const text = textOf(row.path);
      if (text === null) {
        failures.push(
          `${row.raw}: the file does not exist.\n` +
            `  the pinned text is now in: ${whereItLivesNow(row.token)}`,
        );
        continue;
      }
      if (row.line !== undefined) {
        const lines = text.split('\n');
        const actual = lines[row.line - 1] ?? '';
        if (!carries(actual, row.token)) {
          const found = lines
            .map((l, i) => (carries(l, row.token) ? i + 1 : 0))
            .filter((n) => n > 0);
          failures.push(
            `${row.raw} has ROTTED.\n  expected that line to contain: ${row.token}\n` +
              `  the line actually reads:       ${actual.trim()}\n` +
              `  the text is now at line(s):    ${found.length > 0 ? found.join(', ') : '(nowhere in the file)'}`,
          );
        }
        continue;
      }
      if (!carries(text, row.token)) {
        failures.push(
          `${row.raw} no longer contains ${JSON.stringify(row.token)}.\n` +
            `  ${PAGE_PATH} sends a reader to that file for it, and they will not find it.\n` +
            `  it now lives in: ${whereItLivesNow(row.token)}`,
        );
      }
    }
    expect(
      failures,
      `${failures.length} of ${ledgerRows.length} ledger rows have rotted:\n\n${failures.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * PROSE → LEDGER, files. A citation added to the page with no pin behind it is verified by
   * nothing, which is how a hand-curated pin list falls behind the prose it was written for.
   */
  it('every file the PROSE cites is pinned in the ledger', () => {
    const unpinned: string[] = [];
    for (const file of proseFiles) {
      if (file.includes('/')) {
        if (!ledgerPaths.has(file)) {
          unpinned.push(
            `${JSON.stringify(file)} is cited on the page but pinned by no ledger row, so nothing checks it.\n` +
              '  Add a row: <repo-relative path> | <the text that file must still contain>.',
          );
        }
        continue;
      }
      // A bare name resolves through the ledger's basenames. It must land on exactly ONE row's
      // path: two ledger rows sharing a basename would make the citation ambiguous on the LEDGER
      // side even where the arm below proves it unambiguous in the tree.
      const pinned = ledgerByBase.get(basename(file)) ?? [];
      if (pinned.length !== 1) {
        unpinned.push(
          `${JSON.stringify(file)} resolves to ${pinned.length} ledger row path(s)${pinned.length > 0 ? `: ${pinned.join(', ')}` : ''}.\n` +
            '  A bare citation must map to exactly one pinned path. Add the row, or write the full\n' +
            '  repo-relative path on the page so the pin is unambiguous.',
        );
      }
    }
    expect(
      unpinned,
      `${unpinned.length} citation(s) on the page are verified by nothing:\n\n${unpinned.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * PROSE → LEDGER, symbols. The direction that makes "every symbol the page cites still exists"
   * true OF THE PAGE rather than of whichever symbols someone remembered to pin.
   */
  it('every symbol the PROSE names is pinned in the ledger', () => {
    const unpinned = proseIdents
      .filter((ident) => !ledgerTokens.has(ident))
      .map(
        (ident) =>
          `\`${ident}\` is named on the page but pinned by no ledger row.\n` +
          `  It currently lives in: ${whereItLivesNow(ident)}`,
      );
    expect(
      unpinned,
      `${unpinned.length} symbol(s) on the page are verified by nothing:\n\n${unpinned.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * LEDGER → PROSE. The other half of "both directions", and the one a pin table usually lacks: a
   * row nothing on the page references is a pin that outlived its sentence, and it reads as coverage
   * the page does not actually have. A row is ANCHORED when the page names its file (in full or as
   * a bare name) or prints its token.
   */
  it('every ledger row is anchored in the prose — the pin set cannot run ahead of the page', () => {
    const proseFileSet = new Set(proseFiles);
    const proseBaseSet = new Set(proseFiles.map((file) => basename(file)));
    const orphans = ledgerRows
      .filter(
        (row) =>
          !proseFileSet.has(row.path) &&
          !proseBaseSet.has(basename(row.path)) &&
          !carries(prose, row.token),
      )
      .map(
        (row) =>
          `${row.raw} | ${row.token}\n` +
          '  Neither the file nor the text is named anywhere in the prose, so this row pins a claim\n' +
          '  the page no longer makes. Delete the row, or restore the sentence it was written for.',
      );
    expect(
      orphans,
      `${orphans.length} ledger row(s) have outlived their sentence:\n\n${orphans.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * A BARE FILENAME MUST BE UNAMBIGUOUS.
   *
   * The page cites most files by bare name, which is readable and fine — as long as the name picks
   * out one file. It did not always: two bare citations on this page resolved to five and two
   * candidates respectively when this arm was written, so a reader grepping the name landed
   * somewhere arbitrary and the pin table could not tell which file was meant either. This arm is
   * what keeps the bare form honest instead of banning it.
   */
  it('every bare filename the page uses resolves to exactly ONE file in the tree', () => {
    const ambiguous = proseFiles
      .filter((file) => !file.includes('/'))
      .map((file) => ({ file, homes: nameIndex.get(file) ?? [] }))
      .filter((entry) => entry.homes.length !== 1)
      .map(
        (entry) =>
          `\`${entry.file}\` resolves to ${entry.homes.length} file(s): ${entry.homes.join(', ') || '(none)'}\n` +
          '  A reader cannot follow it and the ledger cannot say which one is meant. Write the full\n' +
          '  repo-relative path on the page.',
      );
    expect(
      ambiguous,
      `${ambiguous.length} bare citation(s) do not resolve to exactly one file:\n\n${ambiguous.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * THE PAGE PRINTS NO LINE NUMBER — except the one the ledger value-checks.
   *
   * This is the page's own stated rule, and until now it was enforced by nobody: the page said it
   * would not print line numbers and nothing stopped one being typed. The single exception is a
   * citation into a released migration file, which cannot rot because the file is never edited —
   * and it is still checked BY VALUE above, so the exception is a pinned row rather than a hole.
   */
  it('this page prints no line number, except the one the ledger value-checks', () => {
    const permitted = new Set(
      ledgerRows
        .filter((row) => row.line !== undefined)
        .flatMap((row) => [
          `${row.path}:${String(row.line)}`,
          `${basename(row.path)}:${String(row.line)}`,
        ]),
    );
    const offenders = proseCitations
      .filter((c) => c.line !== undefined)
      .map((c) => `${c.file}:${c.line as string}`)
      .filter((citation) => !permitted.has(citation))
      .map(
        (citation) =>
          `\`${citation}\` is a line-numbered citation on a page that says it prints none.\n` +
          '  A line number looks precise, is checked less, and rots silently. Cite the symbol,\n' +
          '  function or test title instead, and pin it in the ledger.',
      );
    expect(
      offenders,
      `${offenders.length} line-numbered citation(s) on the page:\n\n${offenders.join('\n\n')}\n`,
    ).toEqual([]);
  });

  /**
   * A VALUE, not merely a symbol. The page states the claim lease in MINUTES; the scheduler ships it
   * in milliseconds. Read as source text rather than imported: `@rayspec/workforce-tools` has no
   * dependency edge on `@rayspec/durable-dbos`, and adding one to check a number would rewrite the
   * lockfile's importers block and turn `gate:sbom-fresh` red.
   */
  it('the lease this page states in minutes is the lease the scheduler ships', () => {
    const schedulerPath = 'packages/workflow/durable-dbos/src/task-scheduler.ts';
    const source = textOf(schedulerPath);
    expect(source, `${schedulerPath} is gone — the arm below would check nothing`).not.toBeNull();
    // Anchored on `const`, so a mention inside a docblock or a call site cannot be read as the
    // declaration — the value must come from the one line that actually defines it.
    const declared = /const DEFAULT_TURN_LEASE_MS\s*=\s*([\d_]+)/.exec(source as string);
    expect(
      declared,
      `DEFAULT_TURN_LEASE_MS is no longer declared in ${schedulerPath} — nothing anchors the number`,
    ).not.toBeNull();
    const minutes =
      Number.parseInt((declared as RegExpExecArray)[1]?.replaceAll('_', '') ?? '0', 10) / 60_000;
    expect(
      prose,
      `the scheduler ships a ${minutes}-minute default lease; the page must say so`,
    ).toContain(`The default lease is ${minutes} minutes`);
  });
});
