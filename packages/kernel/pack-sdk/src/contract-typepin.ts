/**
 * COMPILE-TIME pins for the promised surface — the assertions that make this package a CONTRACT
 * rather than a folder of types. This module is COMPILED by `tsc -b` (it is NOT a `.test.ts`, which
 * every package `tsconfig` excludes), so dropping or narrowing any pinned member FAILS
 * `pnpm typecheck` rather than passing silently. A runtime test cannot carry this guarantee: a
 * types-only package has no behaviour to run, so the compiler is the only instrument that observes it.
 *
 * It proves, for each half of the contract:
 *   1. CONTRIBUTION KINDS — the manifest carries a slot for every kind a pack may contribute, and the
 *      version pin is REQUIRED (the fail-closed skew check reads it). The SERVICE kind adds two of
 *      its own: the module a declaration is addressed by, and the three members the deployment starts
 *      and stops a service through.
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
  PackAgentFragment,
  PackApiRouteFragment,
  PackDatabase,
  PackErrorCode,
  PackFragments,
  PackHandlerFragment,
  PackJournalEntry,
  PackManifest,
  PackManifestBrand,
  PackSectionClaim,
  PackServiceContext,
  PackServiceDeclaration,
  PackServiceModule,
  PackStoreFragment,
  PackToolFragment,
  TurnDispatch,
} from './index.js';

type Assert<_T extends true> = true;

/**
 * Every contribution kind that exists today has a slot on the manifest: the five FRAGMENT kinds a
 * pack contributes content to, the SECTION CLAIMS it takes ownership of, and the SERVICES it brings.
 * Neither of the last two is a fragment — both sit on the manifest itself — so the pin has to name
 * every half or a kind can be dropped from one of them without the compiler noticing.
 */
type _EveryContributionKindHasASlot = Assert<
  'stores' | 'handlers' | 'tooling' | 'api' | 'agents' extends keyof PackFragments
    ? 'sections' | 'services' extends keyof PackManifest
      ? true
      : false
    : false
>;

/** A section claim stays nameable by the pair the loader resolves and jails it by. */
type _SectionClaimIsAddressable = Assert<
  PackSectionClaim extends { key: string; schemaModule: string } ? true : false
>;

/** A service declaration stays nameable by the module the loader resolves and jails it by. */
type _ServiceDeclarationIsAddressable = Assert<
  PackServiceDeclaration extends { module: string } ? true : false
>;

/**
 * A SERVICE MODULE keeps the three members the deployment calls: the name every message about it uses,
 * the boot that takes the context, and the shutdown that takes nothing. A service is the one
 * contribution the platform starts and stops rather than invokes, so dropping any of the three would
 * leave a pack unable to declare the kind at all.
 */
type _ServiceModuleIsBootable = Assert<
  PackServiceModule extends {
    name: string;
    boot: (ctx: PackServiceContext) => Promise<void> | void;
    shutdown: () => Promise<void> | void;
  }
    ? true
    : false
>;

/**
 * The SERVICE CONTEXT carries every member the issue's contract names — the database door, the parsed
 * document, this pack's own validated sections, the journal writer, the environment — plus the ONE
 * capability that is a service's alone. `TurnDispatch` is pinned by NAME here on purpose: the CI
 * dispatch-boundary gate matches that identifier in an import clause from ANY source, so a handler
 * that reaches for it through this package fails the build exactly as it would through the platform.
 */
type _ServiceContextCarriesTheContract = Assert<
    | 'packId'
    | 'db'
    | 'spec'
    | 'sections'
    | 'journal'
    | 'env'
    | 'dispatch' extends keyof PackServiceContext
    ? PackServiceContext['dispatch'] extends TurnDispatch | undefined
      ? true
      : false
    : false
>;

/**
 * The DATABASE door keeps BOTH of its members. The single-statement executor is what a service reads
 * and writes through; `transaction` is what makes an atomic pair and a held row lock expressible at
 * all, and it hands the callback the same door rather than a wider one — so the pin names the shape of
 * the callback's parameter too. Dropping either member, or handing the callback something else, is a
 * contract change and fails to compile here.
 */
type _DatabaseDoorIsTransactional = Assert<
  PackDatabase extends {
    query: (sql: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;
    transaction: <T>(fn: (tx: PackDatabase) => Promise<T>) => Promise<T>;
  }
    ? true
    : false
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
        ? PackAgentFragment extends { id: string }
          ? true
          : false
        : false
      : false
    : false
>;

/** The brand literal a loader checks a pack entry's default export for. */
type _BrandIsPinned = Assert<PackManifestBrand extends '@rayspec/extension@1' ? true : false>;

/** The codes a pack author branches on are members of the closed set. */
type _PackFacingErrorCodes = Assert<
    | 'duplicate_name'
    | 'dangling_ref'
    | 'unknown_field'
    | 'reserved_store_name'
    | 'extension_pack_unavailable'
    | 'extension_pack_refused' extends PackErrorCode
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
  _SectionClaimIsAddressable,
  _ServiceDeclarationIsAddressable,
  _ServiceModuleIsBootable,
  _ServiceContextCarriesTheContract,
  _DatabaseDoorIsTransactional,
  _VersionIsRequired,
  _HandlerIsAddressable,
  _SectionsKeepTheirIdentity,
  _BrandIsPinned,
  _PackFacingErrorCodes,
  _JournalEntryVocabulary,
  _IdentifierRuleIsCheckable,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true];
