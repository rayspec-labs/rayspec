/**
 * @rayspec/bundle — the one reader and writer of RaySpec application bundles (`.ray`) and of the
 * inner snapshot archive a migration bundle encrypts.
 *
 * The reader implements the strict ZIP profile and the hostile-input rules of the bundle contract
 * in the contract's order, streams under byte and time budgets, and never imports, evaluates or
 * executes anything from an archive. `inspectBundle` writes nothing; `extractBundle` copies into a
 * fresh private directory and removes it on any failure. The writer produces the same bytes for
 * the same input, reads its output back through the reader and moves it into place atomically.
 * Detached Ed25519 signatures of a `.ray` and of a release manifest are made and verified with
 * Node's crypto.
 *
 * Built on Node's own modules and `@rayspec/bundle-contract`, and nothing else.
 */

export {
  type BundleExtraction,
  type BundleInspection,
  DEFAULT_TIME_BUDGET_MS,
  extractBundle,
  inspectBundle,
  MANIFEST_NAME,
  type ReadOperation,
  type ReadOptions,
} from './reader.js';
export {
  isSecretPath,
  PrivateKeyScanner,
  type SecretFinding,
  type SecretRule,
} from './secrets.js';
export {
  createReleaseSignatureFile,
  createSignatureFile,
  publicKeySha256,
  releaseSignatureMessage,
  signatureMessage,
  verifyReleaseSignatureFile,
  verifySignatureFile,
} from './signature.js';
export {
  inspectSnapshotArchive,
  type SnapshotArchiveOptions,
  type SnapshotDocumentInput,
  type SnapshotEntryLocation,
  type SnapshotInspection,
  type WrittenSnapshotArchive,
  writeSnapshotArchive,
} from './snapshot.js';
export type { Clock } from './source.js';
export {
  type BundleFile,
  type BundleManifestInput,
  type WriteOptions,
  type WrittenBundle,
  writeBundle,
} from './writer.js';
