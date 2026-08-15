# @rayspec/pack-sdk — public API report

<!-- GENERATED FILE — do not edit by hand. Regenerate with
     `node scripts/check-public-api-report.mjs --write`. It is derived from the package's BUILT
     type declarations (`dist/**/*.d.ts`), so it reports what a consumer actually compiles
     against; any change to the exported surface shows up here as a reviewable diff. -->

## dist/contract-typepin.d.ts

```ts
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
import type { isSafeIdentifier, MAX_IDENTIFIER_LENGTH, PackApiRouteFragment, PackErrorCode, PackFragments, PackHandlerFragment, PackJournalEntry, PackManifest, PackManifestBrand, PackStoreFragment, PackToolFragment } from './index.js';
type Assert<_T extends true> = true;
/** Every contribution kind that exists today has a slot on the fragments half of the manifest. */
type _EveryContributionKindHasASlot = Assert<'stores' | 'handlers' | 'tooling' | 'api' | 'agents' extends keyof PackFragments ? true : false>;
/** The declared version is REQUIRED — the boot-time pin check has nothing to compare otherwise. */
type _VersionIsRequired = Assert<undefined extends PackManifest['version'] ? false : true>;
/** A handler fragment stays nameable by the quadruple the loader resolves it by. */
type _HandlerIsAddressable = Assert<PackHandlerFragment extends {
    id: string;
    module: string;
    export: string;
    kind: string;
} ? true : false>;
/** The other four kinds keep the field their section is addressed by post-merge. */
type _SectionsKeepTheirIdentity = Assert<PackStoreFragment extends {
    name: string;
} ? PackToolFragment extends {
    id: string;
    handler: string;
} ? PackApiRouteFragment extends {
    method: string;
    path: string;
} ? true : false : false : false>;
/** The brand literal a loader checks a pack entry's default export for. */
type _BrandIsPinned = Assert<PackManifestBrand extends '@rayspec/extension@1' ? true : false>;
/** The codes a pack author branches on are members of the closed set. */
type _PackFacingErrorCodes = Assert<'duplicate_name' | 'dangling_ref' | 'unknown_field' | 'reserved_store_name' extends PackErrorCode ? true : false>;
/** A journaled step keeps its kind + status vocabulary. */
type _JournalEntryVocabulary = Assert<PackJournalEntry extends {
    type: 'llm' | 'tool' | 'store';
    status: 'ok' | 'error';
} ? true : false>;
/** The identifier rule is checkable, and bounded by the Postgres identifier limit. */
type _IdentifierRuleIsCheckable = Assert<ReturnType<typeof isSafeIdentifier> extends boolean ? typeof MAX_IDENTIFIER_LENGTH extends 63 ? true : false : false>;
export declare const PACK_CONTRACT_TYPEPINS: [
    _EveryContributionKindHasASlot,
    _VersionIsRequired,
    _HandlerIsAddressable,
    _SectionsKeepTheirIdentity,
    _BrandIsPinned,
    _PackFacingErrorCodes,
    _JournalEntryVocabulary,
    _IdentifierRuleIsCheckable
];
export {};
```

## dist/errors.d.ts

```ts
/**
 * The ERROR half of the contract — the closed vocabulary a pack author can be handed, and the flat
 * envelope that carries it.
 *
 * A pack's fragments are validated by the deployment's own parse pass over the MERGED document, so
 * every way a pack can be wrong is reported as one of these codes — never as a free-form string.
 * The set is CLOSED by construction: a pack author can enumerate what they must handle, write a
 * total switch over it, and be told by the compiler when this surface widens.
 *
 * The pass aggregates the FULL list of violations rather than the first, so a pack that is wrong in
 * three places learns all three in one boot attempt.
 *
 * TWO FAMILIES SHARE THE VOCABULARY. The first group is the backend-document family — the one a
 * pack contributes fragments to, and the only group a pack's own declarations can produce. The
 * second group belongs to the product-document family, which a pack does not write; it is listed
 * because the vocabulary is one closed set and a total switch has to cover it.
 */
/** One closed code. Every parse/lint violation carries exactly one. */
export type PackErrorCode = 
/** The raw text is not valid YAML. */
'yaml_parse_error'
/** `version` is missing or is not the supported literal. */
 | 'unsupported_version'
/** A shape failure that is not a pure unknown-key rejection (wrong type, missing field, bad enum). */
 | 'schema_violation'
/** An unknown key — the grammar is fail-closed, so any extra key is refused. */
 | 'unknown_field'
/** The document carries a mapping key literally named `__proto__` (refused anywhere it appears). */
 | 'reserved_document_key'
/** A cross-reference names an id that is not declared post-merge (a tool's handler, an agent's tool). */
 | 'dangling_ref'
/** Two entries in one section share an id/name — including a pack id colliding with a deployment id. */
 | 'duplicate_name'
/** An agent demands a capability its resolved backend lacks. */
 | 'capability_violation'
/** An embedded JSON-Schema (tool parameters/output, agent output) failed to compile. */
 | 'invalid_embedded_schema'
/** A store declares a business column whose name collides with an injected tenancy/GDPR column. */
 | 'reserved_column_name'
/** A store declares a business column named after a list-query control keyword. */
 | 'reserved_query_keyword'
/** A store is named after a platform table — its `CREATE TABLE` would collide with the platform's. */
 | 'reserved_store_name'
/** A static frontend mount's route collides with another mount, a declared route, or a system prefix. */
 | 'frontend_route_collision'
/** A declared frontend directory does not resolve to a readable directory of built assets. */
 | 'frontend_dir_missing'
/** The declared stores form a circular foreign-key reference — no CREATE order satisfies every FK. */
 | 'fk_cycle'
/** An agent declares both tools and an output schema: it would answer in one turn and never call one. */
 | 'agent_output_schema_shortcircuits_tools'
/** A response projection addresses a column that is not on the response. */
 | 'projection_unknown_column'
/** A response projection maps two exposed columns onto the same wire field name. */
 | 'projection_collision'
/** A projection rename target equals the author name of ANOTHER column of the same store. */
 | 'projection_query_shadow'
/** Implementation (code/handler/SQL/shell) appears where only product meaning belongs. */
 | 'no_code_in_yaml'
/** A provider-native payload or provider policy leaked into the provider-neutral executable graph. */
 | 'provider_native_leak'
/** Reserved (closed-code discipline): capability wiredness is enforced at deploy, not at parse. */
 | 'invalid_capability_status'
/** A declared contract uses a key/type outside the closed, declarative schema vocabulary. */
 | 'invalid_contract'
/** A graph string claims prompt/model EXECUTION, which is a runtime concern rather than meaning. */
 | 'prompt_execution_claim'
/** A graph string claims production EXECUTION. */
 | 'production_execution_claim'
/** A step's dependency names a step that is not declared before it (a forward or self reference). */
 | 'invalid_dependency_order'
/** A view declaration violates the view semantics (source/contract conflation, shape, pagination). */
 | 'invalid_view'
/** A store or store-step declaration violates the store semantics. */
 | 'invalid_store';
/**
 * One fail-closed violation: the closed code, a message written for the author, and — where the
 * violation is IN the document — a JSON path to the exact offending node (dot/bracket notation,
 * e.g. `agents[0].backend`). The path is absent for whole-document failures, where no in-document
 * node applies.
 */
export interface PackError {
    /** The closed code. Branch on this; the message is for humans and is not part of the contract. */
    readonly code: PackErrorCode;
    /** The human-readable explanation. Free text — never parsed. */
    readonly message: string;
    /** JSON path into the document; absent for whole-document failures. */
    readonly path?: string;
}
```

## dist/identifier.d.ts

```ts
/**
 * The IDENTIFIER rule — the one part of this contract a type cannot express.
 *
 * A store name and a column name are interpolated VERBATIM into generated SQL (`CREATE TABLE
 * "<name>"`) and into generated TypeScript, so an unconstrained string is an injection seam: a name
 * carrying a quote or a semicolon lands in executable DDL. The rule is therefore fail-closed at the
 * source — a safe identifier is `/^[a-z_][a-z0-9_]*$/`, at most 63 characters (the Postgres
 * identifier limit), lowercase only (Postgres folds unquoted identifiers to lowercase, and the
 * generators camel-case these snake_case author names for TypeScript).
 *
 * A pack that spells its names out as literals needs nothing but the rule. A pack that DERIVES a
 * name — from its own configuration, from a caller-supplied fragment — needs to check one, and a
 * regular expression bounded by a length is not expressible as a type. `isSafeIdentifier` is that
 * check and the only executable line in this package: pure, total, allocation-free, no state, no
 * I/O. Everything else here is types.
 *
 * The check is ADVISORY at authoring time, not a substitute for the platform's own: the parse pass
 * re-asserts the same rule over the merged document and refuses a violating name as a
 * `schema_violation`, and the generators re-assert it a third time for a document assembled in
 * code. Checking early only turns a boot failure into an authoring-time one.
 */
/** The safe-identifier pattern: lowercase letters, digits and underscore, never leading with a digit. */
export declare const SAFE_IDENTIFIER_RE: RegExp;
/** The Postgres identifier limit — a longer name is silently truncated by the database, so it is refused. */
export declare const MAX_IDENTIFIER_LENGTH = 63;
/**
 * True iff `value` is a safe identifier: it matches the pattern AND is within the length bound. The
 * pattern already requires at least one character, so an empty string is rejected by it.
 */
export declare function isSafeIdentifier(value: string): boolean;
```

## dist/index.d.ts

```ts
/**
 * @rayspec/pack-sdk — the surface an out-of-tree extension pack compiles against.
 *
 * An extension pack ships in its OWN repository: it carries its own stores, handlers, tooling,
 * routes and agents, and a deployment names it by reference. To build, it has to import SOMETHING —
 * manifest types, the error vocabulary, the identifier rule, the journal shapes. Without a promised
 * surface it reaches into whichever internal package happens to export them, which turns every
 * internal refactor into a silent break for every pack and makes "what may a pack rely on" a matter
 * of taste. This package is the answer: it is the ONE surface a pack is allowed to compile against,
 * and it promises nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TYPES ONLY — AND WHY THAT IS THE POINT, NOT A LIMITATION.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack receives every runtime object it needs by INJECTION at boot: the deployment builds the
 * capabilities and hands them in. It never constructs one, so it never needs to IMPORT one — and a
 * contract that ships no implementation cannot drift from the implementation it describes, cannot
 * pull a transitive dependency into a pack's build, and cannot become a back door into internals
 * through a re-export. The one executable line in this package is `isSafeIdentifier`, because the
 * rule it checks — a pattern bounded by a length — is not expressible as a type.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO AUTHORING SURFACES, DELIBERATELY DISTINCT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack's ENTRY module DECLARES the pack: it default-exports the manifest, which it builds with
 * the platform's manifest helper (the entry is the one module that names the platform). A pack's
 * HANDLER modules RUN with injected capabilities and import only `@rayspec/handler-sdk`, the
 * type-only handler contract — a boundary the repository enforces with its own gate. This package
 * is the DECLARATION-side contract: the shapes a pack author writes down and the vocabulary the
 * deployment answers them with.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * COMPATIBILITY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The exported surface is reported in `api-report.md`, checked in beside this source, so every
 * change to it is a reviewable diff rather than an accident. What a minor release may change, what
 * forces a major, and what is frozen once a release ships are stated in the package README — read
 * it before adding anything here.
 */
export type { PackError, PackErrorCode } from './errors.js';
export { isSafeIdentifier, MAX_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_RE } from './identifier.js';
export type { PackJournalEntry, PackJournalStatus, PackJournalStepType, PackTokenUsage, } from './journal.js';
export type { DefinedPack, PackAgentFragment, PackApiRouteFragment, PackCapabilities, PackFragments, PackHandlerFragment, PackHandlerKind, PackHttpMethod, PackManifest, PackManifestBrand, PackStoreFragment, PackToolFragment, } from './manifest.js';
```

## dist/journal.d.ts

```ts
/**
 * The JOURNAL half of the contract — the entries a pack's work is recorded as.
 *
 * The run journal is the platform's reliability primitive: one transactional, append-only,
 * tenant-scoped record per step, and the single source of truth for replay, cost and audit. A pack
 * never inserts a row itself — it contributes the tool, store route or agent whose step the
 * platform journals on its behalf, under exactly the shape below. Naming the shape here is what
 * lets a pack read its own runs, correlate a step with the work that produced it, and assert on
 * both in its own tests without importing platform internals.
 *
 * IDEMPOTENCY IS THE LOAD-BEARING FIELD. `(runId, idempotencyKey)` is unique per tenant: a replay
 * of the same step returns the recorded output instead of re-running it. A contributed tool that
 * declares itself idempotent is promising exactly that, and the journal is where the promise is
 * kept — so a pack author reading a step is reading the replay decision, not a log line.
 *
 * WHAT THIS SURFACE PROMISES, AND WHAT IT DOES NOT. The fields below are the neutral ones: identity,
 * the step's own inputs and output, and its measured cost and latency. The stored record carries
 * further PLATFORM-OWNED accounting and provenance columns — which provider ran the step, how the
 * run authenticated, which pricing entry computed the cost — that are deliberately not part of this
 * contract: they name vocabulary a pack neither supplies nor chooses, and pinning a copy of it here
 * would freeze this surface to the platform's provider list. A reader must therefore treat the
 * record as OPEN: these fields are promised to be present and to mean this, never to be all of them.
 */
/** The kind of step recorded in the journal. */
export type PackJournalStepType = 'llm' | 'tool' | 'store';
/** How a step ended. A failed step is journaled, never dropped. */
export type PackJournalStatus = 'ok' | 'error';
/**
 * Token usage for a step. The three totals are always present; the remaining members are reported
 * only by providers that measure them, so a reader must treat their absence as "not reported"
 * rather than as zero.
 */
export interface PackTokenUsage {
    /** Tokens in the request. */
    readonly inputTokens: number;
    /** Tokens in the response. */
    readonly outputTokens: number;
    /** The sum the provider reported. */
    readonly totalTokens: number;
    /** Cached input tokens read, where the provider reports caching. */
    readonly cacheReadTokens?: number;
    /** Input tokens written to the cache, where the provider reports caching. */
    readonly cacheCreationTokens?: number;
    /** Reasoning tokens, where the provider reports them separately. */
    readonly reasoningTokens?: number;
}
/**
 * One journal entry — the append-only record of a single step of a run. Every entry is tenant-scoped
 * by construction: the tenant is derived server-side, never supplied by the code that produced the
 * step.
 */
export interface PackJournalEntry {
    /** The step's own id. */
    readonly stepId: string;
    /** The run this step belongs to. */
    readonly runId: string;
    /** The tenant the run executed for — server-derived. */
    readonly tenantId: string;
    /** Which kind of step this is. */
    readonly type: PackJournalStepType;
    /** The replay key: identical `(runId, idempotencyKey)` returns the recorded output. */
    readonly idempotencyKey: string;
    /** A hash of the step input, for the replay lookup and for audit. */
    readonly inputHash: string;
    /** The step's output as recorded. Opaque data — its shape is the step's own concern. */
    readonly output: unknown;
    /** Token usage for the step. */
    readonly usage: PackTokenUsage;
    /** The computed cost of the step in USD. */
    readonly costUsd: number;
    /** Wall-clock duration of the step in milliseconds. */
    readonly latencyMs: number;
    /** Whether the step succeeded. */
    readonly status: PackJournalStatus;
    /** When the entry was recorded (ISO 8601). */
    readonly createdAt: string;
}
```

## dist/manifest.d.ts

```ts
/**
 * The MANIFEST half of the contract — what a pack's entry module declares.
 *
 * A pack's entry module default-exports a manifest: a declared version, the spec fragments it
 * contributes, and (optionally) the capability instances it provides. At boot the deployment
 * resolves that module, fail-closed-checks the declared version against the exact pin its
 * `extensions: [{ id, module, version }]` reference carries, jails the pack's handler root, and
 * MERGES the fragments into the deployment's own sections — after which a pack-contributed section
 * is indistinguishable from a deployment-declared one and rides the same validation, the same
 * migration gate and the same interpreters.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS PINNED HERE, AND WHAT IS DELIBERATELY NOT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Each fragment type below pins the fields the MERGE and the cross-reference resolution address it
 * by — a store's `name`, a handler's `id`/`module`/`export`/`kind`, a tool's `id`/`handler`, a
 * route's `method`/`path`, an agent's `id` — and nothing else. The REST of a section body is the
 * document grammar, which the deployment re-validates fail-closed at boot over the merged document;
 * re-stating it here would duplicate a large surface, and would make every additive grammar field a
 * breaking change to THIS package. So each fragment carries an open index signature: a fuller
 * declaration is accepted verbatim, and what it means is decided by the one validator that is
 * authoritative — the deployment's own parse pass, which reports through `PackErrorCode`.
 *
 * The identity fields are also the ones a pack MUST get right before anything can validate them:
 * an id that collides with a deployment id, or a handler `module` that does not resolve under the
 * pack root, is a boot failure rather than a type error. Ids that reach generated SQL or generated
 * TypeScript — store and column names — additionally obey the identifier rule (`isSafeIdentifier`).
 */
/**
 * The brand a pack entry's default export carries, stamped by the platform's manifest helper. A
 * loader checks it to fail-closed-reject a module that is not a manifest at all (a typo'd entry
 * path, a module jailed in by accident) instead of merging whatever the module happened to export.
 * A pack never writes the brand itself: it is a TYPE here, not a value, because this package ships
 * no runtime and the pack gets the branded value from the helper it calls.
 */
export type PackManifestBrand = '@rayspec/extension@1';
/** What a handler is wired into — the chokepoint the platform dispatches it through. */
export type PackHandlerKind = 'tool' | 'route' | 'trigger';
/** The HTTP method a contributed route handles. */
export type PackHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * A contributed store — a normal generated table that rides the deployment's migration gate. It is
 * addressed by `name`, which must be unique across the MERGED document (a collision with a
 * deployment store, or with a platform table, is refused at boot) and must satisfy the identifier
 * rule: the name is interpolated into generated SQL and generated TypeScript.
 */
export interface PackStoreFragment {
    /** The store name — unique post-merge, and a safe identifier (see `isSafeIdentifier`). */
    readonly name: string;
    /** Every other declared key of the section body, validated by the deployment's own parse pass. */
    readonly [declaredKey: string]: unknown;
}
/**
 * A contributed escape-hatch handler. `module` is resolved RELATIVE TO THE PACK ROOT — the pack's
 * own directory, never the deployment root — and jailed there, so a pack ships its handlers with
 * itself. The module is loaded as compiled JavaScript at deploy time.
 */
export interface PackHandlerFragment {
    /** The logical id contributed tooling / api entries reference. Unique post-merge. */
    readonly id: string;
    /** The handler module path, resolved and jailed under the PACK root. */
    readonly module: string;
    /** The named export within that module. */
    readonly export: string;
    /** Which chokepoint it dispatches through. */
    readonly kind: PackHandlerKind;
    /** Every other declared key of the section body, validated by the deployment's own parse pass. */
    readonly [declaredKey: string]: unknown;
}
/**
 * A contributed tool declaration. `handler` names a handler id from the MERGED `handlers` section —
 * the pack's own fragment or the deployment's — and is resolved there; a dangling reference is
 * refused at boot rather than at first call.
 */
export interface PackToolFragment {
    /** The logical id contributed agents reference in their tool list. Unique post-merge. */
    readonly id: string;
    /** A handler id, resolved against the merged `handlers` section. */
    readonly handler: string;
    /** Every other declared key of the section body, validated by the deployment's own parse pass. */
    readonly [declaredKey: string]: unknown;
}
/**
 * A contributed HTTP route. It mounts on the deployment's existing auth chain and is served by the
 * same interpreter as a deployment-declared route — a pack gets no separate routing surface.
 */
export interface PackApiRouteFragment {
    /** The method this route handles. */
    readonly method: PackHttpMethod;
    /** The route path, unique post-merge against every other declared route. */
    readonly path: string;
    /** Every other declared key of the section body, validated by the deployment's own parse pass. */
    readonly [declaredKey: string]: unknown;
}
/**
 * A contributed agent. Its backend is resolved by the DEPLOYMENT at boot (a pack ships no backend),
 * and its tool references resolve against the merged tooling section — so a pack can ship a working
 * agent without knowing which provider the deployment runs it on.
 */
export interface PackAgentFragment {
    /** The logical id, unique post-merge across the deployment's agents. */
    readonly id: string;
    /** Every other declared key of the section body, validated by the deployment's own parse pass. */
    readonly [declaredKey: string]: unknown;
}
/**
 * The five declarative sections a pack may contribute. Each is optional: a pack contributes only
 * what it ships. Every member is merged onto the deployment's own section of the same name, and the
 * merged document is validated as a whole — a fragment gets no special pass.
 */
export interface PackFragments {
    /** Contributed stores (normal generated tables; they ride the existing migration gate). */
    readonly stores?: readonly PackStoreFragment[];
    /** Contributed escape-hatch handlers (modules jailed under the PACK root). */
    readonly handlers?: readonly PackHandlerFragment[];
    /** Contributed tool declarations, wired to handler ids and resolved post-merge. */
    readonly tooling?: readonly PackToolFragment[];
    /** Contributed HTTP routes, served by the existing route interpreter. */
    readonly api?: readonly PackApiRouteFragment[];
    /** Contributed agents, whose backend the deployment resolves at boot. */
    readonly agents?: readonly PackAgentFragment[];
}
/**
 * The capability INSTANCES a pack provides — the concrete, deployment-side implementations a
 * contributed route or handler needs (a blob backend, a vendor client). Deliberately OPEN and NOT
 * frozen here: a capability is a runtime object, and this package promises TYPES. Its shape is the
 * platform's own capability contract, which the pack receives by injection and which travels with
 * the platform version the pack is pinned against — freezing a copy of it here would promise a
 * compatibility this surface cannot keep.
 */
export type PackCapabilities = {
    readonly [capability: string]: unknown;
};
/**
 * One pack manifest — the value a pack's entry module default-exports.
 *
 *  - `version`      — the pack's OWN declared version. It must equal the EXACT pin the deployment's
 *                     reference carries: a SKEW is a hard boot error, never a silent skip.
 *  - `fragments`    — the sections the pack contributes (merged into the deployment's document).
 *  - `capabilities` — the capability instances the pack provides (optional).
 */
export interface PackManifest {
    /** The pack's declared exact version — checked fail-closed against the deployment's pin. */
    readonly version: string;
    /** The declarative sections the pack contributes. */
    readonly fragments: PackFragments;
    /** The capability instances the pack provides (optional). */
    readonly capabilities?: PackCapabilities;
}
/**
 * A branded manifest — what a pack's entry module actually default-exports once it has been through
 * the platform's manifest helper, and the shape a loader accepts. A pack author names this type to
 * declare its entry module's export; it never constructs the brand.
 */
export interface DefinedPack extends PackManifest {
    /** The brand the loader checks before merging anything. */
    readonly __rayspecExtension: PackManifestBrand;
}
```
