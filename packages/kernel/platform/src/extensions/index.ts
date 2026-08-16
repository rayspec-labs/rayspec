/**
 * The minimal extension-pack mechanism.
 *
 *  - extension.ts        the `defineExtension` manifest contract + the runtime brand (the typed
 *                        authoring surface a pack uses; the impl `loadExtensions` validates).
 *  - load-extensions.ts  `loadExtensions(refs, ctx)` — directory-only path-jailed resolution,
 *                        version-pin FAIL-CLOSED, multi-root handler jail, the top-level section
 *                        claims a manifest makes, the pack-owned migration chain it declares, and
 *                        the merge of pack
 *                        store/handler/tooling/api fragments + capability instances into the spec
 *                        the UNCHANGED `deploy()` consumes (byte-unchanged
 *                        deploy/chokepoint/dispatch).
 *  - parse-with-packs.ts `parseSpecWithPacks(yaml, ctx)` — the pack-aware parse: the core grammar
 *                        plus the top-level sections the deployment's packs own, with a typed
 *                        failure when a referenced pack is not there.
 *  - pack-services.ts    the `services` contribution kind — the shape a service module exports, the
 *                        context it boots with, and `bootPackServices` (declaration-order boot,
 *                        reverse-order shutdown, a failing boot that names its pack).
 *  - route-namespace.ts  the route NAMESPACE a pack is confined to (`/ext/<packId>/` by default),
 *                        the containment rules two claims are compared by, and the router-normalized
 *                        shadowing check that keeps a merged route surface free of dead routes.
 */
export {
  type DefinedExtension,
  defineExtension,
  EXTENSION_BRAND,
  type ExtensionCapabilities,
  type ExtensionManifest,
  type ExtensionMigrationChain,
  type ExtensionSectionClaim,
  type ExtensionServiceDeclaration,
  type ExtensionSpecFragments,
  isDefinedExtension,
} from './extension.js';
export {
  EXTENSION_VIRTUAL_PREFIX,
  ExtensionLoadError,
  type ExtensionRefLike,
  type LoadExtensionsContext,
  type LoadedExtensions,
  loadExtensions,
} from './load-extensions.js';
export {
  bootPackServices,
  isPackServiceModule,
  type LoadedPackService,
  type PackServiceContext,
  type PackServiceDatabase,
  PackServiceError,
  type PackServiceJournal,
  type PackServiceJournalStep,
  type PackServiceModule,
  type PackServicesHandle,
} from './pack-services.js';
export { parseSpecWithPacks, type SpecWithPacks } from './parse-with-packs.js';
export {
  canonicalRoutePrefix,
  defaultPackRoutePrefix,
  isUnderRoutePrefix,
  PACK_ROUTE_PREFIX_ROOT,
  type PackContributedRoute,
  routePrefixesOverlap,
  routePrefixRefusal,
  shadowedRouteRefusal,
} from './route-namespace.js';
