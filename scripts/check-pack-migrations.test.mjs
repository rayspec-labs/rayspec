#!/usr/bin/env node
/**
 * Regression test for the pack-migration chain gate (`scripts/check-pack-migrations.mjs`).
 *
 * The gate binds every table and index a pack migration chain creates to the pack's declared table
 * prefix, and holds the chain to additive-only statements with NO allowlist. Both halves are worth
 * nothing unless something can make them go red, so this drives the REAL gate against throwaway
 * chains and pins the arms that matter:
 *
 *   (C) a conforming chain PASSES, and the pass line reports how much it read — including the
 *       comment and the string literal that NAME an unprefixed table without being statements, so
 *       the comment strip and the literal-awareness are proven on the accepting side too.
 *   (V) a planted unprefixed CREATE TABLE FAILS, and a planted unprefixed CREATE UNIQUE INDEX
 *       FAILS. Two accept controls, not one: a scan that only reads table names would still pass
 *       the second, and the index half is exactly the one a generator gets wrong.
 *   (D) a destructive statement FAILS. A pack chain has no allowlist and no way to author one, so
 *       there is no second arm here — the failure is the whole behaviour.
 *   (G) a chain directory that reads nothing — empty, or absent altogether — FAILS CLOSED rather
 *       than reporting a vacuous pass over zero files.
 *
 * The gate takes the chain directory and the required prefix as arguments, so a throwaway chain is
 * just a directory of `.sql` files; nothing about this checkout is touched.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GATE = join(SCRIPTS_DIR, 'check-pack-migrations.mjs');

/** The prefix every throwaway chain below declares. */
const PREFIX = 'fx_';

/** Run the gate against one chain directory + required prefix; capture exit code + streams. */
function runGate(dir, prefix) {
  try {
    const stdout = execFileSync('node', [GATE, dir, prefix], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

const created = [];
/** Write a throwaway chain directory from `{ filename: sql }` and return its path. */
function chain(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-pack-migrations-'));
  created.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

/**
 * A conforming chain: every created object carries `fx_`, every statement is additive. It also
 * carries the two shapes a naive text match gets wrong — a `--` comment and a string literal that
 * each name an unprefixed table — so the accepting side proves the strip and the literal-awareness.
 */
const CONFORMING = [
  '-- The chain the pack owns. Nothing here creates a bare `orgs` table.',
  'CREATE TABLE "fx_ledger" (',
  '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
  '\t"tenant_id" uuid NOT NULL,',
  '\t"kind" text DEFAULT \'CREATE TABLE orgs\' NOT NULL,',
  '\t"recorded_at" timestamp with time zone DEFAULT now() NOT NULL',
  ');',
  '--> statement-breakpoint',
  'ALTER TABLE "fx_ledger" ADD CONSTRAINT "fx_ledger_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;',
  '--> statement-breakpoint',
  'CREATE INDEX "fx_ledger_tenant_idx" ON "fx_ledger" USING btree ("tenant_id");',
  '--> statement-breakpoint',
  'CREATE UNIQUE INDEX "fx_ledger_kind_unique" ON "fx_ledger" USING btree ("tenant_id", "kind");',
  '',
].join('\n');

try {
  // ── (C) a conforming chain passes, and says how much it read ─────────────────────────────────
  {
    const dir = chain({ '0000_ledger.sql': CONFORMING });
    const r = runGate(dir, PREFIX);
    assert.equal(r.code, 0, `(C) a conforming chain must PASS; got ${r.code}: ${r.err}`);
    assert.match(r.out, /PASSED/, '(C) a clean scan must report PASSED');
    assert.match(r.out, /1 migration file\(s\)/, '(C) the pass line must report the files it read');
    assert.match(r.out, /4 statement\(s\)/, '(C) the pass line must report the statements it read');
    console.log('ok (C) — a conforming chain passes and reports what it read');
  }

  // ── (V) an unprefixed TABLE fails ────────────────────────────────────────────────────────────
  {
    const dir = chain({
      '0000_ledger.sql': CONFORMING,
      '0001_stray.sql': 'CREATE TABLE "audit_events" ("id" uuid PRIMARY KEY NOT NULL);\n',
    });
    const r = runGate(dir, PREFIX);
    assert.notEqual(r.code, 0, '(V/table) an unprefixed CREATE TABLE must FAIL');
    assert.match(r.err, /audit_events/, '(V/table) the offending table must be named');
    assert.match(r.err, /fx_/, '(V/table) the required prefix must be named');
    console.log(`ok (V/table) — an unprefixed table is detected (exit ${r.code})`);
  }

  // ── (V) an unprefixed INDEX fails — the second accept control ────────────────────────────────
  {
    const dir = chain({
      '0000_ledger.sql': CONFORMING,
      '0001_stray.sql':
        'CREATE UNIQUE INDEX "ledger_kind_unique" ON "fx_ledger" USING btree ("kind");\n',
    });
    const r = runGate(dir, PREFIX);
    assert.notEqual(r.code, 0, '(V/index) an unprefixed CREATE UNIQUE INDEX must FAIL');
    assert.match(r.err, /ledger_kind_unique/, '(V/index) the offending index must be named');
    console.log(`ok (V/index) — an unprefixed index is detected (exit ${r.code})`);
  }

  // ── (D) a destructive statement fails — there is no allowlist to clear it ────────────────────
  {
    const dir = chain({
      '0000_ledger.sql': CONFORMING,
      '0001_drop.sql': 'DROP TABLE "fx_ledger";\n',
    });
    const r = runGate(dir, PREFIX);
    assert.notEqual(r.code, 0, '(D) a destructive statement must FAIL');
    assert.match(r.err, /destructive/i, '(D) the failure must say the statement is destructive');
    console.log(`ok (D) — a destructive statement is refused (exit ${r.code})`);
  }

  // ── (G) a chain that reads nothing fails CLOSED ──────────────────────────────────────────────
  {
    const empty = chain({});
    const r = runGate(empty, PREFIX);
    assert.notEqual(r.code, 0, '(G/empty) a chain with no migration files must fail CLOSED');
    assert.match(r.err, /0 migration file\(s\)/, '(G/empty) the fail-closed reason must be named');
    assert.ok(r.err.includes(empty), `(G/empty) the unscanned chain must be named; got: ${r.err}`);
    console.log(`ok (G/empty) — an empty chain fails closed (exit ${r.code})`);

    const absent = join(empty, 'not-here');
    const r2 = runGate(absent, PREFIX);
    assert.notEqual(r2.code, 0, '(G/absent) a chain directory that is not there must fail CLOSED');
    assert.match(
      r2.err,
      /0 migration file\(s\)/,
      '(G/absent) the fail-closed reason must be named',
    );
    assert.ok(
      r2.err.includes(absent),
      `(G/absent) the missing chain must be named; got: ${r2.err}`,
    );
    console.log(`ok (G/absent) — an absent chain fails closed (exit ${r2.code})`);
  }

  console.log('\npack-migrations gate regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
