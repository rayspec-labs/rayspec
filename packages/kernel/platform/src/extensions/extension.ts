/**
 * The extension-pack manifest contract — the MINIMAL pack mechanism.
 *
 * An EXTENSION PACK is product code authored + versioned in its OWN repo (a product pack lives
 * outside this repo entirely; the platform stays 100% product-empty). A pack carries ALL of
 * its product: its `stores` / `handlers` / `tooling` / `api` SPEC FRAGMENTS, the top-level spec
 * SECTIONS it claims the grammar of, the MIGRATION CHAIN for the platform tables it owns, + the
 * capability INSTANCES
 * it provides (a blob backend, vendor SDK clients — serializable-shaped, sandbox-forward). A
 * deployment's `rayspec.yaml` names a pack by REFERENCE (`extensions: [{ id, module, version }]`); at
 * boot `loadExtensions` resolves the pack's `defineExtension` MANIFEST, version-pin-checks it, jails
 * its handler root, and MERGES its fragments into the deployment's spec sections + the same
 * `RolloutConfig` the UNCHANGED `deploy()` consumes — so a pack STORE rides the existing product
 * migration gate + the chokepoint probe, a pack route rides the existing api
 * interpreter, a pack handler rides the existing path-jailed loader. `deploy()` / the product
 * migration gate / `dispatchTool` / the chokepoint stay BYTE-UNCHANGED. The PLATFORM tables a pack
 * OWNS travel separately, as a migration chain of the pack's own (`migrations` below), because they
 * are not spec at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A `defineExtension` MANIFEST (not a bare default-export object).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `defineExtension(manifest)` is an IDENTITY helper a pack calls in its entry module — it gives the
 * pack author a TYPED authoring surface (so a wrong fragment shape is a tsc error at the PACK's edge)
 * and stamps a runtime BRAND on the returned object so `loadExtensions` can fail-closed-reject a
 * module whose default export is NOT a real manifest (a typo'd entry, a non-pack module path-jailed
 * by accident). It carries NO runtime behavior beyond the brand — the pack stays a pure declaration.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack runs IN OUR PROCESS (the per-tenant isolate is the before-external-exposure launch gate — see
 * LIMITATIONS.md). The path jail bounds WHICH directory a pack loads from; the `gate:handler-imports`
 * + `gate:extension-capability` tripwires (now manifest-derived — they discover the pack handler root
 * from this manifest) bound a pack handler's imports + forbid it self-constructing a raw DB/blob
 * backend. None of these is a sandbox — they are deploy-time fail-closed boundaries for a TRUSTED
 * author. Before-external-exposure hardening stays an ABSOLUTE gate.
 */
import type { BlobStoreFactory } from '@rayspec/handler-sdk';
import type {
  AgentSpecConfig,
  ApiRouteSpec,
  HandlerSpec,
  StoreSpec,
  ToolSpecConfig,
} from '@rayspec/spec';

/** The runtime brand stamped by `defineExtension` (a non-enumerable marker is overkill at N=1). */
export const EXTENSION_BRAND = '@rayspec/extension@1' as const;

/**
 * The SPEC-FRAGMENT half of a pack manifest — the five declarative sections a pack may contribute.
 * Each fragment is the SAME shape as the corresponding `RaySpec` section; `loadExtensions`
 * concatenates them onto the deployment's own sections and the MERGED spec re-validates through the
 * unchanged `deploy()` (so a fragment that collides with a deployment id / is internally malformed
 * fails fail-closed at the normal `parseSpec`/`lintSpec` gate — the pack gets no special pass).
 *
 * Pack handler `module` paths are resolved RELATIVE TO THE PACK ROOT (the pack's own directory), NOT
 * the deployment root — `loadExtensions` path-jails each against the pack root + threads the
 * resolution so the unchanged loader imports the real pack file (see `loadExtensions`).
 */
export interface ExtensionSpecFragments {
  /** Pack-contributed stores (NORMAL generated tables — no new ColumnType; ride the migration gate). */
  readonly stores?: readonly StoreSpec[];
  /** Pack-contributed escape-hatch handlers (modules jailed under the PACK root). */
  readonly handlers?: readonly HandlerSpec[];
  /** Pack-contributed declared tools (wired to pack handlers by id; lint-resolved post-merge). */
  readonly tooling?: readonly ToolSpecConfig[];
  /** Pack-contributed HTTP routes (ride the existing api interpreter incl. the stream arms). */
  readonly api?: readonly ApiRouteSpec[];
  /**
   * Pack-contributed OOTB agents. Each WRAPS the neutral `core.AgentSpec` exactly like a
   * deployment-declared agent (`AgentSpecConfig`): the pack declares its own structured-output agent,
   * its `tools[]` reference ids in the MERGED `tooling[]` (the pack's own tooling fragment + the
   * deployment's), and its `backend` is resolved at boot by the DEPLOYMENT's `agentBackendsFactory`
   * (the platform/pack ship no backend). Post-merge a pack agent is INDISTINGUISHABLE from a
   * deployment agent: it lands in the merged `spec.agents[]`, is lint-resolved (tool refs + capability)
   * + registered by `buildAgentRegistry` + run through the SAME `executeAgentRun`/`{agent}` route arm
   * (no pack special-case). So a self-contained pack can ship its OOTB agent, not just stores/handlers/
   * tooling/api (the ONE core add identified for a pack's own OOTB agent).
   */
  readonly agents?: readonly AgentSpecConfig[];
}

/**
 * The CAPABILITY-INSTANCE half — the concrete, serializable-shaped capabilities a pack PROVIDES (the
 * deployment-side impls a pack route/handler needs). At N=1 the only platform-known capability is the
 * blob backend (the stream arm reads `engine.blobFactory`). A pack that ships a `stream` route can
 * provide its OWN `blobFactory` (e.g. an S3 backend) here; absent ⇒ the composition root's default
 * (fs) backend is used. Vendor SDK clients a pack handler needs are injected the SAME way (the
 * serializable-shaped `init.ext` slot — reserved; not wired at N=1). This is the seam the design calls
 * "capability instances into the same RolloutConfig deploy() consumes".
 */
export interface ExtensionCapabilities {
  /**
   * An OPTIONAL pack-provided tenant-bound blob backend factory. When a pack ships a `stream` route
   * and provides this, the composition root injects it as `engine.blobFactory` (overriding the
   * default fs backend). The factory mints handles ALREADY bound to a tenant (the tenant-prefix +
   * path jail are the entire tenant isolation for blobs). Absent ⇒ the composition root's default.
   */
  readonly blobFactory?: BlobStoreFactory;
}

/**
 * One TOP-LEVEL SPEC SECTION the pack claims — the contribution kind that lets a pack be CONFIGURED
 * by the deployment's own document instead of through the opaque `config` blob on its `extensions[]`
 * entry, which no lint and no schema export can see into.
 *
 *  - `key`          — the top-level key the pack owns. A safe identifier, and never a key the core
 *                     grammar already owns; a second pack claiming the same key is a load failure
 *                     naming both packs (see `loadExtensions`).
 *  - `schemaModule` — the module INSIDE THE PACK whose default export validates the section node. It
 *                     is resolved by the same path jail, and preferring the same compiled `.js`
 *                     sibling, as the pack entry and every pack handler. Its default export only has
 *                     to be able to `safeParse` a node: a pack ships in its own repository and
 *                     validates with its own library, so the contract is structural, not an instance
 *                     of this repository's Zod.
 *
 * The deployment's own parse is what calls the validator — a claimed section is validated at PARSE,
 * beside every core section, and a violation inside it is reported at `<key>.<field>` with the same
 * closed codes a core section's violation carries.
 */
export interface ExtensionSectionClaim {
  /** The claimed top-level key (a safe identifier; never a key the core grammar owns). */
  readonly key: string;
  /** The pack-relative module whose default export validates the section node (path-jailed). */
  readonly schemaModule: string;
}

/**
 * The MIGRATION CHAIN a pack brings — the third contribution kind, and the one that is not spec at
 * all. A `stores` fragment is a generated business table the platform owns; this is PLATFORM state
 * the pack owns: hand-shaped indexes, a foreign key onto a platform table, an append-only ledger —
 * everything the generator does not express and that used to have no home but `packages/kernel/db`.
 *
 * The chain runs through the SAME drizzle migrator as the platform's, strictly AFTER it, journaled
 * in the pack's own `__migrations_<packId>` table — so a pack chain restarts at `0000` and neither
 * it nor the core one can renumber the other (see `applyPackMigrations` in `@rayspec/db`).
 *
 *  - `dir`         — the chain directory, resolved RELATIVE TO THE PACK ROOT and jailed there, with
 *                    the same discipline as the pack entry and every pack handler. It holds the
 *                    `.sql` files and the `meta/_journal.json` the migrator reads.
 *  - `tablePrefix` — MANDATORY, and the namespace the whole chain lives in: every table and index it
 *                    creates must carry it, and it may neither contain a platform table nor overlap
 *                    another pack's prefix. A chain with no namespace is a chain that can reach into
 *                    anything, so the field is required whenever `migrations` is present at all. It
 *                    is written in LOWER CASE — PostgreSQL folds an unquoted identifier to lower
 *                    case, so that is the one form a declared namespace and a created object can be
 *                    compared in (any other case is refused fail-closed).
 */
export interface ExtensionMigrationChain {
  /** The chain directory, pack-relative and path-jailed under the pack root. */
  readonly dir: string;
  /** The namespace every table and index in the chain carries (mandatory). */
  readonly tablePrefix: string;
}

/**
 * One extension-pack MANIFEST (the value a pack's entry module default-exports via `defineExtension`).
 *  - `version`      — the pack's OWN declared version. `loadExtensions` FAIL-CLOSED-checks it equals
 *                     the EXACT `ref.version` pin in the deployment spec (the silent-skip class:
 *                     a SKEW is a hard error, NEVER a silent skip).
 *  - `fragments`    — the spec sections the pack contributes (merged into the deployment spec).
 *  - `sections`     — the top-level spec sections the pack CLAIMS (optional; absent = claims none).
 *  - `migrations`   — the pack's OWN migration chain for the platform tables it owns (optional;
 *                     absent = the pack owns no platform state).
 *  - `capabilities` — the capability instances the pack provides (optional).
 */
export interface ExtensionManifest {
  /** The pack's declared exact version (must equal the deployment's `ref.version` pin — fail-closed). */
  readonly version: string;
  /** The declarative spec fragments the pack contributes. */
  readonly fragments: ExtensionSpecFragments;
  /** The top-level spec sections the pack claims the grammar of (optional). */
  readonly sections?: readonly ExtensionSectionClaim[];
  /** The pack's own migration chain for the platform tables it owns (optional). */
  readonly migrations?: ExtensionMigrationChain;
  /** The capability instances the pack provides (optional). */
  readonly capabilities?: ExtensionCapabilities;
}

/** A `defineExtension` result — the branded manifest `loadExtensions` validates + merges. */
export interface DefinedExtension extends ExtensionManifest {
  /** The runtime brand `loadExtensions` checks (fail-closed-rejects a non-manifest module). */
  readonly __rayspecExtension: typeof EXTENSION_BRAND;
}

/**
 * Author a pack manifest. An IDENTITY helper: it returns the manifest unchanged but (1) gives the
 * pack author a TYPED authoring surface (a wrong fragment shape is a tsc error at the pack edge) and
 * (2) stamps the runtime brand `loadExtensions` checks. A pack's ENTRY module (`index.ts` at the pack
 * root — NOT a gate-scanned handler under `handlers/`) does:
 *
 *   import { defineExtension } from '@rayspec/platform';
 *   export default defineExtension({ version: '1.0.0', fragments: { stores: […], … } });
 *
 * The pack ENTRY authors against `@rayspec/platform` (where this impl + the fragment types live — a
 * pack ships in its own repo that depends on the platform). A pack HANDLER module (under `handlers/`)
 * still imports ONLY `@rayspec/handler-sdk` (the type-only capability contract; `gate:handler-imports`
 * enforces that for the manifest-derived pack handler root). The two surfaces are deliberately
 * distinct: the entry DECLARES the pack (platform types), a handler RUNS with injected capabilities
 * (handler-sdk types).
 */
export function defineExtension(manifest: ExtensionManifest): DefinedExtension {
  return { ...manifest, __rayspecExtension: EXTENSION_BRAND };
}

/** True iff `v` is a branded `DefinedExtension` (a real `defineExtension` result). */
export function isDefinedExtension(v: unknown): v is DefinedExtension {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __rayspecExtension?: unknown }).__rayspecExtension === EXTENSION_BRAND
  );
}
