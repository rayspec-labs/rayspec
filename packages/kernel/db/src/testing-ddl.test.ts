/**
 * Meta + fail-the-fix tests for the injected-column test-DDL emitters.
 *
 * Extends the `INJECTED_COLUMN_NAMES === RESERVED_COLUMN_NAMES` discipline (generate-product-schema.test):
 * the DB-backed tests that hand-build product tables in isolated schemas interpolate
 * `injectedColumnLinesSql()` so a NEW injected column can never silently drift them. These prove the
 * emitter derives EXACTLY the canonical injected column set (so the interpolation is complete + in the
 * fixed order) and that `parseCreateTableColumnNames` — the drift-guard's parser — has teeth.
 */
import { describe, expect, it } from 'vitest';
import { INJECTED_COLUMN_NAMES } from './generated/injected-columns.js';
import { injectedColumnLinesSql, parseCreateTableColumnNames } from './testing-ddl.js';

describe('injectedColumnLinesSql', () => {
  it('emits column lines for EXACTLY the canonical injected columns (before ∪ after, in order)', () => {
    const { before, after } = injectedColumnLinesSql({
      tenantFkRef: 'REFERENCES orgs(id) ON DELETE CASCADE',
    });
    // Drop the emitted lines into a throwaway CREATE TABLE and read back the column names.
    const cols = parseCreateTableColumnNames(`CREATE TABLE t (${before}, ${after})`, 't');
    expect(cols).toEqual([...INJECTED_COLUMN_NAMES]);
  });

  it('places id + tenant_id BEFORE and the GDPR columns AFTER (fixed schema order)', () => {
    const { before, after } = injectedColumnLinesSql();
    expect(parseCreateTableColumnNames(`CREATE TABLE t (${before})`, 't')).toEqual([
      'id',
      'tenant_id',
    ]);
    expect(parseCreateTableColumnNames(`CREATE TABLE t (${after})`, 't')).toEqual([
      'created_at',
      'deleted_at',
      'retention_days',
      'region',
      'created_by',
      'idempotency_key',
    ]);
  });

  it('appends the tenant FK ref to the tenant_id line ONLY, and only when given', () => {
    expect(injectedColumnLinesSql().before).not.toContain('REFERENCES');
    const withFk = injectedColumnLinesSql({ tenantFkRef: 'REFERENCES orgs(id) ON DELETE CASCADE' });
    expect(withFk.before).toContain(
      '"tenant_id" uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE',
    );
    // The id line is untouched by the FK ref.
    expect(withFk.before).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL');
  });
});

describe('parseCreateTableColumnNames (drift-guard parser has teeth)', () => {
  it('skips table-level constraints and keeps a composite UNIQUE as one item', () => {
    const sql = `CREATE TABLE x (
      "id" uuid PRIMARY KEY,
      a text NOT NULL,
      b text,
      CONSTRAINT x_ab_unique UNIQUE (a, b)
    )`;
    expect(parseCreateTableColumnNames(sql, 'x')).toEqual(['id', 'a', 'b']);
  });

  it('ignores a -- comment (even one carrying commas) inside the column region', () => {
    const sql = `CREATE TABLE z (
      "id" uuid PRIMARY KEY,
      a text NOT NULL,
      -- a comment, with a comma, so it must be stripped before the split
      b text,
      CONSTRAINT z_ab UNIQUE (a, b)
    )`;
    expect(parseCreateTableColumnNames(sql, 'z')).toEqual(['id', 'a', 'b']);
  });

  it('resolves an IF NOT EXISTS + schema-qualified table name', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS myschema.y ( "id" uuid PRIMARY KEY, note text NOT NULL )';
    expect(parseCreateTableColumnNames(sql, 'y')).toEqual(['id', 'note']);
  });

  it('throws when the table is absent (never a silent empty match)', () => {
    expect(() => parseCreateTableColumnNames('CREATE TABLE a (id uuid)', 'zzz')).toThrow(
      /not found/,
    );
  });
});
