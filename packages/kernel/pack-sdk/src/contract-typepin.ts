/**
 * COMPILE-TIME pins for the promised surface — the assertions that make this package a CONTRACT
 * rather than a folder of types. This module is COMPILED by `tsc -b` (it is NOT a `.test.ts`, which
 * every package `tsconfig` excludes), so dropping or narrowing any pinned member FAILS
 * `pnpm typecheck` rather than passing silently. A runtime test cannot carry this guarantee: a
 * types-only package has no behaviour to run, so the compiler is the only instrument that observes it.
 *
 * It proves, for each half of the contract:
 *   1. CONTRIBUTION KINDS — the manifest carries a slot for every kind a pack may contribute, and the
 *      version pin is REQUIRED (the fail-closed skew check reads it).
 *   2. ADDRESSING — a handler fragment is nameable by the id/module/export/kind quadruple the loader
 *      resolves it by, and every other fragment kind keeps the field its section is addressed by.
 *   3. THE BRAND — the literal a loader checks a pack entry's default export for.
 *   4. ERROR VOCABULARY — the codes a pack author branches on are members of the closed set.
 *   5. JOURNAL — the entry a pack's contribution produces keeps its kind + status vocabulary.
 *   6. THE IDENTIFIER RULE — checkable at authoring time, bounded by the Postgres identifier limit.
 */
import type {
  isSafeIdentifier,
  MAX_IDENTIFIER_LENGTH,
  PackApiRouteFragment,
  PackErrorCode,
  PackFragments,
  PackHandlerFragment,
  PackJournalEntry,
  PackManifest,
  PackManifestBrand,
  PackStoreFragment,
  PackToolFragment,
} from './index.js';

type Assert<_T extends true> = true;

/** Every contribution kind that exists today has a slot on the fragments half of the manifest. */
type _EveryContributionKindHasASlot = Assert<
  'stores' | 'handlers' | 'tooling' | 'api' | 'agents' extends keyof PackFragments ? true : false
>;

/** The declared version is REQUIRED — the boot-time pin check has nothing to compare otherwise. */
type _VersionIsRequired = Assert<undefined extends PackManifest['version'] ? false : true>;

/** A handler fragment stays nameable by the quadruple the loader resolves it by. */
type _HandlerIsAddressable = Assert<
  PackHandlerFragment extends { id: string; module: string; export: string; kind: string }
    ? true
    : false
>;

/** The other four kinds keep the field their section is addressed by post-merge. */
type _SectionsKeepTheirIdentity = Assert<
  PackStoreFragment extends { name: string }
    ? PackToolFragment extends { id: string; handler: string }
      ? PackApiRouteFragment extends { method: string; path: string }
        ? true
        : false
      : false
    : false
>;

/** The brand literal a loader checks a pack entry's default export for. */
type _BrandIsPinned = Assert<PackManifestBrand extends '@rayspec/extension@1' ? true : false>;

/** The codes a pack author branches on are members of the closed set. */
type _PackFacingErrorCodes = Assert<
  'duplicate_name' | 'dangling_ref' | 'unknown_field' | 'reserved_store_name' extends PackErrorCode
    ? true
    : false
>;

/** A journaled step keeps its kind + status vocabulary. */
type _JournalEntryVocabulary = Assert<
  PackJournalEntry extends { type: 'llm' | 'tool' | 'store'; status: 'ok' | 'error' } ? true : false
>;

/** The identifier rule is checkable, and bounded by the Postgres identifier limit. */
type _IdentifierRuleIsCheckable = Assert<
  ReturnType<typeof isSafeIdentifier> extends boolean
    ? typeof MAX_IDENTIFIER_LENGTH extends 63
      ? true
      : false
    : false
>;

// Touch the type aliases so unused-locals cannot strip the pins (they are the point of the module).
export const PACK_CONTRACT_TYPEPINS: [
  _EveryContributionKindHasASlot,
  _VersionIsRequired,
  _HandlerIsAddressable,
  _SectionsKeepTheirIdentity,
  _BrandIsPinned,
  _PackFacingErrorCodes,
  _JournalEntryVocabulary,
  _IdentifierRuleIsCheckable,
] = [true, true, true, true, true, true, true, true];
