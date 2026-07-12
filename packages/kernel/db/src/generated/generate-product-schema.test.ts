/**
 * Generator GOLDEN + meta tests (a field-flip MUST break the golden).
 *
 * The generator is the product-agnostic platform mechanism that materializes a validated
 * RaySpec `stores[]` into committed Drizzle-TS source. These tests prove:
 *   1. GOLDEN — a representative stores set (all 6 column types, nullable/unique, FK
 *      cascade/restrict/set null) produces a byte-stable golden module; a field-flip (a column
 *      type, a nullable, an FK onDelete) BREAKS the golden (fail-the-fix, not pass-the-shape).
 *   2. INJECTION — every generated table carries the 6 injected tenancy/GDPR columns in the fixed
 *      schema.ts order, and tenant_id references orgs ON DELETE CASCADE.
 *   3. NO CORE EMISSION — the generated source references `orgs` ONLY as the injected FK target and
 *      never re-declares a core table.
 *   4. META — `INJECTED_COLUMN_NAMES` agrees with `@rayspec/spec`'s `RESERVED_COLUMN_NAMES` (the
 *      injected names are exactly the names the spec lint rejects), and a reserved business column
 *      slipping past validation is a hard generator error (defense in depth).
 *   5. EMPTY BASELINE — `generateProductSchema([])` equals the committed product-EMPTY baseline
 *      byte-for-byte (the platform main line stays product-free + regenerable).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_COLUMN_NAMES, StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { generateProductSchema, INJECTED_COLUMN_NAMES } from './generate-product-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Parse a raw store object through the real Zod grammar so defaults (nullable/unique/onDelete). */
function store(raw: unknown): StoreSpec {
  return StoreSpec.parse(raw);
}

/**
 * A representative stores set: covers every ColumnType, nullable + non-nullable, unique, and all
 * three FK onDelete policies (cascade / restrict / set null on a nullable column). This is the
 * golden input — broad enough that a generator regression in any branch breaks the snapshot.
 */
const REPRESENTATIVE = [
  store({
    name: 'projects',
    columns: [
      { name: 'title', type: 'text' },
      { name: 'description', type: 'text', nullable: true },
      { name: 'slug', type: 'text', unique: true },
      { name: 'priority', type: 'integer' },
      { name: 'active', type: 'boolean' },
      { name: 'metadata', type: 'jsonb', nullable: true },
      { name: 'due_at', type: 'timestamp', nullable: true },
    ],
  }),
  store({
    name: 'tasks',
    columns: [
      { name: 'project_id', type: 'uuid' },
      { name: 'assignee_id', type: 'uuid', nullable: true },
      { name: 'body', type: 'text' },
    ],
    foreignKeys: [
      { column: 'project_id', references: 'projects', onDelete: 'cascade' },
      // restrict + a set-null on a NULLABLE column (the spec lint permits set null only when
      // nullable; assignee_id is nullable above).
      { column: 'assignee_id', references: 'projects', onDelete: 'set null' },
    ],
  }),
  store({
    name: 'audit_rows',
    columns: [{ name: 'task_id', type: 'uuid' }],
    foreignKeys: [{ column: 'task_id', references: 'tasks', onDelete: 'restrict' }],
  }),
];

describe('generator golden', () => {
  it('produces the byte-stable golden for a representative stores set', () => {
    const out = generateProductSchema(REPRESENTATIVE);
    expect(out).toMatchFileSnapshot(resolve(here, '__snapshots__/representative.golden.ts'));
  });

  // FAIL-THE-FIX: each flip changes EXACTLY one load-bearing fact; the golden must change too. We
  // assert the flipped output DIFFERS from the golden (so a generator that ignored the field fails).
  it('a column TYPE flip changes the output', () => {
    const golden = generateProductSchema(REPRESENTATIVE);
    const flipped = structuredClone(REPRESENTATIVE);
    flipped[0].columns[3].type = 'text'; // priority: integer -> text
    expect(generateProductSchema(flipped)).not.toBe(golden);
    expect(generateProductSchema(flipped)).toContain("priority: text('priority')");
  });

  it('a NULLABLE flip changes the output', () => {
    const golden = generateProductSchema(REPRESENTATIVE);
    const flipped = structuredClone(REPRESENTATIVE);
    flipped[0].columns[0].nullable = true; // title: NOT NULL -> nullable
    const out = generateProductSchema(flipped);
    expect(out).not.toBe(golden);
    expect(out).toContain("title: text('title'),"); // no .notNull()
    expect(out).not.toContain("title: text('title').notNull(),");
  });

  it('a UNIQUE flip changes the output', () => {
    const golden = generateProductSchema(REPRESENTATIVE);
    const flipped = structuredClone(REPRESENTATIVE);
    flipped[0].columns[2].unique = false; // slug: unique -> not
    const out = generateProductSchema(flipped);
    expect(out).not.toBe(golden);
    // A non-key author `unique: true` emits a TENANT-SCOPED table-level uniqueIndex; flipping
    // unique off removes it entirely (and reverts `projects` to the 2-arg pgTable form).
    expect(golden).toContain("uniqueIndex('projects_slug_unique').on(t.tenantId, t.slug)");
    expect(out).not.toContain('projects_slug_unique');
    expect(out).not.toContain('uniqueIndex');
  });

  it('a conflict-key unique stays column-level .unique() (single index)', () => {
    // Mark `slug` as a durable conflict key → it keeps the column-level `.unique()` (single-column
    // index — the ON CONFLICT target), NOT a tenant-scoped table-level uniqueIndex.
    const conflictKeys = new Map([['projects', new Set(['slug'])]]);
    const out = generateProductSchema(REPRESENTATIVE, conflictKeys);
    expect(out).toContain("slug: text('slug').notNull().unique(),");
    expect(out).not.toContain('uniqueIndex'); // no table-level compound index for a conflict key
  });

  it('an FK onDelete flip changes the output', () => {
    const golden = generateProductSchema(REPRESENTATIVE);
    const flipped = structuredClone(REPRESENTATIVE);
    flipped[1].foreignKeys[0].onDelete = 'restrict'; // project_id cascade -> restrict
    const out = generateProductSchema(flipped);
    expect(out).not.toBe(golden);
    // P3S1-GEN-4: assert the SPECIFIC flipped FK line (project_id -> projects, now restrict), not a
    // bare `.toContain("restrict")` that any restrict FK in the spec would satisfy.
    expect(out).toContain("    .references(() => projects.id, { onDelete: 'restrict' }),");
    // ...and the golden's cascade form of THAT line is gone.
    expect(golden).toContain("    .references(() => projects.id, { onDelete: 'cascade' }),");
  });
});

describe('generator injection invariants', () => {
  const out = generateProductSchema(REPRESENTATIVE);

  it('injects all 8 tenancy/GDPR columns on EVERY table, tenant_id -> orgs ON DELETE CASCADE', () => {
    // Three tables, each must carry the injected pattern.
    const tableCount = (out.match(/= pgTable\(/g) ?? []).length;
    expect(tableCount).toBe(3);
    // tenant_id FK -> orgs cascade appears once per table.
    const tenantFk = (
      out.match(/\.references\(\(\) => orgs\.id, \{ onDelete: 'cascade' \}\)/g) ?? []
    ).length;
    expect(tenantFk).toBe(3);
    // id pk + created_at/deleted_at/retention_days/region/created_by/idempotency_key present per table.
    for (const frag of [
      "id: uuid('id').defaultRandom().primaryKey()",
      "createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()",
      "deletedAt: timestamp('deleted_at', { withTimezone: true })",
      "retentionDays: integer('retention_days')",
      "region: text('region').notNull().default('eu')",
      "createdBy: text('created_by')",
      "idempotencyKey: text('idempotency_key')",
    ]) {
      expect(
        (out.match(new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
      ).toBe(3);
    }
  });

  it('NEVER emits/re-declares a core table; references orgs ONLY as the injected FK target', () => {
    // The only `orgs` reference is `() => orgs.id` (the injected tenant_id FK). The generator never
    // emits `pgTable('orgs'...)` or any other core table.
    expect(out).not.toContain("pgTable('orgs'");
    expect(out).not.toContain("pgTable('users'");
    expect(out).not.toContain("pgTable('memberships'");
    // orgs appears only inside the references thunk (once per table).
    const orgsRefs = (out.match(/orgs\.id/g) ?? []).length;
    expect(orgsRefs).toBe(3);
  });

  it('imports only the pg-core builders actually used (no unused import)', () => {
    // REPRESENTATIVE uses text/uuid/timestamp/integer/boolean/jsonb -> all six + pgTable, plus
    // `uniqueIndex` for the tenant-scoped compound unique on projects.slug. The full set
    // exceeds printWidth (100) so the generator emits the Biome-canonical MULTILINE import.
    expect(out).toContain(
      "import {\n  boolean,\n  integer,\n  jsonb,\n  pgTable,\n  text,\n  timestamp,\n  uniqueIndex,\n  uuid,\n} from 'drizzle-orm/pg-core';",
    );
    // No unused import: `uniqueIndex` appears (compound unique) and every used builder is present.
    expect(out).toContain('  uniqueIndex,');
  });

  it('emits PRODUCT_TENANT_SCOPED_TABLES with every table in declared order', () => {
    expect(out).toContain(
      'export const PRODUCT_TENANT_SCOPED_TABLES = [projects, tasks, auditRows] as const;',
    );
  });
});

describe('generator meta-invariants', () => {
  it('INJECTED_COLUMN_NAMES === @rayspec/spec RESERVED_COLUMN_NAMES (single source of truth)', () => {
    expect(new Set(INJECTED_COLUMN_NAMES)).toEqual(RESERVED_COLUMN_NAMES);
  });

  it('a reserved business column slipping past validation is a HARD generator error', () => {
    // The spec lint rejects this at config time; the generator double-checks fail-closed (a spec
    // built directly in code bypasses parseSpec, so the guard must hold here too).
    const sneaky = [
      {
        name: 'evil',
        columns: [{ name: 'tenant_id', type: 'text' as const, nullable: false, unique: false }],
        foreignKeys: [],
      },
    ];
    expect(() => generateProductSchema(sneaky)).toThrow(/reserved column 'tenant_id'/);
  });

  // TEN-1 defense-in-depth: a code-built spec (bypassing parseSpec) with an unsafe identifier must
  // THROW in the generator — never interpolate a metacharacter name into emitted TS.
  it('an unsafe STORE name throws in the generator (TEN-1 defense-in-depth)', () => {
    const evil = [
      {
        name: 'm"); DROP TABLE orgs; --',
        columns: [{ name: 'label', type: 'text' as const, nullable: false, unique: false }],
        foreignKeys: [],
      },
    ];
    expect(() => generateProductSchema(evil)).toThrow(/unsafe identifier/);
  });

  it('an unsafe COLUMN name throws in the generator (TEN-1 defense-in-depth)', () => {
    const evil = [
      {
        name: 'widgets',
        columns: [{ name: "lab'el", type: 'text' as const, nullable: false, unique: false }],
        foreignKeys: [],
      },
    ];
    expect(() => generateProductSchema(evil)).toThrow(/unsafe identifier/);
  });

  // GEN-1 defense-in-depth: a non-uuid FK column throws in the generator (would diverge the twins).
  it('a non-uuid FK column throws in the generator (GEN-1 defense-in-depth)', () => {
    const evil = [
      {
        name: 'parts',
        columns: [{ name: 'widget_id', type: 'text' as const, nullable: false, unique: false }],
        foreignKeys: [{ column: 'widget_id', references: 'widgets', onDelete: 'cascade' as const }],
      },
    ];
    expect(() => generateProductSchema(evil)).toThrow(/must be 'uuid'/);
  });
});

describe('product-EMPTY baseline', () => {
  it('generateProductSchema([]) === the committed product-empty baseline (regenerable)', () => {
    const committed = readFileSync(resolve(here, 'product-schema.ts'), 'utf8');
    expect(generateProductSchema([])).toBe(committed);
  });

  it('the empty baseline declares an empty PRODUCT_TENANT_SCOPED_TABLES tuple', () => {
    expect(generateProductSchema([])).toContain(
      'export const PRODUCT_TENANT_SCOPED_TABLES = [] as const;',
    );
  });
});
