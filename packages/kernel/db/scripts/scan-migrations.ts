/**
 * Migration-gate CLI: scan every *.sql migration with the home-grown destructive scan + the
 * reviewed allowlist. Exits non-zero (blocks the deploy) if any destructive statement lacks an
 * allowlist entry. This is the GATE — NOT `atlas migrate lint` (Pro-gated). Diff/
 * shadow-DB dry-run come from community Atlas; the destructive POLICY is this scan.
 *
 * Scans the PLATFORM chain `drizzle/` AND the throwaway PRODUCT migration
 * `examples/acme-notes-backend/drizzle/` — so the scan→apply chain is closed for the product half too
 * (shadow-dryrun applies the product migration; this gate must have scanned it first). A real
 * deployment scans its OWN generated product migration the same way. Extra dirs can be passed as
 * argv (each `<label>=<path>` or a bare path).
 *
 * Run with: pnpm --filter @rayspec/db gate:migrations
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_ALLOWLIST } from '../src/migration-scan.allowlist.js';
import { formatFindings, scanMigrationSql } from '../src/migration-scan.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The directories scanned in CI: the platform chain + the throwaway product migration (MGI-1). */
const DEFAULT_DIRS = [
  join(here, '..', 'drizzle'),
  join(here, '..', '..', '..', '..', 'examples', 'acme-notes-backend', 'drizzle'),
];

function scanDir(dir: string): boolean {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    console.log(`destructive-scan: ${dir} — no directory, skipping.`);
    return false;
  }
  if (files.length === 0) {
    console.log(`destructive-scan: ${dir} — no migrations.`);
    return false;
  }
  let blocked = false;
  for (const file of files.sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const allow = MIGRATION_ALLOWLIST[basename(file)] ?? [];
    const result = scanMigrationSql(sql, allow);
    console.log(`\n== ${dir}/${file} ==`);
    console.log(formatFindings(result));
    if (!result.pass) {
      blocked = true;
      const unallowed = result.findings.filter((f) => !f.allowed);
      console.error(
        `BLOCKED: ${unallowed.length} destructive statement(s) without a reviewed allowlist entry.`,
      );
    }
  }
  return blocked;
}

function main(): void {
  const extra = process.argv.slice(2).map((a) => (a.includes('=') ? a.split('=')[1] : a));
  const dirs = [...DEFAULT_DIRS, ...extra].filter((d): d is string => !!d);
  let blocked = false;
  let scannedAny = false;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      console.log(`destructive-scan: ${dir} — no directory, skipping.`);
      continue;
    }
    scannedAny = true;
    if (scanDir(dir)) blocked = true;
  }
  if (!scannedAny) {
    console.log('destructive-scan: no migration directories — nothing to scan.');
    return;
  }
  if (blocked) {
    console.error('\ndestructive-scan: GATE FAILED — add reviewed allowlist entries or revise.');
    process.exit(1);
  }
  console.log('\ndestructive-scan: GATE PASSED — all destructive statements are allowlisted.');
}

main();
