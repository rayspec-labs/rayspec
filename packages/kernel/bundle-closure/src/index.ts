/**
 * @rayspec/bundle-closure — what goes into an application bundle, decided without running anything.
 *
 * `resolveClosure` takes a spec path and returns the explicit inclusion list of the application:
 * the spec, its compiled handler and extension modules with everything they import, its static
 * frontend output and the configuration files the runtime reads next to it, the third-party
 * packages those modules need with their licenses, a CycloneDX SBOM and the license notices, and
 * the manifest fields the spec derives. Every path stays inside the directory of the spec; links
 * out of it, unresolved and computed imports, native addons not built for linux/x64, excluded file
 * classes and private keys are refused before anything is written. `closurePreview`,
 * `closureManifest` and `closureFiles` turn a closure into the preview `rayspec pack` prints and the
 * input of the `@rayspec/bundle` writer.
 *
 * The spec checks `rayspec bundle verify` runs — parsing a bundle's spec and re-deriving its
 * manifest fields — live here too, so pack and verify derive the same fields from the same code.
 */

export {
  type Closure,
  type ClosureFile,
  type ClosureOptions,
  type ExcludedEntry,
  type FileRole,
  type PlatformImport,
  PRODUCT_ALLOWLIST_PATH,
  PRODUCT_DELTA_PATH,
  type ProductMigrationInput,
  resolveClosure,
} from './closure.js';
export { type AddonVerdict, inspectAddon, NODE_22_MODULE_VERSION } from './native.js';
export {
  type ClosurePreview,
  closureFiles,
  closureManifest,
  closurePreview,
  type PreviewEntry,
} from './preview.js';
export {
  type ExclusionClass,
  excludedDirectory,
  excludedFile,
  excludedPackageDirectory,
  excludedPackageFile,
  excludedWalkedFile,
  isDatabaseDump,
} from './rules.js';
export { noticesText, packageUrl, sbomBytes, type VendoredPackage } from './sbom.js';
export {
  type ApplicationIdentity,
  type BundleSpec,
  checkDerivedFields,
  type DerivedFields,
  deriveBindings,
  deriveManifestFields,
  networkBackends,
  parseBundleSpec,
  resolveApplicationIdentity,
} from './spec-fields.js';
