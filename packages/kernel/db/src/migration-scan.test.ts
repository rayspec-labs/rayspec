/**
 * Destructive-migration scan — the migration GATE (NOT atlas migrate lint, which is
 * Pro-gated). Proves the hardened scan FLAGS the patterns the earlier bash regex
 * was never built against — bare TRUNCATE + a column-type-change USING-cast — and that THIS
 * exact identity migration is blocked without, and passes only with, explicit allowlist
 * entries. Also re-checks the earlier-known bypasses are now caught.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATION_ALLOWLIST } from './migration-scan.allowlist.js';
import { scanMigrationSql } from './migration-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const MIGRATION = '0000_identity_and_run_retrofit.sql';
const migrationSql = readFileSync(join(drizzleDir, MIGRATION), 'utf8');

describe('scan flags the patterns the earlier regex missed', () => {
  it('flags a bare TRUNCATE', () => {
    const r = scanMigrationSql('TRUNCATE TABLE foo;');
    expect(r.findings.some((f) => f.kind === 'truncate')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('flags a column-type-change USING-cast', () => {
    const r = scanMigrationSql('ALTER TABLE foo ALTER COLUMN bar TYPE uuid USING bar::uuid;');
    expect(r.findings.some((f) => f.kind === 'using-cast')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('flags a newline-split DROP\\nCOLUMN (whitespace-tolerant)', () => {
    const r = scanMigrationSql('ALTER TABLE foo DROP\n  COLUMN bar;');
    expect(r.findings.some((f) => f.kind === 'drop-column')).toBe(true);
  });

  it('flags the previously-known bypasses: DROP SCHEMA CASCADE, DELETE FROM, RENAME TO, DROP CONSTRAINT/INDEX', () => {
    expect(scanMigrationSql('DROP SCHEMA public CASCADE;').pass).toBe(false);
    expect(scanMigrationSql('DELETE FROM users;').pass).toBe(false);
    expect(scanMigrationSql('ALTER TABLE a RENAME TO b;').pass).toBe(false);
    expect(scanMigrationSql('ALTER TABLE a DROP CONSTRAINT c;').pass).toBe(false);
    expect(scanMigrationSql('DROP INDEX idx;').pass).toBe(false);
  });

  it('does NOT flag a benign non-destructive migration', () => {
    const r = scanMigrationSql('CREATE TABLE foo (id uuid PRIMARY KEY);\nADD COLUMN bar text;');
    expect(r.findings).toHaveLength(0);
    expect(r.pass).toBe(true);
  });
});

describe('the identity migration requires an explicit allowlist (no silent pass)', () => {
  it('is BLOCKED with no allowlist (TRUNCATE + USING-casts + DROP INDEX flagged)', () => {
    const r = scanMigrationSql(migrationSql, []);
    expect(r.pass).toBe(false);
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds.has('truncate')).toBe(true);
    expect(kinds.has('using-cast')).toBe(true);
    // GATES-1: the title claims DROP INDEX is flagged — assert it (the retrofit drops the old
    // (run_id, idempotency_key) journal_idem_idx before re-keying it on tenant).
    expect(kinds.has('drop-index')).toBe(true);
    // exactly the three tenant_id casts.
    expect(r.findings.filter((f) => f.kind === 'using-cast')).toHaveLength(3);
  });

  it('PASSES only with the reviewed allowlist entries applied', () => {
    const allow = MIGRATION_ALLOWLIST[MIGRATION] ?? [];
    const r = scanMigrationSql(migrationSql, allow);
    expect(r.pass).toBe(true);
    // every destructive finding is cleared by an entry that carries a reason.
    expect(r.findings.every((f) => f.allowed)).toBe(true);
    expect(allow.every((e) => e.reason.length > 0)).toBe(true);
  });

  it('removing the TRUNCATE allowlist entry re-blocks the migration', () => {
    const allow = (MIGRATION_ALLOWLIST[MIGRATION] ?? []).filter((e) => e.kind !== 'truncate');
    const r = scanMigrationSql(migrationSql, allow);
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.kind === 'truncate' && !f.allowed)).toBe(true);
  });
});

describe('comment-strip is literal-aware (literal-stripping guard regression)', () => {
  it('a `--` inside a single-quoted literal does NOT hide a following DROP TABLE', () => {
    // The naive per-line `--.*$` strip truncated the line at `--123` and dropped the next
    // statement; here the DROP TABLE that follows the literal MUST still be flagged.
    const r = scanMigrationSql("UPDATE config SET note = 'see ticket --123'; DROP TABLE orgs;");
    expect(r.findings.some((f) => f.kind === 'drop-table')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('a `--` inside a literal does NOT hide a following TRUNCATE', () => {
    const r = scanMigrationSql("INSERT INTO log VALUES ('x -- y'); TRUNCATE TABLE orgs;");
    expect(r.findings.some((f) => f.kind === 'truncate')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('still strips a GENUINE trailing `--` line comment (no false positive)', () => {
    // The DROP TABLE here is genuinely commented out and must NOT be flagged.
    const r = scanMigrationSql('CREATE TABLE foo (id uuid); -- DROP TABLE foo;');
    expect(r.findings).toHaveLength(0);
    expect(r.pass).toBe(true);
  });

  it('a `--` inside a dollar-quoted body ($$...$$) is not a comment', () => {
    const r = scanMigrationSql(
      "CREATE FUNCTION f() RETURNS void AS $$ SELECT 'a -- b'; $$ LANGUAGE sql; DROP TABLE orgs;",
    );
    expect(r.findings.some((f) => f.kind === 'drop-table')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('an escaped doubled-quote inside a literal does not end the string early', () => {
    // The '' is an escaped apostrophe; the `;` and DROP are still inside the literal until the
    // real closing quote, after which the trailing DROP TABLE must be flagged.
    const r = scanMigrationSql("INSERT INTO t VALUES ('it''s a; trap -- x'); DROP TABLE orgs;");
    const dropFindings = r.findings.filter((f) => f.kind === 'drop-table');
    // exactly one DROP TABLE (the real one after the literal), not a phantom from inside it.
    expect(dropFindings).toHaveLength(1);
    expect(r.pass).toBe(false);
  });

  it('a `;` inside a literal does not split the statement prematurely', () => {
    // No destructive content; just proves the literal `;` is not a terminator (single benign stmt).
    const r = scanMigrationSql("INSERT INTO t VALUES ('a; b; c');");
    expect(r.findings).toHaveLength(0);
    expect(r.pass).toBe(true);
  });
});

describe('high-blast detectors an earlier scan missed', () => {
  it('flags DROP DATABASE', () => {
    const r = scanMigrationSql('DROP DATABASE rayspec;');
    expect(r.findings.some((f) => f.kind === 'drop-database')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('flags DROP OWNED BY', () => {
    const r = scanMigrationSql('DROP OWNED BY app_user;');
    expect(r.findings.some((f) => f.kind === 'drop-owned')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('flags a plain DROP VIEW and a DROP MATERIALIZED VIEW', () => {
    expect(scanMigrationSql('DROP VIEW active_users;').pass).toBe(false);
    expect(
      scanMigrationSql('DROP VIEW active_users;').findings.some((f) => f.kind === 'drop-view'),
    ).toBe(true);
    const mv = scanMigrationSql('DROP MATERIALIZED VIEW mv_costs;');
    expect(mv.findings.some((f) => f.kind === 'drop-view')).toBe(true);
  });

  it('flags a mass UPDATE / DELETE with no WHERE', () => {
    const upd = scanMigrationSql('UPDATE users SET email = NULL;');
    expect(upd.findings.some((f) => f.kind === 'update-no-where')).toBe(true);
    const del = scanMigrationSql('DELETE FROM sessions;');
    expect(del.findings.some((f) => f.kind === 'delete-no-where')).toBe(true);
    expect(upd.pass).toBe(false);
    expect(del.pass).toBe(false);
  });

  it('does NOT flag an UPDATE/DELETE that carries a WHERE as a no-where mass mutation', () => {
    const upd = scanMigrationSql("UPDATE users SET email = NULL WHERE id = '1';");
    expect(upd.findings.some((f) => f.kind === 'update-no-where')).toBe(false);
    // A DELETE ... WHERE is still flagged as delete-from (row removal needs review), but NOT as
    // the higher-blast delete-no-where form.
    const del = scanMigrationSql("DELETE FROM sessions WHERE user_id = '1';");
    expect(del.findings.some((f) => f.kind === 'delete-no-where')).toBe(false);
    expect(del.findings.some((f) => f.kind === 'delete-from')).toBe(true);
  });

  it('flags RENAME COLUMN', () => {
    const r = scanMigrationSql('ALTER TABLE users RENAME COLUMN email TO email_addr;');
    expect(r.findings.some((f) => f.kind === 'rename-column')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('flags a column type change with NO USING clause', () => {
    const r = scanMigrationSql('ALTER TABLE t ALTER COLUMN c TYPE integer;');
    expect(r.findings.some((f) => f.kind === 'type-change-no-using')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('a type change WITH USING is using-cast, NOT type-change-no-using', () => {
    const r = scanMigrationSql('ALTER TABLE t ALTER COLUMN c TYPE uuid USING c::uuid;');
    expect(r.findings.some((f) => f.kind === 'using-cast')).toBe(true);
    expect(r.findings.some((f) => f.kind === 'type-change-no-using')).toBe(false);
  });
});

describe('C5: EVERY committed migration passes the scan with its reviewed allowlist (per-migration)', () => {
  // The gate CLI already scans all migrations; this gives each one PER-MIGRATION unit coverage so a
  // future migration that is destructive without a reviewed allowlist entry fails HERE too (and a
  // currently-clean one — e.g. 0004_run_events — has an explicit clean-status assertion).
  const migrations = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('finds the committed migration set (sanity: not an empty glob)', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    expect(migrations).toContain('0004_run_events.sql');
  });

  for (const file of migrations) {
    it(`${file} PASSES with its reviewed allowlist`, () => {
      const sql = readFileSync(join(drizzleDir, file), 'utf8');
      const allow = MIGRATION_ALLOWLIST[file] ?? [];
      const r = scanMigrationSql(sql, allow);
      expect(r.pass).toBe(true);
      // Every destructive finding (if any) is cleared by a reviewed allowlist entry, never a silent pass.
      expect(r.findings.every((f) => f.allowed)).toBe(true);
    });
  }

  it('0004_run_events.sql is CLEAN (no destructive statements at all — additive table)', () => {
    const sql = readFileSync(join(drizzleDir, '0004_run_events.sql'), 'utf8');
    const r = scanMigrationSql(sql, []);
    expect(r.findings).toHaveLength(0);
    expect(r.pass).toBe(true);
  });
});

describe('exact-equality rule: allowlist match is anchored to the FULL statement', () => {
  it('an allowlist match that is only a SUBSTRING of the statement does NOT clear it', () => {
    const sql = 'TRUNCATE TABLE "users", "secrets";';
    // A reviewer-supplied substring (a different, narrower TRUNCATE) must not clear this one.
    const r = scanMigrationSql(sql, [
      { kind: 'truncate', match: 'TRUNCATE TABLE "users"', reason: 'substring only' },
    ]);
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.kind === 'truncate' && !f.allowed)).toBe(true);
  });

  it('a full-statement match clears it (trailing `;` optional)', () => {
    const sql = 'TRUNCATE TABLE "users", "secrets";';
    const withSemi = scanMigrationSql(sql, [
      { kind: 'truncate', match: 'TRUNCATE TABLE "users", "secrets";', reason: 'reviewed' },
    ]);
    expect(withSemi.pass).toBe(true);
    const noSemi = scanMigrationSql(sql, [
      { kind: 'truncate', match: 'TRUNCATE TABLE "users", "secrets"', reason: 'reviewed' },
    ]);
    expect(noSemi.pass).toBe(true);
  });

  it('an entry cannot clear a DIFFERENT statement that contains the same characters', () => {
    // Two TRUNCATEs; the allowlist clears only the first. The second (a superset) stays blocked.
    const sql = 'TRUNCATE TABLE "a"; TRUNCATE TABLE "a", "b";';
    const r = scanMigrationSql(sql, [
      { kind: 'truncate', match: 'TRUNCATE TABLE "a";', reason: 'only the first' },
    ]);
    const truncs = r.findings.filter((f) => f.kind === 'truncate');
    expect(truncs).toHaveLength(2);
    expect(truncs.filter((f) => f.allowed)).toHaveLength(1);
    expect(r.pass).toBe(false);
  });
});

describe('destructive keyword INSIDE a string literal is NOT flagged', () => {
  it("an INSERT with a value of 'DROP TABLE x' is clean (no false positive)", () => {
    const sql = `INSERT INTO audit (note) VALUES ('DROP TABLE secrets');`;
    const r = scanMigrationSql(sql, []);
    expect(r.findings).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('a value mentioning TRUNCATE/DELETE FROM is clean', () => {
    const sql = `INSERT INTO log (msg) VALUES ('we will TRUNCATE TABLE t and DELETE FROM u WHERE x');`;
    expect(scanMigrationSql(sql, []).findings).toEqual([]);
  });

  it('but a REAL DROP TABLE outside a literal IS still flagged', () => {
    const sql = `INSERT INTO log (msg) VALUES ('safe'); DROP TABLE secrets;`;
    const r = scanMigrationSql(sql, []);
    expect(r.findings.some((f) => f.kind === 'drop-table')).toBe(true);
    expect(r.pass).toBe(false);
  });
});

describe('ADD COLUMN NOT NULL (no default) + SET NOT NULL detectors', () => {
  it('flags ADD COLUMN ... NOT NULL with NO default (breaks on a populated table)', () => {
    const sql = 'ALTER TABLE "meetings" ADD COLUMN "owner" text NOT NULL;';
    const r = scanMigrationSql(sql, []);
    expect(r.findings.some((f) => f.kind === 'add-column-not-null-no-default')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('does NOT flag ADD COLUMN ... NOT NULL WITH a default (safe on a populated table)', () => {
    const sql = `ALTER TABLE "meetings" ADD COLUMN "owner" text NOT NULL DEFAULT 'x';`;
    const r = scanMigrationSql(sql, []);
    expect(r.findings.some((f) => f.kind === 'add-column-not-null-no-default')).toBe(false);
  });

  it('does NOT flag a plain nullable ADD COLUMN (purely additive, safe)', () => {
    const sql = 'ALTER TABLE "meetings" ADD COLUMN "owner" text;';
    expect(scanMigrationSql(sql, []).findings).toEqual([]);
  });

  it('flags SET NOT NULL on an existing column (fails if any row holds NULL)', () => {
    const sql = 'ALTER TABLE "meetings" ALTER COLUMN "location" SET NOT NULL;';
    const r = scanMigrationSql(sql, []);
    expect(r.findings.some((f) => f.kind === 'set-not-null')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('a reviewed allowlist entry clears an ADD COLUMN NOT NULL (safe-on-empty, reviewed)', () => {
    const sql = 'ALTER TABLE "meetings" ADD COLUMN "owner" text NOT NULL;';
    const r = scanMigrationSql(sql, [
      {
        kind: 'add-column-not-null-no-default',
        match: sql,
        reason: 'reviewed: table is empty at deploy time',
      },
    ]);
    expect(r.pass).toBe(true);
  });
});

describe('allowlist match is `;`-insensitive via a bounded terminator strip (no `\\s*;\\s*$` ReDoS)', () => {
  const STMT = 'TRUNCATE TABLE foo;';

  it('an allowlist match clears the statement regardless of its trailing `;`/whitespace', () => {
    for (const match of [
      'TRUNCATE TABLE foo', // no terminator
      'TRUNCATE TABLE foo;', // exact
      'TRUNCATE TABLE foo ;  ', // whitespace around the terminator + trailing space
      '  TRUNCATE TABLE foo  ', // surrounding whitespace, no terminator
    ]) {
      const r = scanMigrationSql(STMT, [{ kind: 'truncate', match, reason: 'reviewed' }]);
      expect(r.pass, match).toBe(true);
    }
  });

  it('a huge trailing-whitespace allowlist match does not hang the scan (bounded strip)', () => {
    // FAIL-THE-FIX: the allowlist `match` string is fed to `stripTerminator`; with the old anchored
    // `\s*;\s*$` a 200k-space no-`;` tail was quadratic. The match doesn't equal the statement, so the
    // finding stays (pass=false) — but the scan must return quickly.
    const pathological = `TRUNCATE TABLE bar${' '.repeat(200_000)}`;
    const start = Date.now();
    const r = scanMigrationSql(STMT, [{ kind: 'truncate', match: pathological, reason: 'x' }]);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.pass).toBe(false);
  });
});
