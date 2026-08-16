/**
 * The minimal extension-pack mechanism.
 *
 *  - extension.ts        the `defineExtension` manifest contract + the runtime brand (the typed
 *                        authoring surface a pack uses; the impl `loadExtensions` validates).
 *  - load-extensions.ts  `loadExtensions(refs, ctx)` — directory-only path-jailed resolution,
 *                        version-pin FAIL-CLOSED, multi-root handler jail, the top-level section
 *                        claims a manifest makes, and the merge of pack
 *                        store/handler/tooling/api fragments + capability instances into the spec
 *                        the UNCHANGED `deploy()` consumes (no new migration path; byte-unchanged
 *                        deploy/chokepoint/dispatch).
 *  - parse-with-packs.ts `parseSpecWithPacks(yaml, ctx)` — the pack-aware parse: the core grammar
 *                        plus the top-level sections the deployment's packs own, with a typed
 *                        failure when a referenced pack is not there.
 */
export {
  type DefinedExtension,
  defineExtension,
  EXTENSION_BRAND,
  type ExtensionCapabilities,
  type ExtensionManifest,
  type ExtensionSectionClaim,
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
export { parseSpecWithPacks, type SpecWithPacks } from './parse-with-packs.js';
