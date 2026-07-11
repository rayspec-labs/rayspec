/**
 * Text utilities — UAX-29 word tokenization + a contiguous token-run subset check.
 *
 * Two product-neutral pure functions for any task that needs script-uniform, language-neutral word
 * tokens or a "does this cited text appear verbatim inside that text" predicate (e.g. retrieval,
 * extraction, citation validation).
 *
 * The segmenter: we use the platform `Intl.Segmenter` with `granularity:'word'` — the Unicode UAX-29
 * default word-boundary algorithm. It is language-neutral and carries no language model. We segment with
 * the `'und'` (undetermined) locale so no locale-specific tailoring applies: the same surface tokenizes
 * identically in every script. A segment is KEPT iff it contains ≥1 alphanumeric character (a
 * Unicode-aware `[\p{L}\p{N}]` test) — a script-neutral "word-ish" filter that drops pure
 * whitespace/punctuation/emoji segments. Each kept token is casefolded for case-insensitive comparison.
 *
 * This module imports nothing — it is pure logic over the JS built-in `Intl.Segmenter`.
 */

/** One UAX-29 word segmenter, language-neutral (`'und'`), reused across calls. */
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });

/**
 * A segment is "word-ish" iff it contains ≥1 alphanumeric character (a Unicode letter or number),
 * expressed as a Unicode-property regex so it is script-neutral (matches a Latin letter, a CJK
 * ideograph, a Thai letter, a digit, …) and drops a pure whitespace/punctuation/emoji segment.
 */
const WORDISH_RE = /[\p{L}\p{N}]/u;

/**
 * The casefolded, word-ish UAX-29 tokens of `text`.
 *
 * A token is kept iff it contains at least one alphanumeric character (dropping pure whitespace and
 * punctuation segments in a script-neutral way); each kept token is lower-cased (JS `toLowerCase` is the
 * available casefold) so comparison is case-insensitive in every script that has case.
 */
export function uax29Tokens(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    if (WORDISH_RE.test(segment)) out.push(segment.toLowerCase());
  }
  return out;
}

/**
 * True iff the UAX-29 tokens of `needle` appear as a CONTIGUOUS run (a consecutive, order-preserving
 * subsequence) within `haystack`'s token sequence.
 *
 * A script-uniform "does the cited text appear verbatim in the source" predicate. An empty needle (no
 * word tokens) is FALSE — a verbatim citation must carry at least one real word token. Contiguity closes
 * the order-free scatter hole (a verbatim citation recombined from non-adjacent tokens — e.g.
 * non-adjacent CJK ideographs — can no longer pass) while matching whole UAX-29 tokens (no
 * inside-a-longer-word false positive on space-separated scripts, no morphological over-rejection).
 * (Residual caveat: on no-word-space scripts a coincidental contiguous grapheme substring can still
 * match; this is a strict improvement over the order-free hole, not a complete guarantee.)
 */
export function tokenRunSubset(needle: string, haystack: string): boolean {
  const nt = uax29Tokens(needle);
  if (nt.length === 0) return false;
  const ht = uax29Tokens(haystack);
  const n = nt.length;
  for (let i = 0; i + n <= ht.length; i++) {
    let match = true;
    for (let j = 0; j < n; j++) {
      if (ht[i + j] !== nt[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
