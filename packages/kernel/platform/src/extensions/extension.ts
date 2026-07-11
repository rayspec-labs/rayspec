/**
 * The extension-pack manifest contract — the MINIMAL pack mechanism.
 *
 * An EXTENSION PACK is product code authored + versioned in its OWN repo (a product pack lives
 * outside this repo entirely; the platform stays 100% product-empty). A pack carries ALL of
 * its product: its `stores` / `handlers` / `tooling` / `api` SPEC FRAGMENTS + the capability INSTANCES
 * it provides (a blob backend, vendor SDK clients — serializable-shaped, sandbox-forward). A
 * deployment's `rayspec.yaml` names a pack by REFERENCE (`extensions: [{ id, module, version }]`); at
 * boot `loadExtensions` resolves the pack's `defineExtension` MANIFEST, version-pin-checks it, jails
 * its handler root, and MERGES its fragments into the deployment's spec sections + the same
 * `RolloutConfig` the UNCHANGED `deploy()` consumes — so a pack store rides the existing migration
 * gate + the chokepoint probe (NO new migration path), a pack route rides the existing api
 * interpreter, a pack handler rides the existing path-jailed loader. `deploy()` / the migration gate /
 * `dispatchTool` / the chokepoint stay BYTE-UNCHANGED.
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
 * One extension-pack MANIFEST (the value a pack's entry module default-exports via `defineExtension`).
 *  - `version`      — the pack's OWN declared version. `loadExtensions` FAIL-CLOSED-checks it equals
 *                     the EXACT `ref.version` pin in the deployment spec (the silent-skip class:
 *                     a SKEW is a hard error, NEVER a silent skip).
 *  - `fragments`    — the spec sections the pack contributes (merged into the deployment spec).
 *  - `capabilities` — the capability instances the pack provides (optional).
 */
export interface ExtensionManifest {
  /** The pack's declared exact version (must equal the deployment's `ref.version` pin — fail-closed). */
  readonly version: string;
  /** The declarative spec fragments the pack contributes. */
  readonly fragments: ExtensionSpecFragments;
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
