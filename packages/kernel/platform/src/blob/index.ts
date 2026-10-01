/**
 * The platform's blob backend — the fs-backed `BlobStore` impl + its composition-root
 * factory. The neutral `BlobStore` INTERFACE lives in `@rayspec/handler-sdk` (open-core, type-only);
 * this is the concrete impl the deployer injects (like an agent backend — zero-product-code). The
 * walk of a whole blob root, for the operator's snapshot, is a separate read-only entry point.
 */

export {
  BlobInventoryError,
  type BlobInventoryErrorKind,
  type FsStoredBlob,
  listFsBlobs,
  MAX_SNAPSHOT_KEY_LENGTH,
} from './fs-blob-inventory.js';
export {
  BlobJailError,
  BlobStoreConfigError,
  makeFsBlobStoreFactory,
} from './fs-blob-store.js';
