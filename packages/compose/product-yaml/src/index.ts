// @rayspec/product-yaml — the Product-YAML deploy composition. `deploy` (the single
// frozen-surface touch) calls `composeProductDeploy` and maps `ProductComposeError` onto its
// DeployError vocabulary; everything about WHAT is supported lives here, reviewable outside the
// frozen surface. Product-free: all product meaning comes from the validated ProductSpec.
export {
  type CapabilityStoreComposition,
  composeCapabilityStores,
  declaresAudio,
  declaresConversationInput,
  declaresFileInput,
  declaresRecordInput,
  recordInputNormalize,
} from './capability-stores.js';
export {
  type ComposedProductDeploy,
  composeProductDeploy,
  type NodeRegistryBindings,
  type ProductYamlRollout,
  WIRED_CAPABILITIES,
} from './compose.js';
export {
  type DerivedProductStores,
  DeriveStoresError,
  deriveConflictKeys,
  deriveProductStores,
} from './derive-stores.js';
export { isProductComposeError, ProductComposeError } from './errors.js';
export {
  mountedTriggerEventDescriptors,
  requirePersistScopeInTriggerPayload,
  triggerRegistrationForWorkflow,
} from './event-vocabulary.js';
export {
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  DEFAULT_MAX_PDF_PAGES,
  DEFAULT_PDF_PARSE_TIMEOUT_MS,
  type FileParseLimits,
  type FileParseNodeConfig,
  makeFileParseNode,
  type PdfExtractOutcome,
  type PdfTextExtractor,
  type ResolvedFileParseLimits,
  resolveFileParseLimits,
} from './file-parse-node.js';
export {
  type LiveExtractionInputContext,
  type LiveExtractionNodeConfig,
  makeLiveExtractionNode,
} from './live-agent-node.js';
export {
  type LiveRecordNormalizerConfig,
  makeLiveRecordNormalizer,
  normalizeRunId,
} from './live-record-normalizer.js';
export {
  type LiveTurnResponderConfig,
  makeLiveTurnResponder,
  REPLY_RUN_MAX_ATTEMPTS,
  replyAttemptRunId,
  replyRunId,
} from './live-turn-responder.js';
export {
  applyGroundingPolicy,
  buildCollectionRows,
  type CollectionPersistOutcome,
  declaredReconcileScope,
  deriveGroundedMembers,
  type GroundingApplication,
  MaterializeError,
  type PlannedCollectionRow,
  persistCollectionRows,
  type ReconcileScope,
  type ResolvedKindMembers,
  type ResolvedMember,
  unwrapArtifactValue,
} from './materialize.js';
export {
  type ArtifactPersistNodeConfig,
  makeArtifactPersistNode,
  makeDeclaredAgentNode,
  makeGroundingPolicyNode,
  makeShapeValidationNode,
  makeSttTranscribeSessionNode,
  type SttSessionNodeConfig,
} from './nodes.js';
export { makeStoreReadNode, makeStoreWriteNode, type StoreNodeConfig } from './store-nodes.js';
