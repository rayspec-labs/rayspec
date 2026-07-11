/**
 * Text utilities — unit tests for the UAX-29 tokenizer + the contiguous token-run subset check.
 *
 * Golden tests that assert the REAL documented behavior (fail-the-fix, not pass-the-shape):
 * casefolding, the word-ish `[\p{L}\p{N}]` filter dropping punctuation/whitespace/emoji, whole-token
 * matching (no inside-a-longer-word false positive), the empty/no-word-token ⇒ false rule, and the
 * contiguity invariant closing the order-free scatter hole (including the CJK case).
 */
import { describe, expect, it } from 'vitest';
import { tokenRunSubset, uax29Tokens } from './text-utils.js';

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
