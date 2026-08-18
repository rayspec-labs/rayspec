// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: a LOCAL dev-boot helper reads the platform's
// boot env vars (PORT / RAYSPEC_PRODUCT_TENANT_ID / RAYSPEC_SPEC_PATH / RAYSPEC_BLOB_ROOT /
// RAYSPEC_EXTRACTION_MODE / OPENAI_API_KEY) directly, by design.
// LOCAL dev-boot wrapper for the Contract-Intake backend.
//
// This product cannot boot through the bare `@rayspec/server` entrypoint: `deploy()`'s
// tenant-scoping chokepoint fail-closes on a product table that isn't registered in the committed
// TENANT_SCOPED_TABLES allowlist (deny-by-default — the correct security posture). A real deployment
// commits a generated product-schema.ts registration; for a LOCAL dev run this thin wrapper supplies
// the same registration at runtime via the SANCTIONED registrar `registerProductStores`
// (@rayspec/db/composition — it VALIDATES every table's tenant predicate before it joins the Set).
//
// This product declares `file_input` AND one agent, so the doc-driven boot ALSO demands
// RAYSPEC_BLOB_ROOT (a throwaway ./.dev-blobs dir here) and RAYSPEC_EXTRACTION_MODE. This wrapper
// boots the LIVE extraction path (real gpt through the generic branch) — HONEST LIMIT: an
// interactive DETERMINISTIC boot is not possible from a wrapper, because deterministic mode requires
// an executor injected via `assembleServer(config, { productDeterministicAgents })` and the platform
// ships none (product-free); the merge-gated e2e
// (`packages/app/server/src/contract-intake-e2e.db.test.ts`) IS that injected-executor boot.
// The live path needs OPENAI_API_KEY (from your shell or the repo-root .env).
//
//   node examples/contract-intake/dev-boot.mjs        # auto-creates the DB, serves on :8793
//
// It defaults to a throwaway `play_contract` DB and CREATES it if missing (one command, no createdb
// step), then seeds the deployment tenant + the contract_type_catalog (idempotent — a reference
// catalog is deployment-seeded by design; there is no product write/admin API). It reads ONLY the
// secrets (RAYSPEC_JWT_SIGNING_KEY + RAYSPEC_API_KEY_PEPPER + OPENAI_API_KEY) from the repo-root
// .env — it DELIBERATELY ignores .env's DATABASE_URL so a demo can never boot against your main dev DB.
//
// Env overrides (all optional; a SHELL value always wins over the default):
//   DATABASE_URL               default postgres://rayspec:rayspec@localhost:5433/play_contract
//   PORT                       default 8793
//   RAYSPEC_PRODUCT_TENANT_ID default 00000000-0000-4000-8000-000000000042
//   RAYSPEC_SPEC_PATH         default the sibling contract-intake.product.yaml
//   RAYSPEC_BLOB_ROOT         default ./.dev-blobs next to this file (throwaway, auto-created)
//   RAYSPEC_EXTRACTION_MODE   default live (the only interactive mode — see above)
//
// LOCAL / single-node / trusted posture / NOT internet-facing.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { makeDb } from '@rayspec/db';
import { registerProductStores } from '@rayspec/db/composition';
import { applyMigrations, assembleServer, bootBaseUrl, loadServerConfig } from '@rayspec/server';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));

// OWN THE TERMINATION SIGNALS FIRST — before any awaited boot step. Node's default action for
// SIGINT/SIGTERM is to terminate, so registering nothing looks safe; it is not. The static imports
// above already installed two handlers this wrapper does not own — @openai/agents-core's tracing
// provider and signal-exit — and each acts ONLY when it is the sole listener, so with both loaded
// they defer to each other and the signal becomes a NO-OP. Everything from module evaluation to the
// `serve()` below was therefore unkillable by SIGTERM. The handler starts in a boot phase that
// aborts, and is REPLACED (not re-registered) once there is something to close, so exactly one pair
// lives on this process. NOT SIGHUP — signal-exit is its only listener there, so that signal already
// stops this process; leaving it unlistened keeps it that way.
const phase = {
  handle: (signal) => {
    console.log(
      `\n[dev-boot] ${signal} received during boot — aborting before the server listens.`,
    );
    process.exit(0);
  },
};
process.on('SIGINT', () => phase.handle('SIGINT'));
process.on('SIGTERM', () => phase.handle('SIGTERM'));

// 1. Boot config — a SHELL env value wins; otherwise a LOCAL default. NOT read from .env (a demo must
//    never boot against the main dev DB), so we capture these BEFORE the .env load below.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://rayspec:rayspec@localhost:5433/play_contract';
const PORT = process.env.PORT ?? '8793';
const TENANT = process.env.RAYSPEC_PRODUCT_TENANT_ID ?? '00000000-0000-4000-8000-000000000042';
const SPEC_PATH = process.env.RAYSPEC_SPEC_PATH ?? resolve(here, 'contract-intake.product.yaml');
const BLOB_ROOT = process.env.RAYSPEC_BLOB_ROOT ?? resolve(here, '.dev-blobs');
const EXTRACTION_MODE = process.env.RAYSPEC_EXTRACTION_MODE ?? 'live';

// 2. Pull ONLY the secrets from the repo-root .env (never override an already-set var; unescape the
//    PEM \n like serve.ts does). We do NOT take DATABASE_URL/PORT/etc. from .env.
const SECRETS = new Set(['RAYSPEC_JWT_SIGNING_KEY', 'RAYSPEC_API_KEY_PEPPER', 'OPENAI_API_KEY']);
const envPath = resolve(here, '..', '..', '.env');
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!SECRETS.has(key) || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  }
}
if (EXTRACTION_MODE === 'live' && !process.env.OPENAI_API_KEY) {
  console.error(
    '[dev-boot] RAYSPEC_EXTRACTION_MODE=live needs OPENAI_API_KEY (shell or repo-root .env) — ' +
      'the boot would fail-close on the extraction backend. Aborting.',
  );
  process.exit(1);
}

// 3. Create the target database if it does not exist (so a fresh `node dev-boot.mjs` just works).
const dbUrl = new URL(DATABASE_URL);
const dbName = dbUrl.pathname.slice(1);
const adminUrl = new URL(DATABASE_URL);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (rows.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`[dev-boot] created database "${dbName}"`);
  }
} finally {
  await admin.end();
}

// 4. Bring the deployment tenant into existence BEFORE the boot. A product deployment whose
//    RAYSPEC_PRODUCT_TENANT_ID names no live org refuses to start — it would serve nobody, since every
//    principal is bound to that tenant. Applying the committed platform chain here creates `orgs`, so
//    the row can be seeded; the boot's own migrate then no-ops over it. The reference CATALOG below
//    still waits for the boot, because its table is a product store the boot materializes.
const tenantSeed = makeDb(DATABASE_URL);
try {
  await applyMigrations(tenantSeed);
  await tenantSeed.$client.unsafe(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Contract Co', 'contract-co')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
} finally {
  await tenantSeed.$client.end();
}

// 5. Boot the composed stack with the LOCAL table-registration stand-in (+ the file/agent env this doc demands).
mkdirSync(BLOB_ROOT, { recursive: true });
process.env.DATABASE_URL = DATABASE_URL;
process.env.PORT = PORT;
process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
process.env.RAYSPEC_SPEC_PATH = SPEC_PATH;
process.env.RAYSPEC_BLOB_ROOT = BLOB_ROOT;
process.env.RAYSPEC_EXTRACTION_MODE = EXTRACTION_MODE;

const config = loadServerConfig();
const server = await assembleServer(config, {
  registerProductTables: registerProductStores,
});

// 6. Seed the contract-type retention catalog (idempotent; the same rows the merge-gated e2e seeds —
//    a reference catalog is deployment-seeded by design).
const seed = postgres(DATABASE_URL, { max: 1 });
try {
  await seed.unsafe(
    `INSERT INTO contract_type_catalog (tenant_id, contract_type, retention_years, review_owner)
     VALUES ($1, 'nda', 5, 'legal-ops'),
            ($1, 'msa', 10, 'general-counsel'),
            ($1, 'sow', 7, 'procurement-desk'),
            ($1, 'dpa', 6, 'privacy-office'),
            ($1, 'other', 10, 'legal-review-queue')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  console.log(
    `[dev-boot] tenant ${TENANT} live + contract_type_catalog seeded (5 rows, idempotent)`,
  );
} finally {
  await seed.end();
}

const httpServer = serve(
  { fetch: server.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(
      `[dev-boot] UP — ${bootBaseUrl(info.address, info.port)} (deployMode=${server.deployMode})`,
    );
  },
);

// Graceful shutdown: stop accepting connections, drain the durable worker + end the DB pool, exit —
// the same wiring `packages/app/server/src/serve.ts` gives the shipped entrypoint. The handlers are
// already installed (top of this file, where the reason they are needed is spelled out); this hands
// them the graceful close now that there is something to close.
// ONE BOUND this does NOT remove: the exit sits inside close()'s callback, which Node runs only once
// every open connection has ended — the port refuses new connections the moment the signal lands,
// but a request still in flight holds the exit until it finishes.
phase.handle = (signal) => {
  console.log(`\n[dev-boot] ${signal} received — shutting down…`);
  httpServer.close(async () => {
    await server.close();
    process.exit(0);
  });
};
