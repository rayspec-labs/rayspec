/**
 * `assertWorkforceAcceptsWork` READS THE RUNTIME ROW THROUGH THE LOCKING UPSERT — a static
 * tripwire, not a comment.
 *
 * The gate's completeness argument is a LOCK argument. `ensureWorkforceRuntime` is an
 * `INSERT … ON CONFLICT DO UPDATE` whose `set` is a REAL write, so it takes the
 * `workforce_runtime` row's exclusive lock and holds it until the caller's transaction commits —
 * and `pauseWorkforce` writes that same row. That is what gives the two a total order, and it is
 * the whole reason a submission that wins the race is guaranteed to be visible to a later halt's
 * roots scan.
 *
 * Swapping it for `readWorkforceRuntime` — a plain `SELECT`, right there in this same module and
 * returning the same record type — keeps the refusal working in every serial test while silently
 * dropping the lock. Nothing behavioural in a serial suite would say so. The db-backed arm in
 * @rayspec/server (`workforce-goal-intake.db.test.ts`, `TAKES the runtime row lock, and holds NO
 * task lock while it waits`) does catch it, from the database side via `pg_blocking_pids`; this
 * scan catches it in the package that OWNS the helper, in lane 1, without a database. Both, for
 * the same reason #502 pinned its identical blind spot twice: the behavioural arm needs a wedged
 * transaction and this is free.
 *
 * FAIL-CLOSED: the function must be found and each marker must appear exactly once inside it, so a
 * rename or a scan that stops finding the code turns this red rather than green.
 *
 * ...AND THE OCCURRENCE MUST BE CODE, NOT MERELY TEXT. A raw `indexOf` over file text cannot tell
 * a statement from a statement that has been COMMENTED OUT with its text left behind, so the scan
 * could be defeated by SUBSTITUTION: comment the locking read out, leave the marker to satisfy
 * this file, and route the real read through something unlocked. That was MEASURED, not theorised
 * — 2026-08-19, on this file as first written:
 *
 *   - S1, ADDITION (a decoy comment added BESIDE a live locking read)     -> RED   (2 failed / 3)
 *   - S2, SUBSTITUTION (locking read commented out, the real read routed
 *     through a local alias of the UNLOCKED plain read so the negative arm
 *     below is not tripped — the exact silent lock drop this file exists
 *     to catch)                                                           -> GREEN (3 passed / 3)
 *   - S3, REFORMAT (an explicit type annotation on the same locking read) -> RED   (2 failed / 3)
 *
 * Addition and reformatting were already fail-closed. Substitution was the one hole, and
 * `onlyIndexOf` now closes it by ALSO requiring the single occurrence to sit at a real CODE
 * position — see `maskedSpans`, which is computed by the TypeScript parser rather than by a
 * regex, and the adversarial battery at the bottom of this file that pins its behaviour.
 *
 * Nothing was relaxed to add it: the exact-text and exactly-once rules are untouched, which is why
 * S1 and S3 still red — and the NEGATIVE arm at the bottom deliberately still reads RAW text. For
 * a denial, raw text is the STRONGER reading: it refuses a commented-out fallback too, and it
 * fails closed on a mere mention. (Observed while building the S2 mutation above: a comment that
 * merely NAMED the denied token reddened that arm.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SOURCE = resolve(here, 'runtime.ts');

// [SOURCE-MASKER v2 BEGIN] — every copy of this block is pinned byte-identical; see the sameness
// arm at the bottom of this file, which finds the copies on disk rather than trusting a list.
//
// WHAT MAKES "THE MARKER IS CODE" A CHECKABLE CLAIM.
//
// TWO PASSES, AND THE ORDER IS WHAT MAKES THEM EXACT:
//
//   1. LITERALS, from the TypeScript parser's own AST. The parser — not a regex — is what decides
//      whether a `/` opens a regular expression or divides, because that is a parse-context
//      question no lexer can answer alone. Getting it wrong swallows real code.
//   2. COMMENTS, scanned over a copy with pass 1's spans blanked out. On text that holds no
//      string, template or regex literal, `//` and `/*` can ONLY begin a comment: every quote
//      that could confuse the scan is already gone, and division can never leave two adjacent
//      slashes because JavaScript reads those as a comment too. A comment-FIRST pass is the one
//      that gets `'https://example.com'` wrong.
//
// BOTH PASSES ARE LOAD-BEARING, and that was measured rather than assumed: an AST-only masker is
// defeated by exactly the substitution shape these scans exist to refuse, because `forEachChild`
// never visits punctuation tokens and so never reaches a comment that is leading trivia of a bare
// `}`; a comment-first masker breaks on `'https://…'`. Neither pass can be dropped.
//
// THE TWO CONSTRUCTS AN AST WALK STILL CANNOT REACH ARE CLOSED BY MECHANISM, NOT BY ARGUMENT:
//
//   - A SHEBANG is trivia no node carries. It can only sit at offset 0, and is masked as a span.
//   - CONFLICT MARKERS are reported as parse diagnostics (measured: 3 for a two-way conflict), and
//     this REFUSES any source that produces a diagnostic at all. A mis-parse under-masks, and
//     under-masking is the direction that leaves a hole open while looking fixed.
//
// IT ERRS TOWARD OVER-MASKING, DELIBERATELY. Spans are taken at full extent including delimiters,
// and an unterminated comment masks to end of file. Over-masking makes a guard go RED for the
// wrong reason — loud, and survivable. Under-masking would leave the hole open while looking
// fixed, which is silent. Given the choice, this instrument takes the loud failure.

/** Node kinds whose text is DATA, never executable code. */
const MASKED_LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/** Every `[from, to)` span of `source` whose text is a comment or a literal — never code. */
function maskedSpans(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];

  // PASS 1 — literals, from the parser.
  const parsed = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, scriptKind);
  // FAIL CLOSED on a source the parser could not read: a mis-parse under-masks. `parseDiagnostics`
  // is not on the public `SourceFile` type, so it is read defensively — if the field ever
  // disappears the check degrades to a no-op instead of throwing on every file.
  const diagnostics = (parsed as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(
      `source masking REFUSED a file the TypeScript parser reported ${diagnostics.length} ` +
        'syntax diagnostic(s) in (conflict markers do exactly this). A mis-parse under-masks, ' +
        'which is the silent direction, so this throws rather than guessing.',
    );
  }
  const walk = (node: ts.Node): void => {
    if (MASKED_LITERAL_KINDS.has(node.kind)) spans.push([node.getStart(parsed), node.getEnd()]);
    node.forEachChild(walk);
  };
  parsed.forEachChild(walk);

  // PASS 2 — comments, over literal-free text. Blanking preserves length, so offsets still line
  // up with the original; newlines are kept so a `//` comment still ends where it really ends.
  const chars = source.split('');
  for (const [from, to] of spans) {
    for (let at = from; at < to; at += 1) {
      if (chars[at] !== '\n') chars[at] = ' ';
    }
  }
  const blanked = chars.join('');
  // The shebang, which is trivia the AST never surfaces and which can only sit at offset 0.
  if (blanked.startsWith('#!')) {
    const firstLine = blanked.indexOf('\n');
    spans.push([0, firstLine < 0 ? blanked.length : firstLine]);
  }
  let cursor = 0;
  while (cursor < blanked.length) {
    const slash = blanked.indexOf('/', cursor);
    if (slash < 0) break;
    const next = blanked[slash + 1];
    if (next === '/') {
      const newline = blanked.indexOf('\n', slash);
      const end = newline < 0 ? blanked.length : newline;
      spans.push([slash, end]);
      cursor = end;
    } else if (next === '*') {
      const close = blanked.indexOf('*/', slash + 2);
      const end = close < 0 ? blanked.length : close + 2;
      spans.push([slash, end]);
      cursor = end;
    } else {
      cursor = slash + 1;
    }
  }
  return spans;
}

/** A code-position test over one source text, with the parse done once. */
function codeMask(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): (offset: number) => boolean {
  const spans = maskedSpans(source, scriptKind);
  return (offset) => !spans.some(([from, to]) => offset >= from && offset < to);
}
// [SOURCE-MASKER v2 END]

/** A sliced region of a source file, plus the code-position test for the file it came from. */
interface MethodScan {
  /** The slice every marker must be found inside. */
  readonly body: string;
  /** True when an offset WITHIN `body` is a real code position of the underlying file. */
  readonly isCode: (offsetInBody: number) => boolean;
}

/**
 * The helper's body, sliced out so a marker elsewhere in runtime.ts cannot satisfy the scan.
 *
 * The mask is computed over the WHOLE file and the offsets translated, never over the slice: a
 * parser handed a fragment it cannot parse is exactly how a masker starts under-masking, and
 * under-masking is the failure direction that leaves the hole open while looking fixed.
 */
function gateScan(): MethodScan {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('export async function assertWorkforceAcceptsWork(');
  expect(
    start,
    'the scan must find `assertWorkforceAcceptsWork` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  const isCode = codeMask(src);
  return { body: src.slice(start), isCode: (offsetInBody) => isCode(start + offsetInBody) };
}

/**
 * The offset of a marker that must occur exactly once AND be code — a duplicate is as bad as a
 * rename, and a commented-out copy is worse than either, because it looks like a pass.
 */
function onlyIndexOf(scan: MethodScan, marker: string): number {
  const first = scan.body.indexOf(marker);
  expect(first, `marker not found in assertWorkforceAcceptsWork: ${marker}`).toBeGreaterThan(-1);
  expect(
    scan.body.indexOf(marker, first + 1),
    `marker appears more than once, so its position is ambiguous: ${marker}`,
  ).toBe(-1);
  expect(
    scan.isCode(first),
    'THE MARKER IS PRESENT BUT IT IS NOT CODE — it sits inside a comment or a string literal. ' +
      'That is defeat by SUBSTITUTION: comment the statement out, leave its text behind to satisfy ' +
      'this scan, and put the real logic somewhere this file would have refused. The position this ' +
      `file pins is the position of a STATEMENT, not of a string. Marker: ${marker}`,
  ).toBe(true);
  return first;
}

/** The LOCKING read — the upsert, taken on the caller's handle. */
const LOCKING_READ = 'const runtime = await ensureWorkforceRuntime(tdb, workforceId);';
/** The refusal, which must come after that read. */
const REFUSAL = 'if (runtime.paused) throw new WorkforcePausedError(workforceId);';

/** Every marker this file positions, so the precondition below can be checked mechanically. */
const MARKERS: Readonly<Record<string, string>> = { LOCKING_READ, REFUSAL };

describe('assertWorkforceAcceptsWork — the gate LOCKS the row it reads', () => {
  it('reads through `ensureWorkforceRuntime`, whose upsert is what takes the row lock', () => {
    const scan = gateScan();
    expect(
      scan.body.indexOf(LOCKING_READ),
      'THE GATE STOPPED LOCKING. `assertWorkforceAcceptsWork` must read the runtime row through ' +
        "`ensureWorkforceRuntime` — its upsert's `set` is a real write, which is what holds the " +
        'workforce_runtime row until the caller commits. A plain `SELECT` (readWorkforceRuntime, ' +
        'in this same module) still sees `paused` in any serial test while dropping the ordering ' +
        'guarantee the refusal rests on.',
    ).toBeGreaterThan(-1);
    onlyIndexOf(scan, LOCKING_READ);
  });

  it('refuses AFTER that read, so the value it branches on is the locked one', () => {
    const scan = gateScan();
    const read = onlyIndexOf(scan, LOCKING_READ);
    const refusal = onlyIndexOf(scan, REFUSAL);
    expect(
      refusal,
      'the refusal must branch on the value read UNDER the lock, not on one read before it',
    ).toBeGreaterThan(read);
  });

  it('does NOT reach for the unlocked plain read', () => {
    const scan = gateScan();
    // Negative assertion, so it carries its own control: the token it denies is a REAL exported
    // symbol of this module (asserted below), not a spelling that could never appear.
    //
    // DELIBERATELY OVER RAW TEXT, not over masked code. For a DENIAL, raw text is the stronger
    // reading — it refuses a commented-out fallback as well as a live one, and it fails closed on
    // a bare mention. The substitution hole the positive arms above close does not exist here:
    // there is no way to satisfy a `not present` assertion by hiding the token in a comment.
    expect(
      readFileSync(SOURCE, 'utf8').includes('export async function readWorkforceRuntime('),
      'control for the assertion below: `readWorkforceRuntime` must really exist in this module, ' +
        'or denying it proves nothing',
    ).toBe(true);
    expect(
      scan.body.includes('readWorkforceRuntime('),
      'the gate must not fall back to the unlocked plain read — that is precisely the silent ' +
        'lock drop this file exists to catch',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MASKER'S OWN BATTERY. `maskedSpans` is now a load-bearing instrument, so it is tested like
// one. The `code: false` rows are the attack; the `code: true` rows are the controls that a
// masker which simply strips too much would fail — a stripper that ate real code would satisfy
// every attack row and still be wrong, and the wrongness would show up as a guard reddening for
// a reason that has nothing to do with the engine.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const M = 'gate(tx, id);';

interface MaskCase {
  readonly name: string;
  readonly source: string;
  /** Which occurrence of `M` to test — default the first. */
  readonly nth?: number;
  /** Whether that occurrence must be judged a real code position. */
  readonly code: boolean;
}

const MASK_BATTERY: readonly MaskCase[] = [
  // ── The attack surface: a marker that is present as TEXT and must not count as code. ────────
  { name: 'inside a // comment', source: `const a = 1;\n// ${M}\n`, code: false },
  { name: 'inside a /* */ block comment', source: `const a = 1;\n/*\n  ${M}\n*/\n`, code: false },
  { name: 'inside a single-quoted string', source: `const s = '${M}';\n`, code: false },
  { name: 'inside a double-quoted string', source: `const s = "${M}";\n`, code: false },
  { name: 'inside a template literal', source: `const s = \`${M}\`;\n`, code: false },
  {
    name: 'inside a template literal that itself contains /* */',
    source: `const s = \`/* ${M} */\`;\n`,
    code: false,
  },
  {
    name: 'inside a comment that is leading trivia of a bare } (the S2 shape, unreachable from the AST)',
    source: `function f() {\n  real();\n  // ${M}\n}\n`,
    code: false,
  },
  {
    name: 'inside a JSDoc block above a declaration',
    source: `/**\n * ${M}\n */\nconst a = 1;\n`,
    code: false,
  },

  // ── The controls: real code that a too-eager stripper would swallow. ────────────────────────
  { name: 'plain executable code (positive control)', source: `${M}\n`, code: true },
  {
    name: 'after a string containing // — on the SAME line, where a comment-first pass eats it',
    source: `const u = 'https://example.com/a'; ${M}\n`,
    code: true,
  },
  {
    name: 'between a template opening /* and a later template closing */',
    source: `const t = \`/* open\`;\n${M}\nconst u = \`close */\`;\n`,
    code: true,
  },
  {
    name: 'after a division whose slashes a regex-guessing stripper would pair with a later /',
    source: `const ratio = a / b;\n${M}\nconst label = 'x/y';\n`,
    code: true,
  },
  {
    name: 'after a regex literal containing both quote kinds',
    source: `const re = /['"]/;\n${M}\n`,
    code: true,
  },
  {
    name: 'after a regex literal containing //',
    source: `const re = /\\/\\//;\n${M}\n`,
    code: true,
  },
  {
    name: "after a comment containing an apostrophe (don't)",
    source: `// don't stop scanning here\nconst a = 1;\n${M}\n`,
    code: true,
  },
  {
    name: 'after a string containing an escaped quote',
    source: `const s = 'it\\'s';\n${M}\n`,
    code: true,
  },
  { name: 'after a string containing /*', source: `const s = '/*';\n${M}\n`, code: true },
  {
    name: 'after a template with an interpolated string expression',
    source: `const t = \`x\${'y'}z\`;\n${M}\n`,
    code: true,
  },

  // ── Both at once: the comment copy is text, the live copy is code. ──────────────────────────
  {
    name: 'present in BOTH a comment and code — the comment copy',
    source: `// ${M}\n${M}\n`,
    nth: 0,
    code: false,
  },
  {
    name: 'present in BOTH a comment and code — the live copy',
    source: `// ${M}\n${M}\n`,
    nth: 1,
    code: true,
  },
];

describe('maskedSpans — the adversarial battery for the instrument itself', () => {
  for (const testCase of MASK_BATTERY) {
    it(`${testCase.name} -> ${testCase.code ? 'CODE' : 'not code'}`, () => {
      let at = -1;
      for (let seen = 0; seen <= (testCase.nth ?? 0); seen += 1) {
        at = testCase.source.indexOf(M, at + 1);
      }
      expect(at, 'the battery case must really contain the marker it claims to').toBeGreaterThan(
        -1,
      );
      expect(codeMask(testCase.source)(at)).toBe(testCase.code);
    });
  }

  it('is not degenerate — the battery contains BOTH verdicts, so a constant masker cannot pass', () => {
    expect(MASK_BATTERY.some((c) => c.code)).toBe(true);
    expect(MASK_BATTERY.some((c) => !c.code)).toBe(true);
  });

  it('every marker in this file is delimiter-free, which is what makes a START-position test enough', () => {
    // The code-position test asks only where a match BEGINS. That is sufficient precisely because
    // no marker can begin in code and continue into a comment: to do so the marker would have to
    // contain the delimiter that opens one. Markers may legitimately reach INTO string literals,
    // which is why the test is not "must not overlap".
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(marker.includes('//'), `${name} must not contain a line-comment delimiter`).toBe(
        false,
      );
      expect(marker.includes('/*'), `${name} must not contain a block-comment delimiter`).toBe(
        false,
      );
      expect(marker.includes('`'), `${name} must not contain a template delimiter`).toBe(false);
      expect(/^[A-Za-z_$]/.test(marker), `${name} must begin with an identifier or keyword`).toBe(
        true,
      );
    }
  });
});

/**
 * THE MASKER IS COPIED INTO EVERY SCAN THAT NEEDS IT, SO THE COPIES ARE PINNED HERE.
 *
 * The scans live in different packages and there is no shared test-utility package between them, so
 * the block above is duplicated rather than imported. Duplication without enforcement is how a
 * load-bearing instrument rots in one place and nobody notices, so this arm DISCOVERS the copies on
 * disk by their sentinel — it is not a hand-maintained list, and a fifth copy added tomorrow is
 * covered the day it lands. The floor (`>= 4`) is what makes a sentinel rename red rather than
 * vacuously green: a rule that finds nothing must not read as a rule that found no drift.
 */
const MASKER_OPEN = '// [SOURCE-MASKER v2 BEGIN]';
const MASKER_CLOSE = '// [SOURCE-MASKER v2 END]';

/** Every `*.test.ts` under `packages/` that carries the masker block, with the block itself. */
function maskerCopies(): ReadonlyArray<{ readonly file: string; readonly block: string }> {
  const packagesRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const found: Array<{ file: string; block: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // The FIRST sentinel pair is the real block: the constants above sit below it in every copy.
      const open = text.indexOf(MASKER_OPEN);
      if (open < 0) continue;
      const close = text.indexOf(MASKER_CLOSE, open);
      expect(close, `${full} opens the masker block and never closes it`).toBeGreaterThan(open);
      found.push({ file: full.slice(packagesRoot.length + 1), block: text.slice(open, close) });
    }
  };
  walk(packagesRoot);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

describe('the source masker — every copy of it, byte-identical', () => {
  it('is carried by at least the four scans that need it, and this file is one of them', () => {
    const copies = maskerCopies();
    expect(
      copies.length,
      'the masker sentinel found fewer copies than the scans that carry it — a rename that hides ' +
        'the block would otherwise make this arm vacuously green',
    ).toBeGreaterThanOrEqual(4);
    const self = fileURLToPath(import.meta.url);
    expect(
      copies.some((copy) => self.endsWith(copy.file)),
      'the discovery did not find THIS file, so it is not actually scanning where it thinks',
    ).toBe(true);
  });

  it('has not drifted — all copies are byte-identical', () => {
    const copies = maskerCopies();
    const distinct = new Set(copies.map((copy) => copy.block));
    expect(
      distinct.size,
      'THE MASKER HAS DRIFTED ACROSS ITS COPIES. It is duplicated because the scans live in ' +
        'packages with no shared test-utility package between them; that is only safe while the ' +
        `copies are identical. Copies found: ${copies.map((copy) => copy.file).join(', ')}`,
    ).toBe(1);
  });
});
