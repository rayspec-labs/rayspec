/**
 * WHERE THE INTAKE'S PAUSE GATE SITS INSIDE `submitGoal` — a static tripwire, not a comment.
 *
 * D-041 refuses a goal submitted to a paused or halted workforce. The refusal's completeness is a
 * LOCK argument, not a read: `assertWorkforceAcceptsWork` upserts the `workforce_runtime` row (a
 * real write, so a real exclusive lock) and the caller's task inserts commit in the SAME
 * transaction, so the gate and `pauseWorkforce` serialize on one row. Two positions carry that
 * argument, and both are load-bearing in a direction nothing else catches:
 *
 *   - OUTSIDE THE TRANSACTION (or taken on `tdb` rather than `tx`) and the refusal still WORKS
 *     while the ordering half is silently gone: the gate would commit and release the row, then a
 *     pause could commit, and only then the task rows — after a concurrent halt's roots scan had
 *     already run. That halt reports `affectedTaskCount` without the root it never saw, which is
 *     the original defect rather than a narrowing of it.
 *   - AFTER THE FIRST `createRootTask` and the transaction takes `workforce_tasks` BEFORE
 *     `workforce_runtime` — the inverted rank the lock-rank docblock in
 *     @rayspec/durable-dbos task-scheduler.ts forbids for the fourth composite runtime+tasks
 *     transaction, which is the only one outside that file and therefore the one with no
 *     kernel-side enforcer.
 *
 * WHY A SOURCE SCAN AND NOT ONLY A BEHAVIOURAL ARM, stated plainly. The db-backed arm
 * (`workforce-goal-intake.db.test.ts`, `TAKES the runtime row lock, and holds NO task lock while
 * it waits`) proves the lock is real and proves the rank, both from the database side via
 * `pg_blocking_pids` and `pg_locks`. It does NOT distinguish a gate moved OUT of the transaction:
 * that variant still blocks on the held pause and still refuses, because the refusal serializes
 * either way — only the COMMIT BOUNDARY moves, and a serial arm cannot see a commit boundary.
 * Reproducing that difference behaviourally needs an interleaving wedged between the gate's commit
 * and the inserts' commit, which is a timing race, not a test. The property under test IS an
 * ordering of statements inside one function, so it is asserted as one — the instrument
 * @rayspec/durable-dbos `claim-pause-ordering.test.ts` uses for the identical class of guarantee.
 *
 * FAIL-CLOSED: every marker must appear EXACTLY ONCE inside `submitGoal`, so a rename, a duplicate,
 * or a scan that stops finding the code turns this red rather than green.
 *
 * ...AND THE OCCURRENCE MUST BE CODE, NOT MERELY TEXT. A raw `indexOf` over file text cannot tell
 * a statement from a statement that has been COMMENTED OUT with its text left behind, so the scan
 * could be defeated by SUBSTITUTION: comment the gate out, leave the marker to satisfy this file,
 * and take the real gate where this file would have refused it. That was MEASURED, not theorised —
 * 2026-08-19, on this file as first written:
 *
 *   - S1, ADDITION (a decoy comment added BESIDE a live gate)            -> RED   (2 failed / 2)
 *   - S2, SUBSTITUTION (gate commented out, real gate moved OUT of the
 *     transaction onto `tdb` — the exact defect this file exists to
 *     catch)                                                             -> GREEN (2 passed / 2)
 *   - S3, REFORMAT (the workforce id hoisted into a local first)         -> RED   (2 failed / 2)
 *
 * Addition and reformatting were already fail-closed. Substitution was the one hole, and
 * `onlyIndexOf` now closes it by ALSO requiring the single occurrence to sit at a real CODE
 * position — see `maskedSpans`, which is computed by the TypeScript parser rather than by a
 * regex, and the adversarial battery at the bottom of this file that pins its behaviour.
 *
 * Nothing was relaxed to add it: the exact-text and exactly-once rules are untouched, which is why
 * S1 and S3 still red.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SOURCE = resolve(here, 'workforce-goal-intake.ts');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SOURCE MASKING — what makes "the marker is CODE" a checkable claim.
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
// PASS 2 IS NOT REDUNDANT WITH THE AST. `forEachChild` never visits punctuation tokens, so a
// comment that is leading trivia of a bare `}` is unreachable from an AST walk — and that is
// exactly the shape of the S2 mutation this file exists to refuse. An AST-only masker would look
// correct and still be defeated.
//
// IT ERRS TOWARD OVER-MASKING, DELIBERATELY. Spans are taken at full extent including delimiters,
// and an unterminated comment masks to end of file. Over-masking makes a guard go RED for the
// wrong reason — loud, and survivable. Under-masking would leave the hole open while looking
// fixed, which is silent. Given the choice, this instrument takes the loud failure.
//
// Duplicated verbatim in @rayspec/durable-dbos `claim-pause-ordering.test.ts` and @rayspec/tasks
// `intake-gate-lock.test.ts`: the three guards live in three packages with no shared test-utility
// package between them, and each copy carries its OWN battery, so a copy that drifts reddens in
// its own lane rather than relying on a parity check nobody runs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
function maskedSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];

  // PASS 1 — literals, from the parser.
  const parsed = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
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
function codeMask(source: string): (offset: number) => boolean {
  const spans = maskedSpans(source);
  return (offset) => !spans.some(([from, to]) => offset >= from && offset < to);
}

/** A sliced region of a source file, plus the code-position test for the file it came from. */
interface MethodScan {
  /** The slice every marker must be found inside. */
  readonly body: string;
  /** True when an offset WITHIN `body` is a real code position of the underlying file. */
  readonly isCode: (offsetInBody: number) => boolean;
}

/**
 * `submitGoal`'s body, sliced out so a marker elsewhere in the file cannot satisfy a scan.
 *
 * The mask is computed over the WHOLE file and the offsets translated, never over the slice: the
 * slice starts mid-object-literal at `async submitGoal(`, which is not a parseable module on its
 * own, and a parser handed a fragment it cannot parse is exactly how a masker starts under-masking.
 */
function submitGoalScan(): MethodScan {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('async submitGoal(input): Promise<WorkforceGoalOutcome> {');
  expect(
    start,
    'the scan must find `submitGoal` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  const isCode = codeMask(src);
  // The seam object's closing `},` then the factory's. Slice to end of file: `submitGoal` is the
  // last member, so an unbounded tail cannot pull in a DIFFERENT function's statements.
  return { body: src.slice(start), isCode: (offsetInBody) => isCode(start + offsetInBody) };
}

/**
 * The offset of a marker that must occur exactly once AND be code — a duplicate is as bad as a
 * rename, and a commented-out copy is worse than either, because it looks like a pass.
 */
function onlyIndexOf(scan: MethodScan, marker: string): number {
  const first = scan.body.indexOf(marker);
  expect(first, `marker not found in submitGoal: ${marker}`).toBeGreaterThan(-1);
  expect(
    scan.body.indexOf(marker, first + 1),
    `marker appears more than once in submitGoal, so its position is ambiguous: ${marker}`,
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

/** The transaction the whole plan commits in. */
const TRANSACTION_OPEN = 'const created = await tdb.transaction(async (tx) => {';
/** The gate, taken ON `tx` — the same transaction the inserts below commit in. */
const GATE_ON_TX = 'await assertWorkforceAcceptsWork(tx, deps.config.id);';
/** The first (and only) task write. */
const FIRST_TASK_WRITE = 'const task = await createRootTask(tx, {';

/** Every marker this file positions, so the precondition below can be checked mechanically. */
const MARKERS: Readonly<Record<string, string>> = {
  TRANSACTION_OPEN,
  GATE_ON_TX,
  FIRST_TASK_WRITE,
};

describe('submitGoal — the pause gate is positioned, not merely present', () => {
  it('is taken INSIDE the plan transaction, on `tx`, so the gate and the inserts commit together', () => {
    const scan = submitGoalScan();
    const txOpen = onlyIndexOf(scan, TRANSACTION_OPEN);
    const gate = onlyIndexOf(scan, GATE_ON_TX);

    expect(
      gate,
      'THE PAUSE GATE LEFT THE TRANSACTION. Taken outside it (or on `tdb`), the gate commits and ' +
        'releases the workforce_runtime row BEFORE the task rows are written, so a pause can ' +
        'commit in between and a concurrent halt scans its roots without seeing the row this call ' +
        'is about to create. The refusal keeps working, which is why nothing else catches this.',
    ).toBeGreaterThan(txOpen);
  });

  it('is taken BEFORE the first task write, so this transaction takes runtime -> tasks', () => {
    const scan = submitGoalScan();
    const gate = onlyIndexOf(scan, GATE_ON_TX);
    const firstWrite = onlyIndexOf(scan, FIRST_TASK_WRITE);

    expect(
      firstWrite,
      'THE PAUSE GATE MOVED BELOW THE FIRST TASK WRITE. This transaction would take ' +
        '`workforce_tasks` before `workforce_runtime` — the inverted rank. The goal intake is the ' +
        'FOURTH composite runtime+tasks transaction and the only one outside task-scheduler.ts, ' +
        'so this order is held by this call site and by nothing else.',
    ).toBeGreaterThan(gate);
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
