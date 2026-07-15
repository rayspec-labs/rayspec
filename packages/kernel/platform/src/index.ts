// The fs-backed BlobStore impl + composition-root factory. The neutral
// `BlobStore` INTERFACE lives in @rayspec/handler-sdk (open-core, type-only); this is the concrete
// deployer-injected backend (tenant-bound by construction + path-jailed — the ENTIRE tenant isolation
// for blobs, which do NOT traverse the TenantDb chokepoint).

// Re-export the neutral blob CONTRACT types (defined open-core in @rayspec/handler-sdk) so a
// platform consumer (the api-auth declarative engine) can type its blob-injection seam
// against ONE package (@rayspec/platform) without adding a direct @rayspec/handler-sdk dep. These
// are TYPE-ONLY re-exports — the impl (the fs backend) is the value export above.
export type {
  BlobNotFound,
  BlobPutOpts,
  BlobRangeOpts,
  BlobReadResult,
  BlobStat,
  BlobStore,
  BlobStoreFactory,
  // The OPT-IN enriched `{handler}` route response envelope (handler-chosen status +
  // headers). Re-exported here so the api-auth route interpreter types + detects it against the one
  // @rayspec/platform package (the value guards are the value re-export just below).
  HttpResponse,
  // The declared `{handler}` ROUTE handler contract — re-exported here so a platform consumer types
  // its route handler fn/init against the one @rayspec/platform package (alongside the stream contract).
  RouteHandler,
  RouteHandlerInit,
  // The `stream` route handler contract — re-exported here so the api-auth stream
  // interpreter types its handler fn + the deploy seam against the one @rayspec/platform package.
  StreamRouteHandler,
  StreamRouteHandlerInit,
} from '@rayspec/handler-sdk';
// The VALUE builders/guards for the enriched route response (the api-auth interpreter
// imports `isHttpResponse`; a handler may import `httpResponse`). Re-exported here so a platform
// consumer needs no direct @rayspec/handler-sdk dep (mirrors the blob CONTRACT re-export above).
export { httpResponse, isHttpResponse } from '@rayspec/handler-sdk';
export {
  BlobJailError,
  BlobStoreConfigError,
  makeFsBlobStoreFactory,
} from './blob/index.js';
export type { DispatchDeps, SeqlessEventSink } from './dispatch.js';
export {
  DEFAULT_TOOL_CONCURRENCY,
  makeDispatchTool,
  Semaphore,
  toolCacheKey,
  toolIdempotencyKey,
} from './dispatch.js';
// The off-request durable spine — the NEUTRAL DurableExecutor seam (engine-agnostic).
// The DBOS engine lives in @rayspec/durable-dbos so run-core/the adapters stay DBOS-free;
// these neutral types carry NO engine reference (the asymmetry is absorbed inside the adapter).
export type {
  DurableExecutor,
  DurableJobStatus,
  EnqueueResult,
  RunJob,
} from './durable/types.js';
export type {
  DurablePersist,
  EventPipelineOptions,
  LiveSink,
} from './event-pipeline.js';
export { DEFAULT_MAX_QUEUE, EventPipeline } from './event-pipeline.js';
// The minimal extension-pack mechanism: the `defineExtension` manifest
// contract + `loadExtensions` (directory-only path-jailed resolution, version-pin FAIL-CLOSED,
// multi-root handler jail, and the merge of pack store/handler/tooling/api fragments + capability
// instances into the spec the UNCHANGED `deploy()` consumes — no new migration path).
export {
  type DefinedExtension,
  defineExtension,
  EXTENSION_BRAND,
  EXTENSION_VIRTUAL_PREFIX,
  type ExtensionCapabilities,
  ExtensionLoadError,
  type ExtensionManifest,
  type ExtensionRefLike,
  type ExtensionSpecFragments,
  isDefinedExtension,
  type LoadExtensionsContext,
  type LoadedExtensions,
  loadExtensions,
} from './extensions/index.js';
// The escape-hatch handler execution model (Option A): path-jailed loader, the
// single swappable HandlerRuntime indirection, the serializable-shaped HandlerDb facade over the
// real TenantDb chokepoint, the declared-tooling NeutralTool factory, and the route/trigger
// transaction-wrapped invocation. Composed by the api-auth declarative engine.
export {
  buildToolFactory,
  defaultImporter,
  getHandlerRuntime,
  HandlerLoadError,
  type HandlerRuntime,
  InProcessHandlerRuntime,
  invokeRouteHandler,
  invokeRouteHandlerDetached,
  invokeStreamRouteHandler,
  invokeTriggerHandler,
  jailModulePath,
  loadHandlers,
  loadHandlersMultiRoot,
  type ModuleImporter,
  makeHandlerDb,
  type ResolvedHandler,
  StoreInputError,
  setHandlerRuntime,
  type ToolFactory,
} from './handlers/index.js';
export { rehydrateConversation } from './rehydrate.js';
export type { CostContext, CostRollup, RunOptions } from './run-core.js';
export {
  isSubscriptionBilling,
  makeJournalSink,
  rollupRunCost,
  rollupTenantCost,
  runAgent,
  SUBSCRIPTION_AUTH_MODE,
} from './run-core.js';
// The run/job observability read-path (SAFE half): surfaces a run's status + taint /
// quarantine state derived ENTIRELY from the already-persisted journal/run_events/markers (no new store).
export { getRunObservability, type RunObservability } from './run-observability.js';
// The non-idempotent-taint marker: the chokepoint writes a tenant-scoped
// `idempotency_keys(scope='run_taint', key=runId)` marker BEFORE a non-idempotent tool fires; every
// automated re-run path (the in-request transient-release, the worker's at-least-once retry, an
// at-least-once cron handler) reads it to REFUSE silently re-running a run that did something irreversible.
export {
  isRunTainted,
  markRunTainted,
  RUN_TAINT_BODY_HASH,
  RUN_TAINT_SCOPE,
} from './run-taint.js';
// The triggers seam: register `spec.triggers[]` descriptors + fail-closed
// boot resolution of their agent/handler action refs. A runtime FIRE is fail-closed-rejected
// (the durable cron/event worker is deferred). Product-agnostic platform mechanism.
export {
  type RegisterTriggersConfig,
  type ResolvedTriggerAction,
  registerTriggers,
  TriggerDeferredError,
  type TriggerDescriptor,
  TriggerRegistrationError,
  TriggerRegistry,
} from './triggers/index.js';
