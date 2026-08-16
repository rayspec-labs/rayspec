/**
 * INTEROP pins between the pack manifest a deployment loads and the manifest surface an out-of-tree
 * pack compiles against (`@rayspec/pack-sdk`).
 *
 * `@rayspec/pack-sdk` RE-EXPRESSES the manifest half of this module: it names the fields a
 * contribution is addressed by and leaves the rest of each section body open, so a pack can annotate
 * its entry export without depending on the whole platform. A re-expression is only worth anything
 * if the value this module actually produces satisfies it — and nothing here placed the two side by
 * side, so a re-expressed shape the helper's own result could not be assigned to compiled cleanly on
 * both sides and would have failed only in a pack author's repository.
 *
 * WHY A NON-TEST SOURCE FILE. `typecheck` runs `tsc -p`, whose tsconfig EXCLUDES `*.test.ts`, and
 * `test` runs `vitest run` WITHOUT `--typecheck`, so a type-level assertion in a test file would
 * assert nothing in CI. These pins live in a file the build compiles: a divergence breaks
 * `pnpm build`/`pnpm typecheck` here, loudly, at the seam that owns it. `@rayspec/pack-sdk` is a
 * DEV dependency of this package and is imported type-only, so nothing crosses into the runtime and
 * the pack surface stays a zero-dependency leaf.
 *
 * WHAT IS PINNED: the direction a pack author depends on — the value `defineExtension` returns is
 * assignable to the type the pack surface tells them to annotate it with — plus the brand literal
 * both sides spell out and the per-kind arms that make a failure name its own section. The SERVICE
 * kind is pinned in both directions, because it is the one kind where values cross the seam in both:
 * the deployment builds the boot context a pack's `boot` is annotated against, and the pack exports
 * the module this loader calls.
 *
 * WHAT IS DELIBERATELY NOT PINNED: the REVERSE direction. A value typed as `PackManifest` is NOT
 * accepted by `defineExtension`, and that is the design: the pack fragment types pin the addressing
 * fields only, so they are WIDER than the document grammar this package validates against. A pack
 * builds its manifest with `defineExtension` (which typechecks the full grammar at the pack's edge)
 * and names the pack-surface type for the RESULT. The error and journal halves of that surface are
 * re-expressions of vocabulary owned elsewhere (`@rayspec/spec`, the run journal) and are not in the
 * scope of this file.
 */
import type {
  DefinedPack,
  PackAgentFragment,
  PackApiRouteFragment,
  PackCapabilities,
  PackHandlerFragment,
  PackManifest,
  PackManifestBrand,
  PackMigrationChain,
  PackServiceContext as PackSdkServiceContext,
  PackServiceModule as PackSdkServiceModule,
  TurnDispatch as PackSdkTurnDispatch,
  PackSectionClaim,
  PackServiceDeclaration,
  PackStoreFragment,
  PackToolFragment,
} from '@rayspec/pack-sdk';
import type {
  AgentSpecConfig,
  ApiRouteSpec,
  HandlerSpec,
  StoreSpec,
  ToolSpecConfig,
} from '@rayspec/spec';
import type { TurnDispatch } from '../turn-dispatch.js';
import type {
  DefinedExtension,
  EXTENSION_BRAND,
  ExtensionCapabilities,
  ExtensionManifest,
  ExtensionMigrationChain,
  ExtensionSectionClaim,
  ExtensionServiceDeclaration,
} from './extension.js';
import type { PackServiceContext, PackServiceModule } from './pack-services.js';

/** Compile-time assertion: fails to compile unless `T` is exactly `true`. */
type Assert<_T extends true> = true;

/**
 * The authoring pattern the pack surface documents:
 *
 *     const pack: DefinedPack = defineExtension({ version: '1.0.0', fragments: { … } });
 *
 * If this arm goes red, that annotation no longer compiles in a pack's repository.
 */
type _DefinedResultIsADefinedPack = Assert<DefinedExtension extends DefinedPack ? true : false>;

/** The same for the unbranded manifest, which a pack may name for the value it hands the helper. */
type _ManifestIsAPackManifest = Assert<ExtensionManifest extends PackManifest ? true : false>;

/**
 * The capability slot. Called out on its own because it is the one member neither side can widen
 * safely by accident: an index-signature target would refuse this INTERFACE outright (TypeScript
 * grants an implicit index signature to object type aliases only), and the refusal reaches nothing
 * in this repository — only a pack author's build.
 */
type _CapabilitiesFitTheOpenSlot = Assert<
  ExtensionCapabilities extends PackCapabilities ? true : false
>;

/** Each contributed section satisfies the pack-side fragment that names its addressing fields. */
type _StoresFit = Assert<StoreSpec extends PackStoreFragment ? true : false>;
type _HandlersFit = Assert<HandlerSpec extends PackHandlerFragment ? true : false>;
type _ToolingFits = Assert<ToolSpecConfig extends PackToolFragment ? true : false>;
type _ApiRoutesFit = Assert<ApiRouteSpec extends PackApiRouteFragment ? true : false>;
type _AgentsFit = Assert<AgentSpecConfig extends PackAgentFragment ? true : false>;

/**
 * The SECTION CLAIM kind. `_ManifestIsAPackManifest` already covers it transitively now that the pack
 * surface declares the slot, but it is named on its own for the same reason each fragment arm is: a
 * failure should say which contribution kind diverged, not just that a manifest stopped fitting.
 */
type _SectionClaimsFit = Assert<ExtensionSectionClaim extends PackSectionClaim ? true : false>;

/**
 * The MIGRATION-CHAIN kind, named on its own for the same reason: the two fields a pack author
 * writes are the two the boot refuses without, so a divergence should say that the chain declaration
 * stopped fitting rather than that a manifest did.
 */
type _MigrationChainsFit = Assert<
  ExtensionMigrationChain extends PackMigrationChain ? true : false
>;

/**
 * The SERVICE kind, in the three places it can diverge.
 *
 * The DECLARATION arm is the manifest half, named on its own like every other kind. The other two are
 * the ones a pack author's build actually depends on, and they run in OPPOSITE directions on purpose:
 *
 *  - CONTEXT: the value this deployment BUILDS must satisfy the type a pack ANNOTATES its `boot`
 *    parameter with, or the pack's own `boot(ctx: PackServiceContext)` would refuse the argument the
 *    platform hands it. So the platform's context must extend the pack surface's.
 *  - MODULE: the value a pack EXPORTS must satisfy the shape this loader accepts and calls, so the
 *    pack surface's module type must extend the platform's. Pinning only one direction would leave
 *    the other free to drift into a failure that surfaces in somebody else's repository.
 */
type _ServiceDeclarationsFit = Assert<
  ExtensionServiceDeclaration extends PackServiceDeclaration ? true : false
>;
type _ServiceContextFitsWhatAPackAnnotates = Assert<
  PackServiceContext extends PackSdkServiceContext ? true : false
>;
type _APackServiceIsBootableHere = Assert<
  PackSdkServiceModule extends PackServiceModule ? true : false
>;

/**
 * The DISPATCH capability, pinned in BOTH directions. It is the one member of the service context the
 * pack surface re-expresses that has behaviour rather than shape — a widening on either side would let
 * a pack call a method this platform does not implement, or leave a platform method a pack cannot
 * reach. Naming `TurnDispatch` here also puts the identifier in a module the dispatch-boundary gate
 * has no reason to scan and every reason to leave alone: this is platform code, not a contribution.
 */
type _DispatchCapabilitiesAgree = Assert<
  TurnDispatch extends PackSdkTurnDispatch
    ? PackSdkTurnDispatch extends TurnDispatch
      ? true
      : false
    : false
>;

/**
 * Both sides spell the brand literal out. The pack surface ships no runtime, so it cannot import
 * the constant — it declares a copy, and a copy that drifts makes every loader check reject every
 * pack. Pinned in BOTH directions so neither a widening nor a narrowing passes.
 */
type _BrandLiteralsAgree = Assert<
  typeof EXTENSION_BRAND extends PackManifestBrand
    ? PackManifestBrand extends typeof EXTENSION_BRAND
      ? true
      : false
    : false
>;

// Touch the aliases so unused-locals cannot strip the pins (they are the point of the module).
const pins: [
  _DefinedResultIsADefinedPack,
  _ManifestIsAPackManifest,
  _CapabilitiesFitTheOpenSlot,
  _StoresFit,
  _HandlersFit,
  _ToolingFits,
  _ApiRoutesFit,
  _AgentsFit,
  _SectionClaimsFit,
  _MigrationChainsFit,
  _ServiceDeclarationsFit,
  _ServiceContextFitsWhatAPackAnnotates,
  _APackServiceIsBootableHere,
  _DispatchCapabilitiesAgree,
  _BrandLiteralsAgree,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

/**
 * The pins, widened. The exported TYPE is deliberately `readonly boolean[]` rather than the tuple
 * above: `@rayspec/pack-sdk` is a DEV dependency, so a declaration that named those aliases would
 * emit an `import type … from '@rayspec/pack-sdk'` into this package's shipped `.d.ts` and point a
 * consumer at a package their install does not carry. The assertions still run — they are checked
 * where `pins` is annotated — and nothing crosses the published surface.
 */
export const PACK_SDK_INTEROP_PINNED: readonly boolean[] = pins;
