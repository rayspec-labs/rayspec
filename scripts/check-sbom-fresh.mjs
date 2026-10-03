#!/usr/bin/env node
/**
 * check-sbom-fresh.mjs — the dependency-SBOM drift gate.
 *
 * WHY THIS EXISTS (a real failure, not a hypothetical). `docs/dependency-sbom.json` is the factual
 * backing for `THIRD-PARTY-NOTICES.md` — a legal document. It was written once and never regenerated,
 * while dependency pins moved underneath it. A notices file whose inventory silently describes a
 * different dependency tree than the one that ships is worse than no inventory: it reads as
 * authoritative and is not.
 *
 * WHAT IT ASSERTS. The SBOM records the sha256 of the `pnpm-lock.yaml` it was generated from. This
 * gate recomputes that hash from the lockfile ON DISK and requires an exact match. Any dependency
 * change at all — an added package, a moved pin, a dropped dev tool — necessarily changes the
 * lockfile, therefore its hash, therefore fails this gate until the SBOM is regenerated.
 *
 * It also checks the SBOM's internal consistency (the required keys exist, and `counts` agrees with
 * the `packages` table it claims to summarise). This catches staleness and structural tampering —
 * NOT the content of a row: a hand-edited `license` string that leaves the count and the recorded
 * lockfile hash intact passes. Row-level truth rests on the generator being deterministic and
 * re-derivable (proven: the committed SBOM is byte-identical to a fresh `gen-dependency-sbom.mjs`
 * run) plus lane 1's own `pnpm install`, not on this gate.
 *
 * It then holds the CycloneDX SBOM of the published closure (`docs/closure-sbom.cdx.json`, written
 * by `scripts/gen-closure-sbom.mjs`) to a fresh derivation from the same lockfile, that inventory and
 * the tracked member manifests, member for member.
 *
 * Host-independent and deterministic: it reads files and `git ls-files`, nothing else. No install,
 * no build, no network, no Postgres. There is NO flag or environment variable that relaxes it — a
 * gate with an escape hatch is a suggestion.
 *
 *   node scripts/check-sbom-fresh.mjs   # exit 1 when the SBOM does not describe the current lockfile
 *
 * On failure: `pnpm install --frozen-lockfile && node scripts/gen-dependency-sbom.mjs` and
 * `node scripts/gen-closure-sbom.mjs`, then review the SBOM diff — a new licence family or a new copyleft flag is a change to the legal surface and
 * belongs in THIRD-PARTY-NOTICES.md too.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT as CLOSURE_SBOM, closureSbomOf } from './gen-closure-sbom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = 'pnpm-lock.yaml';
const SBOM = 'docs/dependency-sbom.json';
const REGENERATE = `pnpm install --frozen-lockfile && node scripts/gen-dependency-sbom.mjs`;
const REGENERATE_CLOSURE = 'node scripts/gen-closure-sbom.mjs';

/** Print the failure and exit non-zero. Every message names the fix. */
function fail(lines) {
  console.error(`SBOM-freshness gate FAILED:\n${lines.map((l) => `  ${l}`).join('\n')}`);
  process.exit(1);
}

let sbom;
try {
  sbom = JSON.parse(readFileSync(join(repoRoot, SBOM), 'utf8'));
} catch (err) {
  fail([`cannot read/parse ${SBOM} (${err?.message ?? err}).`, `Regenerate it: ${REGENERATE}`]);
}

// Structural: the keys this gate and the notices depend on must all exist. A missing key means the
// SBOM was hand-written or produced by something other than the committed generator.
const REQUIRED_KEYS = [
  'schema',
  'lockfile',
  'lockfile_sha256',
  'counts',
  'classification',
  'license_groups',
  'flags',
  'packages',
];
const missing = REQUIRED_KEYS.filter((k) => !(k in sbom));
if (missing.length > 0) {
  fail([
    `${SBOM} is missing required key(s): ${missing.join(', ')}.`,
    `It must be produced by scripts/gen-dependency-sbom.mjs, not edited by hand.`,
    `Regenerate it: ${REGENERATE}`,
  ]);
}

if (sbom.lockfile !== LOCKFILE) {
  fail([
    `${SBOM} claims to describe '${sbom.lockfile}', but this gate governs '${LOCKFILE}'.`,
    `Regenerate it: ${REGENERATE}`,
  ]);
}

if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) {
  fail([`${SBOM} carries no per-package table.`, `Regenerate it: ${REGENERATE}`]);
}

// Internal consistency: the summary must agree with the rows. Catches a hand-edited count.
if (sbom.counts?.lockfile_distinct !== sbom.packages.length) {
  fail([
    `${SBOM} is internally inconsistent: counts.lockfile_distinct=${sbom.counts?.lockfile_distinct} ` +
      `but the packages table has ${sbom.packages.length} rows.`,
    `Regenerate it: ${REGENERATE}`,
  ]);
}

// The load-bearing check: does the SBOM describe the lockfile that is actually on disk?
const actual = createHash('sha256')
  .update(readFileSync(join(repoRoot, LOCKFILE)))
  .digest('hex');
if (actual !== sbom.lockfile_sha256) {
  fail([
    `${SBOM} was generated from a DIFFERENT ${LOCKFILE} than the one on disk — the dependency tree`,
    `moved and the third-party inventory did not follow it.`,
    `  recorded lockfile_sha256: ${sbom.lockfile_sha256}`,
    `  actual   lockfile_sha256: ${actual}`,
    ``,
    `Regenerate it: ${REGENERATE}`,
    `Then review the diff: a new licence family, a new copyleft flag, or a package that ships no`,
    `licence file is a change to the legal surface and belongs in THIRD-PARTY-NOTICES.md too.`,
  ]);
}

// The CycloneDX SBOM of the published closure is derived from the lockfile, the inventory above
// and the member manifests, and nothing else, so it is compared with a fresh derivation as a whole:
// a moved pin, a regenerated inventory, a member that joined or left the closure, or a version
// change all show up as a difference.
let closure;
try {
  closure = JSON.parse(readFileSync(join(repoRoot, CLOSURE_SBOM), 'utf8'));
} catch (err) {
  fail([
    `cannot read/parse ${CLOSURE_SBOM} (${err?.message ?? err}).`,
    `Regenerate it: ${REGENERATE_CLOSURE}`,
  ]);
}
let fresh;
try {
  fresh = closureSbomOf(repoRoot);
} catch (err) {
  fail([
    `the closure SBOM cannot be derived from this checkout: ${err?.message ?? err}`,
    `Fix the cause, then regenerate it: ${REGENERATE_CLOSURE}`,
  ]);
}
if (JSON.stringify(closure) !== JSON.stringify(fresh)) {
  fail([
    `${CLOSURE_SBOM} does not describe this checkout: a fresh derivation from ${LOCKFILE}, ${SBOM}`,
    `and the member manifests differs from the committed document.`,
    `Regenerate it: ${REGENERATE_CLOSURE}`,
  ]);
}

console.log(
  `SBOM-freshness gate PASSED: ${SBOM} describes the current ${LOCKFILE} ` +
    `(sha256 ${actual.slice(0, 12)}…, ${sbom.packages.length} distinct packages, ` +
    `${sbom.flags?.strong_copyleft?.length ?? '?'} strong-copyleft), and ${CLOSURE_SBOM} matches ` +
    `a fresh derivation (${fresh.components.length + 1} components).`,
);
