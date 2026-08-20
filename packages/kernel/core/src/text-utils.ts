/**
 * Text utilities — UAX-29 word tokenization, a contiguous token-run subset check, and the tree's
 * shared surrogate-safe truncation guard.
 *
 * Product-neutral pure functions for any task that needs script-uniform, language-neutral word
 * tokens, a "does this cited text appear verbatim inside that text" predicate (e.g. retrieval,
 * extraction, citation validation), or a length cap that cannot corrupt the text it caps.
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

/** A UTF-16 HIGH surrogate in final position — the only orphan a prefix cut can create. */
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

/**
 * THE SHARED TRUNCATION GUARD. A prefix of `text` at most `maxCodeUnits` UTF-16 code units long
 * that NEVER ends on a surrogate this cut orphaned.
 *
 * ── THE HAZARD ────────────────────────────────────────────────────────────────────────────────────
 * `String.prototype.slice` cuts UTF-16 CODE UNITS, not code points. A non-BMP ("astral") character —
 * every emoji, every CJK extension ideograph, every historic script — is TWO code units, a HIGH
 * surrogate (`\uD800`–`\uDBFF`) followed by a LOW one (`\uDC00`–`\uDFFF`). A cut between them keeps
 * the high half and drops its partner, and a lone surrogate is not valid Unicode text.
 *
 * Where the result is only DISPLAYED that is mangled text. Where it is written to a **`jsonb`**
 * column it is a write PostgreSQL REFUSES OUTRIGHT — `22P02`, "Unicode low surrogate must follow a
 * high surrogate" — and if that write sits inside a transaction, the whole transaction rolls back.
 * Both jsonb sites in this tree have been observed doing exactly that, on real Postgres:
 * `@rayspec/tasks` `task-locks.ts` (the escalation-reply signal payload, which rolled back the
 * SUPERIOR'S OWN completion and stranded the parked caller) and `apply-intents.ts` (the failure
 * summary). The guard exists because both of those were found the hard way.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────────
 *  - The result is always a PREFIX of `text` — this function only ever removes from the end.
 *  - Its length is always `<= maxCodeUnits`. Dropping the orphan only shortens it, so a caller that
 *    appends a marker or an ellipsis keeps whatever ceiling it computed from `maxCodeUnits`.
 *  - It NEVER emits an unpaired surrogate THAT IT CREATED.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO: it does not SCRUB ───────────────────────────────────────────
 * A lone surrogate ALREADY present in `text` is passed through untouched, including when `text` is
 * at or under the cap and is returned by identity. This is a decision, not an oversight, and there
 * is a test named for it.
 *
 * The reason is that a scrubbing truncation guard would be PARTIAL while reading as TOTAL: every
 * caller returns its input verbatim when it is short enough, so scrubbing here would protect only
 * the over-the-cap branch while inviting the conclusion that the string is now safe to write. Making
 * it total would mean scrubbing the whole string on every call — i.e. becoming an input sanitizer,
 * which belongs ONCE at the boundary where untrusted text enters, not once per truncation site. A
 * model emitting a lone surrogate directly is a real and separate question; this function fixes
 * CUTS, not INPUTS, and says so rather than half-answering both.
 *
 * ── WHY ONLY THE TRAILING HIGH HALF IS CHECKED ────────────────────────────────────────────────────
 * Every caller takes a PREFIX (`slice(0, n)`). A prefix cut can only orphan the HIGH half — the low
 * half is what gets dropped. A leading lone LOW surrogate cannot be produced by a cut starting at
 * index 0, so a leading check would be dead code at every call site and a first step toward the
 * scrub above.
 *
 * ── THE CALLERS — a NEW truncation site calls this, it does not re-derive it ──────────────────────
 *  - `@rayspec/workforce-tools` `memory.ts` `clampText` — recall hit text, ellipsis-terminated.
 *  - `@rayspec/workforce-tools` `context.ts` `truncateToBytes` — a UTF-8 BYTE budget, so it settles
 *    its own length first and passes that length here.
 *  - `@rayspec/tasks` `task-locks.ts` — the escalation-reply signal payload (**jsonb**).
 *  - `@rayspec/tasks` `apply-intents.ts` — the failure summary (**jsonb**), and the two
 *    machine-composed child titles (`Review: …` / `Escalation: …`, a `text` column — there an
 *    orphan is stored as U+FFFD rather than refused, which is quieter and not better).
 *  - `@rayspec/core` `seam-confinement.ts` — the confined selection rationale (extension-authored).
 *
 * THE ONE DELIBERATE EXCEPTION: `@rayspec/core` `orchestration-strategy.ts` carries its own copy of
 * this predicate, because a SEAM INTERFACE MODULE may import nothing at all — `seam-wiring.test.ts`
 * asserts its import list is empty, so an out-of-tree implementer can read one self-contained file
 * and know the whole contract. That rule outranks the deduplication. The copy is labelled as a copy,
 * points back here, and has its own non-BMP test; it is not a fourth SILENT copy of the kind that
 * produced the defect this guard exists for.
 *
 * @param maxCodeUnits a non-negative code-unit ceiling; a negative value clamps to 0 (empty).
 */
export function truncateCodeUnits(text: string, maxCodeUnits: number): string {
  // NOTHING WAS CUT ⇒ NOTHING TO REPAIR. This early return is what makes the pass-through contract
  // above true rather than aspirational: an orphan the caller supplied survives it untouched.
  if (text.length <= maxCodeUnits) return text;
  const sliced = text.slice(0, Math.max(maxCodeUnits, 0));
  return TRAILING_HIGH_SURROGATE_RE.test(sliced) ? sliced.slice(0, -1) : sliced;
}
