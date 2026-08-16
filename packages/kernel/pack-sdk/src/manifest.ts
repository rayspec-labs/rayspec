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
import type { PackServiceDeclaration } from './service.js';

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
 *
 * It is `object` rather than an index signature (`{ readonly [k: string]: unknown }`), and that is
 * load-bearing: TypeScript grants an implicit index signature to object TYPE ALIASES only, never to
 * an INTERFACE. The platform's capability contract is an interface, so an index-signature target
 * here would reject the very value the manifest helper returns — the annotation this package tells
 * a pack author to write would not compile. `object` states the one thing this package is entitled
 * to promise about the slot: something is there, and its keys are not ours to name.
 */
export type PackCapabilities = object;

/**
 * One TOP-LEVEL SECTION a pack CLAIMS — the second contribution kind, and the one that runs the other
 * way round. A fragment is content the pack ADDS to the deployment's document; a claim takes a
 * top-level key the deployment writes in its OWN document and makes the pack's schema module, not the
 * core grammar, the thing that decides whether what is written there is valid. It is how a pack is
 * CONFIGURED by a first-class section instead of through the opaque `config` blob on its
 * `extensions[]` entry, which no lint and no schema export can see into.
 *
 * Both fields are checked fail-closed at boot, naming the pack: the key must be a safe identifier
 * (`isSafeIdentifier`), it may not be a key a document grammar already owns, and no two packs may
 * claim one key. `schemaModule` is resolved under the PACK root with the same jail as a handler
 * module, and its default export only has to be able to `safeParse` a node — a pack ships in its own
 * repository and validates with its own library, so the contract is structural rather than an
 * instance of any particular validation package.
 *
 * A violation inside a claimed section is reported at `<key>.<field>` under the same closed
 * `PackErrorCode` vocabulary as a violation in any other section.
 */
export interface PackSectionClaim {
  /** The top-level document key this pack owns the grammar of. A safe identifier, unique post-merge. */
  readonly key: string;
  /** The pack-relative module whose default export validates the section node (jailed under the pack). */
  readonly schemaModule: string;
}

/**
 * The MIGRATION CHAIN a pack brings — the third contribution kind, and the only one that is not part
 * of the document at all. A `stores` fragment is a business table the platform generates and owns;
 * this is PLATFORM state the pack owns, for what a generator cannot express: hand-shaped indexes, a
 * foreign key onto a platform table, an append-only ledger.
 *
 * The chain is applied by the deployment through the SAME migrator that applies the platform's own,
 * strictly AFTER it, and journaled in a table named for the pack — so the chain restarts at `0000`
 * and is its OWN chain rather than an extension of the platform's, and neither can renumber the
 * other.
 *
 * Both fields are checked fail-closed at boot, naming the pack. `dir` is resolved under the PACK
 * root with the same jail as a handler module. `tablePrefix` is MANDATORY whenever `migrations` is
 * present: every table and index the chain creates must carry it, it may not contain a platform
 * table, and it may not overlap the prefix another pack declares — a collision is a boot failure
 * naming both parties. There is no default, because a namespace nobody declared is a namespace
 * nothing can hold the chain to.
 *
 * Write the prefix in LOWER CASE. PostgreSQL folds an unquoted identifier to lower case before it
 * names anything, so that is the only form in which a declared namespace and the objects a chain
 * creates can be compared at all; a prefix in any other case is refused fail-closed rather than
 * quietly measured against names the server never writes down.
 */
export interface PackMigrationChain {
  /** The chain directory (`.sql` files plus `meta/_journal.json`), pack-relative and jailed. */
  readonly dir: string;
  /** The namespace every table and index in the chain carries (mandatory). */
  readonly tablePrefix: string;
}

/**
 * One pack manifest — the value a pack's entry module default-exports.
 *
 *  - `version`      — the pack's OWN declared version. It must equal the EXACT pin the deployment's
 *                     reference carries: a SKEW is a hard boot error, never a silent skip.
 *  - `fragments`    — the sections the pack contributes (merged into the deployment's document).
 *  - `sections`     — the top-level document sections the pack CLAIMS the grammar of (optional;
 *                     absent = claims none). It sits beside `fragments`, not inside it, because a
 *                     claim is not content merged into the document — it is ownership of a key the
 *                     DEPLOYMENT writes.
 *  - `migrations`   — the pack's OWN migration chain for the platform tables it owns (optional;
 *                     absent = the pack owns no platform state). Beside `fragments` for the same
 *                     reason a claim is: it is not content merged into the document.
 *  - `services`     — the LONG-LIVED services the pack brings (optional; absent = brings none). The
 *                     one contribution kind the deployment BOOTS rather than calls, declared in the
 *                     order it is booted; see `PackServiceModule`. Beside `fragments` for the same
 *                     reason a claim and a chain are.
 *  - `capabilities` — the capability instances the pack provides (optional).
 */
export interface PackManifest {
  /** The pack's declared exact version — checked fail-closed against the deployment's pin. */
  readonly version: string;
  /** The declarative sections the pack contributes. */
  readonly fragments: PackFragments;
  /** The top-level document sections the pack claims the grammar of (optional). */
  readonly sections?: readonly PackSectionClaim[];
  /** The pack's own migration chain for the platform tables it owns (optional). */
  readonly migrations?: PackMigrationChain;
  /** The long-lived services the pack brings, booted in this order (optional). */
  readonly services?: readonly PackServiceDeclaration[];
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
