/**
 * The FRACTIONAL column types — `double` (float8) and `numeric(precision, scale)` (exact decimal).
 *
 * `double` is a plain vocabulary addition. `numeric` carries the two REQUIRED parameters the
 * generator interpolates into DDL (`numeric(12, 2)`), so the parse is FAIL-CLOSED around them:
 *   - BOTH `precision` and `scale` are required on a `numeric` column (there is no honest default);
 *   - each is an INTEGER inside the Postgres bounds (precision 1..1000 — the documented Postgres
 *     limit — scale 0..precision);
 *   - either field on any NON-numeric column is rejected (mirroring the enum-only-on-text rule).
 * The same rules bind on the product profile (its stores reuse the backend `StoreColumn`).
 */
import { describe, expect, it } from 'vitest';
import { StoreColumn } from './grammar.js';
import { parseSpec } from './parse.js';
import { parseProductSpec } from './product-parse.js';

/** A minimal backend spec around ONE store column list (so each case isolates one column defect). */
function specWith(columnsYaml: string): string {
  return `
version: '1.0'
metadata:
  name: fractional-fixture
stores:
  - name: readings
    columns:
${columnsYaml}
`;
}

describe('grammar — the double column type', () => {
  it('parses the author-facing form { name: confidence, type: double }', () => {
    const res = StoreColumn.safeParse({ name: 'confidence', type: 'double' });
    expect(res.success).toBe(true);
  });

  it('parses through the full pipeline (parseSpec)', () => {
    const res = parseSpec(specWith('      - { name: confidence, type: double }'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.stores[0]?.columns[0]?.type).toBe('double');
  });

  it('does not inject precision/scale on a double column (absent stays absent)', () => {
    const res = StoreColumn.safeParse({ name: 'confidence', type: 'double' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect('precision' in res.data).toBe(false);
      expect('scale' in res.data).toBe(false);
    }
  });
});

describe('grammar — the numeric column type (required precision/scale)', () => {
  it('parses the author-facing form { name: amount, type: numeric, precision: 12, scale: 2 }', () => {
    const res = parseSpec(
      specWith('      - { name: amount, type: numeric, precision: 12, scale: 2 }'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const col = res.value.stores[0]?.columns[0];
      expect(col?.type).toBe('numeric');
      expect(col?.precision).toBe(12);
      expect(col?.scale).toBe(2);
    }
  });

  it('accepts scale 0 (an exact integer-valued decimal) and scale === precision', () => {
    expect(
      parseSpec(specWith('      - { name: amount, type: numeric, precision: 10, scale: 0 }')).ok,
    ).toBe(true);
    expect(
      parseSpec(specWith('      - { name: amount, type: numeric, precision: 4, scale: 4 }')).ok,
    ).toBe(true);
  });

  it('REJECTS a numeric column missing precision and/or scale (both are required)', () => {
    for (const columns of [
      '      - { name: amount, type: numeric }',
      '      - { name: amount, type: numeric, precision: 12 }',
      '      - { name: amount, type: numeric, scale: 2 }',
    ]) {
      const res = parseSpec(specWith(columns));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'schema_violation')).toBe(true);
        expect(res.errors.some((e) => /precision|scale/.test(e.message))).toBe(true);
      }
    }
  });

  it('REJECTS scale > precision', () => {
    const res = parseSpec(
      specWith('      - { name: amount, type: numeric, precision: 4, scale: 5 }'),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('REJECTS non-integer / out-of-Postgres-bounds parameters', () => {
    for (const columns of [
      '      - { name: amount, type: numeric, precision: 12.5, scale: 2 }', // non-integer precision
      '      - { name: amount, type: numeric, precision: 12, scale: 2.5 }', // non-integer scale
      '      - { name: amount, type: numeric, precision: 0, scale: 0 }', // precision below 1
      '      - { name: amount, type: numeric, precision: 1001, scale: 2 }', // precision above 1000
      '      - { name: amount, type: numeric, precision: 12, scale: -1 }', // negative scale
    ]) {
      expect(parseSpec(specWith(columns)).ok).toBe(false);
    }
  });

  it('REJECTS precision/scale on any NON-numeric column (mirrors enum-only-on-text)', () => {
    for (const columns of [
      '      - { name: confidence, type: double, precision: 12, scale: 2 }',
      '      - { name: label, type: text, precision: 12 }',
      '      - { name: count, type: integer, scale: 2 }',
    ]) {
      const res = parseSpec(specWith(columns));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => /precision|scale/.test(e.message))).toBe(true);
      }
    }
  });
});

describe('product profile — the same rules bind (its stores reuse the backend StoreColumn)', () => {
  /** A minimal product doc around ONE store (key column separate, so the case isolates one defect). */
  function productWith(columnYaml: string): string {
    return `
version: '1.0'
product:
  id: tiny
  name: Tiny
stores:
  - name: ledger_lines
    columns:
      - { name: line_ref, type: text }
${columnYaml}
    key: [line_ref]
`;
  }

  it('accepts a valid numeric(12, 2) column and a double column', () => {
    const res = parseProductSpec(
      productWith(
        '      - { name: amount, type: numeric, precision: 12, scale: 2 }\n' +
          '      - { name: confidence, type: double }',
      ),
    );
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
  });

  it('REJECTS a numeric column missing its parameters', () => {
    const res = parseProductSpec(productWith('      - { name: amount, type: numeric }'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => /precision|scale/.test(e.message))).toBe(true);
  });

  it('REJECTS scale > precision', () => {
    const res = parseProductSpec(
      productWith('      - { name: amount, type: numeric, precision: 4, scale: 5 }'),
    );
    expect(res.ok).toBe(false);
  });

  it('REJECTS precision/scale on a non-numeric column', () => {
    const res = parseProductSpec(productWith('      - { name: label, type: text, precision: 3 }'));
    expect(res.ok).toBe(false);
  });
});
