/**
 * @rayspec/api-auth — the first HTTP server (Hono OpenAPIHono app + auth services).
 *
 * Public surface: the app factory + the auth-core services it composes. At RUNTIME the request/response
 * path translates to/from RaySpec Zod DTOs only (no node-oidc-provider / jose / argon2 / Drizzle type
 * crosses the request boundary). The COMPOSITION-ROOT surface (the re-export block below) deliberately
 * exposes the assembler primitives so a deployer / boot entrypoint OUTSIDE this package can wire an app
 * `createOidcProvider` returns an `oidc-provider` `Provider`, and the store/service constructors
 * take a Drizzle `Db` — those implementation types DO cross the boundary for the ASSEMBLER only, not the
 * request/response path. Zero product code crosses either way (preserved).
 */
// the GitOps deploy command: one flow wiring the full pipeline (validate → diff →
// lint/gate → migrate → roll out → drift), abort-on-fail. Product-agnostic platform mechanism; the
// deployment supplies the DB-side seam + the AppDeps assembly (zero product code in the platform).

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Composition-root surface — for deployers / a real boot entrypoint (the deployer assembles
// AppDeps). Pure re-exports of existing platform primitives; zero product code.
//
// WHY THIS BLOCK EXISTS: a deployment / dev entrypoint OUTSIDE this package needs to ASSEMBLE an
// `AppDeps` (the stores + services + the OIDC provider) and build the running app — the same wiring
// the test harness does in-package via relative imports. These were package-internal until now; a
// real composition root (a deploy entrypoint, the dev curl-server) cannot use in-package relative
// paths, so the cohesive composition-root primitives are re-exported here. ZERO product code: every
// symbol below is a generic platform primitive (a service/store class, the app factory, a type) — no
// product table, route, agent, or domain name crosses this boundary (invariant preserved).
//
// `createAuthApp` is the documented entrypoint (CAPABILITIES.md); the store/service classes are
// the deny-by-default global-table modules the deployment instantiates against a raw `Db` (obtained
// from `makeDb` on the MAIN `@rayspec/db` surface — named only at the boot composition root; the
// `makeDb` NAME is Biome-banned in the scoped roots). A deployment's PRODUCT tables join the tenant
// chokepoint Set through the SANCTIONED validating registrar `@rayspec/db/composition`, not the raw
// `@rayspec/db/testing` seam (which stays test/gate-only).
export { createAuthApp } from './app.js';
export type {
  AgentRegistry,
  AgentRegistryEntry,
  AppDeps,
  AppEnv,
  AuthContext,
  DeclarativeEngine,
} from './app-context.js';
// the platform-generic, operator-gated, fail-closed tenant DATA-ERASURE (product rows via the
// TenantDb chokepoint + blobs via BlobStore.deleteTenant). The composition root wires it as the
// on-demand `BootedServer.eraseTenantNow` control seam (not internet-facing — pre-external-exposure hardening).
export {
  type EraseBlobOutcome,
  type EraseDryRunReason,
  type EraseResult,
  type EraseTenantOpts,
  eraseTenant,
  orderTablesChildrenFirst,
  TenantEraseError,
} from './cleanup/erase-tenant.js';
// the scheduled-cleanup orchestrator (OIDC prune LIVE + the operator-gated GDPR purge) +
// its config/result types. The composition root injects `runScheduledCleanup` as the engine-agnostic
// `SystemCleanupScheduler`'s `runCleanup()` callback so @rayspec/durable-dbos stays api-auth-free.
export {
  type CleanupConfig,
  type CleanupDeps,
  type CleanupResult,
  DEFAULT_GDPR_RETENTION_DAYS,
  formatCleanupLogLine,
  type GdprCleanupResult,
  runScheduledCleanup,
} from './cleanup/index.js';
// the declared-agent registry builder — the composition root reuses it to build the
// SAME AgentRegistry the durable worker resolves a RunJob's agentId against (so an off-request run
// resolves { backend, spec, toolFactory } identically to the sync run surface).
export {
  type BuildAgentRegistryConfig,
  buildAgentRegistry,
} from './engine/build-agent-registry.js';
export {
  type DeployConfig,
  DeployError,
  type DeployResult,
  type DeployTarget,
  deploy,
  type MigrationGateResult,
  type PlannedMigration,
  type RolloutConfig,
} from './engine/deploy.js';
// the media-token service (the playback route's distinct HS256 auth path) + the
// in-process revocation denylist. The composition root builds the service from the distinct
// RAYSPEC_MEDIA_SIGNING_KEY and injects it into the engine. Zero product vocabulary (a generic
// short-lived tenant+resource-bound bearer token).
export {
  createMediaDenylist,
  createMediaTokenService,
  type MediaTokenClaims,
  type MediaTokenDenylist,
  type MediaTokenService,
  type MediaVerifyResult,
  MIN_MEDIA_SECRET_BYTES,
} from './media/media-token.js';
export { mountOidc, OIDC_MOUNT_PATH } from './oidc/mount.js';
export { createOidcProvider, type OidcProviderOptions } from './oidc/provider.js';
export { AuthService } from './services/auth-service.js';
export { ApiKeyStore } from './stores/api-key-store.js';
export { AuditStore } from './stores/audit-store.js';
export { IdempotencyStore } from './stores/idempotency-store.js';
export { IdentityStore } from './stores/identity-store.js';
export { OrgStore } from './stores/org-store.js';
