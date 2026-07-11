/**
 * The platform's blob backend — the fs-backed `BlobStore` impl + its composition-root
 * factory. The neutral `BlobStore` INTERFACE lives in `@rayspec/handler-sdk` (open-core, type-only);
 * this is the concrete impl the deployer injects (like an agent backend — zero-product-code).
 */
export {
  BlobJailError,
  BlobStoreConfigError,
  makeFsBlobStoreFactory,
} from './fs-blob-store.js';
