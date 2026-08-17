#!/usr/bin/env node
/**
 * EVERY TEST THAT NEEDS A REAL DATABASE IS NAMED FOR IT.
 *
 * `*.db.test.ts` is a convention, not a collector: none of this repository's twenty-six vitest configs
 * splits on it, and CI's two lanes are split per PACKAGE. What the convention is actually for is the
 * ad-hoc `--exclude '**\/*.db.test.ts'` a maintainer reaches for to get "the subset that needs no
 * database". A file that needs one under a name outside the convention makes that subset a misnomer:
 * the run stays green, its arms self-skip or hard-fail depending on the machine, and a count taken
 * from it is wrong in a way nobody can see. That happened, which is why this exists.
 *
 * THE SIGNAL IS A DEMAND-GUARD, and finding it took four wrong detectors first. Matching database
 * CALLS caught a regex literal, a comment beside a mocked module, a dummy handle that never connects,
 * and two occurrences inside fixture STRINGS. Matching `process.env.DATABASE_URL` caught ten files —
 * a test asserting how the variable's ABSENCE is reported reads it and needs no database. Running the
 * excluded subset and requiring it clean failed its own accept control, because a misnamed file can
 * pass without a database rather than failing or skipping.
 *
 * What works is neither reading nor running: REFUSING TO RUN without the variable, reached either
 * directly in the test file or transitively through a test-support module that carries the guard.
 *
 * The signal is a DEMAND-GUARD: code that REFUSES TO RUN when DATABASE_URL is absent. Reading the
 * variable is not the signal (a test asserting how its ABSENCE is reported reads it and needs no
 * database); refusing to run without it is.
 *
 * A demand-guard is reached either
 *   (a) directly, in the test file itself, or
 *   (b) transitively, through a test-support module that carries one — `createHarness` in
 *       api-auth's test-support/harness.ts is the canonical example.
 *
 * Fail-closed: a scan that reads zero test files, or that resolves zero demand-guard modules,
 * exits 2 rather than reporting a green.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEMAND = [
  /DATABASE_URL[^\n'"`]{0,60}\brequired\b/i,
  /\brequired env var DATABASE_URL\b/i,
  /RAYSPEC_REQUIRE_DB_TESTS/,
];
const READS_URL = /process\.env\.DATABASE_URL/;

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
process.exit(direct.length + viaHelper.length === 0 ? 0 : 1);
