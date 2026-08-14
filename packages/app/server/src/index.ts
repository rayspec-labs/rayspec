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
// The UPDATE flow: re-export the report-only drift finding type so a wrapper/test can name
// `BootedServer.drift`. It originates in @rayspec/db (drift-detect.ts); the server already depends on
// @rayspec/db, so re-exporting here spares a consumer a direct db dep. Additive — a pure type re-export.
export type { DriftFinding } from '@rayspec/db';
// The agent trace-export posture (issue #287). Re-exported here for embedders, but the `rayspec deploy`
// CLI imports the SAME symbols through the `@rayspec/server/agent-tracing` SUBPATH instead: that module
// pulls in no adapter, so the deploy path can decide the posture — and write the SDK's switch — before
// it loads this closure and the agent SDK inside it.
export {
  type AgentTracingPosture,
  applyDeployAgentTracing,
  observedAgentTracing,
  resolveAgentTracing,
} from './agent-tracing.js';
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
  BootConfigError,
  type BootedServer,
  DEFAULT_PORT,
  detectStaticProfile,
  isStaticProfile,
  loadServerConfig,
  loadStaticServerConfig,
  loadTenantProvisionSecrets,
  type ProductTableRegistrar,
  type ServerConfig,
  type StaticBootedServer,
  type StaticServerConfig,
} from './composition-root.js';
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
  WIRED_EXTRACTION_BACKENDS,
} from './product-boot.js';
// The env-proxy dispatcher restore (issue #287) — `assembleServer` installs it at boot; the predicates
// and the installer are exported so the gate can be asserted directly (a runtime that implements
// NODE_USE_ENV_PROXY + the opt-in + a named proxy ⇒ installed; anything else ⇒ the two
// global-dispatcher symbols are left untouched).
export {
  envProxyRequested,
  installEnvProxyDispatcher,
  nodeSupportsEnvProxy,
} from './proxy-dispatcher.js';
// The deployer-seam opts builder — shared by the `rayspec-serve` bin (serve.ts) AND the `rayspec deploy`
// CLI so both boot a backend-profile spec WITH agents directly from ONE builder (the sanctioned
// registerProductStores registrar + the env-driven agent-backend factory). Exported so the CLI
// (packages/app/cli/src/deploy.ts) reuses it instead of duplicating the opts logic; lives in serve-opts.ts
// (not the self-executing bin) so re-exporting it here drags in no entrypoint side effect.
export { assembleOptsFromEnv } from './serve-opts.js';
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
