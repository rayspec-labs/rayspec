/**
 * Email normalization — applied BEFORE every users.email write so the partial unique index on
 * lower(email) cannot be bypassed by compatibility/whitespace/invisible-character variants, and
 * the dummy-hash enumeration defense operates on a single canonical form.
 *
 * Steps: trim, Unicode NFKC fold, lowercase, cap at 254 chars (RFC 5321), then reject any
 * embedded Unicode Control/Format (\p{C}) or Separator/whitespace (\p{Z}) character anywhere in
 * the address. NOT a deliverability validator — a normalization + basic shape guard. Throws on
 * a structurally invalid address so a bad value never reaches the DB.
 *
 * SCOPE / LIMITATION (honest): NFKC collapses COMPATIBILITY variants (e.g. fullwidth ＡＬＩＣＥ ->
 * alice) and the \p{C}/\p{Z}/\p{Default_Ignorable_Code_Point} reject closes the invisible-character
 * class (zero-width space/joiner/non-joiner, word-joiner, soft-hyphen, BOM, LRM/RLO bidi marks,
 * NBSP, AND the Default_Ignorable code points \p{C} misses — variation selectors U+FE00–FE0F /
 * U+E0100–E01EF, Mongolian free variation selectors, etc., which are category Mn/format-invisible
 * and would otherwise survive NFKC) — these all PASSED the previous ASCII-only guard and the
 * earlier \p{C}/\p{Z}-only guard. It does NOT defend against cross-script HOMOGLYPHS: a Cyrillic
 * "а" (U+0430) is a distinct letter that NFKC does not fold and \p{C}/\p{Z} does not catch, so
 * "аlice@x.com" and "alice@x.com" remain different canonical strings. Full TR39 confusable-
 * skeleton / IDNA defense is deliberately out of scope (it needs a confusables table);
 * the homograph test below documents this boundary so the limitation is explicit, not implied.
 */

// Reject Unicode Control/Format chars (\p{C} — incl. zero-width/format/bidi marks), any
// Separator/whitespace (\p{Z} + ASCII control/whitespace via \s), AND every other
// Default_Ignorable code point — notably the variation selectors U+FE00–FE0F and U+E0100–E01EF,
// which are category Mn (a Mark, NOT \p{C}) yet render invisibly and survive NFKC, so a
// \p{C}/\p{Z}-only guard let them through and they could defeat the lower(email) unique index.
// NFKC keeps all of these (it does not strip them), so they must be rejected explicitly. The /u
// flag is required for \p{...}. Built so the source carries no literal invisible bytes.
const DISALLOWED = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\s]/u;

export function normalizeEmail(raw: string): string {
  const normalized = raw.trim().normalize('NFKC').toLowerCase();
  if (normalized.length === 0) throw new Error('email is empty');
  if (normalized.length > 254) throw new Error('email exceeds 254 characters');
  if (DISALLOWED.test(normalized)) {
    throw new Error('email contains control, whitespace, or invisible characters');
  }
  const at = normalized.indexOf('@');
  if (at <= 0 || at !== normalized.lastIndexOf('@') || at === normalized.length - 1) {
    throw new Error('email is not a valid address');
  }
  return normalized;
}
