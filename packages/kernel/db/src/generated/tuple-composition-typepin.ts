/**
 * COMPILE-TIME pin for the product-table tuple composition — the load-bearing
 * deny-by-default TYPE invariant. This module is COMPILED by `tsc -b` (NOT a `.test.ts`, which tsc
 * excludes), so the assertions below FAIL `pnpm typecheck` on a regression — this tuple pin is build-blocking.
 *
 * It proves, against the REAL `schema.ts` composition + a synthetic populated tuple:
 *   1. NO WIDENING — the composed element type is the precise UNION of the member table literal
 *      types, NOT `PgTable`. (A `[...] as PgTable[]` widening would make this fail.)
 *   2. POPULATED MEMBERSHIP — a product table's literal type IS in the composed union (reachable
 *      through the chokepoint when registered).
 *   3. DENY-BY-DEFAULT (negative) — an UNREGISTERED table's literal type is NOT assignable to the
 *      composed union (a table absent from the tuple is unreachable through the chokepoint).
 *   4. EMPTY-BASELINE — ONLY when the real product tuple is empty (the platform main line), the
 *      platform union equals the CORE union. This is GUARDED on the actual product-tuple length so a
 *      POPULATED deployment (product tuple non-empty) still typechecks (the populated-deployment type-pin).
 *
 * A POPULATED deployment compile path is additionally typechecked by `__fixtures__/populated-
 * product-schema.ts` (the populated-schema fixture pin) — a real populated module composed against schema.ts.
 *
 * The RUNTIME half of the tuple invariant (an unregistered table throws at access) is proven by
 * product-pipeline.test.ts + the api-auth cross-tenant gate.
 */
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { CORE_TENANT_SCOPED_TABLES, orgs, type TENANT_SCOPED_TABLES } from '../schema.js';
import type { PRODUCT_TENANT_SCOPED_TABLES } from './product-schema.js';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsMember<T, U> = T extends U ? true : false;
type Assert<_T extends true> = true;

// A product table (mirrors a generated product table's shape) to model a POPULATED tuple member.
const sampleProduct = pgTable('sample_product', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
});
// A table that is NOT in any composed tuple — used for the deny-by-default NEGATIVE pin.
const unregisteredTable = pgTable('unregistered_table', {
  id: uuid('id').defaultRandom().primaryKey(),
});

const COMPOSED = [...CORE_TENANT_SCOPED_TABLES, sampleProduct] as const;

type ComposedMember = (typeof COMPOSED)[number];
type CoreMember = (typeof CORE_TENANT_SCOPED_TABLES)[number];
type PlatformMember = (typeof TENANT_SCOPED_TABLES)[number];

// (1) NO WIDENING: the composed element type EQUALS the exact union of its members (core ⊕ sample),
// not the wide `PgTable`. If the composition widened, `Equals<ComposedMember, CoreMember | sample>`
// would be false. We assert it equals the precise union we expect.
type _NoWidening = Assert<Equals<ComposedMember, CoreMember | typeof sampleProduct>>;
// (2) POPULATED MEMBERSHIP: the sample product table IS a member of the composed union.
type _ProductIsMember = Assert<IsMember<typeof sampleProduct, ComposedMember>>;
// (2b) every core table is still a member.
type _CoreIsMember = Assert<IsMember<CoreMember, ComposedMember>>;
// (3) DENY-BY-DEFAULT (negative): an UNREGISTERED table is NOT assignable to the composed union.
//     `[typeof unregisteredTable] extends [ComposedMember]` is false when it is not a member, so we
//     assert the membership is FALSE (the deny-by-default type guarantee).
type _UnregisteredIsNotMember = Assert<
  IsMember<typeof unregisteredTable, ComposedMember> extends true ? false : true
>;

// (4) EMPTY-BASELINE — guarded on the REAL product tuple length. Only assert union-equality when the
// product tuple is empty (the platform main line); a POPULATED deployment skips this (it would not
// hold, by design) and still typechecks (the populated-deployment type-pin).
type ProductIsEmpty = (typeof PRODUCT_TENANT_SCOPED_TABLES)['length'] extends 0 ? true : false;
type _EmptyBaselineUnchangedIfEmpty = Assert<
  ProductIsEmpty extends true ? Equals<PlatformMember, CoreMember> : true
>;

// Touch the type aliases so unused-locals cannot strip the pins (they are the point of the module).
export const TUPLE_COMPOSITION_TYPEPINS: [
  _NoWidening,
  _ProductIsMember,
  _CoreIsMember,
  _UnregisteredIsNotMember,
  _EmptyBaselineUnchangedIfEmpty,
] = [true, true, true, true, true];
