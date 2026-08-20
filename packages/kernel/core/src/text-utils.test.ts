/**
 * Text utilities — unit tests for the UAX-29 tokenizer + the contiguous token-run subset check.
 *
 * Golden tests that assert the REAL documented behavior (fail-the-fix, not pass-the-shape):
 * casefolding, the word-ish `[\p{L}\p{N}]` filter dropping punctuation/whitespace/emoji, whole-token
 * matching (no inside-a-longer-word false positive), the empty/no-word-token ⇒ false rule, and the
 * contiguity invariant closing the order-free scatter hole (including the CJK case).
 */
import { describe, expect, it } from 'vitest';
import { tokenRunSubset, truncateCodeUnits, uax29Tokens } from './text-utils.js';

/** No unpaired surrogate in EITHER direction — the property every caller of the guard depends on. */
const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** U+1F600 GRINNING FACE — two code units: U+D83D U+DE00. */
const EMOJI = '\u{1F600}';

describe('uax29Tokens', () => {
  it('returns casefolded word tokens, dropping whitespace and punctuation', () => {
    expect(uax29Tokens('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('drops pure whitespace, punctuation, and emoji segments', () => {
    expect(uax29Tokens('hi! 👋 world... 😀')).toEqual(['hi', 'world']);
    // A string of only punctuation/emoji yields no tokens.
    expect(uax29Tokens('?!.,  —  👋😀')).toEqual([]);
  });

  it('keeps digit-bearing and mixed alphanumeric tokens', () => {
    expect(uax29Tokens('Order ABC-123 ships')).toEqual(['order', 'abc', '123', 'ships']);
  });

  it('lower-cases for case-insensitive comparison', () => {
    expect(uax29Tokens('HELLO')).toEqual(uax29Tokens('hello'));
  });

  it('is empty for empty / punctuation-only input', () => {
    expect(uax29Tokens('')).toEqual([]);
    expect(uax29Tokens('   ')).toEqual([]);
  });
});

describe('tokenRunSubset', () => {
  it('is true when the needle tokens appear as a contiguous run', () => {
    expect(tokenRunSubset('quick brown fox', 'the quick brown fox jumps')).toBe(true);
  });

  it('matches a single-token needle inside the haystack', () => {
    expect(tokenRunSubset('brown', 'the quick brown fox')).toBe(true);
  });

  it('is false when the same tokens are present but NOT adjacent (scattered)', () => {
    // Both "quick" and "fox" occur, in order, but "brown" sits between them: not a contiguous run.
    expect(tokenRunSubset('quick fox', 'the quick brown fox jumps')).toBe(false);
  });

  it('is false when the run order is reversed', () => {
    expect(tokenRunSubset('fox brown', 'the quick brown fox')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(tokenRunSubset('Quick Brown', 'the quick brown fox')).toBe(true);
    expect(tokenRunSubset('HELLO', 'oh hello there')).toBe(true);
  });

  it('is false for an empty needle', () => {
    expect(tokenRunSubset('', 'any text here')).toBe(false);
  });

  it('is false for a needle with no word tokens (pure punctuation)', () => {
    expect(tokenRunSubset('?!.,', 'any text here')).toBe(false);
    expect(tokenRunSubset('  👋  ', 'wave 👋 hello')).toBe(false);
  });

  it('matches whole tokens only — "cat" must NOT match inside "category"', () => {
    expect(tokenRunSubset('cat', 'a category of items')).toBe(false);
    // ...but DOES match the standalone token.
    expect(tokenRunSubset('cat', 'a cat and a dog')).toBe(true);
  });

  it('ignores punctuation when aligning the run', () => {
    // The needle's punctuation is dropped, so "brown fox" still matches across the comma.
    expect(tokenRunSubset('brown, fox', 'the quick brown fox')).toBe(true);
  });

  it('CJK: a contiguous ideograph run matches; a non-adjacent recombination does NOT', () => {
    // 我喜欢猫 tokenizes to ["我","喜欢","猫"].
    const haystack = '我喜欢猫';
    expect(uax29Tokens(haystack)).toEqual(['我', '喜欢', '猫']);
    // "喜欢猫" → ["喜欢","猫"] is a contiguous run (positions 1,2): true.
    expect(tokenRunSubset('喜欢猫', haystack)).toBe(true);
    // "我猫" → ["我","猫"]: both present, order-preserved, but NON-adjacent (喜欢 between): false.
    expect(tokenRunSubset('我猫', haystack)).toBe(false);
  });

  it('mixed-script / digits-and-letters sanity', () => {
    const haystack = 'Order ABC-123 東京 ships';
    expect(tokenRunSubset('abc 123', haystack)).toBe(true);
    expect(tokenRunSubset('123 東京', haystack)).toBe(true);
    // Present tokens but not contiguous: "abc" then "東京" skips "123".
    expect(tokenRunSubset('abc 東京', haystack)).toBe(false);
  });
});

describe('truncateCodeUnits', () => {
  it('THE FIXTURE ITSELF: an astral char is two code units, and a naive slice orphans the high half', () => {
    // Asserted FIRST and separately, because every arm below is worthless if this stops holding.
    // `'x'.repeat(n)` is pure BMP and its cut can never land inside a pair — which is exactly how
    // the sibling defect in @rayspec/tasks apply-intents.ts shipped green under an ASCII test.
    expect(EMOJI.length).toBe(2);
    expect(EMOJI.charCodeAt(0)).toBe(0xd83d);
    expect(EMOJI.charCodeAt(1)).toBe(0xde00);
    const naive = `ab${EMOJI}`.slice(0, 3);
    expect(naive).toHaveLength(3);
    expect(naive).toMatch(LONE_HIGH); // the bug this function exists to prevent
  });

  it('cuts INSIDE an astral pair without leaving a lone surrogate', () => {
    const text = `ab${EMOJI}cd`;
    const out = truncateCodeUnits(text, 3);
    expect(out).toBe('ab');
    expect(out).not.toMatch(LONE_HIGH);
    expect(out).not.toMatch(LONE_LOW);
    // One SHORTER than the cap — dropping the orphan only ever shrinks, so a caller's ceiling holds.
    expect(out.length).toBeLessThan(3);
  });

  it('keeps a whole astral pair when the cut lands cleanly after it', () => {
    expect(truncateCodeUnits(`ab${EMOJI}cd`, 4)).toBe(`ab${EMOJI}`);
    // and cleanly before it
    expect(truncateCodeUnits(`ab${EMOJI}cd`, 2)).toBe('ab');
  });

  it('returns the input by identity when nothing needs cutting', () => {
    const text = `hi ${EMOJI}`;
    expect(truncateCodeUnits(text, text.length)).toBe(text);
    expect(truncateCodeUnits(text, text.length + 1000)).toBe(text);
    expect(truncateCodeUnits('', 0)).toBe('');
  });

  it('a lone surrogate ALREADY in the input is passed through untouched — this guard fixes cuts, not inputs', () => {
    // THE DECIDED BEHAVIOUR, pinned so it cannot drift back to being an accident. Scrubbing here
    // would be PARTIAL while reading as TOTAL: the under-cap branch returns by identity, so a
    // scrubbing guard would protect only the over-cap branch while inviting the conclusion that the
    // string is now safe to write. Whole-string sanitization belongs once, at the input boundary.
    const orphan = '\uD83Dtail'; // a bare high surrogate the CALLER supplied
    expect(truncateCodeUnits(orphan, orphan.length)).toBe(orphan);
    expect(truncateCodeUnits(orphan, 99)).toBe(orphan);
    // Even when a cut DOES happen, an orphan away from the cut point survives.
    expect(truncateCodeUnits(`${orphan}xxxx`, 5)).toBe('\uD83Dtail');
    // And a caller-supplied LOW surrogate is never touched either — no leading check exists,
    // because a prefix cut cannot create one.
    expect(truncateCodeUnits('\uDE00abc', 2)).toBe('\uDE00a');
  });

  it('the guard fires ONLY on a real cut: a trailing orphan at exactly the cap survives', () => {
    // `text.length === maxCodeUnits` is the boundary between "returned by identity" and "cut".
    // Getting it wrong in the strict direction would silently scrub; in the loose direction it
    // would leave the orphan the cut created. Both are pinned here.
    expect(truncateCodeUnits('ab\uD83D', 3)).toBe('ab\uD83D'); // no cut ⇒ untouched
    expect(truncateCodeUnits('ab\uD83D!', 3)).toBe('ab'); // cut at 3 orphans it ⇒ dropped
  });

  it('never emits an orphan it created, over every cut position of an astral-dense string', () => {
    // Exhaustive over the one dimension that matters. A single hand-picked index proves the index;
    // this proves the function.
    const text = `a${EMOJI}b${EMOJI}${EMOJI}c${EMOJI}d`;
    expect(text).not.toMatch(LONE_HIGH); // the fixture is well-formed to begin with
    for (let n = 0; n <= text.length + 2; n++) {
      const out = truncateCodeUnits(text, n);
      expect(out).not.toMatch(LONE_HIGH);
      expect(out).not.toMatch(LONE_LOW);
      expect(out.length).toBeLessThanOrEqual(Math.max(n, 0));
      expect(text.startsWith(out)).toBe(true); // always a PREFIX — never a scrub, never a rewrite
      expect(out).not.toContain('�'); // dropping is not the same as replacing
    }
  });

  it('clamps a negative cap to empty rather than slicing from the end', () => {
    // `slice(0, -1)` would drop the LAST unit and return almost the whole string — the opposite of
    // a cap. Pinned because the naive spelling is a plausible edit.
    expect(truncateCodeUnits(`ab${EMOJI}`, -1)).toBe('');
  });
});
