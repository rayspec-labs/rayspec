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
 *   7. THE HANDLER CONTRACT — the two kinds a pack can WRITE (not just declare) keep the init they
 *      take and the members that init promises on every invocation.
 *   8. THE ROUTE INIT'S TWO DOORS — the journal READ stays a bounded, cursored page, and the
 *      incremental response stays a constructor that hands back the value a handler returns.
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
  PackJournal,
  PackJournalEntry,
  PackJournalPage,
  PackJournalReader,
  PackJournalWriter,
  PackManifest,
  PackManifestBrand,
  PackRouteHandler,
  PackRouteHandlerInit,
  PackRouteResponse,
  PackSectionClaim,
  PackServiceContext,
  PackServiceDeclaration,
  PackServiceModule,
  PackStoreDb,
  PackStoreFragment,
  PackToolFragment,
  PackToolHandler,
  PackToolHandlerInit,
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
 * all. Dropping either member is a contract change and fails to compile here.
 *
 * This pin catches REMOVAL and nothing else, deliberately paired with the one below: `transaction` is
 * declared method-style, so its parameters are compared BIVARIANTLY and an assignability test alone
 * accepts a `transaction` that hands the callback something WIDER than the door.
 */
type _DatabaseDoorIsTransactional = Assert<
  PackDatabase extends {
    query: (sql: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;
    transaction: <T>(fn: (tx: PackDatabase) => Promise<T>) => Promise<T>;
  }
    ? true
    : false
>;

/** The handle `transaction` hands its callback, extracted from the signature rather than restated. */
type TransactionCallbackHandle = Parameters<PackDatabase['transaction']>[0] extends (
  tx: infer Handle,
) => unknown
  ? Handle
  : never;

/**
 * …and that handle is EXACTLY the door — the same members, no more and no fewer. Assignability is
 * asserted in BOTH directions (each side wrapped in a one-tuple, so a union would be compared whole
 * rather than distributed): `Handle extends PackDatabase` catches a NARROWED callback parameter, and
 * `PackDatabase extends Handle` catches a WIDENED one. That second direction is the one the contract
 * leans on — "a transaction is not a seam a pack can widen its reach through" — and it is the one a
 * plain `extends` test cannot see, because a method's parameters are bivariant even under
 * `strictFunctionTypes`. Verified by construction: this assertion resolves to `false` (and so fails to
 * compile) against a `transaction` whose callback takes `PackDatabase & { … }`.
 */
type _TransactionHandsBackTheSameDoor = Assert<
  [TransactionCallbackHandle] extends [PackDatabase]
    ? [PackDatabase] extends [TransactionCallbackHandle]
      ? true
      : false
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

/**
 * A pack handler is CALLABLE with the init this package tells its author to annotate against: the
 * tool arm takes `(args, init)` and the route arm takes `(init)`. These extract the parameter from
 * the exported function type rather than restating it, so a handler type that started taking
 * something else — or stopped taking an init at all — fails here rather than in a pack's repository.
 */
type _AToolHandlerTakesTheToolInit = Assert<
  Parameters<PackToolHandler>[1] extends PackToolHandlerInit ? true : false
>;
type _ARouteHandlerTakesTheRouteInit = Assert<
  Parameters<PackRouteHandler>[0] extends PackRouteHandlerInit ? true : false
>;

/**
 * BOTH inits promise the two members a handler cannot work without — the invocation's server-derived
 * tenant and the door onto the declared stores — and the ROUTE arm additionally promises what the
 * request carried. `params` is REQUIRED and the rest are not, which is the contract: a route always
 * has its bound path parameters, while a body, the allowlisted headers and a resolved principal are
 * each absent on a real invocation, so a handler that needs one fail-closes loudly on `undefined`.
 */
type _BothInitsCarryTenantAndStores = Assert<
  'tenantId' | 'db' extends keyof PackToolHandlerInit
    ? 'tenantId' | 'db' | 'params' extends keyof PackRouteHandlerInit
      ? true
      : false
    : false
>;
type _RouteParamsAreRequired = Assert<
  undefined extends PackRouteHandlerInit['params'] ? false : true
>;

/**
 * The STORE DOOR keeps every method a handler reaches a declared store through, and `transaction`
 * hands its callback the SAME door. The second half is asserted in BOTH directions (each side wrapped
 * in a one-tuple so a union is compared whole): a method's parameters are compared BIVARIANTLY even
 * under `strictFunctionTypes`, so a one-way test would accept a callback handed something WIDER —
 * which is exactly what "a transaction is not a seam a pack can reach further through" forbids. The
 * same pairing `PackDatabase` uses above, for the same reason.
 */
type _StoreDoorKeepsItsMethods = Assert<
  'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'transaction' extends keyof PackStoreDb
    ? true
    : false
>;
type StoreTransactionHandle = Parameters<PackStoreDb['transaction']>[0] extends (
  tx: infer Handle,
) => unknown
  ? Handle
  : never;
type _StoreTransactionHandsBackTheSameDoor = Assert<
  [StoreTransactionHandle] extends [PackStoreDb]
    ? [PackStoreDb] extends [StoreTransactionHandle]
      ? true
      : false
    : false
>;

/**
 * THE ROUTE INIT'S TWO NEW DOORS keep the members a handler cannot use them without. Both are pinned
 * through `NonNullable<…>` because both are OPTIONAL on the contract (a deployment older than them
 * injects neither), and a pin that let the `undefined` arm satisfy it would assert nothing.
 *
 * ⚠ WHAT THIS FILE CAN AND CANNOT SEE. Every assertion here compares this package against ITSELF, so
 * it goes red only when someone edits this package — it keeps the surface from being narrowed by
 * accident, and it cannot notice the PLATFORM drifting away from it. The arms that catch that live in
 * `pack-sdk-interop.ts`, on the side where the value is built.
 */
type _JournalReaderReads = Assert<
  NonNullable<PackRouteHandlerInit['journal']> extends PackJournalReader
    ? Awaited<ReturnType<PackJournalReader['read']>> extends PackJournalPage
      ? true
      : false
    : false
>;
/** A page is BOUNDED + CURSORED: the entries carry their own position, and the page says if more wait. */
type _AJournalPageIsCursoredAndBounded = Assert<
  PackJournalPage extends { entries: readonly { cursor: string }[]; hasMore: boolean }
    ? true
    : false
>;
/**
 * The INCREMENTAL response is reachable and is a CONSTRUCTOR, not a stream: it TAKES the producer and
 * hands back the opaque response a handler returns unchanged. The parameter half is what this arm
 * actually measures — it is extracted from the member rather than restated, so a responder that
 * started taking something other than an `(emit, signal)` producer fails here. The return half is
 * deliberately weak, because `PackRouteResponse` is deliberately opaque; the arm that gives the return
 * teeth is the cross-package one, where the deployment's real envelope is on the other side.
 */
type _SseResponderBuildsARouteResponse = Assert<
  ReturnType<NonNullable<PackRouteHandlerInit['sseResponse']>> extends PackRouteResponse
    ? Parameters<NonNullable<PackRouteHandlerInit['sseResponse']>>[0] extends (
        emit: (frame: { data: string }) => Promise<void>,
        signal: { readonly aborted: boolean },
      ) => Promise<void>
      ? true
      : false
    : false
>;
/** The RESUME CURSOR is carried, and it is a plain string — never a parsed platform object. */
type _ResumeCursorIsAString = Assert<
  PackRouteHandlerInit['resumeFrom'] extends string | undefined ? true : false
>;

/**
 * THE SERVICE'S JOURNAL DOOR CARRIES BOTH VERBS. This is the arm that would have caught the shape
 * this contract shipped with first: a reader reachable only from a route, leaving the surface that
 * WRITES journal steps unable to read one back — which is the sentence the whole read half exists to
 * make false. Asserted through the context member rather than through `PackJournal` directly, because
 * what a service is HANDED is the thing that matters; a door declared and never handed over is a type
 * nobody receives.
 */
type _AServiceJournalReadsAndWrites = Assert<
  NonNullable<PackServiceContext['journal']> extends PackJournalReader
    ? NonNullable<PackServiceContext['journal']> extends PackJournalWriter
      ? true
      : false
    : false
>;
/** …and the door a service is handed IS that pair, not a third shape that happens to fit both. */
type _TheServiceDoorIsThePackJournal = Assert<
  PackJournal extends PackJournalReader & PackJournalWriter
    ? NonNullable<PackServiceContext['journal']> extends PackJournal
      ? true
      : false
    : false
>;
/**
 * BOTH SURFACES READ THROUGH THE SAME READER. A service's read and a route's read returning
 * different pages would be two contracts wearing one name, and a pack author moving code between the
 * two would discover it at the call site.
 */
type _BothSurfacesShareOneReader = Assert<
  Awaited<ReturnType<NonNullable<PackServiceContext['journal']>['read']>> extends PackJournalPage
    ? Awaited<
        ReturnType<NonNullable<PackRouteHandlerInit['journal']>['read']>
      > extends PackJournalPage
      ? true
      : false
    : false
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
  _TransactionHandsBackTheSameDoor,
  _VersionIsRequired,
  _HandlerIsAddressable,
  _SectionsKeepTheirIdentity,
  _BrandIsPinned,
  _PackFacingErrorCodes,
  _JournalEntryVocabulary,
  _AToolHandlerTakesTheToolInit,
  _ARouteHandlerTakesTheRouteInit,
  _BothInitsCarryTenantAndStores,
  _RouteParamsAreRequired,
  _StoreDoorKeepsItsMethods,
  _StoreTransactionHandsBackTheSameDoor,
  _JournalReaderReads,
  _AJournalPageIsCursoredAndBounded,
  _SseResponderBuildsARouteResponse,
  _ResumeCursorIsAString,
  _AServiceJournalReadsAndWrites,
  _TheServiceDoorIsThePackJournal,
  _BothSurfacesShareOneReader,
  _IdentifierRuleIsCheckable,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
