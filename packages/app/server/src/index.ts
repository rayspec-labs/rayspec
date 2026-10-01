/**
 * @rayspec/server — the LOCAL boot composition root + entrypoint.
 *
 * LOCAL / single-node / pre-external-hardening — NOT internet-facing. The external-hardening suite
 * (RLS / KMS / per-tenant sandbox / DPoP) is the gate before external exposure and is NOT built yet.
 * See the package README.
 *
 * Public surface: the composition root (assemble the platform from env, apply the committed
 * migration chain, build the app) + the env-config loader + the banner. The `serve` bin
 * (src/serve.ts → dist/serve.js, the `rayspec-serve` bin) is the runnable entrypoint; it is not
 * re-exported (it self-executes). A wrapper (e.g. examples/local-boot) imports `assembleServer` to
 * inject an AgentBackendsFactory for a spec-with-agents boot.
 */

// The UPDATE flow: re-export the deploy-migration seam types a wrapper needs to build the
// `updateMigrations` input for `assembleServer` + assert `deploy()`'s block. These originate in
// @rayspec/api-auth (deploy.ts, a frozen-surface file — consumed via its EXPORTS only, never edited); the
// server already depends on api-auth, so re-exporting here spares the wrapper a direct api-auth dep.
export { DeployError, type PlannedMigration } from '@rayspec/api-auth';
// The one redaction path, for an entrypoint that writes before (or without) a server boot.
export { installOutputRedaction, registerSecretValues } from '@rayspec/core';
// The UPDATE flow: re-export the report-only drift finding type so a wrapper/test can name
// `BootedServer.drift`. It originates in @rayspec/db (drift-detect.ts); the server already depends on
// @rayspec/db, so re-exporting here spares a consumer a direct db dep. Additive — a pure type re-export.
export type { DriftFinding } from '@rayspec/db';
// The bindings a bundle deploy grants: the application's own to its handlers (`init.bindings`), the
// provider credentials to the adapters that use them — neither through the process environment.
export { type ApplicationBindingGrant, setApplicationBindings } from '@rayspec/platform';
// age v1 encryption to one X25519 recipient (the age authors' implementation), its decryption with
// the matching identity, and the migration bundle that carries an encrypted inner snapshot archive.
export {
  AGE_X25519_ENCRYPTION,
  type DecryptedFile,
  type DecryptOptions,
  decryptFile,
  type EncryptedFile,
  EncryptionAborted,
  type EncryptOptions,
  encryptFile,
  isAgeX25519Recipient,
  parseAgeX25519Identity,
} from './age-encryption.js';
// The agent trace-export posture (issue #287). Re-exported here for embedders, but the `rayspec deploy`
// CLI imports the SAME symbols through the `@rayspec/server/agent-tracing` SUBPATH instead: that module
// pulls in no adapter, so the deploy path can decide the posture — and write the SDK's switch — before
// it loads this closure and the agent SDK inside it.
// `applyServeAgentTracing` is here for the same reason `assembleServer` is: a boot wrapper that
// assembles the server itself has to apply the posture itself, and it has already loaded this closure
// (and the agent SDK inside it) by the time it can call anything — which is precisely the case that
// function's programmatic half is written for.
export {
  type AgentTracingPosture,
  applyDeployAgentTracing,
  applyServeAgentTracing,
  observedAgentTracing,
  resolveAgentTracing,
} from './agent-tracing.js';
// Apply: a list of steps run under the operation lease with a receipt before and after each, after the
// plan, revision, fence and idempotency checks, and after reconciling what an interrupted apply left
// unsettled; a step whose outcome cannot be established blocks until an operator records it.
export {
  type ApplyCheckpoint,
  type ApplyControl,
  type ApplyOptions,
  type ApplyPlanCheck,
  type ApplyStep,
  ApplyStepRefusal,
  DEFAULT_APPLY_LEASE_TTL_MS,
  hasUnsettledApplies,
  MAX_STEP_NAME_LENGTH,
  type ObservedOutcome,
  type ReconciledOperation,
  type ResolveStepRequest,
  type ResolveStepResult,
  reconcileUnsettled,
  resolveInterruptedStep,
  runApply,
  type StateObservers,
  type StepContext,
  type StepEffect,
} from './apply-operation.js';
export { bootBanner, bootBaseUrl, staticBootBanner } from './banner.js';
// The port-collision boot refusal — shared by the `rayspec-serve` bin (serve.ts) and the `rayspec
// deploy` CLI so a taken port refuses the boot in the same actionable one-line form on both, instead
// of surfacing as an unhandled listen `'error'`. A leaf module (it imports nothing), and its message
// builder is pure, so the wording is pinned by a unit test that binds no port.
export {
  attachBindRefusal,
  type BindErrorEmitter,
  type BindRefusalOpts,
  type BindRefusalPrefix,
  bindRefusalMessage,
} from './bind-refusal.js';
// The boot's ENVIRONMENT DEMANDS — the single source of truth the boot refusals are composed from and
// the read-only `rayspec deploy --check-env` report is enumerated from. Re-exported here for embedders,
// but the CLI imports `checkBootEnv` through the `@rayspec/server/boot-env` SUBPATH instead: that module
// pulls in no adapter, no durable engine and no database driver, so a read-only environment check loads
// none of them — the same reason `agent-tracing` has a subpath of its own.
export {
  AGENT_BACKEND_DEMANDS,
  type AgentBackendDemand,
  anthropicReuseLogin,
  type BootEnvOptional,
  type BootEnvReport,
  type BootEnvRequirement,
  type BootEnvVar,
  type BootEnvVarState,
  checkBootEnv,
  declaredAgentBackends,
  declaresPlaybackRoute,
  declaresStreamRoute,
  fireableTriggers,
  PROVISION_BOOT_SECRETS,
  SERVER_BOOT_SECRETS,
} from './boot-env-demands.js';
// The boot-timeout guard — shared by the `rayspec-serve` bin (serve.ts) and the local-boot dev wrapper
// so a hung assemble step is diagnosed rather than silent. Pure (timer race); no entrypoint side effect.
export {
  BootTimeoutError,
  bootTimeoutMessage,
  DEFAULT_BOOT_TIMEOUT_MS,
  resolveBootTimeoutMs,
  withBootTimeout,
} from './boot-timeout.js';
// Deploying a bundle on a self-hosted target: the apply `rayspec deploy <file.ray>` runs, the binding
// revisions its plan is bound to, and how the deployed application's modules resolve.
export {
  type AppliedBundle,
  type ApplyBundleOptions,
  applyBundle,
  BUNDLE_DEPLOY_ACTOR,
  bindingRevisions,
  type EnvironmentIdentity,
  initialBindingRevisionKey,
  liveSchemaHead,
  planNeedsReview,
  readEnvironmentIdentity,
  SCHEMA_CHANGED_RECOVERY,
} from './bundle-deploy.js';
export { type BundleModuleResolution, installBundleModuleResolution } from './bundle-modules.js';
// The composition root. Its STATIC (frontend-only) half — `isStaticProfile` (the fail-closed shape
// predicate), `detectStaticProfile` (the read+classify wrapper the boot branches on),
// `loadStaticServerConfig` (the secret-free config) and `assembleStaticServer` (the bare app that never
// constructs the auth/DB composition) — is exported, with `staticBootBanner` above, so the `rayspec
// deploy` CLI (packages/app/cli/src/deploy.ts) branches to the SAME static boot the `rayspec-serve` bin
// takes instead of duplicating it; a frontend-only spec then boots identically on both paths.
// `detectStaticProfile` is exported for the same reason `assembleOptsFromEnv` below is: both entrypoints
// share ONE detection instead of duplicating the wrapper (a duplicated wrapper drifts).
export {
  type AgentBackendsFactory,
  applyMigrations,
  assembleServer,
  assembleStaticServer,
  assertSingleTenantBootable,
  type BeforeSchemaChangeResult,
  BootConfigError,
  type BootedServer,
  checkDatabaseIsolation,
  type DatabaseIsolationStatus,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  databaseIsolationWarning,
  detectStaticProfile,
  type ExportSourceConfig,
  type HostingPosture,
  isStaticProfile,
  loadExportSourceConfig,
  loadServerConfig,
  loadStaticServerConfig,
  loadTenantProvisionSecrets,
  MAX_SCHEMA_LOCK_TIMEOUT_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  MIGRATION_DATABASE_URL_VAR,
  PREVIOUS_API_KEY_PEPPER_VAR,
  PREVIOUS_JWT_SIGNING_KEY_VAR,
  type ProductTableRegistrar,
  parseHostingPosture,
  parseSchemaLockTimeoutMs,
  parseShutdownDrainMs,
  parseSingleTenantMode,
  SchemaNewerThanRuntimeError,
  type ServerConfig,
  SINGLE_ROLE_ISOLATION,
  SNAPSHOT_DATABASE_URL_VAR,
  type StaticBootedServer,
  type StaticServerConfig,
  validateInjectedSpec,
} from './composition-root.js';
// The legacy YAML deploy's schema changes, each run as an apply.
export {
  BOOT_ACTOR,
  bootRefusalExitCode,
  DeployApply,
  type DeployApplyOptions,
  LEGACY_DEPLOY_PLAN_FORMAT_VERSION,
  type ProductDdlStepInput,
  productDdlStep,
  RuntimeApplyError,
  schemaObservers,
} from './deploy-apply.js';
// The deployment state directory of a self-hosted bundle deployment: the deployment record, the
// active version, the immutable version directories and the plan records.
export {
  type ActiveRecord,
  DEFAULT_STATE_DIR,
  DEPLOYMENT_FORMAT_VERSION,
  type DeploymentRecord,
  newDeploymentId,
  openStateDirectory,
  protectedFileRefusal,
  readProtectedFile,
  removeTree,
  StateDirectory,
  StateDirectoryError,
  verifyVersion,
} from './deployment-state.js';
// An import: the dump's table of contents read from its bytes, the allowlist that decides what of it
// reaches the target, the migration bundle opened and checked, the target checked, restored,
// verified and fenced, and the receipts of every transition.
export {
  DumpArchiveError,
  type DumpHeader,
  type DumpToc,
  type DumpTocEntry,
  readDumpToc,
  tocListing,
} from './dump-archive.js';
export {
  type CountedTable,
  type DumpDatabase,
  type DumpPolicyInput,
  type DumpPolicyResult,
  type DumpRestorePlan,
  lexSql,
  planDumpRestore,
  type SqlToken,
} from './dump-policy.js';
// The receipts of an export (the local, shareable one and the environment's) and its scratch space.
export {
  closeInterruptedExport,
  EXPORT_ACTOR,
  type ExportDigests,
  type ExportInputs,
  type ExportReceipt,
  ExportReceiptLog,
  type ExportState,
  type ExportSummary,
  type ExportTransition,
  exportReceiptName,
  resumeInstruction,
} from './export-receipts.js';
export {
  clearInterruptedExportScratch,
  EXPORT_LOCK_NAME,
  type ExportScratch,
  type ScratchClearance,
  takeExportScratch,
} from './export-scratch.js';
// Liveness and readiness: the probes `/health` runs and the runtime-control `health()` reports.
export {
  bindingsProbe,
  databaseProbe,
  durableWorkerReadiness,
  type HealthCheck,
  type HealthCheckName,
  LIVENESS_PATH,
  type ReadinessProbe,
  runReadiness,
  type SecretFile,
  schemaProbe,
} from './health.js';
export {
  CUTOVER_TOKEN_LIFETIME_MS,
  type CutoverToken,
  closeInterruptedImport,
  discardInstruction,
  IMPORT_ACTOR,
  type ImportDigests,
  type ImportReceipt,
  ImportReceiptLog,
  type ImportRecord,
  type ImportState,
  type ImportSummary,
  type ImportTransition,
  importReceiptName,
} from './import-receipts.js';
export {
  discardImportTarget,
  type ImportTargetConfig,
  type ImportTargetFacts,
  type ImportTargetInspection,
  type ImportVerification,
  inspectImportTarget,
  type RestoredImport,
  type RestoreImportOptions,
  type RestoreImportResult,
  restoreImport,
} from './import-target.js';
export {
  type MigrationBundleInput,
  MigrationWriteAborted,
  type MigrationWriteOptions,
  type WrittenMigrationBundle,
  writeMigrationBundle,
} from './migration-bundle.js';
// The operation lease with its fencing epoch, and the append-only operation receipts: the frame a
// mutating runtime-control operation runs in (one holder at a time, intent before effect, every write
// checked against the epoch in its own transaction).
export {
  acquireOperationLease,
  appendOperationReceipt,
  findIntentByIdempotencyKey,
  type LeaseTakeover,
  type LeaseTx,
  MAX_LEASE_TTL_MS,
  type OperationIdentity,
  OperationLease,
  OperationLeaseError,
  type OperationOutcome,
  type OperationReceipt,
  type ReceiptEvent,
  type ReceiptInput,
  readOperationReceipts,
  unfinishedSteps,
} from './operation-lease.js';
// The snapshot of a fenced source, as an export takes it: the read-only preflight of everything a
// snapshot must carry or cannot carry, and the capture of the plaintext inner snapshot archive under
// the fence (the caller encrypts it). `pg_dump` is found and run by `pg-dump.ts`.
export {
  PgDumpAborted,
  PgDumpError,
  type PgDumpTool,
  pgDumpMajor,
  pgToolMajor,
  resolvePgDump,
  resolvePgTool,
} from './pg-dump.js';
export {
  type DumpSource,
  listDump,
  PgRestoreAborted,
  RESTORE_OPTIONS,
  restoreDump,
} from './pg-restore.js';
// The Product-YAML boot composition + its extraction-config helpers (deployment wiring).
// The per-agent / multi-backend extraction seam — the boot-side backend factory,
// the per-agent config-path resolver, and the fork-4 structured-output policy resolver are exported so
// a wrapper/test can assert the multi-backend wiring deterministically (no creds). `bindProductBackends`
// + the ProductBackend* types are the OPTIONAL construction seam an embedder installs through
// `assembleServer`'s `productAgentBackendsFactory` (omitting it leaves the env construction unchanged).
export {
  assembleExtractionInstructions,
  bindProductBackends,
  buildLiveAgent,
  buildSttAdapter,
  deployProductYamlSpec,
  makeExtractionBackend,
  type ProductAgentBackendsFactory,
  type ProductBackendContext,
  type ProductBackendKind,
  type ProductBackendRequirement,
  type ProductBackendSource,
  ProductBootError,
  resolveExtractorConfigPath,
  resolveStructuredOutputMode,
  validateProductYamlSpec,
  WIRED_EXTRACTION_BACKENDS,
} from './product-boot.js';
// The product migration ledger: every product schema change an environment applied, with the digests
// before and after it, read fail-closed.
export {
  type DeclaredProductStores,
  describeProductDrift,
  ledgerDrift,
  PRODUCT_LEDGER_FORMAT_VERSION,
  type ProductLedger,
  type ProductLedgerRow,
  readProductLedger,
} from './product-ledger.js';
// Product schema planning: the delta regenerated from the ledger and the spec, the shadow replay that
// computes the head after it, and the plan of a bundle's product change against the live schema.
export {
  affectedObject,
  BUNDLED_DELTA_NAME,
  DESTRUCTIVE_REVIEW_STEP,
  declaredStoresOf,
  PRODUCT_DELTA_LABEL,
  type ProductPlan,
  type ProductPlanInput,
  ProductPlanReadError,
  planProductSchema,
  productDelta,
  type ShadowDigests,
  shadowProductDigests,
  uncoveredDestructiveMessage,
} from './product-schema-plan.js';
export {
  CredentialFileError,
  type CredentialSource,
  grantProviderCredentials,
  isProviderCredentialName,
  PROVIDER_CREDENTIAL_NAMES,
  type ProviderCredentialName,
  providerCredential,
  providerCredentialSources,
  providerCredentialSupplied,
} from './provider-credentials.js';
// The env-proxy dispatcher restore (issue #287) — `assembleServer` installs it at boot; the predicates
// and the installer are exported so the gate can be asserted directly (a runtime that implements
// NODE_USE_ENV_PROXY + the opt-in + a named proxy ⇒ installed; anything else ⇒ the two
// global-dispatcher symbols are left untouched).
export {
  envProxyRequested,
  installEnvProxyDispatcher,
  nodeSupportsEnvProxy,
} from './proxy-dispatcher.js';
// The local `.env` auto-loader the `rayspec-serve` bin runs at startup (issue #384). Exported so a boot
// wrapper resolves its configuration through the SAME two-candidate search in the SAME order as the two
// documented entrypoints instead of carrying a private single-path copy — the construction that let
// those two drift apart in the first place. A leaf module (node builtins only).
export { loadLocalDotenvIfPresent } from './read-env.js';
// The runtime-control adapter — the typed library through which a deployment supervisor or the CLI
// asks a runtime what it is (`inspect`), what a bundle would do to its environment (`prepare`) and
// whether it is ready (`health`), and fences and releases its source (`quiesce`, `resume`). It mounts
// NO route: a caller holds the environment's database connection and calls it in process.
export {
  CAPABILITY_MODULES,
  createRuntimeControl,
  type HostingReport,
  type PreparedPlan,
  type PreparePlanOptions,
  preparePlan,
  providedCapabilities,
  type ReadApplicationBundle,
  type ReadApplicationBundleOptions,
  type RuntimeControlAdapter,
  type RuntimeControlOptions,
  readApplicationBundle,
  runtimeVersion,
} from './runtime-control.js';
// The source fence as one runtime process keeps it: the phases, the producers it stops and restarts,
// and the heartbeat quiesce reads.
export {
  DEFAULT_FENCE_POLL_MS,
  type FencedProducer,
  type FencePhase,
  fencedBlobStore,
  gatedProducer,
  PROCESS_LIVE_WINDOW_MS,
  queueProducer,
  RuntimeFence,
  type RuntimeFenceOptions,
} from './runtime-fence.js';
// The live two-part schema head (platform ledger tag + product schema digest), read-only.
export {
  type CatalogQuery,
  type LivePlatformHead,
  readPlatformHead,
  readProductSchemaDigest,
  readProductTables,
  readSchemaHead,
  runtimePlatformHead,
} from './schema-head.js';
// The shared schema lock every schema-mutating path takes (boot migration chain, product DDL, tenant
// ensure), with its bounded wait.
export {
  lockSchemaInTransaction,
  SchemaLockTimeoutError,
  type SchemaLockTx,
  withSchemaLock,
} from './schema-lock.js';
// The deployer-seam opts builder — shared by the `rayspec-serve` bin (serve.ts) AND the `rayspec deploy`
// CLI so both boot a backend-profile spec WITH agents directly from ONE builder (the sanctioned
// registerProductStores registrar + the env-driven agent-backend factory). Exported so the CLI
// (packages/app/cli/src/deploy.ts) reuses it instead of duplicating the opts logic; lives in serve-opts.ts
// (not the self-executing bin) so re-exporting it here drags in no entrypoint side effect.
export { assembleOptsFromEnv } from './serve-opts.js';
// The bounded graceful shutdown both entrypoints run on SIGINT/SIGTERM.
export { type DrainableServer, type ShutdownOutcome, shutdownHttpServer } from './shutdown.js';
export {
  type CaptureBarrier,
  type CapturedSnapshot,
  type CaptureResult,
  type CaptureSnapshotOptions,
  captureSnapshot,
  type ExcludedTable,
} from './snapshot-capture.js';
export {
  type ExportedSnapshot,
  type ExportSnapshotOptions,
  type ExportSnapshotResult,
  exportSnapshot,
} from './snapshot-export.js';
export {
  type ImportApplication,
  type ImportDump,
  isRestorableObjectKey,
  type OpenedMigration,
  type OpenMigrationOptions,
  type OpenMigrationResult,
  openMigrationBundle,
  type PlanDumpsOptions,
  planDumps,
} from './snapshot-import.js';
export {
  type ClassifiedTable,
  classifyApplicationTables,
  excludedDataCategories,
  identityPolicy,
  openWorkflowSystemDatabase,
  type PreflightPhase,
  preflightSnapshot,
  type RunHistoryPolicy,
  type SnapshotBlobSource,
  type SnapshotPreflight,
  type SnapshotSourceFacts,
  type SnapshotSourceOptions,
  type UnsupportedSourceState,
} from './snapshot-source.js';
// The OPERATOR tenant-provisioning path — create-or-resolve one org under a chosen id, with an owner
// handoff that leaves no platform user behind. It lives in the composition root because it is the only
// package permitted to name `makeDb`, and it is exported so the `rayspec tenant ensure` CLI can reach
// it; it mounts NO route in any posture, which is the property `tenant-provision-unreachable.db.test.ts`
// exists to keep true.
export {
  OPERATOR_INVITE_DEFAULT_TTL_SECONDS,
  type OwnerHandoff,
  provisionTenant,
  TenantProvisionError,
  type TenantProvisionInput,
  type TenantProvisionResult,
  type TenantProvisionSecrets,
} from './tenant-provision.js';
// The database write barrier a quiesce holds: the runtime role's write privileges revoked (with role
// separation), or a stopped source with no other session connected.
export {
  BarrierUnavailableError,
  CONTROL_APPLICATION_PREFIX,
  openControlDatabase,
  type RecordedGrant,
} from './write-barrier.js';
