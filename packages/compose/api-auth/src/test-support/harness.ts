/**
 * api-auth integration test harness.
 *
 * Builds an ISOLATED Postgres schema (so parallel suites do not collide on the shared DB), creates
 * the full table set (identity + oidc + idempotency + run journal) in their CURRENT shape,
 * generates a real RS256 signing key, and wires every store/service into a createAuthApp() app.
 *
 * This is test-support (NOT shipped code) — it legitimately uses the @rayspec/db/testing raw
 * factory (the Biome ban + chokepoint gate carve out test-support/**).
 */

import { createSigner, JwksProvider, RateLimiter } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { forTenant, generateProductSql } from '@rayspec/db';
import {
  buildProductTables,
  makeDbWithSchema,
  registerScopedTables,
  type StoreConflictKeys,
} from '@rayspec/db/testing';
import type { ResolvedHandler } from '@rayspec/platform';
import type { RaySpec } from '@rayspec/spec';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import type { Configuration } from 'oidc-provider';
import { createAuthApp } from '../app.js';
import type { AppDeps, DeclarativeEngine } from '../app-context.js';
import type { DeployTarget, PlannedMigration } from '../engine/deploy.js';
import { createOidcProvider } from '../oidc/provider.js';
import { AuthService } from '../services/auth-service.js';
import { ApiKeyStore } from '../stores/api-key-store.js';
import { AuditStore } from '../stores/audit-store.js';
import { IdempotencyStore } from '../stores/idempotency-store.js';
import { IdentityStore } from '../stores/identity-store.js';
import { OrgStore } from '../stores/org-store.js';

/**
 * A mutable, test-controlled clock. A grace-window test drives it deterministically instead of
 * relying on a wall-clock delta (which flakes under CI CPU load). `advance` moves time forward;
 * `reset` returns to the base captured at construction (called from the harness `reset()` so an
 * advance in one test does not leak into the next).
 */
export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  reset: () => void;
}

/** Build a mutable fake clock seeded at the current wall time (so sessions look realistic). */
export function makeFakeClock(): FakeClock {
  const base = Date.now();
  let t = base;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    reset: () => {
      t = base;
    },
  };
}

export interface Harness {
  app: ReturnType<typeof createAuthApp>;
  deps: AppDeps;
  db: Db;
  /** Present only when the harness was built with `useFakeClock: true` — the grace-window seam. */
  clock?: FakeClock;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

const DEFAULT_SCHEMA = 'rayspec_test_apiauth';

/** Build the full + schema DDL for an isolated schema name (so concurrent harnesses differ). */
function buildFullSchemaSql(SCHEMA: string): string {
  // No bare `SET search_path` here: the pool's startup search_path (makeDbWithSchema) already pins
  // `${SCHEMA}, public` on every connection, so after CREATE SCHEMA the unqualified CREATE TABLEs
  // resolve to ${SCHEMA}. A session-level SET would drop `, public` and PERSIST on the pooled
  // connection (a heterogeneous pool → intermittent relation-not-found across suites).
  return `
  DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
  CREATE SCHEMA ${SCHEMA};

  CREATE TABLE orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, slug text NOT NULL,
    region text NOT NULL DEFAULT 'eu', retention_days integer, external_idp_id text,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE UNIQUE INDEX orgs_slug_lower_idx ON orgs (lower(slug));

  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL, email_verified_at timestamptz, password_hash text,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE deleted_at IS NULL;

  CREATE TABLE memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL, status text NOT NULL DEFAULT 'active',
    scim_provisioned boolean NOT NULL DEFAULT false, invited_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE UNIQUE INDEX memberships_user_org_idx ON memberships (user_id, org_id);
  CREATE INDEX memberships_org_idx ON memberships (org_id);

  CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_org_id uuid REFERENCES orgs(id) ON DELETE CASCADE,
    token_hash text NOT NULL, family_id uuid NOT NULL,
    rotated_at timestamptz, replaced_by uuid, expires_at timestamptz NOT NULL,
    revoked_at timestamptz, revoked_reason text, ua text, ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
  CREATE INDEX sessions_user_idx ON sessions (user_id);
  CREATE INDEX sessions_family_idx ON sessions (family_id);

  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    type text NOT NULL DEFAULT 'api_key', key_prefix text NOT NULL, key_hash text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}', created_by uuid, last_used_at timestamptz,
    expires_at timestamptz, revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );
  CREATE INDEX api_keys_prefix_idx ON api_keys (key_prefix);
  CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);
  CREATE INDEX api_keys_org_idx ON api_keys (org_id);

  CREATE TABLE auth_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_org_id uuid, actor_user_id uuid, event text NOT NULL, request_id text,
    target_hash text, ip_hash text, meta jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX auth_audit_actor_org_idx ON auth_audit (actor_org_id);

  CREATE TABLE oidc_models (
    model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
    grant_id text, user_code text, uid text, consumed_at timestamptz, expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT oidc_models_model_id_pk PRIMARY KEY (model, id)
  );
  CREATE INDEX oidc_grant_idx ON oidc_models (grant_id);
  CREATE INDEX oidc_user_code_idx ON oidc_models (user_code);
  CREATE INDEX oidc_uid_idx ON oidc_models (uid);

  CREATE TABLE idempotency_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idem_tenant_scope_key_idx ON idempotency_keys (tenant_id, scope, idem_key);

  CREATE TABLE journal_steps (
    step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    backend text NOT NULL, type text NOT NULL, idempotency_key text NOT NULL,
    input_hash text NOT NULL, output jsonb,
    input_tokens numeric NOT NULL DEFAULT '0', output_tokens numeric NOT NULL DEFAULT '0',
    total_tokens numeric NOT NULL DEFAULT '0', cost_usd numeric NOT NULL DEFAULT '0',
    -- cost reconciliation + provenance columns (mirrors migration 0005).
    provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
    cost_drift boolean NOT NULL DEFAULT false, produced_by text, pricing_version text,
    latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL, auth_mode text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX journal_idem_idx ON journal_steps (tenant_id, run_id, idempotency_key);

  CREATE TABLE conversation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq numeric NOT NULL, role text NOT NULL,
    -- ConvPart columns (mirrors migration 0003): nullable + legacy content nullable.
    turn_index numeric, kind text, tool_call_id text, payload jsonb,
    name text, content text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE runs (
    run_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL,
    model text NOT NULL, status text NOT NULL, final_text text, output jsonb,
    cost_usd numeric NOT NULL DEFAULT '0',
    -- run-level cost roll-up columns (mirrors migration 0005).
    provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
    cost_drift boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- run-header time indexes (mirror migration 0006).
  CREATE INDEX runs_created_at_idx ON runs (created_at);
  CREATE INDEX runs_tenant_created_at_idx ON runs (tenant_id, created_at);

  -- run_events: the durable, resumable per-run event log (mirrors migration 0004).
  CREATE TABLE run_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq numeric NOT NULL, type text NOT NULL, data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX run_events_run_seq_idx ON run_events (run_id, seq);
  CREATE UNIQUE INDEX run_events_tenant_run_seq_idx ON run_events (tenant_id, run_id, seq);
`;
}

const ALL_TABLES =
  'orgs, users, memberships, sessions, api_keys, auth_audit, oidc_models, ' +
  'idempotency_keys, journal_steps, conversation_items, runs, run_events';

/**
 * Build the harness: isolated schema, real signing key, wired app. `withOidc` mounts the provider;
 * `oidcClients` registers real OAuth clients on it (so a legitimate token request can return 200
 * through the shipped guard + mount — used by the served token-guard suite).
 */
export async function createHarness(
  opts: {
    withOidc?: boolean;
    oidcClients?: Configuration['clients'];
    /** Override the provider issuer (default http://127.0.0.1/oidc). A served suite passes its
     * real `http://127.0.0.1:<port>/oidc` so the provider's emitted/validated URLs line up. */
    oidcIssuer?: string;
    /** The minimal agent registry wired into AppDeps for the runs-route suite. */
    agentRegistry?: AppDeps['agentRegistry'];
    /**
     * a validated RaySpec whose `api[]` declared routes the harness wires onto the
     * SAME app. When supplied: the harness materializes its `stores[]` in the isolated
     * schema (via the REAL `generateProductSql` generator, mirroring), builds the runtime
     * product tables (`buildProductTables`), registers them in the deny-by-default Set for the suite,
     * and injects `{ spec, productTables }` as `deps.engine`. PRODUCT-FREE platform: the product
     * tables come from the THROWAWAY spec a test fixture supplies, never from `packages/`.
     */
    engineSpec?: RaySpec;
    /**
     * The per-store conflict-key carve-out threaded to `generateProductSql`/`buildProductTables`
     * so a durable `ON CONFLICT` target column keeps a single-column unique index (a product-composed
     * engineSpec passes `deriveConflictKeys(spec, stores)`). Omit ⇒ every author `unique: true` column is
     * tenant-scoped compound (the backend-profile default).
     */
    conflictKeys?: StoreConflictKeys;
    /**
     * the BOOT-LOADED escape-hatch handlers (id → ResolvedHandler) wired into
     * `deps.engine.handlers`. A test loads them via `@rayspec/platform`'s `loadHandlers(root, …)`
     * (with the real importer or an injected one) and passes the map here. Used by `{handler}` routes
     * + declared agents' tool factories. Omit ⇒ no loaded handlers (a `{handler}` route fails closed
     * at boot; a declared tool with a handler would too).
     */
    engineHandlers?: ReadonlyMap<string, ResolvedHandler>;
    /**
     * the backend INSTANCE per BackendId for DECLARED agents (wired into
     * `deps.engine.agentBackends`). When supplied, `createAuthApp` builds the agent registry FROM THE
     * SPEC (so a declared agent runs through the existing runAgent). When OMITTED, the spec's agents
     * are NOT engine-built (the harness falls back to the directly-injected `agentRegistry` — the /
     * pattern). The platform ships no backend — the test supplies a FakeRunBackend.
     */
    agentBackends?: NonNullable<NonNullable<AppDeps['engine']>['agentBackends']>;
    /**
     * the tenant-bound blob backend factory wired into `deps.engine.blobFactory` (the
     * `stream` route arm builds `init.blob` from it). A stream-ingest test passes a real fs factory
     * over a per-suite temp dir (`makeFsBlobStoreFactory(tmpDir)`) — exercising the SAME injection the
     * composition root does. Omit ⇒ a declared `stream` route fails closed at boot (no blob backend).
     */
    blobFactory?: NonNullable<NonNullable<AppDeps['engine']>['blobFactory']>;
    /**
     * the media-token service wired into `deps.engine.mediaTokenService` (the playback
     * route's 2nd auth path + the mint capability). A playback test passes a service built over a test
     * media secret. Omit ⇒ a declared `stream` playback route fails closed at boot (no media verifier).
     */
    mediaTokenService?: NonNullable<NonNullable<AppDeps['engine']>['mediaTokenService']>;
    /**
     * the per-user playback concurrent-stream cap (default 4). A semaphore test sets it
     * tiny (e.g. 1) to exercise the 429 deterministically.
     */
    playbackMaxStreamsPerUser?: number;
    /**
     * Override the isolated schema name (default `rayspec_test_apiauth`). A second concurrent
     * harness (e.g. the A3 GUC test, which needs its OWN schema so it does not collide with the main
     * declared-routes suite) passes a distinct name.
     */
    schema?: string;
    /**
     * -TTL: override the access-token TTL (seconds) the harness signer mints with. Default UNSET ⇒
     * the signer default (ACCESS_TOKEN_TTL_SECONDS = 480), so every existing suite is unaffected. A
     * TTL test passes e.g. 3600 to assert the auth-route `expiresIn` reflects the configured TTL.
     */
    accessTokenTtlSeconds?: number;
    /**
     * override the body-refresh operator gate. Default UNSET ⇒ `false` (today's
     * cookie-only posture; every existing suite is unaffected). A body-refresh test passes `true` to
     * exercise the gated+opt-in delivery of the rotated secret in the JSON body.
     */
    bodyRefreshEnabled?: boolean;
    /**
     * Wrap the raw Db BEFORE it is injected into `createAuthApp` (test-only seam, A3). The A3 GUC
     * test passes a wrapper whose `transaction` reads `current_setting('app.current_tenant')` INSIDE
     * the handler's real transaction — proving the GUC is populated (not a proxy). The schema DDL is
     * applied on the UNWRAPPED handle; only the app's deps.db is wrapped.
     */
    wrapDb?: (db: Db) => Db;
    /**
     * Build the AuthService over a deterministic fake clock (default UNSET ⇒ the real wall clock, so
     * every existing suite is unaffected). A grace-window test opts in and drives `harness.clock`
     * (advance/reset) so the reuse-detection grace boundary is exercised WITHOUT a wall-clock race.
     */
    useFakeClock?: boolean;
    /**
     * the OPTIONAL session-reprocess seam wired into `deps.sessionReprocessor` (the reprocess route's
     * injected dependency). A reprocess-route suite injects a fake reprocessor; omit ⇒ the route
     * fail-closes 501 (the unwired posture a test can also exercise).
     */
    sessionReprocessor?: AppDeps['sessionReprocessor'];
  } = {},
): Promise<Harness> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for api-auth integration tests');
  const SCHEMA = opts.schema ?? DEFAULT_SCHEMA;
  const FULL_SCHEMA_SQL = buildFullSchemaSql(SCHEMA);
  const db = makeDbWithSchema(url, SCHEMA);
  await db.$client.unsafe(FULL_SCHEMA_SQL);

  // materialize the declared stores in the isolated schema (real generated DDL), build
  // the runtime product tables, and register them in the chokepoint Set for the suite's lifetime.
  let engine: AppDeps['engine'];
  let unregisterTables: (() => void) | undefined;
  let productTableNames: string[] = [];
  if (opts.engineSpec) {
    const stores = opts.engineSpec.stores;
    if (stores.length > 0) {
      // The REAL generated DDL. It carries `-> statement-breakpoint` markers and
      // `"public".`-qualified FK targets (orgs + product->product); strip the markers and retarget
      // the qualifier to THIS isolated schema (the same retarget the cross-tenant gate does),
      // then apply under the schema's search_path. The pool's startup `search_path = '${SCHEMA}, public'`
      // (makeDbWithSchema) already resolves unqualified `CREATE TABLE` to ${SCHEMA} on EVERY pooled
      // connection — so NO bare `SET search_path` here: a session-level SET drops the `, public` and
      // PERSISTS on the pooled connection (a heterogeneous pool → intermittent relation-not-found).
      const productSql = generateProductSql(stores, opts.conflictKeys)
        .replace(/-->\s*statement-breakpoint/g, '')
        .replace(/"public"\./g, `"${SCHEMA}".`);
      await db.$client.unsafe(productSql);
    }
    const productTables = buildProductTables(stores, opts.conflictKeys);
    unregisterTables = registerScopedTables([...productTables.values()]);
    productTableNames = stores.map((s) => s.name);
    // thread the boot-loaded escape-hatch handlers + the declared-agent backends into the
    // engine, so `{handler}` routes resolve + declared agents are spec-built. Omitted ⇒ shape.
    engine = {
      spec: opts.engineSpec,
      productTables,
      // Thread the conflict-key carve-out onto the engine (mirroring product-boot) so the
      // store-route 409 mapper treats a global-unique key column as unnameable. Omit ⇒ backend-profile
      // default (every author `unique` column tenant-scoped, safe to name).
      ...(opts.conflictKeys ? { conflictKeys: opts.conflictKeys } : {}),
      ...(opts.engineHandlers ? { handlers: opts.engineHandlers } : {}),
      ...(opts.agentBackends ? { agentBackends: opts.agentBackends } : {}),
      // the tenant-bound blob backend for declared `stream` routes (omit ⇒ no blob backend
      // ⇒ a stream route fails closed at boot — the deploy-guard property a test can also exercise).
      ...(opts.blobFactory ? { blobFactory: opts.blobFactory } : {}),
      // the media-token service for declared `stream` playback routes + the mint capability
      // (omit ⇒ a playback route fails closed at boot — the deploy-guard a test can also exercise).
      ...(opts.mediaTokenService ? { mediaTokenService: opts.mediaTokenService } : {}),
      ...(opts.playbackMaxStreamsPerUser !== undefined
        ? { playbackMaxStreamsPerUser: opts.playbackMaxStreamsPerUser }
        : {}),
    };
  }

  // A real RS256 key — set into the env so assertBootSecrets passes + the signer signs.
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  process.env.RAYSPEC_JWT_SIGNING_KEY = pkcs8;
  if (!process.env.RAYSPEC_API_KEY_PEPPER) {
    process.env.RAYSPEC_API_KEY_PEPPER = 'dev-pepper-for-tests-only';
  }
  // -TTL: pass the optional override (undefined ⇒ createSigner's default 480 — existing suites unaffected).
  const signer = await createSigner(pkcs8, 'RS256', opts.accessTokenTtlSeconds);
  const jwksProvider = new JwksProvider([signer.publicKeyJwk()]);

  const identityStore = new IdentityStore(db);
  const orgStore = new OrgStore(db);
  const apiKeyStore = new ApiKeyStore(db);
  const auditStore = new AuditStore(db);
  const idempotency = new IdempotencyStore(db);
  // A short grace window (30ms) so the reuse-detection tests exercise both sides of the grace
  // boundary. Production uses the default ~10s window. When `useFakeClock` is set, the grace tests
  // drive an injected clock (advance/reset) so the boundary is deterministic — no wall-clock race.
  const clock = opts.useFakeClock ? makeFakeClock() : undefined;
  const authService = new AuthService(identityStore, signer, {
    graceMs: 30,
    ...(clock ? { now: clock.now } : {}),
  });

  let oidcProvider: ReturnType<typeof createOidcProvider> | undefined;
  if (opts.withOidc) {
    const providerJwk = await exportJWK(privateKey);
    oidcProvider = createOidcProvider({
      issuer: opts.oidcIssuer ?? 'http://127.0.0.1/oidc',
      db,
      jwks: { keys: [{ ...providerJwk, use: 'sig', alg: 'RS256' }] },
      clients: opts.oidcClients ?? [],
      proxy: true,
    });
  }

  const deps: AppDeps = {
    // A3: the declared-route engine reads deps.db; wrap it (test-only) to capture the in-handler
    // transaction GUC. The stores hold the UNWRAPPED handle (they ran the DDL on it) — only the
    // engine/run path sees the wrapper.
    db: opts.wrapDb ? opts.wrapDb(db) : db,
    signer,
    jwks: jwksProvider,
    rateLimiter: new RateLimiter(),
    identityStore,
    orgStore,
    apiKeyStore,
    auditStore,
    idempotency,
    authService,
    oidcProvider,
    allowedOrigins: ['https://app.rayspec.test'],
    // default false (today's cookie-only posture); a body-refresh suite opts in.
    bodyRefreshEnabled: opts.bodyRefreshEnabled ?? false,
    agentRegistry: opts.agentRegistry,
    engine,
    ...(opts.sessionReprocessor ? { sessionReprocessor: opts.sessionReprocessor } : {}),
  };

  const app = createAuthApp(deps);

  // Product tables are TRUNCATEd on reset too (they are tenant-scoped data; a leak across tests would
  // corrupt the cross-tenant assertions). They cascade-depend on orgs, so order them BEFORE the core
  // truncate of ALL_TABLES (CASCADE on orgs would also clear them, but listing them is explicit).
  const truncateList =
    productTableNames.length > 0 ? `${productTableNames.join(', ')}, ${ALL_TABLES}` : ALL_TABLES;

  return {
    app,
    deps,
    db,
    clock,
    reset: async () => {
      // No bare `SET search_path` (it would drop `, public` and persist on the pooled connection).
      // The pool's startup search_path already pins `${SCHEMA}, public`, so the unqualified TRUNCATE
      // resolves to ${SCHEMA} on every connection.
      await db.$client.unsafe(`TRUNCATE ${truncateList} CASCADE;`);
      // Reset the in-memory rate limiter so per-test counts/locks do not bleed across tests.
      deps.rateLimiter.clearAll();
      // Reset the fake clock (if any) to its base so an advance in one test cannot leak into the next.
      clock?.reset();
    },
    close: async () => {
      // Unregister the product tables from the deny-by-default Set (the persistent registration must
      // not leak into another suite's chokepoint state).
      unregisterTables?.();
      await db.$client.end();
    },
  };
}

// ---------------------------------------------------------------------------------------
// the DEPLOY harness: drive the REAL `deploy` GitOps flow end-to-end.
// ---------------------------------------------------------------------------------------

export interface DeployHarness {
  /** The assembled AppDeps WITHOUT an engine (deploy()'s buildApp wires the engine). */
  deps: AppDeps;
  db: Db;
  /** The DeployTarget seam backed by the isolated-schema DB (applyMigration/verify/query/driftSchema). */
  target: DeployTarget;
  /**
   * The deployer's `buildApp` — returns a `createAuthApp` wired with `{ ...deps, engine }`. The
   * acceptance test passes this in `rollout.buildApp` so deploy() builds the REAL app (engine-wired).
   */
  buildApp: (engine: DeclarativeEngine) => ReturnType<typeof createAuthApp>;
  /**
   * The CANONICAL product tables the harness built + REGISTERED (the committed A1 tuple sim). The
   * acceptance test passes THESE as `deploy()`'s `rollout.productTables` so the verify-not-register
   * probe sees the SAME registered instances (the Set is keyed by object identity).
   */
  productTables: ReadonlyMap<string, PgTable>;
  /** Optionally wrap the raw Db before it is injected (the route-handler GUC capture test). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Build a harness for driving the REAL `deploy()` command end-to-end against an isolated schema.
 *
 * UNLIKE `createHarness`, this does NOT pre-apply the product DDL — `deploy()` applies it via the
 * `applyMigration` seam (so the MIGRATE step is exercised for real). It DOES pre-register the
 * throwaway product tables in the deny-by-default Set (the test seam — `registerScopedTables`,
 * carved out of both gates), simulating the COMMITTED A1 tuple a real deployment ships; deploy()'s
 * verify-not-register step then passes (and a NON-registered store would abort the deploy — the
 * acceptance suite proves both directions).
 *
 * @param opts.stores            the declared stores whose tables are pre-registered (the A1 tuple sim).
 * @param opts.schema            the isolated schema name (default `rayspec_test_deploy`).
 * @param opts.wrapDb            optional raw-Db wrapper (the route-handler GUC capture test).
 */
export async function createDeployHarness(opts: {
  stores: RaySpec['stores'];
  schema?: string;
  wrapDb?: (db: Db) => Db;
  /** Conflict-key carve-out for the pre-registered product tables (see createHarness.opts). */
  conflictKeys?: StoreConflictKeys;
}): Promise<DeployHarness> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for api-auth deploy harness');
  const SCHEMA = opts.schema ?? 'rayspec_test_deploy';
  const db = makeDbWithSchema(url, SCHEMA);
  // Core-only schema (identity + oidc + idempotency + run journal). NO product DDL — deploy applies it.
  await db.$client.unsafe(buildFullSchemaSql(SCHEMA));

  // Pre-register the throwaway product tables in the REAL deny-by-default Set — this SIMULATES the
  // committed A1 tuple a real deployment ships (the platform main line is product-empty). deploy()
  // verifies-not-registers; the test owns registration via the carved-out test seam.
  const productTables = buildProductTables([...opts.stores], opts.conflictKeys);
  const unregister = registerScopedTables([...productTables.values()]);
  const productTableNames = opts.stores.map((s) => s.name);

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  process.env.RAYSPEC_JWT_SIGNING_KEY = pkcs8;
  if (!process.env.RAYSPEC_API_KEY_PEPPER) {
    process.env.RAYSPEC_API_KEY_PEPPER = 'dev-pepper-for-tests-only';
  }
  const signer = await createSigner(pkcs8, 'RS256');
  const jwksProvider = new JwksProvider([signer.publicKeyJwk()]);

  const wrappedDb = opts.wrapDb ? opts.wrapDb(db) : db;
  const identityStore = new IdentityStore(db);
  const orgStore = new OrgStore(db);
  const apiKeyStore = new ApiKeyStore(db);
  const auditStore = new AuditStore(db);
  const idempotency = new IdempotencyStore(db);
  const authService = new AuthService(identityStore, signer, { graceMs: 30 });

  const deps: AppDeps = {
    db: wrappedDb,
    signer,
    jwks: jwksProvider,
    rateLimiter: new RateLimiter(),
    identityStore,
    orgStore,
    apiKeyStore,
    auditStore,
    idempotency,
    authService,
    allowedOrigins: ['https://app.rayspec.test'],
    // the deploy harness does not exercise body-refresh — default cookie-only.
    bodyRefreshEnabled: false,
  };

  // The DeployTarget seam — backed by THIS isolated-schema DB. applyMigration strips drizzle's
  // statement-breakpoints + retargets the `"public".`-qualified FK targets to the isolated schema
  // (mirrors how createHarness applies the generated DDL), and runs it in ONE transaction
  // (all-or-nothing). verifyTenantScoped probes the REAL chokepoint via forTenant(...).select(table).
  const PROBE_TENANT = '00000000-0000-0000-0000-0000000000aa';
  const target: DeployTarget = {
    driftSchema: SCHEMA,
    async applyMigration(migration: PlannedMigration): Promise<void> {
      const ddl = migration.sql
        .replace(/-->\s*statement-breakpoint/g, '')
        .replace(/"public"\./g, `"${SCHEMA}".`);
      // ONE all-or-nothing transaction: a failed statement rolls the whole migration back. `SET LOCAL`
      // is TRANSACTION-scoped — it does NOT persist on the pooled connection after COMMIT (unlike a
      // bare session-level `SET`, which would drop `, public` and poison the pool); keep `, public` so
      // unqualified references still resolve in-tx.
      await db.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${SCHEMA}", public;\n${ddl}`);
      });
    },
    verifyTenantScoped(table: PgTable, storeName: string): void {
      // Probe the REAL TenantDb chokepoint: `.select(table)` runs `assertScoped`, which THROWS
      // deny-by-default if the table is not in TENANT_SCOPED_TABLES. We do not execute the query —
      // building the select is enough to trip the runtime admission check. storeName aids the deploy
      // message. The `select` signature is typed to the COMMITTED literal tuple (the A1 compile-time
      // guard); a runtime-built product table is not a member of that type, so we cast to the
      // parameter type — the RUNTIME `assertScoped` is exactly what this probe is meant to exercise.
      void storeName;
      const tdb = forTenant(db, PROBE_TENANT);
      (tdb.select as (t: PgTable) => unknown)(table);
    },
    async query(querySql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
      // detectDrift introspects information_schema filtered by table_schema = driftSchema; run it on
      // the isolated-schema pool (search_path already set by makeDbWithSchema).
      const rows = await db.$client.unsafe(querySql, params as never[]);
      return rows as unknown as Record<string, unknown>[];
    },
  };

  const buildApp = (engine: DeclarativeEngine) => createAuthApp({ ...deps, engine });

  const truncateList =
    productTableNames.length > 0 ? `${productTableNames.join(', ')}, ${ALL_TABLES}` : ALL_TABLES;

  return {
    deps,
    db,
    target,
    buildApp,
    productTables,
    reset: async () => {
      // No bare `SET search_path` (it would drop `, public` and persist on the pooled connection); the
      // pool's startup search_path already pins `${SCHEMA}, public` so the unqualified TRUNCATE resolves
      // to ${SCHEMA} on every connection.
      await db.$client.unsafe(`TRUNCATE ${truncateList} CASCADE;`);
      deps.rateLimiter.clearAll();
    },
    close: async () => {
      unregister();
      await db.$client.end();
    },
  };
}

/** Re-export so a deploy-acceptance test can build the GUC probe SQL without re-importing drizzle. */
export { sql as drizzleSql };

/** Issue a Hono request against the app with a JSON body + headers, returning the Response. */
export async function jsonRequest(
  app: ReturnType<typeof createAuthApp>,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return app.request(path, { method, headers, body });
}
