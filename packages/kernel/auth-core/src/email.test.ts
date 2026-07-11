/**
 * Email normalization — proves case/whitespace/compatibility variants collapse to one canonical
 * form, that invisible Control/Format/Separator AND Default_Ignorable characters (incl. the
 * variation selectors U+FE00–FE0F / U+E0100, which are category Mn and slip past a \p{C}/\p{Z}-only
 * guard) are REJECTED (so they cannot defeat the lower(email) partial unique index), and that bad
 * shapes throw. Also documents the homoglyph boundary the normalizer deliberately does NOT cover
 * (see email.ts SCOPE/LIMITATION).
 *
 * Invisible code points are built with String.fromCodePoint so this source carries no literal
 * zero-width bytes.
 */
import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe('normalizeEmail', () => {
  it('trims, lowercases and NFKC-folds to a single canonical form', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    // NFKC folds fullwidth characters to their ASCII equivalents.
    expect(normalizeEmail('ＡＬＩＣＥ@example.com')).toBe('alice@example.com');
  });

  it('collapses case and surrounding-whitespace variants of one address to the same value', () => {
    const canonical = normalizeEmail('user@example.com');
    expect(normalizeEmail('USER@EXAMPLE.COM')).toBe(canonical);
    expect(normalizeEmail('  user@example.com  ')).toBe(canonical);
  });

  it('preserves hyphens in the domain (does not over-reject)', () => {
    expect(normalizeEmail('a@sub-domain.example.com')).toBe('a@sub-domain.example.com');
  });

  it('rejects embedded ASCII whitespace and control characters', () => {
    expect(() => normalizeEmail('us er@example.com')).toThrow();
    expect(() => normalizeEmail('user@exa\tmple.com')).toThrow();
    expect(() => normalizeEmail('user@exa mple.com')).toThrow();
  });

  // These all PASSED the previous ASCII-only guard and yielded distinct canonical strings,
  // defeating the lower(email) unique index. NFKC keeps them, so they must be rejected.
  it('rejects embedded invisible Control/Format/Separator/Default_Ignorable characters', () => {
    const local = 'a';
    const domain = 'b@example.com';
    const cases: [string, number][] = [
      ['ZWSP U+200B', 0x200b],
      ['ZWNJ U+200C', 0x200c],
      ['ZWJ U+200D', 0x200d],
      ['word-joiner U+2060', 0x2060],
      ['soft-hyphen U+00AD', 0x00ad],
      ['LRM U+200E', 0x200e],
      ['RLO U+202E', 0x202e],
      ['BOM/ZWNBSP U+FEFF', 0xfeff],
      ['NBSP U+00A0', 0x00a0],
      // Variation selectors are category Mn (a Mark, NOT \p{C}) and survive NFKC, so a
      // \p{C}/\p{Z}-only guard let them through; \p{Default_Ignorable_Code_Point} catches them.
      ['VS-1 U+FE00', 0xfe00],
      ['VS-16 (emoji) U+FE0F', 0xfe0f],
      ['VS-17 (supplement) U+E0100', 0xe0100],
    ];
    for (const [name, code] of cases) {
      expect(() => normalizeEmail(local + cp(code) + domain), name).toThrow(
        /control, whitespace, or invisible/,
      );
    }
  });

  it('rejects structurally invalid addresses', () => {
    expect(() => normalizeEmail('')).toThrow();
    expect(() => normalizeEmail('no-at-sign')).toThrow();
    expect(() => normalizeEmail('@no-local.com')).toThrow();
    expect(() => normalizeEmail('no-domain@')).toThrow();
    expect(() => normalizeEmail('two@at@signs.com')).toThrow();
  });

  it('rejects addresses longer than 254 characters', () => {
    const long = `${'a'.repeat(250)}@x.com`;
    expect(() => normalizeEmail(long)).toThrow(/254/);
  });

  // Documents the DELIBERATE boundary (email.ts SCOPE/LIMITATION): cross-script homoglyphs are
  // letters, not Control/Format chars, and NFKC does not fold them. The normalizer does NOT collapse them —
  // a full TR39 confusable-skeleton/IDNA defense is out of scope. If this test ever needs to
  // flip to `.toBe(canonical)`, that confusable step has been added (and the claim re-broadened).
  it('does NOT collapse cross-script homoglyphs (documented limitation)', () => {
    const latin = normalizeEmail('alice@example.com');
    // U+0430 is the Cyrillic "а", a different code point from Latin "a" (U+0061).
    const cyrillic = normalizeEmail(`${cp(0x0430)}lice@example.com`);
    expect(cyrillic).not.toBe(latin); // they remain distinct — homoglyph NOT folded.
  });
});
