/**
 * THE BUDGET CLAIM, BYTE-PINNED. Three sentences, named below, and nothing else.
 *
 * WHAT THIS TEST IS FOR. A ceiling bounds what may be DISPATCHED, not what may be SETTLED: the
 * engine denies when the NEXT turn's reservation would cross the line, so the turn already in
 * flight settles above it, once, by one turn's actual cost (`@rayspec/tasks` `settleTurn`). The
 * pages that tell an author and an operator this are `docs/spec-reference.md` §`budgets` and
 * `docs/cli-reference.md` §`workforce`. Until this file existed, **nothing in the repository
 * noticed if those sentences were replaced by their opposite.** Measured, not assumed: the
 * paragraph was reworded to *"A ceiling is a hard bound on settled spend: settled_usd never exceeds
 * it."* and all four doc-drift suites, both doc-consuming suites and `rotscan` stayed green across
 * 76 test files. The drift guards check citations, values, names and schema coverage; none of them
 * has an opinion about whether a sentence is true.
 *
 * WHAT IT DOES, EXACTLY. It holds THESE THREE SENTENCES, word for word. That is all.
 *
 *   1. the dispatch/settle claim itself (spec reference — the page an author reads while typing
 *      `usd: 25`);
 *   2. the BOUND on the overrun — one turn's actual cost, counted once. A page that kept (1) and
 *      dropped (2) would say spend can exceed the ceiling without saying by how much, which is
 *      materially weaker than what the engine guarantees;
 *   3. the operator-facing form of (1) on the CLI page.
 *
 * WHAT IT DOES NOT DO — and the distinction is the whole subject of the sentences it pins, so
 * getting it wrong here would be an unusually poor joke. **It does not verify that budget prose is
 * true.** It cannot. A claim-level lock on prose semantics is not mechanically achievable, and this
 * file must not be cited as one. Every other sentence on both pages remains unguarded: reword the
 * paragraph AROUND these three and nothing here fires. What it makes impossible is silently
 * reverting THESE THREE — which is the failure that was actually demonstrated. The general gap
 * ("nothing guards budget prose") stays an open finding and wants a deliberate design, not this.
 *
 * THE ONE TOLERANCE: whitespace runs are collapsed to a single space on both sides before
 * comparing, so the paragraphs may be re-wrapped freely. Nothing else is tolerated — a changed
 * word, a dropped clause or a softened emphasis marker fails.
 *
 * CACHE CAVEAT, stated because a pin nobody runs is worse than no pin. `turbo.json` declares no
 * `inputs` for `test`, so a task's hash covers its own package and its dependencies — and `docs/`
 * is inside NEITHER. Measured on this tree with `turbo run test --filter=@rayspec/spec
 * --dry-run=json`, appending a comment to `docs/spec-reference.md`:
 *
 *     @rayspec/spec#test  4a9fa3e18c345599 -> 4a9fa3e18c345599   UNCHANGED
 *
 * So a LOCAL `pnpm test` can replay a cached PASS over a reverted claim; run `--force` (the PR
 * workflow already requires it, `Cached: 0 cached`). CI is unaffected and is the enforcing path:
 * `ci.yml` caches pnpm only, never `.turbo`, and configures no remote cache, so every CI job starts
 * cold and every task is a miss. This caveat is a property of every doc-reading suite in the repo,
 * not of this one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');

/** Whitespace runs → one space. The ONLY tolerance; see the header. */
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Slice one `#`-heading section out of a page, with a FLOOR: a heading that moved or was reworded
 * FAILS here loudly instead of returning '' and taking every `toContain` below down with a
 * confusing message. A section that shrank to nothing is not agreement either, so the length is
 * asserted and an unrelated anchor from inside the section is required — proof the slice landed on
 * the intended region rather than on some other part of the page.
 */
function section(rel: string, heading: string, anchor: string): string {
  const page = read(rel);
  const start = page.indexOf(heading);
  expect(start, `${rel} no longer contains the heading ${JSON.stringify(heading)}`).toBeGreaterThan(
    -1,
  );
  const level = (/^#+/.exec(heading) as RegExpExecArray)[0];
  const next = page.indexOf(`\n${level} `, start + heading.length);
  const body = next === -1 ? page.slice(start) : page.slice(start, next);
  expect(body.length, `${rel} ${heading} shrank to nothing`).toBeGreaterThan(500);
  expect(body, `${rel} ${heading} slice does not look like the intended section`).toContain(anchor);
  return collapse(body);
}

/**
 * The exact text. Typed out here rather than derived from the pages — deriving it from the thing
 * under test is what a byte-pin exists NOT to do.
 */
const PINNED_DISPATCH_CLAIM =
  '**A ceiling bounds what may be DISPATCHED, not what may be SETTLED — do not read ' +
  '`settled_usd <= ceiling` as an invariant, because it is not one.**';

const PINNED_OVERRUN_BOUND =
  "The overrun is bounded by ONE turn's actual cost, it lands in `settled_usd` exactly once, and " +
  'the next authorization sees `consumed > ceiling` and denies — never a silent truncation';

const PINNED_OPERATOR_CLAIM =
  "A tier's `consumedUsd` is **unclamped and can exceed its `ceilingUsd`** — a ceiling bounds what " +
  'may be *dispatched*, not what may be *settled*, so the turn already in flight when the ceiling ' +
  "is reached settles above the line (once, by one turn's actual cost).";

describe('the dispatch-not-settlement claim is pinned on both pages that make it', () => {
  it('the SPEC REFERENCE states it, word for word', () => {
    // A pin whose literal is trivial passes on almost any page; this one is a whole sentence.
    expect(PINNED_DISPATCH_CLAIM.length).toBeGreaterThan(100);
    expect(
      section('docs/spec-reference.md', '### `budgets`', 'budgets:'),
      'docs/spec-reference.md §budgets no longer states that a ceiling bounds DISPATCH rather ' +
        'than SETTLEMENT. That claim is load-bearing: the engine over-settles by one turn BY ' +
        'DESIGN (@rayspec/tasks settleTurn), and an author who reads the ceiling as a settlement ' +
        'bound is wrong about their own bill. Change the engine or keep the sentence.',
    ).toContain(collapse(PINNED_DISPATCH_CLAIM));
  });

  it('the SPEC REFERENCE also states the BOUND on the overrun — one turn, counted once', () => {
    expect(
      section('docs/spec-reference.md', '### `budgets`', 'budgets:'),
      'the page says spend can exceed the ceiling but no longer says BY HOW MUCH. "Unbounded ' +
        'overrun" and "one turn’s actual cost, once" are very different promises, and the ' +
        'engine makes the second one.',
    ).toContain(collapse(PINNED_OVERRUN_BOUND));
  });

  it('the CLI REFERENCE states the operator-facing form, word for word', () => {
    expect(
      section('docs/cli-reference.md', '## `workforce` —', 'rayspec workforce status'),
      'docs/cli-reference.md §workforce no longer warns that a tier’s consumedUsd can exceed ' +
        'its ceilingUsd. This is the page an operator reads; headroomUsd floors at zero and so ' +
        'cannot show the overrun on its own.',
    ).toContain(collapse(PINNED_OPERATOR_CLAIM));
  });
});
