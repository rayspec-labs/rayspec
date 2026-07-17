/**
 * COMPILE-TIME pin for a POPULATED deployment's product-table composition.
 *
 * The platform main line ships a PRODUCT-EMPTY tuple, so the populated-deployment compile path was
 * never typechecked (the original empty-baseline bug — an unconditional empty-baseline assertion — would have
 * broken a real deployment, and nothing caught it). This module composes the POPULATED fixture
 * tuple against the REAL core tuple EXACTLY as schema.ts does, and asserts the populated deployment
 * typechecks: every product table is a member of the composed union, and the composed element type
 * is the precise core ⊕ product union (no widening). If a future change broke the populated
 * composition (as the empty-baseline bug did), `tsc -b` would fail HERE.
 *
 * It is a fixture (under `__fixtures__/`, compiled by tsc -b but not used at runtime).
 */
import { CORE_TENANT_SCOPED_TABLES } from '../../schema.js';
import {
  type entries,
  type notebooks,
  PRODUCT_TENANT_SCOPED_TABLES,
} from './populated-product-schema.js';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsMember<T, U> = T extends U ? true : false;
type Assert<_T extends true> = true;

// Compose EXACTLY as schema.ts does: [...CORE, ...PRODUCT] as const.
const POPULATED_COMPOSED = [...CORE_TENANT_SCOPED_TABLES, ...PRODUCT_TENANT_SCOPED_TABLES] as const;

type PopulatedMember = (typeof POPULATED_COMPOSED)[number];
type CoreMember = (typeof CORE_TENANT_SCOPED_TABLES)[number];

// Both populated product tables are MEMBERS of the composed union (reachable through the chokepoint).
type _NotebooksIsMember = Assert<IsMember<typeof notebooks, PopulatedMember>>;
type _EntriesIsMember = Assert<IsMember<typeof entries, PopulatedMember>>;
// No widening: the composed union is precisely core ⊕ {notebooks, entries}.
type _PopulatedNoWidening = Assert<
  Equals<PopulatedMember, CoreMember | typeof notebooks | typeof entries>
>;

export const POPULATED_COMPOSITION_TYPEPINS: [
  _NotebooksIsMember,
  _EntriesIsMember,
  _PopulatedNoWidening,
] = [true, true, true];
