/**
 * THE PACK-MIGRATION SCAN'S STATEMENT BOUNDARIES — where this module decides one statement ends and
 * the next begins, which every rule it applies is anchored on.
 *
 * The namespace and additive-form rules were already covered through `scripts/check-pack-migrations.
 * test.mjs`; the SPLITTER underneath them was not covered directly anywhere, and it is the part every
 * other decision rests on: a boundary read wrongly means a rule was applied to text the migrator will
 * not run as one statement. `statements` is the observable — the count the scan reports — so each arm
 * below reads the split itself rather than a rule that happens to depend on it.
 *
 * ⚠ KNOWN DIVERGENCE FROM THE SERVER'S GRAMMAR, measured and NOT covered below because it is an open
 * defect rather than intended behaviour: this splitter reads as ONE statement several strings
 * PostgreSQL executes as TWO — a NESTED block comment (Postgres nests them; this scan closes at the
 * first terminator), an `E''` escape string (the server ends the literal at the backslash-quote), and
 * a non-ASCII dollar-quote tag (a legal tag the ASCII-only pattern cannot match). The pack database
 * door used to share this splitter and now lets the SERVER decide instead. The scan cannot do that —
 * it reads files without a connection — so the divergence is live here, and it is tracked as its own
 * finding rather than pinned green in this file.
 */
import { describe, expect, it } from 'vitest';
import { scanPackMigrationSql } from './pack-migration-scan.js';

/** Scan one chunk with a clean prefix, and report what it read. */
function read(sql: string): { statements: number; violations: string[] } {
  const r = scanPackMigrationSql('0001_x.sql', sql, 'fx_');
  return { statements: r.statements, violations: r.violations };
}

describe('the pack-migration statement splitter', () => {
  it('a `;` inside a string literal is not a boundary', () => {
    const r = read("CREATE TABLE fx_a (id int, c text DEFAULT 'a;b');");
    expect(r).toEqual({ statements: 1, violations: [] });
  });

  it('a doubled quote inside a literal does not end it', () => {
    const r = read("CREATE TABLE fx_a (id int, c text DEFAULT 'a''b;c');");
    expect(r).toEqual({ statements: 1, violations: [] });
  });

  it('a `;` inside a dollar-quoted body is not a boundary — tagged and untagged', () => {
    expect(read('CREATE TABLE fx_a (id int, c text DEFAULT $t$a;b$t$);')).toEqual({
      statements: 1,
      violations: [],
    });
    expect(read('CREATE TABLE fx_a (id int, c text DEFAULT $$a;b$$);')).toEqual({
      statements: 1,
      violations: [],
    });
  });

  it('a dollar-quoted body may hold a FOREIGN tag without ending', () => {
    const r = read('CREATE TABLE fx_a (id int, c text DEFAULT $o$a;$i$b$o$);');
    expect(r).toEqual({ statements: 1, violations: [] });
  });

  it('a dollar tag may carry digits after its first character', () => {
    const r = read('CREATE TABLE fx_a (id int, c text DEFAULT $t1$a;b$t1$);');
    expect(r).toEqual({ statements: 1, violations: [] });
  });

  it('a `;` inside a quoted identifier is not a boundary', () => {
    const r = read('CREATE TABLE "fx_a;b" (id int);');
    expect(r.statements).toBe(1);
  });

  it('a `;` inside a line comment and inside a block comment is not a boundary', () => {
    expect(read('CREATE TABLE fx_a (id int); -- ; not a statement\n')).toEqual({
      statements: 1,
      violations: [],
    });
    expect(read('CREATE TABLE fx_a (id int) /* ; not a statement */;')).toEqual({
      statements: 1,
      violations: [],
    });
  });

  it('a trailing `;`, trailing whitespace and a trailing comment add no statement', () => {
    for (const tail of [';', ';   \n  ', '; -- done', '; /* done */']) {
      expect(read(`CREATE TABLE fx_a (id int)${tail}`).statements).toBe(1);
    }
  });

  it('a top-level `;` IS a boundary, and each side is scanned on its own', () => {
    const r = read('CREATE TABLE fx_a (id int); CREATE TABLE fx_b (id int);');
    expect(r).toEqual({ statements: 2, violations: [] });
  });

  it('the drizzle breakpoint marker is a boundary even without a `;`', () => {
    const r = read(
      'CREATE TABLE fx_a (id int)\n--> statement-breakpoint\nCREATE TABLE fx_b (id int)',
    );
    expect(r).toEqual({ statements: 2, violations: [] });
  });

  it('a marker hidden behind a `--` is STILL a boundary — the migrator has no lexer', () => {
    // Cutting the raw text on the marker BEFORE stripping comments is the only order in which a
    // comment cannot swallow a statement the migrator would go on to run.
    const r = read('CREATE TABLE fx_a (id int); -- x --> statement-breakpoint DROP TABLE "orgs";');
    expect(r.statements).toBe(2);
    expect(r.violations.join('\n')).toMatch(/destructive statement/);
  });

  it('an UNTERMINATED literal is a violation, not a silent short read', () => {
    const r = read("CREATE TABLE fx_a (id int, c text DEFAULT 'oops);");
    expect(r.violations.join('\n')).toMatch(/UNTERMINATED string literal/);
  });

  it('an unterminated dollar-quoted body is one too, and names its tag', () => {
    const r = read('CREATE TABLE fx_a (id int, c text DEFAULT $t$oops);');
    expect(r.violations.join('\n')).toMatch(/UNTERMINATED dollar-quoted literal \$t\$/);
  });

  it('a newline-split statement reads as ONE, with its whitespace collapsed', () => {
    const r = read('CREATE\n  TABLE\n  fx_a (id int);');
    expect(r).toEqual({ statements: 1, violations: [] });
  });

  it('ACCEPT CONTROL — a chain of ordinary additive statements passes and is fully counted', () => {
    const r = read(
      'CREATE TABLE fx_a (id int);\nCREATE UNIQUE INDEX fx_a_ix ON fx_a (id);\n' +
        'ALTER TABLE fx_a ADD COLUMN c text;',
    );
    expect(r).toEqual({ statements: 3, violations: [] });
  });
});
