/**
 * archaeology-tokens.mjs — the forbidden-token registry for the anti-re-accretion gate.
 *
 * PURE DATA. This module is the single source of the forbidden build-history token vocabulary that
 * check-no-archaeology.mjs scans for. It is deliberately kept separate from the gate machinery so the
 * gate SCRIPT stays generic and this file is the ONE place the forbidden words are encoded.
 *
 * Because this file lives under a scanned ROOT and necessarily encodes every forbidden token, it is
 * whole-file-skipped by the gate (like the gate script itself) — one of exactly two legitimate
 * whole-file skips, justified because it is a pure-data token list with NO prose that could hide a hit.
 *
 * To keep the file itself free of the very build-history strings it detects, every human-readable
 * forbidden PHRASE is ASSEMBLED AT RUNTIME from fragments (so the contiguous literal never appears in
 * this source) while the compiled RegExp still matches that phrase exactly. Only pattern-shape
 * fragments (`\d`, character classes, anchors) and short structural codes stay written out.
 *
 * Token families: phase labels in both delimiter forms (a `Phase <letter>` word form and a short
 * `P<n>` form), slice labels (a `Slice <n>` word form plus an abbreviated slice+finding form in both
 * space and hyphen delimiters), wave labels, iteration labels, decision-number tokens (a bare
 * decision number and a prefixed variant), mission/version build-labels, plan/mission/goal and fork
 * labels, section cross-refs, pipeline `stage<n>` labels, leaked product-domain names, authoring-tool
 * / process-narration references, and build-history migration phrases.
 *
 * TWO detector mechanisms live here:
 *   TOKENS        plain [name, RegExp] pairs — the vocabulary that is safe to encode.
 *   HASHED_TOKENS [name, sha256hex] pairs — see below.
 */

// Each entry is a [name, RegExp] pair: the name labels the token family in the gate's output, the
// RegExp is the detector. Only regex-shaping rationale is inline (no build-history narrative). The
// human-readable PHRASE detectors are assembled from fragments so the contiguous literal is absent
// from this source, while the compiled pattern is exactly the phrase it always was.
export const TOKENS = [
  ['prefixed-decision', new RegExp('PY' + '-D\\d')], // a decision number carried under a project prefix
  ['section-ref', /§\s?\d/],
  ['P3.5', /P3\.5/],
  ['spike', /\bSpike [A-Z]\b/],
  ['phase-P#', /\bP\d{1,2}\b(?!\.\d)/],
  ['phase-word', /\bPhase[- ][A-Z]\b/], // both the space and hyphen delimiter forms of the phase-word label
  ['Slice#', /\bSlice\s?\d/i],
  // `stage#` catches BOTH the word-boundary form (`stage3`, `Stage 3`, `stage-3`) AND a camelCase
  // `...Stage<digit>` identifier (`fooStage9`) — the `[a-z]Stage\d` alternation adds the
  // lowercase→`Stage` boundary the leading `\b` form misses (a numbered pipeline var like
  // `unknownStage8` would otherwise slip through).
  ['stage#', /\bstage[- ]?\d|[a-z]Stage\d/i],
  ['D-number', /(?<![\w-])D\d{1,3}\b/], // standalone decision number; excludes the prefixed form (own token)
  // Mission/version build-labels: the hyphen forms and the glued `DX<nn>` (≥2 digits). The leading
  // lookbehind guards a letter-prefixed collision (`IDX-…`); a bare developer-experience `DX` word
  // with no adjacent digit is NOT tokenized.
  ['DX-label', /(?<![A-Za-z])DX(?:-v?\d|\d\d)/],
  ['wave#', /\bwave[ -]?\d/i],
  ['wave-code', /\bW\d(?:FI|CV|S\d)/],
  ['It.#', /\bIt\.\d|\bIteration\s?\d/],
  ['mission', /\bGOAL2\b|\bINTEL-1\b/],
  ['goal-label', /\bGoal-\d\b/], // roadmap goal labels; the glued mission literal stays on `mission`
  ['mission-label', /\bM\d-[A-Z]|\bKS-\d/],
  ['fork', /\bFork\s?#?\d|\bOpen Question\s?#?\d/i],
  ['plan-section', /\bS\d\.\d/],
  // Abbreviated slice-label form (the `Slice N` companion): `S<n> law/brief/defect/finding/round/
  // dim/slice/wave`, the space slice+finding `S<n> F<n>`, AND the hyphenated `S<n>-F<n>` form.
  // Context-scoped to those exact keywords so it catches the dangling slice pointer WITHOUT flagging
  // bare `S\d` (status codes / identifiers).
  ['slice-abbrev', /\bS\d+ (?:law|brief|defect|finding|round|dim|slice|wave|F\d)\b|\bS\d+-F\d\b/],
  // Leaked product-domain names — a shipped source file must be product-neutral. The publisher
  // identity is a public name but is still assembled from fragments here so this registry never
  // spells it out. (A second product-domain name that was never public is detected via HASHED_TOKENS
  // below, not here.)
  ['product-domain-name', new RegExp('me' + 'movo', 'i')],
  ['product-meeting', /\bmeeting\b/i],
  // Authoring-tool + process-narration references: an authoring-skill reference is a dangling ref in a
  // shipped file (its `.claude/**` home never ships), and process-narration identifiers must not
  // surface in the shipped example/package surface. Both are neutralized in the tree and held to ZERO.
  ['authoring-skill', /rayspec-author/i],
  ['dogfood', /dogfood/i],
  // ── build-history migration terms. Most are multi-word phrases, so legitimate live architectural
  // vocabulary is not tripped; the migration SOURCE word (below) is a bare single-word token because it
  // is 0 across shipped source, so any future occurrence is archaeology. Each term is assembled from
  // fragments so it is not spelled out contiguously in this registry. Held to ZERO across the tree. ──
  ['build-parallel-run', new RegExp('\\bshadow' + '-run\\b', 'i')],
  // the migration-pipeline framing (NOT the bare business/incident word, which is legit vocabulary in
  // fixture transcripts, test labels, and real deployment bug descriptions).
  ['build-cutover', new RegExp('\\bcutover ' + 'stages\\b', 'i')],
  ['build-retired-pack', new RegExp('\\bretired ' + 'product-pack\\b', 'i')],
  ['build-source-ref', new RegExp('\\bdo' + 'nor\\b', 'i')], // the migration SOURCE word — a bare single-word token; any occurrence in shipped source is archaeology
  ['build-frozen-baseline', new RegExp('\\bfrozen ' + 'baseline\\b', 'i')],
  ['build-reference-impl', new RegExp('\\breference ' + 'implementation\\b', 'i')],
  ['build-prior-impl', new RegExp('\\bprior ' + 'implementation\\b', 'i')],
];

/**
 * HASHED detectors — for a forbidden word that must not exist ANYWHERE in this repository, this file
 * included.
 *
 * `codename-1` is an internal codename that was never published. Writing it here as a plain literal (the
 * shape every TOKENS entry takes) would reintroduce the exact string the gate exists to keep out of the
 * tree, so the detector stores only the SHA-256 of the LOWERCASED word, plus that word's length.
 *
 * DETECTION IS SUBSTRING-EXACT, not word-boundary. The gate lowercases each scanned line, splits it into
 * maximal `[a-z]+` runs, and slides a window of exactly `length` across every run, hashing each window.
 * The word is made only of letters, so lowercasing preserves it and every case-insensitive occurrence of
 * it lies wholly inside one maximal run — which makes this equivalent to the plain `/word/i` literal it
 * replaced, and catches the glued forms a word-run check misses: `theWordProtocol`, `WordService`, the
 * plural, `// see wordv2`, alongside `WORD`, `word_v2` and `X-Word-Protocol`.
 *
 * WHAT THE HASH BUYS, HONESTLY: a SHA-256 of a short, known word is NOT a secret — anyone who knows the
 * word confirms the digest in one line. All it buys is that the literal is absent from this tree, so a
 * grep of this repository never surfaces it. That is the whole and only goal.
 *
 * A hashed hit is an UNCONDITIONAL failure BY CONSTRUCTION: it bypasses the gate's classification and
 * allowlist machinery entirely, including the whole-file skip the two gate files enjoy for the plain
 * TOKENS. There is no override path, and nothing here can grant one. The accepted cost: the word is also
 * an ordinary English word in some technical domains, and substring matching makes an innocent hit (an
 * inflected form, a compound) likelier than the word-run check did. A hit is therefore a conversation
 * with the maintainers about renaming the identifier, never an allowlist entry.
 *
 * Each entry is [name, sha256-hex-of-the-lowercased-word, word-length]. The length is not a secret; a
 * digest of a known-length word already implies it.
 */
export const HASHED_TOKENS = [
  ['codename-1', '2972f9afb85ba78fdc5aa4970eef30ddecc4ed690bdef28dcfdb494543b6f401', 9],
];
