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
// @rayspec/api-auth (deploy.ts, a kill-set file — consumed via its EXPORTS only, never edited); the
// server already depends on api-auth, so re-exporting here spares the wrapper a direct api-auth dep.
export { DeployError, type PlannedMigration } from '@rayspec/api-auth';
// The UPDATE flow: re-export the report-only drift finding type so a wrapper/test can name
// `BootedServer.drift`. It originates in @rayspec/db (drift-detect.ts); the server already depends on
// @rayspec/db, so re-exporting here spares a consumer a direct db dep. Additive — a pure type re-export.
export type { DriftFinding } from '@rayspec/db';
export { bootBanner } from './banner.js';
export {
  type AgentBackendsFactory,
  applyMigrations,
  assembleServer,
  BootConfigError,
  type BootedServer,
  DEFAULT_PORT,
  loadServerConfig,
  type ProductTableRegistrar,
  type ServerConfig,
} from './composition-root.js';
// The Product-YAML boot composition + its extraction-config helpers (deployment wiring).
// The per-agent / multi-backend extraction seam — the boot-side backend factory,
// the per-agent config-path resolver, and the fork-4 structured-output policy resolver are exported so
// a wrapper/test can assert the multi-backend wiring deterministically (no creds).
export {
  assembleExtractionInstructions,
  buildLiveAgent,
  buildSttAdapter,
  deployProductYamlSpec,
  makeExtractionBackend,
  ProductBootError,
  resolveExtractorConfigPath,
  resolveStructuredOutputMode,
  WIRED_EXTRACTION_BACKENDS,
} from './product-boot.js';
// The deployer-seam opts builder — shared by the `rayspec-serve` bin (serve.ts) AND the `rayspec deploy`
// CLI so both boot a backend-profile spec WITH agents directly from ONE builder (the sanctioned
// registerProductStores registrar + the env-driven agent-backend factory). Exported so the CLI
// (packages/app/cli/src/deploy.ts) reuses it instead of duplicating the opts logic; lives in serve-opts.ts
// (not the self-executing bin) so re-exporting it here drags in no entrypoint side effect.
export { assembleOptsFromEnv } from './serve-opts.js';
