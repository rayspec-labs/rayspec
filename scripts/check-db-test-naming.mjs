#!/usr/bin/env node
/**
 * EVERY TEST THAT NEEDS A REAL DATABASE IS NAMED FOR IT.
 *
 * `*.db.test.ts` is a convention, not a collector: none of this repository's twenty-six vitest configs
 * splits on it, and CI's two required lanes are split per PACKAGE. What the convention is actually for
 * is the ad-hoc `--exclude '**\/*.db.test.ts'` a maintainer reaches for to get "the subset that needs
 * no database". A file that needs one under a name outside the convention makes that subset a
 * misnomer: the run stays green, its arms self-skip or hard-fail depending on the machine, and a count
 * taken from it is wrong in a way nobody can see. That happened, which is why this exists.
 *
 * THE SIGNAL IS A DEMAND-GUARD — code that REFUSES TO RUN when DATABASE_URL is absent. Reading the
 * variable is not the signal; refusing to run without it is. A demand-guard is reached either
 *   (a) directly, in the test file itself, or
 *   (b) transitively, through a test-support module that carries one — `createHarness` in
 *       api-auth's test-support/harness.ts is the canonical example. Three such modules exist and
 *       they are pinned by path below, because the transitive rule is where most of the reach is:
 *       sixteen of the twenty-four files this gate first found are reached only through one of them.
 *
 * Finding that signal took four wrong detectors, and what each one actually got wrong is worth more
 * than the fact that it failed:
 *
 *   1. Matching database CALLS caught a regex literal, a comment beside a mocked module, a dummy
 *      handle that never connects, and two occurrences inside fixture STRINGS.
 *
 *   2. Matching `process.env.DATABASE_URL` caught twelve files, of which four are false positives —
 *      three secret-redaction tests that SET the variable to a decoy credential and assert it never
 *      reaches the output, and a boot test that sets a valid-shaped-but-unused URL to satisfy a
 *      fail-closed config check. The approach was then retired on that sample of four, and the eight
 *      unmeasured ones were the true positives. Even fully measured it finds only eight of the
 *      twenty-four; the other sixteen need the transitive rule.
 *
 *      A NOTE ON WHAT THAT DOES NOT SOLVE: the class the "reads it, needs no database" story names is
 *      still a live false positive HERE. A test asserting ON a refusal is textually identical to one
 *      performing it, so a test that reads the variable and expects `toThrow('DATABASE_URL is
 *      required')` is flagged by this gate and needs no database. None exists today.
 *
 *   3. Running the excluded subset and requiring it CLEAN failed its own accept control — but not for
 *      the reason first recorded. A restored file does not pass: it either hard-fails (run-core, orgs)
 *      or SELF-SKIPS (boot.smoke: 3 skipped) while the runner still exits 0. Requiring zero
 *      DB-conditioned SKIPS as well as zero failures does work, and it is the only formulation that
 *      sees the four live-smoke files, which carry no DATABASE_URL demand-guard at all. It is not
 *      adopted here because it needs a full run of every package; this gate is static and runs in
 *      lane 1. The live-smoke gap is closed instead by matching their own guard variable.
 *
 *   4. An earlier revision concluded from the above that no static gate was achievable and shipped
 *      that conclusion. It was refuted by measuring detector 2's unmeasured majority.
 *
 * FAIL-CLOSED, on four counts: a declared root that resolves to nothing, a scan that reads zero test
 * files, a scan that resolves zero demand-guard modules, and a pinned carrier that stops being
 * recognised — each exits 2 rather than reporting a green.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEMAND = [
  /DATABASE_URL[^\n'"`]{0,60}\brequired\b/i,
  /\brequired env var DATABASE_URL\b/i,
  /RAYSPEC_REQUIRE_DB_TESTS/,
  // The live-smoke suites gate on a DIFFERENT variable and their refusal never says "required"
  // next to DATABASE_URL — they say the live PREREQUISITES are absent. Four such files create their
  // own database (`CREATE DATABASE`) and were invisible to this scan: correct today only because
  // they were already named right, which the gate did not check and could not have found.
  /RAYSPEC_REQUIRE_LIVE_TESTS/,
];
const READS_URL = /process\.env\.DATABASE_URL/;

/**
 * THE CARRIERS THIS GATE'S REACH DEPENDS ON, pinned by path.
 *
 * Two of the three patterns above match an English word inside an error string, so rewording a
 * refusal — behaviour unchanged — silently retires the transitive rule for every test that reaches a
 * database only through that helper. Measured: rewording api-auth's harness from `DATABASE_URL
 * required for …` to `DATABASE_URL must be set for …` dropped the resolved-guard count by one and
 * made sixteen files invisible at once, with a planted violation still exiting 0. The count moving is
 * not a signal unless something asserts on it, so these assert on it.
 */
const REQUIRED_CARRIERS = [
  'packages/compose/api-auth/src/test-support/harness.ts',
  'packages/kernel/platform/src/test-support/test-db.ts',
  'packages/adapters/openai/src/test-support/test-db.ts',
];

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

const isTs = (n) => n.endsWith('.ts') && !n.endsWith('.d.ts');
const isTest = (n) => n.endsWith('.test.ts');

const roots = ['packages', 'examples'];
// PER ROOT, not in aggregate. `walk` returns [] for a directory that is not there, so a rename or a
// move of one declared root left the other still producing files — and the aggregate zero-check
// below never fired. Measured: with `packages` resolving to nothing the scan reported a green over
// 8 of 469 test files. This is the same fail-open `check-gate-coverage.test.mjs` records for three
// earlier gates; it is a standing rule here, not a precaution.
for (const r of roots) {
  if (!existsSync(resolve(r))) {
    console.error(
      `detector: declared root '${r}' resolves to nothing — refusing to scan what is left`,
    );
    process.exit(2);
  }
}
// Absolute paths throughout: the import resolver below uses path.resolve, so the index must match.
const allTs = roots.flatMap((r) => walk(resolve(r), isTs));
const tests = allTs.filter((f) => isTest(f)).sort();

/** A module that itself refuses to run without DATABASE_URL. */
const demands = (text) => READS_URL.test(text) && DEMAND.some((r) => r.test(text));

const text = new Map(allTs.map((f) => [f, readFileSync(f, 'utf8')]));
const guardModules = new Set(allTs.filter((f) => demands(text.get(f))));

/** Resolve a relative `./x.js` / `../y.js` import to the .ts on disk. */
function resolveLocal(from, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
    if (text.has(cand)) return cand;
  }
  return undefined;
}

/** Does `file` reach a demand-guard module through local imports (transitively)? */
function reachesGuard(file, seen = new Set()) {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const src = text.get(file);
  if (!src) return undefined;
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
    const dep = resolveLocal(file, m[1]);
    if (!dep) continue;
    if (guardModules.has(dep)) return dep;
    const deeper = reachesGuard(dep, seen);
    if (deeper) return deeper;
  }
  return undefined;
}

const named = tests.filter((f) => f.endsWith('.db.test.ts'));
const unnamed = tests.filter((f) => !f.endsWith('.db.test.ts'));

const direct = [];
const viaHelper = [];
for (const f of unnamed) {
  if (guardModules.has(f)) {
    direct.push(f);
    continue;
  }
  const via = reachesGuard(f);
  if (via) viaHelper.push([f, via]);
}

console.log(
  `scanned ${tests.length} test files (${named.length} *.db.test.ts, ${unnamed.length} other)`,
);
console.log(`demand-guard modules resolved: ${guardModules.size}`);
console.log(
  `\nFLAGGED — reaches a database, not named for it: ${direct.length + viaHelper.length}`,
);
console.log(`\n  [direct demand-guard in the file] ${direct.length}`);
for (const f of direct) console.log(`    ${f}`);
console.log(`\n  [via a test-support helper that demands one] ${viaHelper.length}`);
for (const [f, via] of viaHelper) console.log(`    ${f}\n        <- ${via}`);

if (tests.length === 0 || guardModules.size === 0) {
  console.error('detector: scanned nothing / resolved no guard — refusing to report a green');
  process.exit(2);
}
// Every pinned carrier must still be recognised. A carrier that stops matching takes every test
// that reaches a database only through it out of the gate's reach, silently and with no red.
const lostCarriers = REQUIRED_CARRIERS.filter((rel) => !guardModules.has(resolve(rel)));
if (lostCarriers.length > 0) {
  console.error(
    `detector: ${lostCarriers.length} pinned demand-guard carrier(s) no longer recognised — the ` +
      'transitive rule silently lost its reach. Either the refusal was reworded (fix the pattern) ' +
      'or the module moved (fix REQUIRED_CARRIERS):',
  );
  for (const c of lostCarriers) console.error(`    ${c}`);
  process.exit(2);
}
process.exit(direct.length + viaHelper.length === 0 ? 0 : 1);
