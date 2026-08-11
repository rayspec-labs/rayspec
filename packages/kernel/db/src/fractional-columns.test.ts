/**
 * The FRACTIONAL column types (`double` → float8, `numeric(precision, scale)` → exact decimal)
 * through the generator twins, the delta-diff, and drift detection — all pure (no DB).
 *
 *   1. SQL generator — a `double` column emits `double precision`; a `numeric` column carries its
 *      declared parameters verbatim (`numeric(24, 6)`), drizzle's spelling.
 *   2. TS generator + runtime twin — the emitted builder strings and the runtime `PgTable` agree
 *      (the same byte-identity discipline the bigint mode pin established).
 *   3. DIFF — a precision/scale change on a SURVIVING numeric column is a REAL schema change: it
 *      emits `ALTER … SET DATA TYPE numeric(<new p>, <new s>)`, classified DESTRUCTIVE through the
 *      real scanMigrationSql (the integer→bigint `SET DATA TYPE` behaviour is the precedent).
 *   4. DRIFT — a live numeric column with the WRONG parameters is drift, not a pass
 *      (information_schema reports `numeric` for every (p, s), so the type name alone proves nothing).
 *   5. Defense-in-depth — a code-built spec (bypassing parseSpec) with a parameterless numeric
 *      column is a HARD generator error, never `numeric(undefined, undefined)` in DDL.
 */
import { StoreSpec } from '@rayspec/spec';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { diffProductStores } from './diff-product-stores.js';
import { buildProductTables } from './generated/build-product-tables.js';
import { detectDrift } from './generated/drift-detect.js';
import { generateProductSchema } from './generated/generate-product-schema.js';
import { generateProductSql } from './generated/generate-product-sql.js';
import { scanMigrationSql } from './migration-scan.js';

/** Parse a raw store object through the REAL Zod grammar so defaults apply. */
function store(raw: unknown): StoreSpec {
  return StoreSpec.parse(raw);
}

const FRACTIONAL = [
  store({
    name: 'measurements',
    columns: [
      { name: 'confidence', type: 'double' },
      { name: 'amount', type: 'numeric', precision: 24, scale: 6 },
      { name: 'ratio', type: 'double', nullable: true },
    ],
  }),
];

describe('SQL generator — double / numeric DDL', () => {
  it('emits `double precision` and the parameterized `numeric(24, 6)` verbatim', () => {
    const sql = generateProductSql(FRACTIONAL);
    expect(sql).toContain('"confidence" double precision NOT NULL');
    expect(sql).toContain('"amount" numeric(24, 6) NOT NULL');
    expect(sql).toContain('"ratio" double precision'); // nullable — no NOT NULL
  });

  it('the CREATE-only output is purely additive (no destructive findings)', () => {
    const result = scanMigrationSql(generateProductSql(FRACTIONAL), []);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

describe('TS generator + runtime twin — byte-identical builder discipline', () => {
  it('emits doublePrecision(...) and numeric(..., { precision, scale, mode }) builders', () => {
    const out = generateProductSchema(FRACTIONAL);
    expect(out).toContain("confidence: doublePrecision('confidence').notNull(),");
    expect(out).toContain(
      "amount: numeric('amount', { precision: 24, scale: 6, mode: 'string' }).notNull(),",
    );
    expect(out).toContain("ratio: doublePrecision('ratio'),");
  });

  it('META: the runtime twin agrees on the drizzle column classes AND the numeric parameters', () => {
    // Mirrors the bigint mode meta-pin: `getSQLType()` alone would be the vacuous assertion for the
    // mode (numeric's SQL type does carry (p, s), asserted too), `columnType` pins the string mode
    // — PgNumeric is the string-mode class; the number mode (PgNumericNumber) would map the exact
    // decimal through float64 INSIDE the ORM, upstream of every guard.
    const table = buildProductTables(FRACTIONAL).get('measurements');
    if (!table) throw new Error('no measurements table');
    const cols = getTableColumns(table) as Record<
      string,
      { columnType: string; getSQLType(): string; precision?: number; scale?: number }
    >;
    expect(cols.confidence?.columnType).toBe('PgDoublePrecision');
    expect(cols.confidence?.getSQLType()).toBe('double precision');
    expect(cols.amount?.columnType).toBe('PgNumeric');
    expect(cols.amount?.getSQLType()).toBe('numeric(24, 6)');
    expect(cols.amount?.precision).toBe(24);
    expect(cols.amount?.scale).toBe(6);
  });
});

describe('DIFF — a numeric precision/scale change is a real, gated schema change', () => {
  const oldStores = [
    store({
      name: 'ledger_lines',
      columns: [{ name: 'amount', type: 'numeric', precision: 12, scale: 2 }],
    }),
  ];
  const newStores = [
    store({
      name: 'ledger_lines',
      columns: [{ name: 'amount', type: 'numeric', precision: 14, scale: 2 }],
    }),
  ];

  it('numeric(12, 2) → numeric(14, 2) emits the ALTER … SET DATA TYPE statement', () => {
    const r = diffProductStores(oldStores, newStores);
    expect(r.statements).toEqual([
      'ALTER TABLE "ledger_lines" ALTER COLUMN "amount" SET DATA TYPE numeric(14, 2)',
    ]);
  });

  it('the ALTER is classified DESTRUCTIVE through the REAL scan and gated on a reviewed allowlist', () => {
    const r = diffProductStores(oldStores, newStores);
    expect(r.destructive).toBe(true);
    // BLOCKED with an empty allowlist; PASSES with the machine-proposed one (byte-fidelity).
    expect(scanMigrationSql(r.migrationSql, []).pass).toBe(false);
    expect(scanMigrationSql(r.migrationSql, r.proposedAllowlist).pass).toBe(true);
  });

  it('a SCALE change is seen too, and the note names the rounding hazard', () => {
    const narrowed = [
      store({
        name: 'ledger_lines',
        columns: [{ name: 'amount', type: 'numeric', precision: 12, scale: 1 }],
      }),
    ];
    const r = diffProductStores(oldStores, narrowed);
    expect(r.statements).toEqual([
      'ALTER TABLE "ledger_lines" ALTER COLUMN "amount" SET DATA TYPE numeric(12, 1)',
    ]);
    expect(r.notes.some((n) => /round/i.test(n))).toBe(true);
  });

  it('NO-OP invariant: identical numeric parameters produce an EMPTY diff', () => {
    const r = diffProductStores(oldStores, oldStores);
    expect(r.statements).toEqual([]);
    expect(r.migrationSql).toBe('');
  });
});

describe('DRIFT — wrong live numeric parameters are drift, not a pass', () => {
  /** A stub introspection: one live `ledger_lines.amount` column with the given numeric params. */
  function stubQuery(livePrecision: number | null, liveScale: number | null) {
    return async (sql: string): Promise<Record<string, unknown>[]> => {
      if (sql.includes('information_schema.columns')) {
        const inject = (name: string, dataType: string, nullable: string) => ({
          table_name: 'ledger_lines',
          column_name: name,
          data_type: dataType,
          is_nullable: nullable,
          numeric_precision: null,
          numeric_scale: null,
        });
        return [
          {
            table_name: 'ledger_lines',
            column_name: 'amount',
            data_type: 'numeric',
            is_nullable: 'NO',
            numeric_precision: livePrecision,
            numeric_scale: liveScale,
          },
          inject('id', 'uuid', 'NO'),
          inject('tenant_id', 'uuid', 'NO'),
          inject('created_at', 'timestamp with time zone', 'NO'),
          inject('deleted_at', 'timestamp with time zone', 'YES'),
          inject('retention_days', 'integer', 'YES'),
          inject('region', 'text', 'NO'),
          inject('created_by', 'text', 'YES'),
          inject('idempotency_key', 'text', 'YES'),
        ];
      }
      if (sql.includes("constraint_type = 'FOREIGN KEY'")) {
        return [
          {
            table_name: 'ledger_lines',
            column_name: 'tenant_id',
            foreign_table_name: 'orgs',
            delete_rule: 'CASCADE',
          },
        ];
      }
      return []; // unique-index introspection — no unique columns declared
    };
  }

  const stores = [
    store({
      name: 'ledger_lines',
      columns: [{ name: 'amount', type: 'numeric', precision: 12, scale: 2 }],
    }),
  ];

  it('matching parameters → NO drift', async () => {
    expect(await detectDrift(stores, 'public', stubQuery(12, 2))).toEqual([]);
  });

  it('a live column with the WRONG precision/scale is column_type drift', async () => {
    const f = await detectDrift(stores, 'public', stubQuery(14, 2));
    expect(f.some((x) => x.kind === 'column_type' && x.column === 'amount')).toBe(true);
  });

  it('a live UNCONSTRAINED numeric (no typmod) is drift too', async () => {
    const f = await detectDrift(stores, 'public', stubQuery(null, null));
    expect(f.some((x) => x.kind === 'column_type' && x.column === 'amount')).toBe(true);
  });
});

describe('defense-in-depth — a parameterless numeric column from a code-built spec throws', () => {
  // Bypasses parseSpec on purpose (the generators may run on a code-built spec) — the guard must
  // refuse rather than interpolate `numeric(undefined, undefined)` into DDL / committed TS.
  const bare = [
    {
      name: 'ledger_lines',
      columns: [{ name: 'amount', type: 'numeric' as const, nullable: false, unique: false }],
      foreignKeys: [],
    },
  ];

  it('generateProductSql throws', () => {
    expect(() => generateProductSql(bare)).toThrow(/precision|scale/);
  });

  it('generateProductSchema throws', () => {
    expect(() => generateProductSchema(bare)).toThrow(/precision|scale/);
  });

  it('buildProductTables throws (the runtime twin refuses an unconstrained numeric)', () => {
    expect(() => buildProductTables(bare)).toThrow(/precision|scale/);
  });

  it('diffProductStores throws on either side', () => {
    const fine = [
      {
        name: 'ledger_lines',
        columns: [
          {
            name: 'amount',
            type: 'numeric' as const,
            nullable: false,
            unique: false,
            precision: 12,
            scale: 2,
          },
        ],
        foreignKeys: [],
      },
    ];
    expect(() => diffProductStores(bare, fine)).toThrow(/precision|scale/);
    expect(() => diffProductStores(fine, bare)).toThrow(/precision|scale/);
  });
});
