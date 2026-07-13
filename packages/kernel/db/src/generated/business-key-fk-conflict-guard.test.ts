/**
 * (GEN-3, defense-in-depth) `generateProductSql` REJECTS a business-key FK that references a parent's
 * CONFLICT-KEY column at CONFIG time — never emitting an unappliable Postgres 42830.
 *
 * A business-key FK materializes as a TENANT-SCOPED COMPOUND reference
 * `(tenant_id, col) REFERENCES parent(tenant_id, refcol)`. That is appliable ONLY when the parent's
 * unique index on `refcol` is the compound `(tenant_id, refcol)` form. A conflict-key column carries a
 * SINGLE-column `(refcol)` unique index (the durable `ON CONFLICT` target), so the compound REFERENCES
 * has no matching unique constraint → 42830 at deploy. The generator now throws a clear GEN-3 error
 * naming the FK + column instead.
 *
 * This state is UNREACHABLE by a valid spec today (business-key FKs materialize ONLY on the backend
 * profile, which passes NO conflict keys), so this is a pure defense-in-depth unit test — no DB.
 *
 * Fail-the-fix: revert the `assertBusinessKeyFksTargetCompoundUnique` call and the throwing test goes
 * GREEN (generation silently emits the unappliable compound REFERENCES) → RED here.
 */
import { type StoreSpec, StoreSpec as StoreSpecSchema } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { generateProductSql, type StoreConflictKeys } from './generate-product-sql.js';

const parse = (raw: unknown): StoreSpec => StoreSpecSchema.parse(raw);

// meetings(slug unique) ← transcripts(business-key FK on slug).
const STORES: StoreSpec[] = [
  parse({ name: 'meetings', columns: [{ name: 'slug', type: 'text', unique: true }] }),
  parse({
    name: 'transcripts',
    columns: [{ name: 'meeting_slug', type: 'text' }],
    foreignKeys: [{ column: 'meeting_slug', references: 'meetings', referencesColumn: 'slug' }],
  }),
];

describe('generateProductSql — business-key FK onto a conflict-key column (GEN-3 guard)', () => {
  it('THROWS a clear config-time error when the referenced parent column is a CONFLICT KEY', () => {
    // `slug` is declared a conflict key on `meetings` → single-column `(slug)` unique index → the
    // compound business-key FK would be an unappliable 42830. The generator must refuse at config time.
    const conflictKeys: StoreConflictKeys = new Map([['meetings', new Set(['slug'])]]);
    expect(() => generateProductSql(STORES, conflictKeys)).toThrowError(
      /business-key FK 'transcripts\.meeting_slug'.*meetings\.slug.*CONFLICT-KEY.*42830.*GEN-3/s,
    );
  });

  it('does NOT throw when the referenced column is a tenant-scoped compound unique (secure default)', () => {
    // No conflict keys → every unique column is the compound `(tenant_id, slug)` form → the compound
    // FK is appliable → generation proceeds and emits the FK statement.
    const sql = generateProductSql(STORES);
    expect(sql).toContain('transcripts_meeting_slug_meetings_slug_fk');
  });

  it('does NOT throw when the conflict-key set names a DIFFERENT column than the FK target', () => {
    // A conflict key on some OTHER column of the parent does not affect this FK's target index.
    const conflictKeys: StoreConflictKeys = new Map([['meetings', new Set(['other_col'])]]);
    expect(() => generateProductSql(STORES, conflictKeys)).not.toThrow();
  });
});
