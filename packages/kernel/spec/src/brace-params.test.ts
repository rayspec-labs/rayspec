/**
 * `braceParamNames` / `rewriteBraceParams` are the no-regex, single-forward-scan equivalent of a global
 * `\{([^}/]+)\}` over a declared route path. These tests PROVE that equivalence two ways:
 *
 *  1. hand-picked EDGE cases that pin the exact semantics (`{}`, `{a/b}`, adjacent/nested braces, an
 *     unclosed brace, non-ASCII/emoji/astral names, and names of length 1 / 128 / 129 / 5000);
 *  2. exhaustive DIFFERENTIAL FUZZING against the ORIGINAL regex form — for thousands of generated
 *     inputs the helpers' output must EQUAL what the original `\{([^}/]+)\}` produced (extraction, the
 *     `:name` rewrite, and the `_by_name_` rewrite alike).
 *
 * The original regex is kept HERE, in the test only, purely as the differential oracle. The production
 * helpers use no regex at all, so the scan is strictly linear (no backtracking, no quantifier) and has
 * NO length cap — a 129+ char (schema-legal) param name is handled exactly like a short one, which the
 * FAIL-THE-FIX assertions below lock in against any regression to a bounded `{1,128}` regex.
 */

import { describe, expect, it } from 'vitest';
import { braceParamNames, rewriteBraceParams } from './brace-params.js';

// --- The ORIGINAL regex form, as the differential oracle (test-only; the production code has no regex). ---

/** Original extraction: collect capture group 1 of a global `\{([^}/]+)\}` scan. */
function originalParamNames(path: string): string[] {
  const re = /\{([^}/]+)\}/g; // fresh per call → lastIndex is not shared across inputs
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex exec loop.
  while ((m = re.exec(path)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Original rewrite: `path.replace(/\{([^}/]+)\}/g, replacement)` with a `$1`-carrying replacement. */
function originalRewrite(path: string, replacement: string): string {
  return path.replace(/\{([^}/]+)\}/g, replacement);
}

// --- Hand-picked edge cases pinning the exact semantics. ---

describe('braceParamNames — exact `{param}` extraction semantics', () => {
  const cases: Array<[string, string[]]> = [
    ['', []],
    ['/plain/path', []],
    ['{}', []], // empty → NOT a param (needs ≥1 char)
    ['{a}', ['a']],
    ['{a/b}', []], // a `/` ends the run before a `}` can close it → NOT a param
    ['{a}{b}', ['a', 'b']], // two adjacent params
    ['{a{b}', ['a{b']], // an inner `{` is an ordinary name character
    ['{a{b}c}', ['a{b']], // greedy run stops at the FIRST closing `}`
    ['{{a}', ['{a']],
    ['{unclosed', []], // no closing `}`
    ['}{a}', ['a']],
    ['{}a{b}', ['b']], // empty first, real second
    ['/x/{id}/y', ['id']],
    ['{a}b}', ['a']],
    ['{/}', []], // first stopping char is `/`
    ['{/a}', []],
    ['{a/}', []],
    ['/{a}{b}/{c}', ['a', 'b', 'c']],
    ['{a}{}{b}', ['a', 'b']],
    ['name of length one', []],
    ['{x}', ['x']], // length-1 name
  ];
  for (const [input, expected] of cases) {
    it(`extracts ${JSON.stringify(expected)} from ${JSON.stringify(input)}`, () => {
      expect(braceParamNames(input)).toEqual(expected);
      // and it matches the original regex oracle for the same input.
      expect(braceParamNames(input)).toEqual(originalParamNames(input));
    });
  }

  it('handles a name of length exactly 128, 129, and 5000 (no length cap) — FAIL-THE-FIX', () => {
    for (const n of [1, 128, 129, 5000]) {
      const name = 'a'.repeat(n);
      // The oracle (unbounded regex) always extracts it; a `{1,128}` bound would DROP n >= 129.
      expect(braceParamNames(`/r/{${name}}`)).toEqual([name]);
      expect(braceParamNames(`/r/{${name}}`)).toEqual(originalParamNames(`/r/{${name}}`));
    }
  });

  it('handles non-ASCII / emoji / astral names (each > 128 UTF-16 units where noted)', () => {
    const emoji = '😀'.repeat(65); // 130 UTF-16 code units
    const astral = '𝔸'.repeat(70); // 140 UTF-16 code units
    const mixed = 'café_señor_日本語';
    for (const name of [emoji, astral, mixed]) {
      expect(braceParamNames(`/r/{${name}}`)).toEqual([name]);
      expect(braceParamNames(`/r/{${name}}`)).toEqual(originalParamNames(`/r/{${name}}`));
    }
  });
});

describe('rewriteBraceParams — exact `{param}` rewrite semantics', () => {
  it('rewrites to `:name` byte-for-byte like the original `:$1` regex on the edge cases', () => {
    const inputs = [
      '',
      '/widgets',
      '/widgets/{id}',
      '/x/{a}/y/{b}',
      '{a/b}c{d}',
      '{a{b}c}',
      '{}a{b}',
      '{unclosed',
      '/{a}{b}/{c}',
    ];
    for (const input of inputs) {
      expect(rewriteBraceParams(input, (name) => `:${name}`)).toBe(originalRewrite(input, ':$1'));
    }
  });

  it('rewrites a 129+ char param (length-SAFE, not length-capped) — FAIL-THE-FIX', () => {
    const long = 'a'.repeat(129);
    expect(rewriteBraceParams(`/r/{${long}}`, (name) => `:${name}`)).toBe(`/r/:${long}`);
    // A bounded `{1,128}` regex would leave it un-rewritten; the oracle rewrites it, and so must we.
    expect(rewriteBraceParams(`/r/{${long}}`, (name) => `:${name}`)).toBe(
      originalRewrite(`/r/{${long}}`, ':$1'),
    );
  });
});

// --- Exhaustive differential fuzzing against the original regex oracle. ---

/** A tiny deterministic xorshift32 PRNG (seeded → the fuzz corpus is reproducible). */
function makePrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Alphabet biased toward the structurally interesting characters, plus letters and astral runes. */
const ALPHABET = ['{', '{', '}', '}', '/', '/', 'a', 'b', '_', '.', '1', 'z', '😀', '𝔸'];

function randomPath(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return out;
}

describe('brace-params — differential fuzz vs the original `\\{([^}/]+)\\}` regex', () => {
  it('matches the oracle for extraction and BOTH rewrites over thousands of generated inputs', {
    timeout: 20_000,
  }, () => {
    const rand = makePrng(0x1234_5678);
    const ITERATIONS = 10_000;
    let checked = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      // Vary the length range so both tiny and longer (multi-param, long-name) inputs are covered.
      const maxLen = i % 4 === 0 ? 3 : i % 4 === 1 ? 12 : i % 4 === 2 ? 40 : 200;
      const input = randomPath(rand, maxLen);

      // 1. extraction equals the oracle
      expect(braceParamNames(input), `extract mismatch for ${JSON.stringify(input)}`).toEqual(
        originalParamNames(input),
      );
      // 2. the `:name` rewrite equals the oracle's `:$1`
      expect(
        rewriteBraceParams(input, (name) => `:${name}`),
        `:name rewrite mismatch for ${JSON.stringify(input)}`,
      ).toBe(originalRewrite(input, ':$1'));
      // 3. the `_by_name_` rewrite equals the oracle's `_by_$1_`
      expect(
        rewriteBraceParams(input, (name) => `_by_${name}_`),
        `_by_name_ rewrite mismatch for ${JSON.stringify(input)}`,
      ).toBe(originalRewrite(input, '_by_$1_'));
      checked++;
    }
    expect(checked).toBe(ITERATIONS);
  });

  it('injects guaranteed long-name inputs (129..5000 chars) into the differential comparison', () => {
    // A separate corpus that always exceeds the old 128 bound, so the fuzz can never pass a bounded regex.
    for (const n of [129, 200, 512, 5000]) {
      const name = `p_${'x'.repeat(n)}`;
      for (const input of [`/r/{${name}}`, `/a/{ok}/b/{${name}}/c`, `{${name}}{short}`]) {
        expect(braceParamNames(input)).toEqual(originalParamNames(input));
        expect(rewriteBraceParams(input, (name2) => `:${name2}`)).toBe(
          originalRewrite(input, ':$1'),
        );
        expect(rewriteBraceParams(input, (name2) => `_by_${name2}_`)).toBe(
          originalRewrite(input, '_by_$1_'),
        );
      }
    }
  });
});
