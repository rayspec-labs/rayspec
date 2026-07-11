#!/usr/bin/env node
/**
 * check-no-archaeology.mjs — the anti-re-accretion structural gate.
 *
 * WHAT IT DOES. Scans the exportable open-core tree for build-history / build-evolution tokens and
 * FAILS on any hit that is not in a documented, line/token-specific allowlist. On a clean tree it
 * reports ZERO un-allowlisted hits, so it is the permanent forcing-function that keeps the source free
 * of build-history archaeology.
 *
 * The forbidden-token vocabulary is a pure-data registry in ./lib/archaeology-tokens.mjs (imported as
 * TOKENS + HASHED_TOKENS); THIS script is the generic scanning + classification machinery. It is NOT a
 * neutrality gate (gate:fixture-neutrality / gate:no-pack own that) and NOT a stylistic checker: opaque
 * review-ids (wf_…, CHOKE-1, NEU-1, TEST-FLAKE-1, CC-1) and legit security vocab ("trust boundary",
 * "untrusted-content boundary") are deliberately NOT tokens.
 *
 * TWO detectors run over every scanned line:
 *   1. TOKENS — plain regexes, subject to the classification/allowlist machinery below.
 *   2. HASHED_TOKENS — for a codename that was never public and must never be reintroduced. Spelling it
 *      out (here or in the registry) would put it straight back into the tree, so the registry carries
 *      only the SHA-256 of the lowercased word and its length. Each line is lowercased, split into
 *      maximal `[a-z]+` runs, and a window of exactly that length is slid across every run and hashed.
 *      Detection is therefore SUBSTRING-exact — equivalent to the case-insensitive literal it replaced,
 *      so glued identifier forms (`theWordProtocol`, `WordService`, a plural) are caught, not merely
 *      word-boundary occurrences. A hashed hit is an UNCONDITIONAL FAIL: it bypasses `classify()`
 *      entirely, so no allowlist applies — not even the whole-file skip the two gate files enjoy for the
 *      plain TOKENS; neither of them can legitimately carry the word either. The SHA-256 is not a
 *      secret (a short known word's digest is trivially confirmed) — it only keeps the literal out of a
 *      grep of this tree. The acceptance oracle for that word is a repo-wide `git grep`; this gate is
 *      its regression oracle. There is no override path, by design: see the registry docblock for the
 *      accepted cost.
 *
 * SCOPE BOUNDARY (families deliberately NOT tokenized — a documented decision, NOT a silent miss):
 *   (a) the `C<n>` invariant-name shorthand (`C10`/`C11`) — a load-bearing shorthand used across the
 *       codebase; a broad `C\d` token is noise-prone (it collides with `C1` constants / hex /
 *       identifiers), so these are not tokenized here.
 *   (b) ambiguous single-letter+digit codes (`E1`/`F1`) — they collide with legit LOCAL test-arm
 *       labels (arm F1/F2, INJ-F1, TF-F1), score/hex forms, and the "Tier-1" test-tier term. Only the
 *       EXPLICIT slice+finding forms `S<n> F<n>` / `S<n>-F<n>` are tokenized (slice-abbrev).
 *
 * ALLOWLIST PHILOSOPHY (guard against a false-green from an over-broad allowlist):
 *   - Prefer file+token+line specificity over a blanket whole-file skip. Every allowlist entry cites
 *     a reason. A whole-file skip hides ANY future archaeology in that file, so it is used for exactly
 *     TWO files: this gate script and its token registry (both necessarily NAME every forbidden word).
 *     The neutrality/denylist checker scripts are token-SCOPED to product-* — they legitimately name
 *     product words, but a NON-product token re-accreting in them still FAILS.
 *   - Enumeration is TRACKED-file-based (git ls-files), not a closed extension allowlist, so a
 *     `.txt`/extension-less tracked file under a ROOT cannot bypass the scan.
 *   - Each residual bucket is TOKEN-SCOPED: it allows only the specific token TYPES that are
 *     legitimately present, so a NEW token type (e.g. a fresh `Slice 3` in an allowlisted file) still
 *     FAILS. This is what makes the gate anti-re-accretion rather than a rubber stamp.
 *   - The kill-set files are BYTE-FROZEN (a founder-signed comment-scrub cannot touch code or strings).
 *     Their residual archaeology lives in string literals / test-name strings / DDL SQL
 *     comments-in-template-literals / audio-fixture identifiers — allowlisted as code (non-comment)
 *     only. A NEW pure-comment archaeology line in a kill-set file still FAILS (catches re-accretion in
 *     the one place already swept).
 *
 * DEFERRED residual buckets (DO NOT scrub — deferred/byte-frozen; each reaches ZERO here by allowlist;
 * named below by the verdict each produces in the --list breakdown):
 *   rf-grammar-secrefs   grammar.ts §-refs — a byte-frozen kill-set residual; a scrub needs a
 *                        founder-signed pass.
 *   rf-killset-strings   byte-frozen non-pure-comment archaeology in the kill-set files.
 *   rf-killset-buildhist byte-frozen adapter comments carrying build-migration phrases (build-* tokens)
 *                        — a byte-frozen kill-set residual; scoped to build-* tokens in a KILLSET_FILE
 *                        only, so a NEW build-phrase in non-kill-set source still FAILS.
 *
 *   node check-no-archaeology.mjs           # summary; exit 1 if any un-allowlisted archaeology
 *   node check-no-archaeology.mjs --list    # every un-allowlisted hit + the by-reason breakdown
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { HASHED_TOKENS, TOKENS } from './lib/archaeology-tokens.mjs';

const repoRoot = process.cwd();
const LIST = process.argv.includes('--list');

// Exportable open-core tree ONLY: packages + scripts + the kept example gallery + ci.yml + root
// config. OUT of scope (export-excluded, not shipped): products/memovo, deployments/memovo, sdks, docs,
// and the CUT example dirs (never scrubbed — they are not part of the open-core release).
const ROOTS = [
  'packages',
  'scripts',
  '.github/workflows', // the WHOLE workflows dir (every workflow file), not just ci.yml
  'examples/acme-notes',
  'examples/acme-notes-backend',
  'examples/invoice-intake',
  'examples/contract-intake',
  'examples/support-intake-chat',
  'examples/support-ticket-triage',
  'examples/expense-claim',
  'examples/expense-claim-coder',
  'examples/stream-backend',
  'examples/agent-pack-deployment',
  'examples/local-boot',
  'deployments/acme-notes',
  'package.json',
  'biome.json',
  'turbo.json',
  'pnpm-workspace.yaml',
  // Exportable root config/CI files (each a real re-accretion vector); .npmrc / vitest.workspace.ts
  // are absent today, so they are not listed (git ls-files silently ignores a missing pathspec).
  'docker-compose.yml',
  '.gitleaks.toml',
  'tsconfig.json',
  'tsconfig.base.json',
];
const EXCLUDE_SUBSTR = ['/node_modules/', '/dist/', '/.turbo/', '/coverage/'];
// File enumeration is TRACKED-file-based (git ls-files), NOT a closed extension allowlist — a
// `.txt`/`.env`/extension-less tracked file under a ROOT is a real re-accretion vector, so every
// tracked TEXT file is scanned. Only known BINARY/non-text extensions are skipped.
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.gz',
  '.zip',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.mp4',
  '.bin',
  '.node',
]);

// The forbidden build-history token-set (name→RegExp pairs) is the pure-data registry imported above.

// ─── HASHED-TOKEN DETECTOR ──────────────────────────────────────────────────────────────────────
// See the docblock: for a never-public codename the registry stores only the SHA-256 of the lowercased
// word plus its length. Detection is SUBSTRING-EXACT — lowercase the line, take its maximal `[a-z]+`
// runs, and slide a window of exactly the token's length across each run. The word is all letters, so
// every case-insensitive occurrence of it lies wholly inside one maximal run: this is equivalent to the
// plain `/word/i` literal it replaced. A run-level (word-boundary) check would be strictly WEAKER — it
// misses the glued identifier forms (`theWordProtocol`, `WordService`, a plural) that are precisely how
// a codename re-accretes in code.
const HASHED_BY_LEN = new Map(); // window length → Map(sha256hex → token name)
for (const [name, hex, len] of HASHED_TOKENS) {
  const byHex = HASHED_BY_LEN.get(len) ?? new Map();
  byHex.set(hex, name);
  HASHED_BY_LEN.set(len, byHex);
}
// Memoised BY WINDOW SUBSTRING (the lookup is a pure function of it), because the same windows recur all
// over the tree: today 365_774 windows collapse to 22_065 distinct ones. The cache therefore cannot
// outgrow the distinct N-letter substrings of the tracked tree — but the cap makes that bound EXPLICIT
// instead of incidental, and clearing is always safe for a pure memo (it costs re-hashing, never
// correctness). A window's LENGTH selects its `byHex` map, so a key can never be resolved against the
// wrong token group.
const WINDOW_CACHE_MAX = 1 << 17; // 131_072 — ~6x the measured working set
const windowCache = new Map(); // window → token name, or null for "not a hashed token"
function lookupWindow(window, byHex) {
  let name = windowCache.get(window);
  if (name === undefined) {
    if (windowCache.size >= WINDOW_CACHE_MAX) windowCache.clear();
    name = byHex.get(createHash('sha256').update(window, 'utf8').digest('hex')) ?? null;
    windowCache.set(window, name);
  }
  return name;
}
/** The hashed-token names present on `line` (usually none). An UNCONDITIONAL fail — no allowlist. */
function hashedHits(line) {
  const runs = line.toLowerCase().match(/[a-z]+/g);
  if (!runs) return [];
  const hits = [];
  for (const [len, byHex] of HASHED_BY_LEN) {
    for (const run of runs) {
      for (let i = 0; i + len <= run.length; i++) {
        const name = lookupWindow(run.slice(i, i + len), byHex);
        if (name !== null && !hits.includes(name)) hits.push(name);
      }
    }
  }
  return hits;
}

// ─── ALLOWLISTS ─────────────────────────────────────────────────────────────────────────────────
// (KEEP-1a) The gate machinery + its pure-data token registry both necessarily spell out every PLAIN
// forbidden token — product AND non-product (e.g. `P3.5`, `Slice 3`, `GOAL2`, `§`, `D41`): the gate's
// docs name them, and the registry's TOKENS list IS them. Those mentions are load-bearing (the gate
// cannot detect a plain token without naming it), so these are the only two legitimate WHOLE-FILE
// skips. The registry is pure data (no prose that could hide a hit); any OTHER file added here would
// re-open a blanket false-green. NOTE the skip covers the plain TOKENS only — a HASHED_TOKENS hit fails
// even here, which is precisely why that word is stored as a hash rather than as a literal.
const KEEP_REGISTRY_FILES = new Set([
  'scripts/check-no-archaeology.mjs',
  'scripts/lib/archaeology-tokens.mjs',
]);
// (KEEP-1b) The sibling neutrality/denylist checkers legitimately NAME forbidden words (their
// forbidden-word denylists + assertion narration) — product-* words AND the build-history migration
// phrases (build-*). Token-SCOPED to product-*/build-* so a NON-product/NON-build token (a re-accreted
// P#/§/D#/Slice#/…) inside one of these checkers still FAILS — they carry zero such archaeology today.
const KEEP_PRODUCT_CHECKER_FILES = new Set([
  'scripts/check-fixture-neutrality.mjs',
  'scripts/check-no-pack-imports.mjs',
  'scripts/check-handler-imports.mjs',
  'scripts/check-extension-capability.mjs',
]);
// (KEEP-2) Neutrality-denylist TEST arrays — assert product words are ABSENT; they must name them.
// Token-scoped to product-* so a NON-product archaeology label in one of these tests still FAILS.
const NEUTRALITY_TEST_RE =
  /manifest\.test\.ts$|cors\.test\.ts$|neutral-views\.test\.ts$|deployed-surface\.test\.ts$/;
// (KEEP-3) diff-product-stores migration-ALGORITHM phase labels (Phase A/B/C/D, space form, A–D only).
const KEEP_ALGO_PHASE_FILE = /kernel\/db\/(src\/)?diff-product-stores/;

// (rf-grammar-secrefs) exact file target — a byte-frozen kill-set residual.
const GRAMMAR_TS = 'packages/kernel/spec/src/grammar.ts';

// (rf-killset-strings) byte-frozen kill-set files (the 6 canonical elements, at their tiered paths).
const KILLSET_FILE =
  /^packages\/kernel\/(core\/src\/neutral|db\/src\/tenant-db|platform\/src\/dispatch|spec\/src\/grammar)\.ts$|^packages\/compose\/api-auth\/src\/engine\/deploy\.ts$|^packages\/adapters\//;

/**
 * Strip a trailing `//` line comment, quote-aware so a `//` INSIDE a string/template literal (e.g. a
 * `https://…` URL or a `//`-bearing DDL string) is NOT mistaken for a comment. Returns the code portion.
 */
function stripLineComment(line) {
  let inString = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') {
        i++; // skip the escaped char
        continue;
      }
      if (c === inString) inString = null;
    } else if (c === "'" || c === '"' || c === '`') {
      inString = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function isKillsetByteFrozen(rel, line, re) {
  if (!KILLSET_FILE.test(rel)) return false;
  // Inside the kill-set, ONLY archaeology that lives in CODE (a string/error/test-name/DDL-comment-in-
  // template-literal/StageN identifier) is a byte-frozen residual. Archaeology that lives in a COMMENT —
  // whether a pure-comment line (leading `*`, `//`, `/*`) OR a trailing `// …` inline comment — would be
  // a missed comment-scrub and must FAIL. So: reject a pure-comment line outright, then strip a
  // quote-aware trailing line comment and re-test — if the token no longer matches the code portion, it
  // lived only in the comment ⇒ NOT allowlisted (FAIL). The quote-aware strip avoids misfiring on `//`
  // in strings.
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
  return re.test(stripLineComment(line));
}

function classify(rel, line, token, re) {
  // ── functional KEEPs ──
  if (KEEP_REGISTRY_FILES.has(rel)) return 'keep'; // the gate machinery + its pure-data token registry
  // The sibling neutrality/denylist checkers legitimately NAME forbidden vocabulary in their denylists +
  // assertion narration — both product-* words AND the build-history migration phrases (build-*). A
  // NON-product/NON-build token (a re-accreted P#/§/D#/Slice#/…) inside one of these checkers still FAILS.
  if (
    KEEP_PRODUCT_CHECKER_FILES.has(rel) &&
    (token.startsWith('product-') || token.startsWith('build-'))
  )
    return 'keep';
  if (NEUTRALITY_TEST_RE.test(rel) && token.startsWith('product-')) return 'keep';
  // The migration-ALGORITHM's own phase labels (Phase A/B/C/D = added/renamed-additive/renamed-
  // destructive/dropped) — scoped to the SPACE form A–D. A future `Phase E`/`Phase-E` there FAILS.
  if (KEEP_ALGO_PHASE_FILE.test(rel) && token === 'phase-word' && /\bPhase [A-D]\b/.test(line))
    return 'keep';

  // ── documented deferred/byte-frozen residuals (each token-scoped or line-specific) ──
  if (rel === GRAMMAR_TS && token === 'section-ref') return 'rf-grammar-secrefs';
  // The byte-frozen adapter carries build-migration phrases (build-* tokens) in its comments — a
  // byte-frozen kill-set residual (the adapters are byte-frozen, so these cannot be scrubbed without a
  // founder-signed pass). Scoped to the build-* phrase tokens inside a KILLSET_FILE ONLY; a NEW
  // build-phrase in NON-kill-set source (or a non-build token here) still FAILS.
  if (token.startsWith('build-') && KILLSET_FILE.test(rel)) return 'rf-killset-buildhist';
  if (isKillsetByteFrozen(rel, line, re)) return 'rf-killset-strings';

  return 'FAIL';
}

// Enumerate TRACKED files under the ROOTS (a directory OR single-file pathspec), then drop the
// build/vendor dirs and known binaries. Tracked-file-based enumeration closes the closed-extension
// bypass: a `.txt`/`.env`/extension-less tracked file under a ROOT is now scanned, not skipped.
function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !EXCLUDE_SUBSTR.some((e) => `/${rel}`.includes(e)))
    .filter((rel) => !BINARY_EXT.has(extname(rel).toLowerCase()));
}

const fails = [];
const allowed = [];
for (const rel of trackedTextFiles()) {
  let content;
  try {
    content = readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    continue;
  }
  content.split('\n').forEach((line, i) => {
    // Evaluate EVERY token on the line (no break): a line FAILS if ANY of its tokens is
    // un-allowlisted. Breaking on the first hit could mask a non-allowlisted token that co-occurs
    // with an already-allowlisted one (a latent false-green for future re-accretion).
    for (const [name, re] of TOKENS) {
      if (re.test(line)) {
        const rec = { rel, line: i + 1, token: name, text: line.trim().slice(0, 140) };
        const verdict = classify(rel, line, name, re);
        if (verdict === 'FAIL') fails.push(rec);
        else allowed.push({ ...rec, verdict });
      }
    }
    // Hashed tokens bypass `classify` entirely: no file, line or token scope can excuse them.
    for (const name of hashedHits(line)) {
      fails.push({ rel, line: i + 1, token: name, text: line.trim().slice(0, 140) });
    }
  });
}

console.log(
  `### anti-re-accretion gate: ${fails.length} un-allowlisted archaeology hit(s); ${allowed.length} allowlisted`,
);
if (LIST || fails.length) {
  for (const f of fails) console.log(`  ❌ ${f.rel}:${f.line}  [${f.token}]  ${f.text}`);
}
if (LIST) {
  const byV = {};
  for (const a of allowed) byV[a.verdict] = (byV[a.verdict] || 0) + 1;
  console.log('allowlisted by reason:', JSON.stringify(byV));
}
process.exit(fails.length === 0 ? 0 : 1);
