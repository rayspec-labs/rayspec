/**
 * @rayspec/db/composition — the sanctioned product-store registrar, unit-proven fail-the-fix.
 *
 * The load-bearing claim is CHECK 2: a table with NO tenant_id column must be REFUSED, because
 * `TenantDb.insert` only `assertScoped()`s (never `tenantColumn()`s), so a tenant-column-less table in
 * the deny-by-default Set yields an UNSCOPED INSERT. We prove that green→red:
 *   - GREEN (fixed): `registerProductStores(memberships)` THROWS.
 *   - RED  (the hole): registering `memberships` via the RAW `registerScopedTables` seam (the pre-fix
 *     path) lets `forTenant(db).insert(memberships, …)` compile SQL with NO tenant_id column.
 * Plus the 7 shape probes (each throws) + a positive control (a real product table registers + its
 * insert IS tenant-scoped) + the validate-all-then-add atomicity guarantee.
 */

import type { StoreSpec } from '@rayspec/spec';
import { getTableName } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDb } from './client.js';
import {
  ProductStoreCompositionError,
  registerProductStores,
  validateProductStore,
} from './composition.js';
import { buildProductTables } from './generated/build-product-tables.js';
import { memberships, orgs, users } from './schema.js';
import { forTenant, registerScopedTables } from './tenant-db.js';

// A never-connected lazy handle: postgres.js only dials on the first QUERY, and we only ever call
// `.toSQL()` (compile, no execution) — so no DB is touched by this suite.
const DUMMY = makeDb('postgres://u:p@127.0.0.1:5432/none');
const TENANT = '00000000-0000-4000-8000-0000000000ab';

/** A real, correctly-shaped product store built by the SAME builder the boot uses (tenant_id → orgs cascade). */
function goodProductTable(name = 'note_artifacts') {
  const stores: StoreSpec[] = [
    {
      name,
      columns: [
        { name: 'session_id', type: 'text', nullable: false, unique: false },
        { name: 'payload', type: 'jsonb', nullable: false, unique: false },
      ],
      foreignKeys: [],
    },
  ];
  return buildProductTables(stores).get(name) as never;
}

describe('registerProductStores — the 7 shape probes (each fail-closed)', () => {
  it('1. name/map-key mismatch (a swapped instance) throws', () => {
    const t = goodProductTable('note_artifacts');
    expect(() => registerProductStores(new Map([['wrong_key', t]]))).toThrow(
      ProductStoreCompositionError,
    );
    expect(() => registerProductStores(new Map([['wrong_key', t]]))).toThrow(/does not match/);
  });

  it('2. NO tenant_id column (the escalation) throws — closing the unscoped-INSERT hole', () => {
    // A hand-built table with no tenant column — the exact shape TenantDb.insert would silently
    // register unscoped. (The real global table `memberships` is proven separately below.)
    const noTenant = pgTable('no_tenant', {
      id: uuid('id').primaryKey().defaultRandom(),
      foo: text('foo'),
    });
    expect(() => registerProductStores(new Map([['no_tenant', noTenant as never]]))).toThrow(
      /NO tenant_id column/,
    );
  });

  it('3a. tenant column mapped to a non-tenant_id SQL name throws', () => {
    const wrongName = pgTable('wrong_name', {
      id: uuid('id').primaryKey().defaultRandom(),
      // The Drizzle prop is `tenantId` (so it passes the getTableColumns lookup) but the SQL column
      // is `org_ref`, not `tenant_id` — check 3a catches it.
      tenantId: uuid('org_ref')
        .notNull()
        .references(() => orgs.id, { onDelete: 'cascade' }),
    });
    expect(() => registerProductStores(new Map([['wrong_name', wrongName as never]]))).toThrow(
      /not\s+'tenant_id'/,
    );
  });

  it('3b. tenant_id of the wrong SQL type (not PgUUID) throws', () => {
    const wrongType = pgTable('wrong_type', {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: text('tenant_id').notNull(),
    });
    expect(() => registerProductStores(new Map([['wrong_type', wrongType as never]]))).toThrow(
      /not a PgUUID/,
    );
  });

  it('3c. NULLABLE tenant_id throws', () => {
    const nullable = pgTable('nullable_t', {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id').references(() => orgs.id, { onDelete: 'cascade' }),
    });
    expect(() => registerProductStores(new Map([['nullable_t', nullable as never]]))).toThrow(
      /NULLABLE/,
    );
  });

  it('4a. no tenant FK at all throws', () => {
    const noFk = pgTable('no_fk', {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id').notNull(),
    });
    expect(() => registerProductStores(new Map([['no_fk', noFk as never]]))).toThrow(
      /expected exactly ONE tenant FK/,
    );
  });

  it('4b. tenant FK targeting the wrong table (not orgs) throws', () => {
    const wrongTarget = pgTable('wrong_target', {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    });
    expect(() => registerProductStores(new Map([['wrong_target', wrongTarget as never]]))).toThrow(
      /targets 'users', not\s+'orgs'/,
    );
  });

  it('4c. tenant FK not ON DELETE CASCADE throws', () => {
    const notCascade = pgTable('not_cascade', {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id')
        .notNull()
        .references(() => orgs.id, { onDelete: 'restrict' }),
    });
    expect(() => registerProductStores(new Map([['not_cascade', notCascade as never]]))).toThrow(
      /ON DELETE restrict, not CASCADE/,
    );
  });

  it('5. shadowing a core/global platform table NAME (e.g. runs) throws', () => {
    // A correctly-shaped tenant table, but named `runs` — it would collide with the core runs table.
    const shadow = buildProductTables([{ name: 'runs', columns: [], foreignKeys: [] }]).get(
      'runs',
    ) as never;
    expect(() => registerProductStores(new Map([['runs', shadow]]))).toThrow(
      /collides with a core\/global platform table/,
    );
  });
});

describe('registerProductStores — the escalation, proven green→red', () => {
  afterEach(() => {
    // Defensive: never leave a global table registered in the shared Set.
    registerScopedTables([memberships])();
  });

  it('GREEN (fixed): registering the tenant-column-LESS `memberships` throws', () => {
    // memberships is a global identity-cluster table with NO tenant_id column (org_id/user_id/role).
    expect(() => registerProductStores(new Map([['memberships', memberships as never]]))).toThrow(
      /NO tenant_id column/,
    );
  });

  it('RED (the hole this closes): the RAW seam lets an UNSCOPED insert into memberships compile', () => {
    // This is the PRE-FIX path — registerScopedTables (no validator) admits memberships, and
    // TenantDb.insert then stamps a `tenantId` key Drizzle SILENTLY DROPS → the compiled SQL carries
    // NO tenant_id. The sanctioned registrar (green test above) refuses exactly this table.
    const unregister = registerScopedTables([memberships]);
    try {
      const tdb = forTenant(DUMMY, TENANT);
      const q = tdb.insert(memberships as never, {
        orgId: TENANT,
        userId: TENANT,
        role: 'owner',
        status: 'active',
      });
      const { sql } = q.toSQL();
      expect(sql).toContain('memberships');
      // The tell: the auto-stamped tenant scope evaporated — no tenant_id column in the INSERT.
      expect(sql).not.toContain('tenant_id');
    } finally {
      unregister();
    }
  });
});

describe('registerProductStores — positive control + atomicity', () => {
  it('a real product table registers, lands in SCOPED, and its insert IS tenant-scoped', () => {
    const table = goodProductTable('note_artifacts');
    const unregister = registerProductStores(new Map([['note_artifacts', table]]));
    try {
      // It reached the Set: a select/insert through the chokepoint does not throw assertScoped, and
      // the auto-stamped tenant_id column IS present (the good table has it).
      const tdb = forTenant(DUMMY, TENANT);
      const ins = tdb.insert(table, { sessionId: 's1', payload: {} }).toSQL();
      expect(ins.sql).toContain('note_artifacts');
      expect(ins.sql).toContain('tenant_id');
      const sel = tdb.select(table).all().toSQL();
      expect(sel.sql).toContain('tenant_id');
    } finally {
      unregister();
    }
  });

  it('registers EXACTLY the tables in the map — no more, no less (the SCOPED-grows-by-N invariant)', () => {
    // Two good product tables + one UNRELATED control table that is NOT in the map. After one
    // registration, the two IN the map are scoped and the control is NOT — proving the Set grew by
    // exactly the map size (a CLI that also called buildProductTables itself would over-register).
    const a = buildProductTables([{ name: 'store_a', columns: [], foreignKeys: [] }]).get(
      'store_a',
    ) as never;
    const b = buildProductTables([{ name: 'store_b', columns: [], foreignKeys: [] }]).get(
      'store_b',
    ) as never;
    const control = buildProductTables([{ name: 'store_c', columns: [], foreignKeys: [] }]).get(
      'store_c',
    ) as never;
    const tdb = forTenant(DUMMY, TENANT);
    const unregister = registerProductStores(
      new Map<string, never>([
        ['store_a', a],
        ['store_b', b],
      ]),
    );
    try {
      expect(() => tdb.select(a).all()).not.toThrow();
      expect(() => tdb.select(b).all()).not.toThrow();
      // The control table was never in the map ⇒ still unscoped (the Set did NOT over-grow).
      expect(() => tdb.select(control).all()).toThrow(/not registered/);
    } finally {
      unregister();
    }
    // After unregister, the two are removed again (the Set is back to its prior size).
    expect(() => tdb.select(a).all()).toThrow(/not registered/);
    expect(() => tdb.select(b).all()).toThrow(/not registered/);
  });

  it('validate-all-then-add: one bad table in the set registers NEITHER (no partial registration)', () => {
    const good = goodProductTable('good_store');
    const bad = pgTable('bad_store', {
      id: uuid('id').primaryKey().defaultRandom(),
      foo: text('foo'), // no tenant_id → check 2 fails
    });
    expect(() =>
      registerProductStores(
        new Map<string, never>([
          ['good_store', good],
          ['bad_store', bad as never],
        ]),
      ),
    ).toThrow(ProductStoreCompositionError);
    // The GOOD table must NOT have been registered (validate-all BEFORE add). Proven: a select through
    // the chokepoint now throws "not registered" — if a partial add had happened, it would not.
    const tdb = forTenant(DUMMY, TENANT);
    expect(() => tdb.select(good).all()).toThrow(/not registered/);
  });
});

describe('validateProductStore — pure validator is directly callable', () => {
  it('accepts a well-shaped table and rejects a shapeless one', () => {
    const good = goodProductTable('direct_ok');
    expect(() => validateProductStore('direct_ok', good)).not.toThrow();
    const bad = pgTable('direct_bad', { id: uuid('id').primaryKey() });
    expect(() => validateProductStore('direct_bad', bad as never)).toThrow(
      ProductStoreCompositionError,
    );
  });

  it('sanity: getTableName agrees with the map key on the positive control', () => {
    const good = goodProductTable('name_check');
    expect(getTableName(good)).toBe('name_check');
  });
});
