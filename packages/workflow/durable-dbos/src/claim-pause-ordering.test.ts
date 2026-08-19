/**
 * WHERE THE PAUSE REFUSAL SITS INSIDE `#claimTurn` — a static tripwire, not a comment.
 *
 * B-015e closes the drain's blind spot by refusing a claim whose workforce is paused. That refusal
 * is deliberately scoped to the `queued -> working` CLAIM and must stay BELOW the recovery branch,
 * and the position is load-bearing in both directions:
 *
 *   - TOO LOW (below the compare-and-swap) and the window re-opens: the row would go `working`
 *     after the drain had already returned. That direction is caught behaviourally — the
 *     dispatched-but-unclaimed arm in task-scheduler.db.test.ts reddens.
 *   - TOO HIGH (above the recovery branch) and a re-execution of a turn that ALREADY claimed would
 *     no-op instead of finishing. Its reservation is taken and its `turn_started` is journaled, so
 *     the row would sit `working` with nobody left to apply it — and the drain, which waits for
 *     exactly that row to leave `working`, would hang to its timeout and then throw. **That
 *     direction is caught by nothing else**, which is why this file exists: a reviewer's mutation
 *     moved the refusal above the recovery branch and the entire behavioural suite stayed green,
 *     23/23.
 *
 * WHY THIS IS A SOURCE SCAN RATHER THAN A BEHAVIOURAL ARM, stated plainly. Entering the recovery
 * branch requires a SECOND execution of the same workflow body — which is DBOS recovery, and the
 * SDK exposes `recoverPendingWorkflows` only on its internal executor, not on the `DBOS` facade.
 * A same-id `startWorkflow` dedupes rather than re-executing, and the reserve pass only ever pages
 * `queued` rows, so no public seam reaches a `working` row's claim path. Reaching into SDK
 * internals would pin the SDK's recovery machinery as much as this engine's ordering. The property
 * under test IS an ordering of statements inside one private method, so it is asserted as one —
 * the same instrument `terminal-fan-in.test.ts` uses for the same class of guarantee.
 *
 * FAIL-CLOSED: every marker must appear EXACTLY ONCE inside the method, so a rename, a duplicate,
 * or a scan that stops finding the code turns this red rather than green.
 *
 * ...AND THE OCCURRENCE MUST BE CODE, NOT MERELY TEXT. A raw `indexOf` over file text cannot tell
 * a statement from a statement that has been COMMENTED OUT with its text left behind, so the scan
 * could be defeated by SUBSTITUTION: comment the refusal out, leave the marker to satisfy this
 * file, and put the real refusal where this file would have refused it. That was MEASURED, not
 * theorised — 2026-08-19, on the unmodified branch:
 *
 *   - S1, ADDITION (a decoy comment added BESIDE a live refusal)          -> RED  (2 failed / 3)
 *   - S2, SUBSTITUTION (refusal commented out, real one moved above the
 *     recovery branch — the exact defect this file exists to catch)       -> GREEN (3 passed / 3)
 *   - S3, REFORMAT (the same refusal rewritten as a braced block)         -> RED  (2 failed / 3)
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
const SOURCE = resolve(here, 'task-scheduler.ts');

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
 * The claim transaction's body, sliced out so a marker elsewhere in the file cannot satisfy a scan.
 *
 * The mask is computed over the WHOLE file and the offsets translated, never over the slice: the
 * slice starts mid-class at `async #claimTurn(`, which is not a parseable module on its own, and a
 * parser handed a fragment it cannot parse is exactly how a masker starts under-masking.
 */
function claimTurnScan(): MethodScan {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('async #claimTurn(');
  const end = src.indexOf('async #parkDenied(');
  expect(
    start,
    'the scan must find `#claimTurn` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  expect(
    end,
    'the scan must find the method that FOLLOWS `#claimTurn`, or the slice is unbounded',
  ).toBeGreaterThan(start);
  const isCode = codeMask(src);
  return { body: src.slice(start, end), isCode: (offsetInBody) => isCode(start + offsetInBody) };
}

/**
 * The offset of a marker that must occur exactly once AND be code — a duplicate is as bad as a
 * rename, and a commented-out copy is worse than either, because it looks like a pass.
 */
function onlyIndexOf(scan: MethodScan, marker: string): number {
  const first = scan.body.indexOf(marker);
  expect(first, `marker not found in #claimTurn: ${marker}`).toBeGreaterThan(-1);
  expect(
    scan.body.indexOf(marker, first + 1),
    `marker appears more than once in #claimTurn, so its position is ambiguous: ${marker}`,
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

const RECOVERY_BRANCH = "if (task.status === 'working') {";
const RECOVERY_RETURNS_CLAIMED = "return { kind: 'claimed' as const, task, budgets };";
const QUEUED_GUARD = "if (task.status !== 'queued') return { kind: 'noop' as const };";
const PAUSE_REFUSAL = "if (runtime?.paused === true) return { kind: 'noop' as const };";
const CLAIM_CAS = "to: 'working',";
const RUNTIME_READ = 'await ensureWorkforceRuntime(tx, task.workforceId)';

/** Every marker this file positions, so the precondition below can be checked mechanically. */
const MARKERS: Readonly<Record<string, string>> = {
  RECOVERY_BRANCH,
  RECOVERY_RETURNS_CLAIMED,
  QUEUED_GUARD,
  PAUSE_REFUSAL,
  CLAIM_CAS,
  RUNTIME_READ,
};

describe('#claimTurn — the pause refusal is positioned, not merely present', () => {
  it('sits BELOW the recovery branch, so a turn that already claimed still finishes', () => {
    const scan = claimTurnScan();
    const recovery = onlyIndexOf(scan, RECOVERY_BRANCH);
    const recoveryClaimed = onlyIndexOf(scan, RECOVERY_RETURNS_CLAIMED);
    const refusal = onlyIndexOf(scan, PAUSE_REFUSAL);

    // The recovery branch must still RETURN CLAIMED — a refusal moved above it would make this
    // unreachable, and a recovery that no-ops strands its row `working` with the reservation taken.
    expect(
      recoveryClaimed,
      'the recovery branch must still return `claimed`, or a re-executed turn can never finish',
    ).toBeGreaterThan(recovery);
    expect(
      refusal,
      'THE PAUSE REFUSAL MOVED ABOVE THE RECOVERY BRANCH. A re-execution of a turn that already ' +
        'claimed would now no-op: its reservation is taken and its turn_started is journaled, so ' +
        "the row sits `working` with nobody left to apply it — and `pauseWorkforce`'s drain, which " +
        'waits for that row to leave `working`, hangs to its timeout and throws. Keep the refusal ' +
        'on the queued->working claim only.',
    ).toBeGreaterThan(recoveryClaimed);
  });

  it('sits ABOVE the compare-and-swap and below the `queued` guard, so it can still refuse', () => {
    const scan = claimTurnScan();
    const queuedGuard = onlyIndexOf(scan, QUEUED_GUARD);
    const refusal = onlyIndexOf(scan, PAUSE_REFUSAL);
    const cas = onlyIndexOf(scan, CLAIM_CAS);

    expect(refusal, 'the refusal belongs after the `queued` guard').toBeGreaterThan(queuedGuard);
    expect(
      cas,
      'THE PAUSE REFUSAL MOVED BELOW THE COMPARE-AND-SWAP — the row would reach `working` after a ' +
        'completed drain, which is the whole defect B-015e closes.',
    ).toBeGreaterThan(refusal);
  });

  it('reads the runtime row INSIDE the claim transaction, which is what closes the window', () => {
    // The completeness argument is a LOCK argument: `ensureWorkforceRuntime`'s upsert is a real
    // write, so taking it on `tx` holds the workforce_runtime row until this transaction commits,
    // and `pauseWorkforce` writes that same row before its drain polls. Reading it off `tdb` (its
    // own autocommit transaction) keeps the refusal working while silently dropping the lock — the
    // ordering half of the proof would be gone and nothing would say so. Pinned here as well as
    // behaviourally, because the behavioural arm needs a wedged claim and this is free.
    const scan = claimTurnScan();
    const runtimeRead = onlyIndexOf(scan, RUNTIME_READ);
    const cas = onlyIndexOf(scan, CLAIM_CAS);
    expect(
      cas,
      'the runtime row must be read, on `tx`, BEFORE the compare-and-swap — same transaction, or ' +
        'the pause and the claim no longer serialize on one row',
    ).toBeGreaterThan(runtimeRead);
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
    // contain the delimiter that opens one. Markers DO legitimately reach into string literals
    // (`if (task.status === 'working') {`), which is why the test is not "must not overlap".
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
