/**
 * The platform's fs-source backend — the READ-ONLY, path-jailed fs `FsSource` impl + its
 * composition-root factory. The neutral `FsSource` INTERFACE lives in `@rayspec/handler-sdk` (open-core,
 * type-only); this is the concrete impl the deployer injects (like a blob backend — zero-product-code).
 */
export {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_SEARCH_RESULTS,
  FsSourceConfigError,
  FsSourceError,
  FsSourceJailError,
  makeFsSourceFactory,
} from './fs-source.js';
