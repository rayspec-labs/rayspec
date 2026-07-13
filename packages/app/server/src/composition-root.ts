/**
 * The LOCAL boot composition root.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SCOPE — LOCAL / single-node / NOT HARDENED / NOT internet-facing.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This is the FIRST real (non-test, non-dev-spike) entrypoint that assembles the platform and
 * serves it on a port. It is deliberately LOCAL-only: the external-exposure hardening (RLS / KMS-wrapped DEKs / per-tenant
 * sandbox / DPoP) is the gate before any external exposure and is NOT built yet. Do not put
 * this behind a public address. The loud banner (`bootBanner`) and the package README say the same.
 *
 * WHAT IT DOES (the composition root is the ONE place a raw Db handle is built — app-context.ts):
 *   1. Read config from the AMBIENT environment, FAIL CLOSED on anything missing/unsafe.
 *   2. Build the one raw Db handle via `makeDb` (the production composition-root factory on the
 *      main @rayspec/db surface — NOT the /testing per-schema seam).
 *   3. Apply the committed platform migration chain via the REAL programmatic migrator
 *      (`drizzle-orm/postgres-js/migrator`), applying the from-clean-DB migration chain.
 *   4. Derive the RS256 signer + JWKS from the PEM, build the OIDC provider (PEM→JWK via jose).
 *   5. Instantiate the five global-table stores + AuthService against the raw Db.
 *   6. OPTIONALLY (a spec path is supplied) run the REAL `deploy()` GitOps pipeline to materialize
 *      the declared product stores + register the declared routes/agents — product-agnostic: the
 *      platform ships NO spec; the spec is injected by the deployer.
 *   7. Return the assembled Hono app (+ a generic `/health` readiness probe).
 *
 * PRODUCT-FREE: this module names no product table, route, agent, or domain. When a spec is
 * provided, EVERYTHING product comes from that injected spec (the deployer's `rayspec.yaml`); an
 * auth-only boot (no spec) is the default.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentRuntimeRegistry } from '@rayspec/agent-runtime';
import {
  type AgentRegistry,
  ApiKeyStore,
  type AppDeps,
  AuditStore,
  AuthService,
  buildAgentRegistry,
  type CleanupResult,
  createAuthApp,
  createMediaTokenService,
  createOidcProvider,
  DEFAULT_GDPR_RETENTION_DAYS,
  type DeclarativeEngine,
  type DeployTarget,
  deploy,
  type EraseResult,
  eraseTenant,
  IdempotencyStore,
  IdentityStore,
  OrgStore,
  type PlannedMigration,
  runScheduledCleanup,
} from '@rayspec/api-auth';
import { createSigner, JwksProvider, RateLimiter } from '@rayspec/auth-core';
import type { Backend, BackendId } from '@rayspec/core';
import {
  buildProductTables,
  classifyProductSchema,
  type Db,
  type DriftFinding,
  detectDrift,
  formatDrift,
  forTenant,
  generateProductSql,
  makeDb,
  migrationsDir,
} from '@rayspec/db';
import {
  DbosCronScheduler,
  DbosDurableExecutor,
  DEFAULT_CLEANUP_SCHEDULE,
  DEFAULT_WORKER_CONCURRENCY,
  type ResolvedRun,
  SystemCleanupScheduler,
} from '@rayspec/durable-dbos';
import {
  type BlobStoreFactory,
  type DurableExecutor,
  ExtensionLoadError,
  invokeTriggerHandler,
  type LoadedExtensions,
  loadExtensions,
  type ModuleImporter,
  makeFsBlobStoreFactory,
  type RunJob,
} from '@rayspec/platform';
import {
  detectSpecKind,
  parseAnySpec,
  parseProductSpec,
  parseSpec,
  type RaySpec,
} from '@rayspec/spec';
import type { SttAdapter } from '@rayspec/stt-port';
import type { PgTable } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { exportJWK, importPKCS8 } from 'jose';
import { stringify as stringifyYaml } from 'yaml';
import { deployProductYamlSpec } from './product-boot.js';
import { mountFrontend } from './serve-static.js';

/** The default local port (overridable via PORT). Local DX only — not a reserved well-known port. */
export const DEFAULT_PORT = 8080;

/** A built app + the metadata the entrypoint logs in its boot banner. */
export interface BootedServer {
  /** The assembled Hono app (auth routes + OIDC mount + optional declared routes + /health). */
  app: ReturnType<typeof createAuthApp>;
  /** The OIDC issuer the provider was built with. */
  issuer: string;
  /** Declared route summaries (empty for an auth-only boot) — for the banner only. */
  declaredRoutes: { method: string; path: string; action: string }[];
  /** Declared agent summaries (empty for an auth-only boot) — for the banner only. */
  declaredAgents: { id: string; backend: string; model: string }[];
  /** Declared CRON trigger names the worker scheduled (empty for no-cron) — banner only. */
  declaredCronTriggers: string[];
  /**
   * how this boot established the product schema (an additive ops signal):
   *   - `'auth-only'`   — no product stores were established — either no spec at all, OR a spec that
   *                       declares zero product stores (nothing to materialize/mount).
   *   - `'materialized'`— a spec on a CLEAN DB → the FIRST roll-out materialized the product stores.
   *   - `'mounted'`     — a spec on an ALREADY-materialized DB → mount-without-deploy ran NO product
   *                       DDL, so existing data (recordings/transcripts/intelligence) SURVIVED the boot.
   *   - `'updated'`     — the deployer supplied a reviewed forward DELTA (`updateMigrations`)
   *                       that evolved an EXISTING schema (old → new) IN PLACE — the
   *                       materialize/mount/drifted decision is bypassed (a legitimate update
   *                       reconciles a schema intentionally 'drifted' vs the NEW spec), and `deploy()`
   *                       gated + applied the delta. Existing rows SURVIVE (no drop/recreate).
   * A drifted/partially-materialized DB (WITHOUT update migrations) does not reach here —
   * `assembleServer` fails closed first.
   */
  deployMode: 'auth-only' | 'materialized' | 'mounted' | 'updated';
  /**
   * The UPDATE flow: the REPORT-ONLY drift findings `deploy()` computed post-migrate,
   * surfaced so the wrapper/tests can assert the reconciled end-state. EMPTY on every SUCCESSFUL boot:
   * a mount/materialize boot only proceeds on a non-drifted schema (so its post-deploy drift is []),
   * and an UPDATE boot whose reviewed delta UNDER-reconciles (residual drift vs the NEW spec) fails
   * closed HERE with a `BootConfigError` rather than booting green (the delta migrations are already
   * committed — the schema is mid-state — so booting green would only defer the failure to the next
   * plain reboot's `drifted` fail-close). An auth-only boot reports []. A Product-YAML boot
   * now surfaces the SAME report-only drift (empty on mount/materialize/update success; a residual
   * env-driven UPDATE delta fails closed with a `ProductBootError` inside deployProductYamlSpec).
   */
  drift: DriftFinding[];
  /**
   * Control seam — fire a declared CRON trigger ON DEMAND for an instant, through the EXACT SAME
   * reserve→dispatch path the scheduler fires on (a thin delegate to the already-wired
   * `DbosCronScheduler.fireNow`). It is generic platform CONTROL surface (it names no product
   * trigger/agent): an operator who must fire a nightly job now, the deterministic test harness, and
   * the CEO demo (which cannot wait until 2am) all need it. Returns whether THIS call won the
   * exactly-once reserve and dispatched (`true`) or was a deduped no-op (`false`). Undefined for an
   * auth-only / no-cron / no-worker boot (nothing to fire). NOT an internet-facing endpoint by itself
   * — the entrypoint does not mount it on the public app; a dev wrapper may expose it on a LOCAL
   * control route.
   */
  fireCronNow?: (name: string, instant?: Date) => Promise<boolean>;
  /**
   * Control seam — run the SYSTEM cleanup (OIDC prune + the operator-gated GDPR purge) ON
   * DEMAND, through the EXACT SAME path the daily scheduled-workflow fires on (a thin delegate to the
   * wired `SystemCleanupScheduler.runCleanupNow`). Returns the structured cleanup result (so an operator
   * sees the dry-run counts / the deleted counts; tests assert on it). Undefined for an auth-only / no
   * durable-worker boot (DBOS is not launched there, so the cleanup workflow is not wired — the documented
   * LOCAL posture). NOT internet-facing by itself; a dev/ops wrapper may expose it on a LOCAL control route.
   */
  runCleanupNow?: () => Promise<CleanupResult>;
  /**
   * the erasure control seam — ERASE a tenant's product data + blobs ON DEMAND (GDPR right-to-erasure), through
   * the platform-generic `eraseTenant` (product rows via the `forTenant` chokepoint; blobs via the
   * tenant-bound `BlobStore.deleteTenant`). The actual hard-delete is OPERATOR-GATED fail-closed: it
   * deletes only when `RAYSPEC_ERASURE_ENABLED === 'true'` (resolved at boot) AND `dryRun` is not set;
   * otherwise it returns a DRY-RUN preview (counts, ZERO deletes). Returns the structured result so an
   * operator previews before / verifies after. Undefined for an auth-only / no-product boot (a spec with
   * zero product stores). NOT internet-facing by itself — an operator/ops wrapper triggers it (pre-hardening;
   * a tenant self-service erasure route is a later, hardening-adjacent decision).
   */
  eraseTenantNow?: (tenantId: string, opts?: { dryRun?: boolean }) => Promise<EraseResult>;
  /** Close the underlying DB pool (the entrypoint wires this to SIGINT/SIGTERM). */
  close: () => Promise<void>;
}

/**
 * The validated boot configuration, derived from the environment by `loadServerConfig`. All the
 * fail-closed checks happen there; by the time you hold a `ServerConfig`, every field is present
 * and CORS is an explicit (possibly empty) allow-list.
 */
export interface ServerConfig {
  databaseUrl: string;
  /** PKCS#8 PEM (RS256) — the JWT signing key AND the OIDC provider signing key. */
  jwtSigningKeyPem: string;
  /** The api-key pepper (read by assertBootSecrets inside createAuthApp). */
  apiKeyPepper: string;
  /** The cookie-CSRF allow-list — EXPLICIT; EMPTY default (no cross-origin). Never dev-permissive. */
  allowedOrigins: string[];
  /** Deployer-injected extra CORS request headers — ALLOWED_REQUEST_HEADERS, comma-separated; empty default. */
  allowedRequestHeaders: string[];
  /** The OIDC issuer (drives emitted URLs). Defaults to http://127.0.0.1:<port>/oidc. */
  issuer: string;
  port: number;
  /**
   * OPTIONAL absolute path to a `rayspec.yaml` to deploy at boot (the declarative engine). The
   * platform ships none — the deployer injects it (RAYSPEC_SPEC_PATH). Absent ⇒ auth-only boot.
   */
  specPath?: string;
  /**
   * OPTIONAL escape-hatch handler root (the path-jail for declared handlers). Required iff the spec
   * declares handlers/tooling/{handler}-routes. Defaults to the spec file's directory.
   */
  escapeHatchRoot?: string;
  /**
   * The DBOS SYSTEM database url — a SEPARATE database from the app DB (DBOS auto-creates
   * it; it does NOT touch our `public`/app schema, so `gate:migrate-clean` is unaffected). Used only
   * when the deployed spec has `deployment.durableWorker:true`. Set explicitly via
   * DBOS_SYSTEM_DATABASE_URL, else DERIVED from databaseUrl by swapping the db name to
   * `<appdb>_dbos_sys`. Never point it at the app DB.
   */
  dbosSystemDatabaseUrl: string;
  /**
   * The tenant (org id) the deployment's CRON triggers fire under (single-deployment
   * LOCAL posture — multi-tenant cron fan-out is RESERVED, out of scope). Set via
   * RAYSPEC_CRON_TENANT_ID. REQUIRED iff the deployed spec declares cron triggers AND
   * `deployment.durableWorker:true` (a cron must fire under a known tenant — firing under an unknown
   * tenant is fail-closed-refused at boot). Absent for an auth-only / no-cron / no-worker boot.
   */
  cronTenantId?: string;
  /**
   * The LOCAL filesystem ROOT the fs `BlobStore` backend writes under (one
   * subdir per tenant — `<root>/<tenantId>/`). Set via RAYSPEC_BLOB_ROOT. REQUIRED iff the deployed
   * spec declares ANY `kind:'stream'` route (a stream route moves binary bytes through the blob
   * backend — there is nowhere to put them without a root); a stores/api/handler-only deploy omits it.
   * Whether it is required is decided at DEPLOY time (the spec is read there): `deployDeclaredSpec`
   * fail-closes if a stream route is declared without it. LOCAL/self-host — pre-hardening, not
   * internet-facing (the per-tenant prefix + path jail are the blob's tenant isolation; the real
   * sandbox is the external-exposure hardening). An S3/object-store backend is a later pack option (the interface is neutral).
   */
  blobRoot?: string;
  /**
   * The DISTINCT HS256 secret for the media-token (playback) auth path — set via
   * RAYSPEC_MEDIA_SIGNING_KEY. It is SEPARATE from the RS256 `jwtSigningKeyPem` (a leaked media URL
   * must NOT grant API access, and vice versa). REQUIRED iff the deployed spec declares a
   * `kind:'stream', mode:'playback'` route OR a mint route that uses `init.mintPlayToken` — decided at
   * DEPLOY time (`deployDeclaredSpec` fail-closes if a playback route is declared without it). Must be
   * ≥32 bytes (a short HMAC secret weakens HS256). Absent for an auth-only / no-playback deploy.
   */
  mediaSigningKey?: string;
  /**
   * The SYSTEM cleanup (OIDC prune + the operator-gated GDPR purge) configuration, ALWAYS
   * present (safe defaults). It is wired onto the durable worker's daily scheduled-workflow whenever a
   * durable worker is launched — INDEPENDENT of whether the spec declares cron triggers (it is platform
   * housekeeping, not a tenant trigger). An auth-only boot (no durable worker) does not launch DBOS, so
   * the cleanup does not run there (the documented LOCAL posture — see `SystemCleanupScheduler`).
   */
  cleanup: CleanupSettings;
  /**
   * the access-token TTL in seconds (RAYSPEC_ACCESS_TOKEN_TTL_SECONDS; default 480 = 8min). A
   * LONGER TTL unblocks long (>8min) recordings whose client can't carry the httpOnly refresh cookie,
   * but TRADEOFF: a bearer JWT is self-contained and NON-REVOCABLE until exp — the opaque session is
   * the revocation point, but the JWT is not re-checked against it per request, so a longer TTL widens
   * the window a leaked/stale token stays valid. Acceptable for a trusted/local beta; a first-class
   * desktop-refresh path is the proper fix. Fail-closed on an invalid value.
   */
  accessTokenTtlSeconds: number;
  /**
   * the OPERATOR gate for tenant DATA-ERASURE (the `eraseTenantNow` control seam). `true` ONLY when
   * RAYSPEC_ERASURE_ENABLED is EXACTLY the string `"true"`; ANYTHING else (unset, "1", "yes", "TRUE",
   * whitespace) is `false` (DISABLED → the seam returns a DRY-RUN preview, ZERO deletes). Deliberately
   * NOT a spec flag — a spec author must never be able to enable irreversible deletion. Default DISABLED.
   * Mirrors the GDPR-purge gate (`RAYSPEC_GDPR_PURGE_ENABLED`) — the irreversible action is
   * fail-closed and ENABLING it for real deletes is a deliberate operator step.
   */
  erasureEnabled: boolean;
  /**
   * The body-refresh OPERATOR gate that lets a NON-browser client opt in to receiving the rotated
   * refresh secret in the JSON body (so a desktop/CLI client can store it in OS-secure storage and
   * refresh without the httpOnly cookie). `true` ONLY when RAYSPEC_BODY_REFRESH_ENABLED is EXACTLY
   * the string `"true"`; ANYTHING else (unset, "1", "yes", "TRUE", whitespace) is `false` (DISABLED →
   * the opt-in field is ignored; the secret rides the cookie only — today's posture byte-for-byte).
   * Deliberately NOT a spec flag (mirrors the GDPR/erasure gates). Default DISABLED.
   */
  bodyRefreshEnabled: boolean;
}

/**
 * The validated cleanup knobs. Resolved by `loadServerConfig` with fail-closed/safe defaults
 * — the GDPR purge is DISABLED unless the operator sets the gate to exactly `"true"`.
 */
export interface CleanupSettings {
  /** The daily crontab the cleanup fires on (RAYSPEC_CLEANUP_SCHEDULE; default `0 3 * * *` = 3am daily). */
  schedule: string;
  /**
   * The GDPR hard-delete gate — OPERATOR-only, fail-closed. `true` ONLY when RAYSPEC_GDPR_PURGE_ENABLED
   * is EXACTLY the string `"true"`; ANYTHING else (unset, "1", "yes", "TRUE", whitespace) is `false`
   * (DISABLED → dry-run). It is deliberately NOT a spec flag — a spec author must never be able to enable
   * irreversible PII deletion. Default DISABLED.
   */
  gdprPurgeEnabled: boolean;
  /**
   * The flat retention default (days) for tombstones without a per-org `orgs.retention_days` override.
   * RAYSPEC_GDPR_RETENTION_DAYS; default 30. Fail-closed: a non-numeric / negative value aborts the boot.
   */
  gdprRetentionDays: number;
}

/** A missing/invalid env var → a fail-closed boot abort with an actionable message. */
export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootConfigError';
  }
}

/**
 * Build the (optional) agent backends a declared spec needs. The platform ships NO backend (
 * zero-product-code), so the deployer supplies the adapter instances. We keep this injectable so a
 * spec WITHOUT agents needs nothing, and a spec WITH agents has its backends wired by the caller
 * (the dev wrapper wires the OpenAI adapter from OPENAI_API_KEY). Returning an empty map is fine for
 * a stores/api-only spec.
 */
export type AgentBackendsFactory = () => ReadonlyMap<BackendId, Backend>;

/**
 * The LOCAL A1 table-registration hook (the deny-by-default chokepoint Set is keyed by object
 * IDENTITY). The composition root builds the product tables ONCE and hands those EXACT instances to
 * this hook BEFORE deploy()'s verify-not-register step, so the verify probe sees the same registered
 * objects. A REAL production deployment ships a COMMITTED `generated/product-schema.ts` that composes
 * these tables into `TENANT_SCOPED_TABLES` (so they are registered as committed source — A1) and
 * needs NO hook; this hook is the LOCAL stand-in for that committed tuple, supplied by the dev
 * wrapper via the `@rayspec/db/testing` `registerScopedTables` seam (which the product-free
 * platform must not import). A spec deploy WITHOUT this hook will abort at deploy()'s verify step
 * unless the tables are already registered as committed source — fail-closed by design.
 */
export type ProductTableRegistrar = (tables: ReadonlyMap<string, PgTable>) => void;

/**
 * Read + VALIDATE the boot config from the ambient environment, FAIL CLOSED on anything missing or
 * unsafe. This does NOT read any file or touch the DB — it only resolves + checks env, so the
 * entrypoint can surface a clean, actionable error before any side effect.
 *
 * Secrets fail closed: `assertBootSecrets` (inside createAuthApp) is the authoritative gate for the
 * two boot secrets, but we ALSO check them here so the abort message is actionable at the entrypoint
 * (and so the OIDC PEM import below has a value to work with). DATABASE_URL is required (no default —
 * a real boot must point at its DB explicitly). CORS is NEVER dev-permissive: ALLOWED_ORIGINS is an
 * explicit comma-separated list; UNSET ⇒ EMPTY (no cross-origin), never a localhost default.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) missing.push('DATABASE_URL');
  const jwtSigningKeyPem = env.RAYSPEC_JWT_SIGNING_KEY;
  if (!jwtSigningKeyPem || jwtSigningKeyPem.trim().length === 0) {
    missing.push('RAYSPEC_JWT_SIGNING_KEY');
  }
  const apiKeyPepper = env.RAYSPEC_API_KEY_PEPPER;
  if (!apiKeyPepper || apiKeyPepper.trim().length === 0) missing.push('RAYSPEC_API_KEY_PEPPER');
  if (missing.length > 0) {
    throw new BootConfigError(
      `Boot aborted — required env var(s) missing: ${missing.join(', ')}. ` +
        'DATABASE_URL is the Postgres connection string; RAYSPEC_JWT_SIGNING_KEY is the RS256 ' +
        'PKCS#8 PEM; RAYSPEC_API_KEY_PEPPER is the api-key pepper. These live in env / a secret ' +
        'manager only (never DB/git). Refusing to start (fail-closed).',
    );
  }

  const port = parsePort(env.PORT);

  // CORS: EXPLICIT allow-list, EMPTY default. A real boot NEVER silently allows a localhost origin.
  // ALLOWED_ORIGINS is comma-separated; blank entries are dropped; unset/blank ⇒ [] (no cross-origin).
  // ORIGIN-NULL-1 (hardening): ALSO drop the special tokens `null` (case-insensitive) and
  // `*`. The array feeds (a) the `cors()` array-origin, which would otherwise ECHO an allow-listed
  // `null`/`*` — granting `Access-Control-Allow-Origin: null` to OPAQUE origins (sandboxed iframes,
  // file://, data:) or a literal wildcard; and (b) the SAME list backs the cookie CSRF
  // guard (`isCsrfSafeForCookieEndpoint`), so a stray `null`/`*` (e.g. `ALLOWED_ORIGINS=null` or a
  // `,*,` typo) must never be allow-listable anywhere. These tokens are never a legitimate origin.
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o.toLowerCase() !== 'null' && o !== '*');

  // CORS: deployer-injected EXTRA request headers, appended to the platform base allow-header set. A
  // product whose native client sends a custom request header injects it here (the platform hardcodes
  // none). Comma-separated; blank entries dropped; unset/blank ⇒ [] (base set only). Unlike
  // allowedOrigins there is no null/* filtering — that is origin-specific, not header-relevant.
  const allowedRequestHeaders = (env.ALLOWED_REQUEST_HEADERS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  // The DBOS SYSTEM database url (separate DB; used only for a durableWorker spec). Set
  // explicitly via DBOS_SYSTEM_DATABASE_URL, else derive from DATABASE_URL by swapping the db name to
  // `<appdb>_dbos_sys` (DBOS auto-creates it). Fail closed on a malformed DATABASE_URL we cannot parse.
  const dbosSystemDatabaseUrl =
    env.DBOS_SYSTEM_DATABASE_URL?.trim() || deriveDbosSystemUrl(databaseUrl as string);

  // The system cleanup knobs (always present, safe defaults; the GDPR gate is fail-closed).
  const cleanup = parseCleanupSettings(env);

  // the access-token TTL (always present, default 480; fail-closed on an invalid value).
  const accessTokenTtlSeconds = parseAccessTokenTtlSeconds(env);

  // the tenant data-erasure OPERATOR gate, fail-closed: STRICTLY the exact string "true" (no
  // trim/lowercase coercion of an ambiguous value), mirroring RAYSPEC_GDPR_PURGE_ENABLED — an
  // ambiguous/typo'd value must never silently enable irreversible product+blob deletion.
  const erasureEnabled = env.RAYSPEC_ERASURE_ENABLED === 'true';

  // The body-refresh OPERATOR gate, fail-closed: STRICTLY the exact string "true"
  // (mirrors the erasure/GDPR gates) — default DISABLED, so an unset/ambiguous value keeps the
  // refresh secret on the httpOnly cookie ONLY (today's posture byte-for-byte).
  const bodyRefreshEnabled = env.RAYSPEC_BODY_REFRESH_ENABLED === 'true';

  // Non-null assertions are safe: the missing-list check above already aborted on any unset secret.
  const config: ServerConfig = {
    databaseUrl: databaseUrl as string,
    jwtSigningKeyPem: jwtSigningKeyPem as string,
    apiKeyPepper: apiKeyPepper as string,
    allowedOrigins,
    allowedRequestHeaders,
    issuer: env.OIDC_ISSUER?.trim() || `http://127.0.0.1:${port}/oidc`,
    port,
    dbosSystemDatabaseUrl,
    cleanup,
    accessTokenTtlSeconds,
    erasureEnabled,
    bodyRefreshEnabled,
  };

  const specPath = env.RAYSPEC_SPEC_PATH?.trim();
  if (specPath) {
    config.specPath = resolve(specPath);
    const handlerRoot = env.RAYSPEC_HANDLER_ROOT?.trim();
    config.escapeHatchRoot = handlerRoot ? resolve(handlerRoot) : dirname(config.specPath);
  }

  // The cron tenant (single-deployment LOCAL posture). Whether it is REQUIRED is decided
  // at deploy time (only a spec with cron triggers + a durable worker needs it) — loadServerConfig
  // just resolves it; deployDeclaredSpec fail-closes if a cron is declared without it.
  const cronTenantId = env.RAYSPEC_CRON_TENANT_ID?.trim();
  if (cronTenantId) config.cronTenantId = cronTenantId;

  // The blob root (the fs BlobStore backend). Whether it is REQUIRED is decided at deploy
  // time (only a spec with a stream route needs it) — loadServerConfig just resolves it;
  // deployDeclaredSpec fail-closes if a stream route is declared without it. Resolved to an absolute
  // path (the fs backend resolves under it; the per-tenant subdir is created lazily on first put).
  const blobRoot = env.RAYSPEC_BLOB_ROOT?.trim();
  if (blobRoot) config.blobRoot = resolve(blobRoot);

  // The distinct media signing key (HS256). Whether it is REQUIRED is decided at deploy
  // time (only a spec with a playback route needs it) — loadServerConfig just resolves it;
  // deployDeclaredSpec fail-closes if a playback route is declared without it. NOT trimmed/resolved (a
  // secret is used verbatim); only carried through when present.
  const mediaSigningKey = env.RAYSPEC_MEDIA_SIGNING_KEY;
  if (mediaSigningKey && mediaSigningKey.length > 0) config.mediaSigningKey = mediaSigningKey;

  return config;
}

/**
 * Derive the DBOS SYSTEM database url from the app DATABASE_URL by swapping the database
 * name to `<appdb>_dbos_sys` (DBOS auto-creates it; it is SEPARATE from the app DB so it never touches
 * our `public` schema). Fail closed on a URL we cannot parse. A url with no path (`/dbname`) is given
 * the default `rayspec_dbos_sys`.
 */
export function deriveDbosSystemUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BootConfigError(
      `Boot aborted — DATABASE_URL is not a valid URL, cannot derive the DBOS system database url. ` +
        'Set DBOS_SYSTEM_DATABASE_URL explicitly or fix DATABASE_URL.',
    );
  }
  const appDb = url.pathname.replace(/^\//, '');
  const sysDb = appDb.length > 0 ? `${appDb}_dbos_sys` : 'rayspec_dbos_sys';
  url.pathname = `/${sysDb}`;
  return url.toString();
}

/**
 * Resolve the system cleanup knobs from env (always returns a complete, safe-default object).
 *
 *  - RAYSPEC_CLEANUP_SCHEDULE — the daily crontab (default `0 3 * * *` = 3am daily). Blank ⇒ default.
 *  - RAYSPEC_GDPR_PURGE_ENABLED — the OPERATOR gate, fail-closed: `true` ONLY for the exact string
 *    "true". Any other value (unset, "1", "yes", "TRUE", " true ") ⇒ DISABLED. This is deliberately
 *    strict (no truthy-coercion) so an ambiguous/typo'd value never silently enables irreversible
 *    PII deletion. NOT a spec flag — a spec author must never be able to flip it.
 *  - RAYSPEC_GDPR_RETENTION_DAYS — the flat retention default (days; default 30). Fail-closed: a
 *    non-numeric or negative value ABORTS the boot (a misconfigured retention must never silently fall
 *    back — it could over- or under-retain PII).
 */
export function parseCleanupSettings(env: NodeJS.ProcessEnv): CleanupSettings {
  const schedule = env.RAYSPEC_CLEANUP_SCHEDULE?.trim() || DEFAULT_CLEANUP_SCHEDULE;
  // Fail-closed gate: STRICTLY the exact string "true" (no trim/lowercase coercion of an ambiguous value).
  const gdprPurgeEnabled = env.RAYSPEC_GDPR_PURGE_ENABLED === 'true';
  const rawRetention = env.RAYSPEC_GDPR_RETENTION_DAYS?.trim();
  let gdprRetentionDays = DEFAULT_GDPR_RETENTION_DAYS;
  if (rawRetention !== undefined && rawRetention !== '') {
    const n = Number(rawRetention);
    if (!Number.isFinite(n) || n < 0) {
      throw new BootConfigError(
        `Boot aborted — RAYSPEC_GDPR_RETENTION_DAYS='${rawRetention}' is not a non-negative number. ` +
          'It is the GDPR tombstone retention window in days (default 30). Fail-closed (a bad retention ' +
          'value must never silently fall back — it could over- or under-retain PII).',
      );
    }
    gdprRetentionDays = n;
  }
  return { schedule, gdprPurgeEnabled, gdprRetentionDays };
}

/** The default access-token TTL (seconds) when RAYSPEC_ACCESS_TOKEN_TTL_SECONDS is unset (= 8min). */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 480;
/**
 * The hard ceiling (seconds) on the access-token TTL = 24h. An access token outliving 24h defeats the
 * short-lived-JWT design (the JWT is NON-REVOCABLE until exp); a longer-lived credential is first-class-desktop-refresh
 * territory, not a TTL bump. Fail-closed above it.
 */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 86400;

/**
 * resolve the access-token TTL (seconds) from env, fail-closed on an invalid value.
 *
 *  - RAYSPEC_ACCESS_TOKEN_TTL_SECONDS — unset/blank ⇒ DEFAULT_ACCESS_TOKEN_TTL_SECONDS (480 = 8min).
 *    A value that is non-numeric, non-integer, ≤ 0, OR > MAX_ACCESS_TOKEN_TTL_SECONDS (86400 = 24h)
 *    ABORTS the boot. Fail-closed: a misconfigured TTL must never silently fall back — too short breaks
 *    long recordings, too long widens the non-revocable-token window (TRADEOFF, see ServerConfig).
 */
export function parseAccessTokenTtlSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.RAYSPEC_ACCESS_TOKEN_TTL_SECONDS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new BootConfigError(
      `Boot aborted — RAYSPEC_ACCESS_TOKEN_TTL_SECONDS='${raw}' is not a positive integer ≤ ` +
        `${MAX_ACCESS_TOKEN_TTL_SECONDS} (24h). It is the access-token lifetime in seconds (default ` +
        `${DEFAULT_ACCESS_TOKEN_TTL_SECONDS} = 8min). A bearer JWT is NON-REVOCABLE until exp, so a TTL ` +
        'above 24h defeats the short-lived-token design (that is desktop-refresh territory). ' +
        'Fail-closed (a bad TTL must never silently fall back).',
    );
  }
  return n;
}

/** Parse PORT, fail closed on a non-numeric/out-of-range value (default DEFAULT_PORT when unset). */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new BootConfigError(`Boot aborted — PORT='${raw}' is not a valid TCP port (1–65535).`);
  }
  return n;
}

/**
 * Apply the committed platform migration chain to the target DB via the REAL programmatic migrator.
 *
 * This exercises the from-clean-DB migration chain: the same chain `drizzle-kit migrate` / the
 * `gate:migrate-clean` forcing-function apply. The migrator reads `drizzle/meta/_journal.json` + the
 * .sql files and applies ALL pending migrations in a SINGLE all-or-nothing transaction (verified
 * doc-first against drizzle-orm 0.45.2: pg-core dialect wraps the whole pending set in one
 * `session.transaction(...)` — NOT a transaction per migration), recording each applied migration's
 * high-water mark in `drizzle.__drizzle_migrations` (default table/schema). The whole-chain atomicity
 * means a mid-chain failure rolls the ENTIRE batch back — never a half-applied DB. It is IDEMPOTENT:
 * `CREATE SCHEMA/TABLE IF NOT EXISTS` for the bookkeeping table + the high-water-mark skip mean a
 * re-run against an already-migrated DB is a no-op. Bootstraps a CLEAN empty DB AND no-ops
 * on an up-to-date one, so the boot is safe to run repeatedly.
 *
 * MIG-2 (concurrency): the migrator takes NO advisory lock. Two boots racing against the SAME fresh
 * empty DB would both try to apply 0000's non-`IF NOT EXISTS` CREATEs — one wins, the other's
 * transaction aborts cleanly (full rollback, no corruption). A LOCAL single-node boot does not hit
 * this; a future multi-replica deploy would gate migrations on a single runner.
 */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsDir() });
}

/**
 * Validate the cron tenant at BOOT — fail loud at startup, NOT lazily at the first
 * fire (2am). Two checks, both fail-closed:
 *   1. SHAPE — `forTenant(db, tenantId)` constructs a `TenantDb`, which THROWS the identical
 *      "tenantId must be a UUID (fail-closed)" for a malformed (non-UUID) id. We reuse it so the shape
 *      rule has a single source of truth (the TenantDb chokepoint) rather than re-deriving the regex.
 *   2. EXISTENCE — a well-formed-but-NONEXISTENT org id would otherwise pass the shape check and only
 *      explode at fire time on the `idempotency_keys.tenant_id` FK (orgs). Probe `SELECT 1 FROM orgs`
 *      so a bogus-but-valid-UUID tenant aborts the boot loudly. `deleted_at IS NULL` so a soft-deleted
 *      org is treated as absent (a cron must not fire under a tombstoned tenant).
 * Throws `BootConfigError` (the entrypoint surfaces it) — never returns a bad tenant into the scheduler.
 */
export async function assertCronTenantBootable(db: Db, cronTenantId: string): Promise<void> {
  // (1) SHAPE — TenantDb's constructor throws on a non-UUID; wrap it as a BootConfigError so the boot
  // abort is uniform + actionable.
  try {
    forTenant(db, cronTenantId);
  } catch {
    throw new BootConfigError(
      `Boot aborted — RAYSPEC_CRON_TENANT_ID='${cronTenantId}' is not a valid org UUID. A cron fires ` +
        'under a known deployment tenant (org id, 8-4-4-4-12 UUID). Fail-closed.',
    );
  }
  // (2) EXISTENCE — the org must actually exist (and not be soft-deleted), else the cron's tenant-scoped
  // reserve INSERT would fail at fire time on the orgs FK. Probe at boot so it fails loud now.
  const rows = (await db.$client.unsafe(
    'SELECT 1 FROM orgs WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [cronTenantId],
  )) as unknown as unknown[];
  if (rows.length === 0) {
    throw new BootConfigError(
      `Boot aborted — RAYSPEC_CRON_TENANT_ID='${cronTenantId}' is a well-formed UUID but no such ` +
        'active org exists. A cron fires under an existing deployment tenant; provision the org (or ' +
        'point RAYSPEC_CRON_TENANT_ID at an existing org id) before deploying a cron. Fail-closed.',
    );
  }
}

/**
 * Assemble the full platform app from a validated `ServerConfig`. Builds the raw Db, applies the
 * migration chain, derives the signer/JWKS + OIDC provider from the PEM, wires the five stores +
 * AuthService, optionally runs the REAL `deploy()` for an injected spec, and returns the running app
 * (+ a generic `/health` probe + a `close()` that ends the DB pool).
 *
 * `agentBackendsFactory` is injected (the platform ships no backend): a spec WITH agents needs
 * it; an auth-only or stores/api-only boot can omit it. The function is product-agnostic — it never
 * names a product table/route/agent; all product comes from the injected spec.
 */
export async function assembleServer(
  config: ServerConfig,
  opts: {
    agentBackendsFactory?: AgentBackendsFactory;
    /** LOCAL A1 stand-in — register the built product tables (the dev wrapper supplies this). */
    registerProductTables?: ProductTableRegistrar;
    /**
     * The deterministic Product-YAML extraction executor for
     * `RAYSPEC_EXTRACTION_MODE=deterministic` (dev/CI — the platform ships none). Ignored for the
     * classic boot + for live extraction.
     */
    productDeterministicAgents?: AgentRuntimeRegistry;
    /**
     * the deterministic conversation REPLY Backend for
     * `RAYSPEC_RESPONDER_MODE=deterministic` (dev/CI — the injected-Backend proof; the
     * responder config path still resolves/validates). Ignored for the classic boot + live replies.
     */
    productDeterministicResponderBackend?: Backend;
    /** A deployment-supplied STT adapter for a Product-YAML boot (dev/CI — else STT_PROVIDER). */
    productSttAdapter?: SttAdapter;
    /**
     * The UPDATE flow: reviewed forward DELTA migration(s) to apply to an EXISTING
     * (the backend-profile RaySpec) schema, each carrying its own reviewed destructive-statement
     * allowlist (empty for a purely-additive delta). When present, the materialize/mount/
     * drifted decision is BYPASSED and THESE migrations are handed to `deploy()`'s `DeployConfig.
     * migrations` seam — so `deploy()` gates them (a destructive statement without a covering
     * allowlist BLOCKS with a `DeployError` at `lint/gate`) then applies them, evolving the schema in
     * place while existing rows survive. Only the backend deploy path consumes this; a
     * product boot ignores it (a product doc never reaches the local-boot wrapper).
     */
    updateMigrations?: PlannedMigration[];
  } = {},
): Promise<BootedServer> {
  // The two boot secrets must be in process.env for assertBootSecrets (inside createAuthApp) +
  // the api-key pepper module. loadServerConfig already validated them; mirror them onto process.env
  // in case the caller passed a config not sourced from process.env.
  process.env.RAYSPEC_JWT_SIGNING_KEY = config.jwtSigningKeyPem;
  process.env.RAYSPEC_API_KEY_PEPPER = config.apiKeyPepper;

  // 1. The ONE raw Db handle (composition root — app-context.ts). Production factory, not /testing.
  const db = makeDb(config.databaseUrl);

  // 2. Apply the committed migration chain (idempotent — safe to re-run).
  await applyMigrations(db);

  // 3. Signer + JWKS + OIDC provider — all from the SAME RS256 PEM. The signer mints with the
  //    configured access-token TTL (default 480s — the boot env, fail-closed-validated above).
  const signer = await createSigner(config.jwtSigningKeyPem, 'RS256', config.accessTokenTtlSeconds);
  const jwks = new JwksProvider([signer.publicKeyJwk()]);
  // The OIDC provider needs the private JWK form (sig/RS256) — derive it from the same PEM.
  const privateKey = await importPKCS8(config.jwtSigningKeyPem, 'RS256', { extractable: true });
  const providerJwk = await exportJWK(privateKey);
  const oidcProvider = createOidcProvider({
    issuer: config.issuer,
    db,
    jwks: { keys: [{ ...providerJwk, use: 'sig', alg: 'RS256' }] },
    clients: [],
    proxy: true,
  });

  // 4. The five global-table stores (deny-by-default predicate-exempt modules) + AuthService.
  const identityStore = new IdentityStore(db);
  const orgStore = new OrgStore(db);
  const apiKeyStore = new ApiKeyStore(db);
  const auditStore = new AuditStore(db);
  const idempotency = new IdempotencyStore(db);
  const authService = new AuthService(identityStore, signer);

  const baseDeps: Omit<AppDeps, 'engine'> = {
    db,
    signer,
    jwks,
    rateLimiter: new RateLimiter(),
    identityStore,
    orgStore,
    apiKeyStore,
    auditStore,
    idempotency,
    authService,
    oidcProvider,
    // EXPLICIT, possibly-empty allow-list — never dev-permissive (loadServerConfig enforced this).
    allowedOrigins: config.allowedOrigins,
    // Deployer-injected extra CORS request headers (ALLOWED_REQUEST_HEADERS); [] ⇒ base set only.
    allowedRequestHeaders: config.allowedRequestHeaders,
    // The body-refresh operator gate (default false ⇒ cookie-only, today's posture).
    bodyRefreshEnabled: config.bodyRefreshEnabled,
  };

  let app: ReturnType<typeof createAuthApp>;
  let declaredRoutes: BootedServer['declaredRoutes'] = [];
  let declaredAgents: BootedServer['declaredAgents'] = [];
  let declaredCronTriggers: BootedServer['declaredCronTriggers'] = [];
  // the product-schema boot mode (auth-only until a spec deploy sets it to materialized/mounted).
  let deployMode: BootedServer['deployMode'] = 'auth-only';
  // The report-only drift findings (empty on every successful boot — the backend
  // and the product deploy paths both populate it; a non-empty update-mode drift fails closed
  // inside deployDeclaredSpec / deployProductYamlSpec before we reach here).
  let drift: BootedServer['drift'] = [];
  // A durable-worker shutdown hook to drain DBOS on close() (undefined when none wired).
  let durableExecutorShutdown: (() => Promise<void>) | undefined;
  // Control seam: the on-demand cron-fire delegate (undefined for an auth-only / no-cron boot).
  let fireCronNow: BootedServer['fireCronNow'];
  // M1 control seam: the on-demand cleanup delegate (undefined for an auth-only / no durable-worker boot).
  let runCleanupNow: BootedServer['runCleanupNow'];
  // the erasure control seam: the on-demand tenant data-erasure delegate (undefined for an auth-only / no-product boot).
  let eraseTenantNow: BootedServer['eraseTenantNow'];

  // Dispatch the injected spec by its PROFILE through the unified `parseAnySpec` — a product-profile
  // doc (`version:'1.0'` + a `product:` section) composes the product deploy (6a); a backend-profile
  // `rayspec.yaml` runs the GitOps deploy() pipeline (6b); no spec ⇒ auth-only. `parseAnySpec`/
  // `detectSpecKind` key on the `product:` discriminant, and each per-profile deploy path re-parses +
  // fail-closed-validates the doc itself (deployProductYamlSpec / deployDeclaredSpec).
  const specParse = config.specPath
    ? parseAnySpec(readFileSync(config.specPath, 'utf8'))
    : undefined;
  const specDispatchKind = specParse?.kind;

  if (config.specPath && specDispatchKind === 'product') {
    // 6a. A Product-YAML document composes the product deploy END-TO-END
    //     (derived store bindings, STT adapter, live/deterministic extraction, media-prep, and the
    //     REAL DbosWorkflowExecutor + resolveWorkflowRun) and serves it — the env-driven boot the
    //     the earlier family guard used to abort. The classic path (6b) is untouched.
    const deployed = await deployProductYamlSpec(db, config, baseDeps, {
      registerProductTables: opts.registerProductTables,
      ...(opts.productDeterministicAgents
        ? { deterministicAgents: opts.productDeterministicAgents }
        : {}),
      ...(opts.productSttAdapter ? { sttAdapter: opts.productSttAdapter } : {}),
      ...(opts.productDeterministicResponderBackend
        ? { deterministicResponderBackend: opts.productDeterministicResponderBackend }
        : {}),
    });
    app = deployed.app;
    declaredRoutes = deployed.declaredRoutes;
    declaredAgents = deployed.declaredAgents;
    declaredCronTriggers = deployed.declaredCronTriggers;
    deployMode = deployed.deployMode;
    // Surface the Product-YAML boot's report-only drift (empty on a successful mount/
    // materialize/update boot; a residual env-driven UPDATE drift fails closed INSIDE
    // deployProductYamlSpec before returning). Mount/materialize stays [] — byte-identical observable.
    drift = deployed.drift;
    durableExecutorShutdown = deployed.durableExecutorShutdown;
    eraseTenantNow = deployed.eraseTenantNow;
  } else if (config.specPath) {
    // 6b. A classic rayspec.yaml → run the REAL deploy() GitOps pipeline (validate → diff → lint/gate
    //    → migrate → roll out → drift). Product-agnostic: the spec is the injected deployer artifact.
    const deployed = await deployDeclaredSpec(db, config, baseDeps, {
      agentBackendsFactory: opts.agentBackendsFactory,
      registerProductTables: opts.registerProductTables,
      ...(opts.updateMigrations ? { updateMigrations: opts.updateMigrations } : {}),
    });
    app = deployed.app;
    declaredRoutes = deployed.declaredRoutes;
    declaredAgents = deployed.declaredAgents;
    declaredCronTriggers = deployed.declaredCronTriggers;
    deployMode = deployed.deployMode;
    drift = deployed.drift;
    durableExecutorShutdown = deployed.durableExecutorShutdown;
    fireCronNow = deployed.fireCronNow;
    runCleanupNow = deployed.runCleanupNow;
    eraseTenantNow = deployed.eraseTenantNow;
  } else {
    // Auth-only boot (the platform main line). No engine, no declared routes, no durable worker.
    app = createAuthApp(baseDeps);
  }

  // 7. A generic readiness probe. Registered AFTER createAuthApp so it sits on the same app; it is
  //    PUBLIC (the authenticate middleware does not 401 by itself) and PRODUCT-FREE. A real GET
  //    /health round-trips the DB so the probe reflects DB reachability, not just process liveness.
  app.get('/health', async (c) => {
    try {
      await db.$client`select 1`;
      return c.json({ status: 'ok', db: 'ok' }, 200);
    } catch {
      return c.json({ status: 'degraded', db: 'unreachable' }, 503);
    }
  });

  // 8. Mount the deployed spec's declared static frontend(s) — registered LAST (after every
  //    API/auth/OIDC route + /health) so a static miss never shadows an API path: Hono runs matching
  //    handlers in registration order, a returning handler terminates, and a static miss falls through
  //    to the uniform 404. Only a backend-profile (`rayspec`) doc carries `frontend`; a product-profile
  //    doc has none. `deployDeclaredSpec` already fail-closed on a missing/unreadable dir (below), so the
  //    dirs are readable here. The spec value is the SAME `frontend` a pack merge leaves untouched.
  const frontend =
    specParse?.ok && specParse.kind === 'rayspec' ? specParse.spec.frontend : undefined;
  if (config.specPath && frontend && frontend.length > 0) {
    mountFrontend(app, frontend, dirname(config.specPath));
  }

  return {
    app,
    issuer: config.issuer,
    declaredRoutes,
    declaredAgents,
    declaredCronTriggers,
    deployMode,
    drift,
    ...(fireCronNow ? { fireCronNow } : {}),
    ...(runCleanupNow ? { runCleanupNow } : {}),
    ...(eraseTenantNow ? { eraseTenantNow } : {}),
    close: async () => {
      // Drain the durable worker FIRST (finish in-flight jobs, stop dequeuing) so a
      // shutdown does not orphan a job, THEN end the app DB pool. Swallow a worker-shutdown error so
      // the DB pool still closes (a noisy shutdown must not leak a pooled connection).
      if (durableExecutorShutdown) await durableExecutorShutdown().catch(() => {});
      await db.$client.end();
    },
  };
}

/** The result of resolving + merging the spec's referenced extension packs. */
interface MergedExtensions {
  /** The effective spec (deployment sections ⊕ pack fragments) — what every downstream step sees. */
  readonly spec: RaySpec;
  /** The re-serialized YAML for the merged spec — `deploy()` re-parses + re-validates THIS. */
  readonly specSource: string;
  /** The multi-root importer for `rollout.importer` (undefined when no packs were loaded — no-op). */
  readonly extensionImporter?: ModuleImporter;
  /** A pack-provided blob backend (undefined when no pack provided one — the default fs is used). */
  readonly packBlobFactory?: BlobStoreFactory;
}

/**
 * Resolve + merge the spec's referenced extension packs. When `extensions[]` is
 * EMPTY this is a strict NO-OP (the original spec + source pass through unchanged, no importer). When
 * packs are present, `loadExtensions` resolves each (DIRECTORY-ONLY path-jailed, version-pin
 * FAIL-CLOSED, pack-handler-jailed) and returns the merged fragments + a multi-root importer + any
 * provided capability instances. We concatenate the pack fragments onto the DEPLOYMENT's own sections,
 * RE-SERIALIZE the merged spec to YAML (so `deploy()` re-parses + re-validates it through the SAME
 * parseSpec/lintSpec gate — a pack fragment gets no special pass), and re-parse it ourselves to obtain
 * the typed merged `RaySpec` the downstream derivations use. A merge that produces an invalid
 * spec (a pack store colliding with a deployment id, a dangling pack tool→handler ref) FAILS CLOSED at
 * that re-parse (an actionable BootConfigError), exactly as a hand-written invalid spec would.
 *
 * `packsRoot` = the deployment's escape-hatch root (a pack referenced by a relative dir resolves under
 * it); a real pack in its own repo is referenced relative to that root or via an explicit packs root.
 * The pack's manifest entry file is `index.ts` (the directory-MVP convention).
 */
async function mergeExtensions(
  baseSpec: RaySpec,
  baseSpecSource: string,
  packsRoot: string,
  specPath: string,
): Promise<MergedExtensions> {
  // Absent / empty extensions ⇒ a true no-op (the original spec + source, no importer). This is the
  // platform main line + every non-pack deployment — zero behavior change.
  if (baseSpec.extensions.length === 0) {
    return { spec: baseSpec, specSource: baseSpecSource };
  }

  let loaded: LoadedExtensions;
  try {
    loaded = await loadExtensions(baseSpec.extensions, {
      packsRoot,
      deploymentRoot: packsRoot,
      importer: undefined, // the real path-jailed dynamic import
    });
  } catch (e) {
    if (e instanceof ExtensionLoadError) {
      throw new BootConfigError(
        `Boot aborted — extension-pack load failed for the spec at ${specPath}: ${e.message}`,
      );
    }
    throw e;
  }

  // Concatenate the pack fragments onto the deployment's own sections. The pack handler `module` paths
  // were rewritten by loadExtensions to jail-safe virtual paths the multi-root importer redirects.
  const mergedPlain = {
    ...baseSpec,
    stores: [...baseSpec.stores, ...loaded.stores],
    handlers: [...baseSpec.handlers, ...loaded.handlers],
    tooling: [...baseSpec.tooling, ...loaded.tooling],
    api: [...baseSpec.api, ...loaded.api],
    // Pack-contributed OOTB agents merge EXACTLY like the other sections. Post-merge a pack
    // agent is indistinguishable from a deployment agent — `buildAgentRegistry` (invoked from deploy()'s
    // buildApp against `engine.spec` = THIS merged spec) registers it, the lint resolves its tool refs
    // against the merged `tooling[]`, and the run surface / durable worker resolve it identically.
    agents: [...baseSpec.agents, ...loaded.agents],
    // `extensions[]` is consumed here — drop it from the merged spec so deploy()'s re-parse does not
    // try to re-resolve the packs (the merge already happened; the refs are spent).
    extensions: [],
  };

  // Re-serialize → YAML so deploy() re-parses + re-validates the MERGED spec (no special pass). Then
  // re-parse it ourselves to get the typed merged spec the downstream derivations consume.
  const mergedSource = stringifyYaml(mergedPlain);
  const reparsed = parseSpec(mergedSource);
  if (!reparsed.ok) {
    throw new BootConfigError(
      `Boot aborted — the spec at ${specPath} merged with its extension packs is invalid (a pack ` +
        'fragment collided with a deployment declaration, or a pack cross-reference is dangling):\n' +
        JSON.stringify(reparsed.errors, null, 2),
    );
  }

  return {
    spec: reparsed.value,
    specSource: mergedSource,
    extensionImporter: loaded.importer,
    ...(loaded.capabilities.blobFactory
      ? { packBlobFactory: loaded.capabilities.blobFactory }
      : {}),
  };
}

/**
 * DOCUMENT-PROFILE DISPATCH at BOOT. A product-profile doc
 * (`version:'1.0'` + a `product:` section) is a DIFFERENT document from a backend `rayspec.yaml` — it
 * declares product MEANING. It IS mountable through the `deploy()` API, but ONLY with a deployer-supplied
 * `rollout.productYaml` composition (STT adapter, agent handlers, workflow enqueuer, store bindings —
 * deployment wiring this env-driven boot path does not assemble; the `deploy()` composition path owns
 * that). Detect the family up-front and abort with helpful guidance, instead of letting the doc hit
 * `parseSpec`'s RaySpec strict-shape wall (a wall of `unknown_field` errors). A classic
 * RaySpec / version-less doc detects as `rayspec`/`unknown` and returns WITHOUT throwing (boot
 * proceeds unchanged, byte-identical to the prior behavior). Exported so the guard is unit-testable
 * without a full DB-backed boot.
 */
export function assertSpecFamilyMountable(specSource: string, specPath: string): void {
  if (detectSpecKind(specSource) !== 'product') return;
  const product = parseProductSpec(specSource);
  if (!product.ok) {
    throw new BootConfigError(
      `Boot aborted — Product-YAML spec at ${specPath} is invalid ` +
        `(${product.errors.length} error(s)):\n${JSON.stringify(product.errors, null, 2)}`,
    );
  }
  throw new BootConfigError(
    `Boot aborted — spec '${product.value.product.id}' at ${specPath} is a valid Product-YAML document. ` +
      'It deploys through the deploy() API with a deployer-supplied rollout.productYaml composition ' +
      '(STT adapter, agent handlers, workflow enqueuer, store bindings are deployment wiring); ' +
      'this env-driven boot path does not assemble that composition, so the doc is not mountable from ' +
      'RAYSPEC_SPEC_PATH. Use `rayspec doctor`/`plan` to validate it.',
  );
}

/**
 * Run the REAL `deploy()` GitOps pipeline for an injected spec (product-agnostic). Mirrors the dev
 * wrapper's pattern but lives in the composition root so a real deployer can drive a declarative
 * deploy from env alone. The deployer supplies the agent backends (the platform ships none).
 *
 * NOTE on the A1 tuple: a REAL production deployment commits a generated `product-schema.ts` that
 * composes the product tables into `TENANT_SCOPED_TABLES`, and deploy() VERIFIES-not-registers. This
 * LOCAL boot does not yet have a committed product-schema for an arbitrary injected spec, so the
 * caller (the dev wrapper) supplies a `registerProductTables` hook — we build the tables ONCE and
 * hand THOSE EXACT instances to the hook BEFORE deploy()'s identity-keyed verify step (the chokepoint
 * Set is keyed by object identity, so the registered instances MUST be the ones deploy verifies). For
 * the auth-only platform main line this branch never runs.
 */
async function deployDeclaredSpec(
  db: Db,
  config: ServerConfig,
  baseDeps: Omit<AppDeps, 'engine'>,
  opts: {
    agentBackendsFactory?: AgentBackendsFactory;
    registerProductTables?: ProductTableRegistrar;
    /**
     * The UPDATE flow: a reviewed forward DELTA (old → new) + its allowlist. When set,
     * the materialize/mount/drifted decision is bypassed and THESE migrations are passed to
     * `deploy()` (which gates + applies them). See the `assembleServer` opts docstring.
     */
    updateMigrations?: PlannedMigration[];
  },
): Promise<{
  app: ReturnType<typeof createAuthApp>;
  declaredRoutes: BootedServer['declaredRoutes'];
  declaredAgents: BootedServer['declaredAgents'];
  /** The cron trigger names the worker scheduled (empty for a no-cron deploy). */
  declaredCronTriggers: BootedServer['declaredCronTriggers'];
  /** 'materialized' (first roll-out on a clean DB) | 'mounted' (reboot — no DDL, data survives). */
  deployMode: BootedServer['deployMode'];
  /** The report-only post-migrate drift (empty on success; a non-empty UPDATE drift threw above). */
  drift: BootedServer['drift'];
  /** Shut down the durable worker on close() (undefined when none was wired). */
  durableExecutorShutdown?: () => Promise<void>;
  /** Control seam: the on-demand cron-fire delegate (undefined when no cron is scheduled). */
  fireCronNow?: BootedServer['fireCronNow'];
  /** M1 control seam: the on-demand cleanup delegate (undefined when no durable worker is wired). */
  runCleanupNow?: BootedServer['runCleanupNow'];
  /** the erasure control seam: the on-demand tenant data-erasure delegate (undefined when no product stores). */
  eraseTenantNow?: BootedServer['eraseTenantNow'];
}> {
  const specPath = config.specPath as string;
  const escapeHatchRoot = config.escapeHatchRoot as string;
  const specSource = readFileSync(specPath, 'utf8');

  // reject a Product-YAML doc up-front with the SAME guidance `deploy()` gives (before any DB work),
  // instead of the RaySpec strict-shape wall below. A classic doc passes through UNCHANGED.
  assertSpecFamilyMountable(specSource, specPath);

  // Pre-parse to build the product tables + the first-materialization migration SQL the rollout
  // needs (deploy() re-parses internally for its own VALIDATE step — a !ok there aborts the deploy).
  const parsed = parseSpec(specSource);
  if (!parsed.ok) {
    throw new BootConfigError(
      `Boot aborted — injected spec at ${specPath} is invalid:\n${JSON.stringify(parsed.errors, null, 2)}`,
    );
  }

  // ── Resolve + merge the referenced extension PACKS, fail-closed ─────────────
  // For each `extensions[]` ref, loadExtensions resolves the pack's defineExtension manifest
  // (DIRECTORY-ONLY path-jailed; version-pin FAIL-CLOSED — never a silent skip), jails each
  // pack handler against the PACK root, and returns the pack's store/handler/tooling/api fragments
  // MERGED onto the deployment's sections + a multi-root importer (virtual pack-handler path → the
  // real pack file) + any capability instances the packs provide. The MERGED spec is what every
  // downstream step (product tables / migration SQL / blob guard / deploy()'s re-parse + handler load)
  // sees — so a pack store rides the UNCHANGED migration gate + chokepoint probe (NO new migration
  // path), a pack route the existing api interpreter (incl. the S2/S3 stream arms), a pack handler the
  // existing path-jailed loader. `deploy()` / the migration pipeline / the chokepoint stay
  // BYTE-UNCHANGED — the multi-root resolution rides the existing `rollout.importer` seam.
  const {
    spec: effectiveSpec,
    specSource: effectiveSpecSource,
    extensionImporter,
    packBlobFactory,
  } = await mergeExtensions(parsed.value, specSource, escapeHatchRoot, specPath);

  const specStores = [...effectiveSpec.stores];
  const productTables = buildProductTables(specStores);
  // LOCAL A1 stand-in: register THESE exact table instances before deploy()'s identity-keyed verify.
  opts.registerProductTables?.(productTables);

  // ── mount-without-deploy — classify the LIVE product schema → MATERIALIZE vs MOUNT ───────
  // The platform migration chain (applyMigrations) already ran in assembleServer, so the platform
  // tables (incl. `orgs`, the tenant_id FK target) exist. We introspect the live product schema against
  // the spec via the EXISTING detectDrift (read-only — NO DDL), then decide:
  //   - CLEAN DB (every store table missing) → 'absent'          → materialize (the FIRST roll-out;
  //                                                                  byte-identical to the prior behavior)
  //   - matches the spec (no drift)          → 'present-matching' → MOUNT: NO product DDL is run, so
  //                                                                  existing rows (recordings/etc.) SURVIVE
  //   - partially-materialized / diverged    → 'drifted'         → FAIL CLOSED (reconcile via a reviewed
  //                                                                  FORWARD migration / re-deploy)
  // `deploy()` stays BYTE-UNCHANGED — it already accepts an arbitrary `migrations[]`; passing `[]` is a
  // legitimate no-materialization re-deploy that still VALIDATEs the spec, chokepoint-VERIFIEs every
  // product table, loads handlers, registers triggers, and reports drift — but runs NO product DDL, so
  // it can never drop/recreate a populated store. The mount-vs-deploy decision lives HERE (the only
  // real deployer), not in the kill-set deploy.ts. The query thunk is reused for `target.query` below.
  const queryFn = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];

  let migrations: PlannedMigration[];
  let deployMode: BootedServer['deployMode'];
  if (opts.updateMigrations !== undefined) {
    // ── The UPDATE flow: the deployer supplied a reviewed forward DELTA (old → new) ──────
    // We DELIBERATELY bypass the materialize/mount/drifted decision: a legitimate update
    // reconciles a schema that is intentionally 'drifted' vs the NEW spec (the delta is exactly what
    // closes that gap — the classify step would otherwise refuse to boot, which is the dead-end this
    // flow replaces). `deploy()` stays BYTE-UNCHANGED: it GATES each migration (scanMigrationSql over
    // its reviewed allowlist — a destructive statement WITHOUT a covering entry BLOCKS with a
    // DeployError at [lint/gate], never a silent apply) then applies it, evolving the live schema in
    // place. The post-migrate drift step (report-only) then reflects the reconciled schema. An empty
    // updateMigrations[] is a legitimate no-DDL re-deploy (validate + chokepoint-verify only).
    migrations = opts.updateMigrations;
    deployMode = specStores.length === 0 ? 'auth-only' : 'updated';
  } else {
    // ── mount-without-deploy — classify the LIVE product schema → MATERIALIZE vs MOUNT ──────
    // The platform migration chain (applyMigrations) already ran in assembleServer, so the platform
    // tables (incl. `orgs`, the tenant_id FK target) exist. We introspect the live product schema
    // against the spec via the EXISTING detectDrift (read-only — NO DDL), then decide:
    //   - CLEAN DB (every store table missing) → 'absent'          → materialize (the FIRST roll-out;
    //                                                                  byte-identical to prior behavior)
    //   - matches the spec (no drift)          → 'present-matching' → MOUNT: NO product DDL is run, so
    //                                                                  existing rows (recordings/etc.) SURVIVE
    //   - partially-materialized / diverged    → 'drifted'         → FAIL CLOSED (reconcile via a
    //                                                                  reviewed FORWARD migration — the
    //                                                                  UPDATE flow above — or re-deploy)
    // `deploy()` stays BYTE-UNCHANGED — it already accepts an arbitrary `migrations[]`; passing `[]` is
    // a legitimate no-materialization re-deploy that still VALIDATEs the spec, chokepoint-VERIFIEs every
    // product table, loads handlers, registers triggers, and reports drift — but runs NO product DDL, so
    // it can never drop/recreate a populated store. The mount-vs-deploy decision lives HERE (the only
    // real deployer), not in the kill-set deploy.ts.
    const preDrift = await detectDrift(specStores, 'public', queryFn);
    const schemaState = classifyProductSchema(specStores, preDrift);
    if (schemaState === 'drifted') {
      throw new BootConfigError(
        `Boot aborted — the live product schema has DRIFTED from the spec at ${specPath}:\n` +
          `${formatDrift(preDrift)}\n` +
          'mount-without-deploy refuses to boot against a drifted/partially-materialized schema — it ' +
          'never auto-materializes or drops. Reconcile via an explicit reviewed FORWARD migration: ' +
          'author the delta with `rayspec plan <new-spec> --against <old-spec>`, then boot with ' +
          '`rayspec deploy --apply-migration <delta.sql>` (add `--allowlist <file.json>` to cover any ' +
          'reviewed destructive statement) — or deploy against a clean DB. Fail-closed.',
      );
    }
    migrations =
      schemaState === 'absent'
        ? [{ name: '0000_product_stores.sql', sql: generateProductSql(specStores), allowlist: [] }]
        : []; // present-matching → MOUNT: NO product DDL (existing data survives)
    deployMode =
      specStores.length === 0 ? 'auth-only' : schemaState === 'absent' ? 'materialized' : 'mounted';
  }

  const agentBackends = opts.agentBackendsFactory?.();

  // ── The BLOB BACKEND deploy guard + injection ───────────────────────────────
  // A `kind:'stream'` route reads/writes binary bytes through the tenant-bound BlobStore (init.blob).
  // FAIL CLOSED at deploy if the spec declares ANY stream route but no blob root is configured — a
  // stream route has nowhere to put its bytes, and the api interpreter would otherwise abort the boot
  // later with a less actionable message. Build the fs BlobStoreFactory once (LOCAL/self-host, pre-
  // hardening); it is injected into the engine in buildApp (below). A spec with NO stream route needs no
  // blob backend (blobFactory stays undefined — exactly like agentBackends for an agent-free spec).
  const hasStreamRoute = effectiveSpec.api.some((r) => r.action.kind === 'stream');
  let blobFactory: BlobStoreFactory | undefined;
  if (hasStreamRoute) {
    // A PACK may PROVIDE its own blob backend (an ExtensionCapabilities.blobFactory — e.g.
    // an S3 backend). When a pack provided one, prefer it (the pack owns the bytes); else the default
    // fs backend over RAYSPEC_BLOB_ROOT. A stream route with NEITHER is fail-closed (nowhere to put
    // bytes). The pack-provided factory is still tenant-bound BY CONSTRUCTION (the BlobStore contract).
    if (packBlobFactory) {
      blobFactory = packBlobFactory;
    } else if (config.blobRoot) {
      blobFactory = makeFsBlobStoreFactory(config.blobRoot);
    } else {
      throw new BootConfigError(
        `Boot aborted — the deployed spec at ${specPath} declares a 'stream' route but no blob backend ` +
          'is configured (RAYSPEC_BLOB_ROOT is unset and no extension pack provided one). A stream ' +
          'route moves binary bytes through the tenant-bound BlobStore; set RAYSPEC_BLOB_ROOT to a ' +
          'writable directory (the fs blob backend writes one subdir per tenant under it), or load a ' +
          'pack that provides a blobFactory. Fail-closed (a stream route requires a blob backend).',
      );
    }
  }

  // ── The MEDIA-TOKEN service (playback's 2nd auth path) deploy guard + build ──
  // A `kind:'stream', mode:'playback'` route is authenticated by a signed `?token=` media-JWT (HS256,
  // a DISTINCT key from the RS256 API/JWKS chain — a leaked media URL must not grant API access). FAIL
  // CLOSED at deploy if a playback route is declared but no media signing key is configured — a
  // playback route without a verifier would be unauthenticated. The service ALSO powers the
  // `init.mintPlayToken` capability a mint `{handler}` route receives. Built once (LOCAL/self-host,
  // pre-hardening); injected into the engine in buildApp. A spec with no playback route needs none.
  const hasPlaybackRoute = effectiveSpec.api.some(
    (r) => r.action.kind === 'stream' && r.action.mode === 'playback',
  );
  let mediaTokenService: ReturnType<typeof createMediaTokenService> | undefined;
  if (hasPlaybackRoute) {
    if (!config.mediaSigningKey) {
      throw new BootConfigError(
        `Boot aborted — the deployed spec at ${specPath} declares a stream PLAYBACK route but no media ` +
          'signing key is configured (RAYSPEC_MEDIA_SIGNING_KEY is unset). A playback route is ' +
          'authenticated by a signed ?token= media-JWT (HS256, a DISTINCT key from the RS256 API chain ' +
          '— a leaked media URL must not grant API access). Set RAYSPEC_MEDIA_SIGNING_KEY to a ' +
          'high-entropy secret of at least 32 bytes. Fail-closed (a playback route requires the media ' +
          'verifier).',
      );
    }
    // createMediaTokenService fail-closes on a too-short secret; wrap that as a BootConfigError so the
    // abort is uniform + actionable at the entrypoint.
    try {
      mediaTokenService = createMediaTokenService(config.mediaSigningKey);
    } catch (err) {
      throw new BootConfigError(
        `Boot aborted — RAYSPEC_MEDIA_SIGNING_KEY is invalid: ${(err as Error).message}`,
      );
    }
  }

  // ── The static FRONTEND deploy guard (fail-closed on a missing/unreadable assets dir) ──
  // A declared frontend mount serves built static assets from `dir` (relative to the spec file). FAIL
  // CLOSED at deploy if the directory is missing / not a directory / unreadable — the mount would
  // otherwise serve nothing (every asset 404s) with no actionable signal. Mirrors the stream/playback
  // guards above; the actual mounting runs in assembleServer AFTER deployDeclaredSpec returns.
  for (const mount of effectiveSpec.frontend ?? []) {
    const resolvedDir = resolve(dirname(specPath), mount.dir);
    let isDir = false;
    try {
      isDir = statSync(resolvedDir).isDirectory();
      // isDirectory() alone does NOT test read/traverse permission — a mode-0000 dir passes stat but
      // then every asset EACCES-misses. Require R_OK|X_OK too so an unreadable/untraversable dir is
      // treated the same as missing (fails closed with the message below).
      if (isDir) accessSync(resolvedDir, constants.R_OK | constants.X_OK);
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new BootConfigError(
        `Boot aborted — the deployed spec at ${specPath} declares a frontend at route '${mount.route}' ` +
          `but its static directory '${mount.dir}' (resolved to ${resolvedDir}) is missing or unreadable. ` +
          'Point frontend.dir at a readable directory of built assets. Fail-closed.',
      );
    }
  }

  // ── Wire the off-request DURABLE WORKER iff the spec declares deployment.durableWorker
  //    AND the deployment supplies agent backends (the platform ships none). The executor runs
  //    the EXISTING runAgent off-request; the api-auth run surface enqueues onto it for `async:true`.
  //    The DBOS engine is constructed HERE (the composition root wires concrete engines — server/src
  //    is NOT a scoped root); run-core/the adapters carry NO DBOS dependency (the asymmetry stays in
  //    @rayspec/durable-dbos). The worker resolves a RunJob's agentId against the SAME AgentRegistry
  //    the run surface uses — built from the engine captured when deploy() calls buildApp (below).
  let durableExecutor: DurableExecutor | undefined;
  let durableExecutorShutdown: (() => Promise<void>) | undefined;
  // The concrete executor + its dedicated worker DB pool, captured at the OUTER scope so
  // the cron scheduler (wired AFTER deploy() yields the trigger registry, BEFORE launch) can enqueue
  // agent runs onto the same executor + run its tenant-scoped reserve/handler dispatch off the SAME
  // dedicated worker pool (never the HTTP pool — fix B). Undefined when no durable worker is wired.
  let durableExecutorInstance: DbosDurableExecutor | undefined;
  let workerDbHandle: Db | undefined;
  // The agent registry the worker resolves against — set INSIDE buildApp (it needs the engine's
  // loaded handlers). Late-bound via this ref so the executor's resolveRun closure reads it.
  let workerAgentRegistry: AgentRegistry | undefined;
  // Fix F (startup race): the executor is CONSTRUCTED here but NOT started — `executor.start()`
  // (which calls `DBOS.launch()`, beginning crash-recovery + queue dispatch) runs AFTER deploy()
  // below, by which point buildApp has already bound `workerAgentRegistry`. Starting it before
  // deploy() would open a window where a recovered/enqueued job reaches `resolveRun` while the
  // registry is still undefined → a spurious terminal failure. Injecting an UN-started executor into
  // buildApp is safe: the run surface only calls `enqueue` at REQUEST time (after the server serves,
  // long after start()), and `enqueue` itself throws if not started — so no enqueue can race the
  // start. This removes the `let … undefined` dispatch window entirely with no duplicate handler load.
  let pendingExecutorStart: (() => Promise<void>) | undefined;
  if (effectiveSpec.deployment?.durableWorker === true && agentBackends) {
    // ── Fix B (pool starvation): the durable worker gets its OWN dedicated postgres pool, SEPARATE
    //    from the HTTP/API `db` pool. Each in-flight off-request run holds ONE connection across the
    //    ENTIRE LLM call (inside `forTenant(workerDb, tenantId).transaction()`), so a worker sharing
    //    the HTTP pool (max 4) would, under `workerConcurrency` long runs, starve `GET /events` /
    //    `/health` / every HTTP DB caller. DBOS's own control plane uses its SEPARATE system-DB pool
    //    (`systemDatabaseUrl`), not this app pool, so this sizing covers only the worker's app-DB run work.
    //    The pool-ISOLATION property (HTTP pool unaffected) is asserted by worker-pool-isolation.db.test.ts.
    //
    //    SIZING ANALYSIS (the autonomous taint write, done HONESTLY against ground
    //    truth). A run that fires a NON-idempotent tool ALSO acquires a connection for the autonomous
    //    `markRunTainted` INSERT (a separate non-transactional `forTenant(workerDb,…)` = `taintDb`, so the
    //    marker commits on its OWN connection and survives the run's tx rollback). So a non-idempotent run
    //    holds TWO connections at its peak: its run-tx connection (held across the whole LLM call) AND, for
    //    the duration of the taint INSERT, a second autonomous connection. A held postgres-js
    //    `tdb.transaction()` DOES pin its pool slot for the whole transaction (empirically confirmed: 2 held
    //    txs on a `max:2` pool leave a 3rd autonomous query PENDING >3s until a held tx releases). So at
    //    `workerConcurrency=N` with a pool of EXACTLY N, all N run-tx transactions pin all N slots, none of
    //    the N autonomous taint INSERTs can acquire a connection, and the worker DEADLOCKS (every run TIMES
    //    OUT). The `+1` is what makes it SAFE: with `N+1`, the N held run-tx connections leave ≥1 free slot,
    //    so the N autonomous taint INSERTs SERIALIZE through that single headroom slot — each acquires it,
    //    does its fast one-shot INSERT, and releases — WITHOUT ever blocking the held run-tx transactions.
    //    The autonomous writes are short and serialized, so one free slot suffices; they never need N free
    //    slots at once. The same headroom slot also covers the started-once reserve + the taint READ (both
    //    run BEFORE the run-tx opens, so they do not even contend with the held run-tx connections).
    //    `executor-pool-saturation.db.test.ts` PROVES BOTH directions: the shipped `N+1` arm completes all N
    //    runs; the undersized `pool==N` arm reproduces the deadlock (all N TIME OUT) — so the `+1` is a
    //    PROVEN minimum, not a guess. INVARIANT (by construction): `WORKER_POOL_MAX > workerConcurrency`.
    const workerConcurrency = DEFAULT_WORKER_CONCURRENCY;
    const WORKER_POOL_MAX = workerConcurrency + 1; // strict headroom over concurrency (sufficient — fix E)
    const workerDb = makeDb(config.databaseUrl, WORKER_POOL_MAX);
    const executor = new DbosDurableExecutor(
      {
        db: workerDb,
        resolveRun: (job: RunJob): ResolvedRun => {
          const entry = workerAgentRegistry?.get(job.agentId);
          if (!entry) {
            throw new Error(
              `durable worker: agent '${job.agentId}' is not in the registry (the run cannot be ` +
                'resolved off-request — fail-closed).',
            );
          }
          return {
            backend: entry.backend,
            spec: entry.spec,
            ...(entry.toolFactory ? { toolFactory: entry.toolFactory } : {}),
            ...(entry.tools ? { tools: entry.tools } : {}),
          };
        },
      },
      {
        name: effectiveSpec.metadata.name,
        systemDatabaseUrl: config.dbosSystemDatabaseUrl,
        workerConcurrency,
      },
    );
    // Inject the (not-yet-started) executor so buildApp wires the async path; start it after deploy().
    durableExecutor = executor;
    durableExecutorInstance = executor; // the concrete type the cron scheduler attaches to.
    workerDbHandle = workerDb; // the cron scheduler dispatches off this dedicated pool.
    // Shut DBOS down AND end the worker's OWN pool (fix B) so close() leaks no connection.
    durableExecutorShutdown = async () => {
      await executor.shutdown();
      await workerDb.$client.end();
    };
    pendingExecutorStart = () => executor.start();
  }

  const PROBE_TENANT = '00000000-0000-0000-0000-0000000000aa';
  const target: DeployTarget = {
    driftSchema: 'public',
    async applyMigration(migration: PlannedMigration): Promise<void> {
      // The generated product SQL carries drizzle statement-breakpoints; strip them and apply the
      // migration all-or-nothing in one transaction (the public schema is the live target here).
      const ddl = migration.sql.replace(/-->\s*statement-breakpoint/g, '');
      await db.$client.begin(async (tx) => {
        await tx.unsafe(ddl);
      });
    },
    verifyTenantScoped(table: PgTable, _storeName: string): void {
      // Probe the REAL TenantDb chokepoint: building the select runs assertScoped, which THROWS
      // deny-by-default unless the table is registered (the caller registered them — see the wrapper).
      const tdb = forTenant(db, PROBE_TENANT);
      (tdb.select as (t: PgTable) => unknown)(table);
    },
    query: queryFn, // the SAME thunk used for the pre-flight drift classification above.
  };

  // The deploy<App> type arg fixes `result.app`'s type. `RolloutConfig.buildApp` is a GENERIC method
  // `<App>(engine) => App` (App is bound per-call, not threaded from DeployConfig), so a real
  // implementation can only satisfy it via the documented cast — exactly how the typechecked
  // deploy() UNIT test's `rollout()` helper implements it (`buildApp<App>(_engine): App { return …
  // as App }`). We are the FIRST shipped, tsc-typechecked consumer of `deploy()`'s buildApp (the
  // dev-server + tests are tsc-excluded), so this surfaces the per-method-generic awkwardness; the
  // cast here is the contract's intended usage, not a type hole — the runtime value IS the app.
  const result = await deploy<ReturnType<typeof createAuthApp>>({
    // deploy() re-parses + re-validates the MERGED spec (deployment ⊕ pack fragments) —
    // so a pack store/route/handler is validated by the SAME parseSpec/lintSpec gate (no special
    // pass), and a pack store rides the SAME migration SQL below. byte-unchanged deploy().
    specSource: effectiveSpecSource,
    // '0000_product_stores.sql' on a clean DB (materialize) — or [] on a reboot (MOUNT: no
    // product DDL → existing data survives). A 'drifted' schema already failed closed above.
    migrations,
    target,
    rollout: {
      productTables,
      escapeHatchRoot,
      // The multi-root importer (a rewritten virtual pack-handler path → the real pack
      // file, jailed against the PACK root; a deployment's own handler falls through to the default).
      // This rides the EXISTING `rollout.importer` seam — `deploy()`/`loadHandlers` stay byte-unchanged.
      ...(extensionImporter ? { importer: extensionImporter } : {}),
      ...(agentBackends ? { agentBackends } : {}),
      buildApp<App>(engine: DeclarativeEngine): App {
        // Capture the SAME AgentRegistry the run surface builds, so the durable worker
        // resolves a RunJob's agentId identically (the engine's loaded handlers are only available
        // HERE — inside the rollout). Built only when the engine declares agents + backends.
        if (engine.agentBackends && engine.spec.agents.length > 0) {
          workerAgentRegistry = buildAgentRegistry({
            spec: engine.spec,
            agentBackends: engine.agentBackends,
            handlers: engine.handlers ?? new Map(),
            productTables: engine.productTables,
            // Thread the SAME wired blob backend (assembled above, present iff the spec has a
            // stream route) so a declared tool the OFF-REQUEST worker runs gets the SAME tenant-bound
            // `init.blob` the sync run surface gives it — built from the run's server-derived tenant.
            ...(blobFactory ? { blobFactory } : {}),
          });
        }
        // Inject the tenant-bound blob backend into the engine (the `stream` route arm
        // reads `engine.blobFactory` to build `init.blob`). `deploy()`/`RolloutConfig` is an unchanged
        // platform contract that knows nothing of blobs, so the composition root — which OWNS
        // buildApp + assembled blobFactory above (guarded: present iff the spec has a stream route) —
        // augments the engine here, exactly as it injects `durableExecutor`. Spread so the field is
        // ABSENT (not undefined) for a no-stream spec, keeping the engine shape exact.
        const engineWithBlob: DeclarativeEngine = {
          ...engine,
          ...(blobFactory ? { blobFactory } : {}),
          // Inject the media-token service (when wired) so the playback arm's 2nd auth path
          // + the mint capability are available. Spread so ABSENT for a no-playback spec.
          ...(mediaTokenService ? { mediaTokenService } : {}),
        };
        // Inject the durable executor (when wired) so the run surface's async path can enqueue.
        return createAuthApp({
          ...baseDeps,
          engine: engineWithBlob,
          ...(durableExecutor ? { durableExecutor } : {}),
        }) as App;
      },
    },
  });

  // ── The post-UPDATE drift GATE (fail-closed on an under-reconciling reviewed delta) ────
  // SCOPED to the UPDATE branch ONLY (opts.updateMigrations set + the spec has stores). deploy()'s
  // drift step (step 6) is REPORT-ONLY: it returns `result.drift` but never aborts. For a mount/
  // materialize boot that is correct (that path already fail-closed on 'drifted' BEFORE deploy, so its
  // post-deploy drift is []); but the UPDATE branch DELIBERATELY bypassed that pre-flight classify, so
  // deploy()'s report-only drift is the ONLY check that the reviewed delta actually CLOSED the gap. A
  // delta that applies cleanly but UNDER-reconciles (e.g. adds one of two new columns) would otherwise
  // boot GREEN as `deployMode:'updated'` — and the NEXT plain reboot (no updateMigrations) would then
  // classify 'drifted' and fail-close, bricking the deployment on a DELAY. We fail NOW instead. Mount/
  // materialize behavior stays byte-identical (this branch never runs for them); the auth-only update
  // path (specStores.length === 0 ⇒ deployMode 'auth-only', deploy returns []) is untouched.
  if (opts.updateMigrations !== undefined && specStores.length > 0 && result.drift.length > 0) {
    throw new BootConfigError(
      `Boot aborted — the reviewed UPDATE delta applied but the live product schema is STILL DRIFTED ` +
        `from the NEW spec at ${specPath} (the delta UNDER-reconciled — it did not fully close the gap):\n` +
        `${formatDrift(result.drift)}\n` +
        'IMPORTANT — the delta migration(s) are ALREADY COMMITTED: deploy() applies each migration in ' +
        'its own transaction and this drift check fires POST-migrate, so the schema is now in a ' +
        'partially-evolved MID-STATE. This gate fails the update NOW rather than booting green as ' +
        "'updated' and letting the NEXT plain reboot fail-close on the residual drift (a delayed brick). " +
        'Recovery (FORWARD-FIX discipline — NEVER a down-migration / hand-patch): re-diff the live ' +
        'schema vs the NEW spec, author the COMPLETING forward migration that closes the remaining ' +
        'drift, and re-run update mode with it. Fail-closed.',
    );
  }

  // ── Wire the CRON scheduler from the deployed trigger registry (BEFORE launch) ──────
  // deploy() yields `result.triggers` (the registered descriptors). For each CRON trigger we
  // register one DBOS scheduled-workflow — but that registration MUST happen BEFORE DBOS.launch() (the
  // ScheduledReceiver lifecycle callback starts the schedule loops at launch). So we attach the
  // scheduler's `registerScheduledWorkflows` as a PRE-LAUNCH hook on the executor; `pendingExecutorStart`
  // (= executor.start()) runs the hooks after registerWorkflow and before launch. cron-only: webhook/
  // event/manual descriptors stay RESERVED (the scheduler does not schedule them).
  let cronTriggerNames: string[] = [];
  // The on-demand cron-fire delegate (the control seam), bound to the wired scheduler below.
  let fireCronNow: BootedServer['fireCronNow'];
  const cronTriggers = result.triggers.list().filter((t) => t.kind === 'cron');
  if (cronTriggers.length > 0) {
    // (Fix #4b — fail-closed, defense-in-depth with the lint rule) A cron is fired ONLY by the durable
    // off-request worker. If the spec declares cron triggers but no durable worker is wired (the spec
    // omitted deployment.durableWorker, or no agent backends were supplied), the cron would be SILENTLY
    // never scheduled (it just never fires). Refuse to boot — a half-deployed cron is never silently OK.
    // The static lint rule (lint.ts) already rejects cron-without-durableWorker at parse/deploy time;
    // this is the runtime backstop for a code-built spec or a missing-backends boot.
    if (!(durableExecutorInstance && workerDbHandle)) {
      throw new BootConfigError(
        `Boot aborted — the spec declares ${cronTriggers.length} cron trigger(s) but no durable ` +
          'worker is wired (deployment.durableWorker is not true, or no agent backends were ' +
          'supplied). A cron is fired by the durable worker; without it the trigger would never ' +
          'fire (silently unscheduled). Set deployment.durableWorker:true and supply agent ' +
          'backends, or remove the cron trigger(s). Fail-closed.',
      );
    }
    // A cron must fire under a KNOWN tenant (single-deployment LOCAL posture). Fail closed if a cron is
    // declared but no cron tenant was configured — firing under an unknown tenant is never silently OK.
    if (!config.cronTenantId) {
      throw new BootConfigError(
        `Boot aborted — the spec declares ${cronTriggers.length} cron trigger(s) but ` +
          'RAYSPEC_CRON_TENANT_ID is not set. A cron fires under a known deployment tenant ' +
          '(single-deployment LOCAL posture; multi-tenant cron fan-out is reserved). Set ' +
          'RAYSPEC_CRON_TENANT_ID to the org id the cron should fire under. Fail-closed.',
      );
    }
    // Validate the cron tenant at BOOT (fix #3), not lazily at fire time (2am). `forTenant` throws the
    // fail-closed "tenantId must be a UUID" for a malformed id; the existence probe below catches a
    // well-formed-but-nonexistent org so a bogus tenant fails loud at boot, not via the FK at fire time.
    await assertCronTenantBootable(db, config.cronTenantId);
    const cronScheduler = new DbosCronScheduler(result.triggers.list(), {
      db: workerDbHandle,
      tenantId: config.cronTenantId,
      executor: durableExecutorInstance,
      productTables,
      invokeTriggerHandler,
    });
    // Register the scheduled workflows in the pre-launch window (executor.start() runs this hook before
    // DBOS.launch()). Without a durable worker there is no launch to hook — but cron implies the worker
    // is wired (durableExecutorInstance is set), so this is always paired with a launch.
    durableExecutorInstance.attachPreLaunchHook(() => cronScheduler.registerScheduledWorkflows());
    cronTriggerNames = cronScheduler.cronTriggerNames;
    // Bind the on-demand fire delegate to the WIRED scheduler (the same instance the DBOS schedule
    // loop fires) so an on-demand fire goes through the EXACT reserve→dispatch path + cross-dedups
    // with a scheduled fire for the same instant (firingKey is instant-truncated). Generic control
    // surface — a future ops endpoint, the deterministic tests, and the CEO demo all use it.
    fireCronNow = (name: string, instant?: Date) => cronScheduler.fireNow(name, instant);
  }

  // ── Wire the SYSTEM cleanup scheduled-workflow (BEFORE launch) ───────────────────────
  // Platform housekeeping (OIDC prune LIVE + the operator-gated GDPR purge) runs on a daily DBOS
  // scheduled-workflow WHENEVER a durable worker is wired — INDEPENDENT of whether the spec declares cron
  // triggers (it is not a tenant trigger; it spans all tenants + the global tables). Like the cron
  // scheduler, its `registerScheduledWorkflow` MUST run in the pre-launch window, so we attach it as a
  // pre-launch hook on the executor. The concrete cleanup logic is INJECTED (`runScheduledCleanup` over the
  // WORKER Db + the gate/retention config) so @rayspec/durable-dbos stays api-auth-free. HONEST POSTURE:
  // this rides the durable worker — an auth-only boot does NOT launch DBOS, so it does not run there (see
  // SystemCleanupScheduler's header). The GDPR purge is DRY-RUN unless the operator gate is explicitly ON.
  let runCleanupNow: BootedServer['runCleanupNow'];
  if (durableExecutorInstance && workerDbHandle) {
    const cleanupScheduler = new SystemCleanupScheduler({
      // Inject the cleanup over the WORKER pool (the same dedicated pool the cron scheduler dispatches off,
      // never the HTTP pool — fix B). The gate + retention come from the validated config (fail-closed).
      runCleanup: () =>
        runScheduledCleanup({
          db: workerDbHandle as Db,
          config: {
            gdprPurgeEnabled: config.cleanup.gdprPurgeEnabled,
            gdprRetentionDays: config.cleanup.gdprRetentionDays,
          },
        }),
      schedule: config.cleanup.schedule,
      executor: durableExecutorInstance,
    });
    durableExecutorInstance.attachPreLaunchHook(() => cleanupScheduler.registerScheduledWorkflow());
    // The on-demand cleanup delegate (control seam) — goes through the EXACT same `runCleanup` path the
    // daily workflow fires on. Cast the engine-local outcome back to the api-auth CleanupResult (the
    // injected runScheduledCleanup returns exactly that — the scheduler's narrower type is a structural
    // subset, so this is the runtime value, not a type hole).
    runCleanupNow = () => cleanupScheduler.runCleanupNow() as Promise<CleanupResult>;
  }

  // Fix F: NOW that deploy() → buildApp has bound `workerAgentRegistry`, START the durable engine
  // (DBOS.launch() begins crash-recovery + queue dispatch). A recovered/enqueued job that reaches
  // `resolveRun` will find the registry bound (no spurious terminal failure). enqueue was unreachable
  // before this (the run surface serves only after assembleServer returns), so nothing raced. The cron
  // scheduler's pre-launch hook (attached above) registers its scheduled-workflows inside this start().
  if (pendingExecutorStart) await pendingExecutorStart();

  // ── wire the on-demand tenant DATA-ERASURE control seam ──────────────────────────────────────
  // Threads the deployed product tables + stores (for FK-safe ordering), the wired blob backend (built
  // per-target-tenant via blobFactory), the out-of-band AuditStore, and the resolved operator gate into
  // the platform-generic `eraseTenant`. Present only when the spec declares product stores (an
  // auth-only / store-less deploy has nothing to erase → the seam stays undefined). NOT mounted on the
  // public app — the operator triggers it (pre-hardening). The gate is OPERATOR-only (config.erasureEnabled);
  // unset ⇒ every call is a DRY-RUN preview (counts, ZERO deletes).
  let eraseTenantNow: BootedServer['eraseTenantNow'];
  if (specStores.length > 0) {
    eraseTenantNow = (tenantId: string, eraseOpts?: { dryRun?: boolean }): Promise<EraseResult> =>
      eraseTenant({
        db,
        tenantId,
        productTables,
        // The blob handle is built bound to the TARGET tenant; eraseTenant calls deleteTenant(tenantId)
        // with the SAME id (the bound-tenant equality holds). Absent when no blob backend was wired.
        ...(blobFactory ? { blob: blobFactory(tenantId) } : {}),
        audit: baseDeps.auditStore,
        enabled: config.erasureEnabled,
        dryRun: eraseOpts?.dryRun ?? false,
        stores: specStores,
      });
  }

  return {
    app: result.app,
    declaredRoutes: result.spec.api.map((route) => {
      const a = route.action;
      let action: string;
      switch (a.kind) {
        case 'store':
          action = `store:${a.store}.${a.op}`;
          break;
        case 'agent':
          action = `agent:${a.agent}`;
          break;
        case 'handler':
          action = `handler:${a.handler}`;
          break;
        case 'stream':
          action = `stream:${a.mode}.${a.handler}`;
          break;
        default: {
          // Exhaustiveness: a new RouteAction kind without a label arm is a compile error here.
          const _never: never = a;
          action = `unknown:${JSON.stringify((_never as { kind?: unknown }).kind)}`;
        }
      }
      return { method: route.method, path: route.path, action };
    }),
    declaredAgents: result.spec.agents.map((a) => ({
      id: a.id,
      backend: a.backend,
      model: a.model,
    })),
    declaredCronTriggers: cronTriggerNames,
    deployMode,
    // Report-only drift (empty here — a non-empty UPDATE-mode drift already threw above).
    drift: result.drift,
    ...(durableExecutorShutdown ? { durableExecutorShutdown } : {}),
    ...(fireCronNow ? { fireCronNow } : {}),
    ...(runCleanupNow ? { runCleanupNow } : {}),
    ...(eraseTenantNow ? { eraseTenantNow } : {}),
  };
}
