#!/usr/bin/env node
/**
 * Pack-migration chain gate — a pack's hand-written platform tables stay inside its own namespace.
 *
 * An extension pack contributes product tables through `stores`, which the platform generates and
 * owns. A pack that needs platform state instead — hand-shaped indexes, foreign keys, an
 * append-only ledger — brings its own migration chain, and that chain runs through the same
 * migrator as the platform's. Two chains writing into one database is only safe while each one
 * stays in its own namespace, so a pack declares a table prefix and the chain is held to it: EVERY
 * `CREATE TABLE` and EVERY `CREATE INDEX` / `CREATE UNIQUE INDEX` must NAME an object that carries
 * the prefix, and every `ALTER TABLE` and every `CREATE INDEX ... ON` must TARGET a table that
 * carries it. A chain that creates a bare `orgs`, or that alters one, is not a pack owning its own
 * tables — it is a pack reaching into the platform's.
 *
 * THE RULE SET LIVES IN `@rayspec/db` (`scanPackMigrationChain`), NOT HERE. It has two callers: this
 * gate, which reads the chains committed in this repository so a violation lands as a red check on
 * the pull request that introduced it, and `applyPackMigrations`, which reads every chain a
 * deployment is about to apply so a chain that never passed through this repository's CI still
 * cannot reach a database. A pack is code from somewhere else; a gate alone would only ever have
 * covered the packs we happen to ship. One module means the boot cannot end up holding packs to a
 * weaker set of rules than CI does — see its docblock for the namespace and additive-only rules,
 * for why a pack chain gets no allowlist, and for how statement boundaries are made a superset of
 * the migrator's.
 *
 * WHAT REMAINS HERE is the CI door: the declared set of chains, the fail-closed guard on an empty
 * scan, and the reporting.
 *
 * A ZERO-FILE OR ZERO-CHAIN SCAN IS A FAILURE. A declared chain whose directory is empty, renamed
 * or absent reads nothing, and so does an emptied `DECLARED_CHAINS`; either would otherwise report
 * a clean pass over a chain that was never scanned — the fail-open shape the chokepoint-family
 * gates closed with a scanned-count guard. The gate refuses on both, names what was not scanned,
 * and its pass line reports how many chains, files and statements it actually read.
 *
 * NEEDS THE BUILD: it imports the scan from `@rayspec/db`'s built output, so it runs after
 * `pnpm build` (as `gate:spec-schema` and `gate:api-report` already do). It needs no database.
 *
 * Usage:
 *   node scripts/check-pack-migrations.mjs                 # scan every DECLARED chain
 *   node scripts/check-pack-migrations.mjs <dir> <prefix>  # scan one chain (the regression's door)
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The pack-chain scan. Loading it is fail-closed on purpose: a gate that silently fell back to a
 * vocabulary of its own when the build was missing would be exactly the "lower bar than the core"
 * this gate exists to prevent.
 */
let scanPackMigrationChain;
try {
  ({ scanPackMigrationChain } = await import('@rayspec/db'));
} catch (cause) {
  console.error(
    'pack-migrations gate: could not load the pack-migration chain scan from ' +
      `@rayspec/db — ${cause.message}\n\nRun \`pnpm build\` first. The gate refuses rather than ` +
      'scanning a pack chain with a weaker rule set of its own.',
  );
  process.exit(2);
}

/**
 * The pack migration chains scanned in CI, each `{ dir, tablePrefix }`. The chain is a directory of
 * `.sql` files and the prefix is the namespace the pack claims — the same pair a pack manifest
 * declares. On the platform main line the only chain is the in-tree fixture pack's, which exists so
 * this gate scans real committed bytes rather than reporting a pass over an empty declared set.
 * EMPTYING THIS ARRAY DOES NOT RETIRE THE GATE — a zero-chain run fails closed (see below).
 */
const DECLARED_CHAINS = [
  { dir: 'packages/test/fixture-pack/migrations', tablePrefix: 'fixture_pack_' },
];

const argv = process.argv.slice(2);
if (argv.length !== 0 && argv.length !== 2) {
  console.error(
    'pack-migrations gate: usage — `check-pack-migrations.mjs` (every declared chain) or ' +
      '`check-pack-migrations.mjs <dir> <tablePrefix>` (one chain).',
  );
  process.exit(2);
}
const chains =
  argv.length === 2
    ? [{ dir: argv[0], tablePrefix: argv[1] }]
    : DECLARED_CHAINS.map((c) => ({ dir: join(repoRoot, c.dir), tablePrefix: c.tablePrefix }));

const violations = [];
let scannedFiles = 0;
let scannedStatements = 0;
for (const { dir, tablePrefix } of chains) {
  const result = scanPackMigrationChain(resolve(dir), tablePrefix, repoRoot);
  violations.push(...result.violations);
  scannedFiles += result.files;
  scannedStatements += result.statements;
}

// The AGGREGATE fail-closed guard (the shape `check-no-pack-imports.mjs` uses): the per-chain
// zero-file check inside the scan cannot see an empty DECLARED_CHAINS, so emptying that array would
// retire the gate with a clean pass while the committed chain rots. Refuse on an empty scan either way.
if (chains.length === 0 || scannedFiles === 0) {
  violations.push(
    `refusing to certify on an empty scan (fail-closed): ${chains.length} chain(s) and ` +
      `${scannedFiles} migration file(s) were read. ${
        chains.length === 0
          ? 'DECLARED_CHAINS is EMPTY — emptying the declared set does not retire this gate.'
          : 'A declared chain read nothing.'
      }`,
  );
}

if (violations.length > 0) {
  console.error('pack-migrations gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\nEvery table and index a pack migration chain creates must carry the pack's declared table " +
      'prefix, and the chain must survive the platform destructive scan with NO allowlist. A pack ' +
      'chain has no allowlist and no mechanism to author one: a closed pack does not get a lower ' +
      'bar than the core.',
  );
  process.exit(1);
}

console.log(
  `pack-migrations gate PASSED: ${chains.length} chain(s), ${scannedFiles} migration file(s), ` +
    `${scannedStatements} statement(s) — every created table and index carries its declared table ` +
    'prefix, and every statement is additive.',
);
