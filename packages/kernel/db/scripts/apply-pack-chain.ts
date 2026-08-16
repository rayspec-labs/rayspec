/**
 * Apply ONE extension pack's migration chain through the REAL wiring — the helper the from-clean-DB
 * gate drives its pack step with.
 *
 * It is deliberately a thin shell around `applyPackMigrations`: the namespace rules, the chain scan
 * and the per-pack `__migrations_<packId>` journal are the boot's, not a re-implementation for the
 * gate, so what the gate proves applies is what a deployment applies. Everything it asserts about
 * the RESULT — the pack's tables and indexes, its journal, and the platform journal being untouched
 * — the gate reads back with psql, in the same idiom as the rest of its assertions.
 *
 *   PACK_CHAIN_URL=postgres://…  tsx scripts/apply-pack-chain.ts <packId> <chainDir> <tablePrefix>
 *
 * `chainDir` is resolved relative to the CWD. Exits non-zero on any refusal, printing it, so the
 * calling gate's `set -e` stops there.
 */
import { resolve } from 'node:path';
import { applyPackMigrations, makeDb } from '../src/index.js';

const [packId, chainDir, tablePrefix] = process.argv.slice(2);
const url = process.env.PACK_CHAIN_URL;

if (!packId || !chainDir || !tablePrefix || !url) {
  console.error(
    'apply-pack-chain: usage — PACK_CHAIN_URL=<postgres url> tsx scripts/apply-pack-chain.ts ' +
      '<packId> <chainDir> <tablePrefix>',
  );
  process.exit(2);
}

const db = makeDb(url, 1);
try {
  const applied = await applyPackMigrations(db, [{ packId, dir: resolve(chainDir), tablePrefix }]);
  for (const chain of applied) {
    console.log(
      `  ok: pack '${chain.packId}' chain applied — ${chain.files} file(s), ` +
        `${chain.statements} statement(s), journaled in drizzle."${chain.journalTable}".`,
    );
  }
} catch (e) {
  console.error(`APPLY PACK CHAIN: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
