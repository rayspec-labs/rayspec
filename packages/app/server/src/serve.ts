#!/usr/bin/env node
// The LOCAL boot entrypoint.
//
//   pnpm --filter @rayspec/server serve        # tsx src/serve.ts (local dev)
//   node packages/server/dist/serve.js          # the built bin (rayspec-serve)
//
// Reads config from the ambient environment (see composition-root.ts / the package README), fails
// closed on missing secrets, assembles the platform, applies the committed migration chain, and
// serves the Hono app on PORT (default 8080) via @hono/node-server. Prints the loud LOCAL / pre-external-hardening
// banner. LOCAL / single-node / NOT internet-facing — external hardening is the gate before external exposure.
//
// Product-free: an auth-only boot is the default. If RAYSPEC_SPEC_PATH points at a spec, the REAL
// deploy() pipeline materializes the declared product stores/routes/agents — the platform ships NO
// spec; the deployer injects it. A backend-profile spec WITH agents boots DIRECTLY here too: this
// entrypoint builds the backend instances the spec's OWN declared agents select from the ambient env
// (agentBackendsFactoryFromEnv → makeExtractionBackend, fail-closed on a missing credential) and feeds
// it, plus the product-table registrar, into assembleServer's existing deployer seams (see
// assembleOptsFromEnv). So `RAYSPEC_SPEC_PATH=<spec> rayspec-serve` runs a stores/api, handler, AND
// agent spec with no hand-written wrapper. The dev wrapper (examples/local-boot) is now only a
// convenience (fresh DROP+CREATE dev-DB provisioning + the RAYSPEC_BOOT_UPDATE redeploy flow), NOT a
// requirement for agents.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { DeployError } from '@rayspec/api-auth';
import { type FrontendSpec, parseSpec } from '@rayspec/spec';
import { bootBanner, bootBaseUrl, staticBootBanner } from './banner.js';
import { BootTimeoutError, resolveBootTimeoutMs, withBootTimeout } from './boot-timeout.js';
import {
  assembleServer,
  assembleStaticServer,
  BootConfigError,
  isStaticProfile,
  loadServerConfig,
  loadStaticServerConfig,
} from './composition-root.js';
import { ProductBootError } from './product-boot.js';
import { assembleOptsFromEnv } from './serve-opts.js';

/**
 * Local-development-only optional `.env` loader. A real deployment sets env via its orchestrator/secret
 * manager and this file is absent. We load the repo-root `.env` (gitignored) ONLY IF it exists, and
 * NEVER override an already-set process.env var (an explicit shell/orchestrator value always wins).
 * PEMs are stored with literal `\n` in this repo's `.env`; we unescape them so importPKCS8 accepts
 * the key. Disable entirely with RAYSPEC_SKIP_DOTENV=1 (e.g. to prove pure-ambient-env boot).
 */
function loadLocalDotenvIfPresent(): void {
  if (process.env.RAYSPEC_SKIP_DOTENV === '1') return;
  // packages/server/src -> repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, '..', '..', '..', '..', '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
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

/**
 * If RAYSPEC_SPEC_PATH names a STATIC-PROFILE (frontend-only) backend spec, return its resolved path +
 * parsed frontend mounts for the DB-less / auth-less static boot; otherwise undefined (⇒ the normal
 * boot). Reads ONLY the spec file — never the three boot secrets — so a frontend-only deployment boots
 * with none of them set. A missing/unreadable spec falls through to the normal boot, which raises its
 * own error exactly as today (this detection never changes the normal path's error behaviour).
 */
function detectStaticBoot(): { specPath: string; frontend: readonly FrontendSpec[] } | undefined {
  const raw = process.env.RAYSPEC_SPEC_PATH?.trim();
  if (!raw) return undefined;
  const specPath = resolve(raw);
  let specSource: string;
  try {
    specSource = readFileSync(specPath, 'utf8');
  } catch {
    return undefined; // unreadable/missing spec → the normal boot raises its own error
  }
  if (!isStaticProfile(specSource)) return undefined;
  // isStaticProfile already proved this parses as a backend RaySpec with a non-empty frontend; re-parse
  // to hand the typed mounts to assembleStaticServer.
  const parsed = parseSpec(specSource);
  if (!parsed.ok || parsed.value.frontend === undefined || parsed.value.frontend.length === 0) {
    return undefined;
  }
  return { specPath, frontend: parsed.value.frontend };
}

async function main(): Promise<void> {
  loadLocalDotenvIfPresent();

  // Static-profile detection BEFORE the secret-requiring config load: a frontend-only spec boots with
  // NO database/JWT/pepper and mounts NO auth surface (see assembleStaticServer). It branches AWAY from
  // the whole DB/auth composition, so it must run before loadServerConfig (which fail-closes on the
  // three secrets). Every non-static boot is byte-unchanged below.
  const staticBoot = detectStaticBoot();
  if (staticBoot) {
    console.log(
      '[rayspec-serve] booting — static profile (frontend-only): no database, no auth surface…',
    );
    const staticConfig = loadStaticServerConfig();
    const staticServer = assembleStaticServer(staticConfig, staticBoot);
    const httpServer = serve(
      { fetch: staticServer.app.fetch, hostname: staticConfig.host, port: staticConfig.port },
      (info) => {
        console.log(staticBootBanner(staticServer, bootBaseUrl(info.address, info.port)));
      },
    );
    const shutdown = (signal: string) => {
      console.log(`\n[rayspec-serve] ${signal} received — shutting down…`);
      httpServer.close(async () => {
        await staticServer.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  // Print a progress line BEFORE the (potentially slow) assemble step so a hang is never silent — the
  // banner below prints only once the whole boot succeeds. Names the phases this boot is about to run.
  console.log(
    '[rayspec-serve] booting — loading config, connecting to the database, applying migrations…',
  );
  const config = loadServerConfig();
  // Guard the assemble step (DB connect → migration chain → product boot) with a boot timeout so a hung
  // boot is DIAGNOSED (see boot-timeout.ts) rather than hanging forever. The happy path is unchanged: a
  // normal boot completes well under the timeout and the timer is cleared.
  const server = await withBootTimeout(
    assembleServer(config, assembleOptsFromEnv(config)),
    resolveBootTimeoutMs(),
  );

  const httpServer = serve(
    { fetch: server.app.fetch, hostname: config.host, port: config.port },
    (info) => {
      // Log the ACTUAL bound address (info.address), never a hard-coded loopback — a non-loopback
      // RAYSPEC_HOST bind must be visible in the banner rather than masked behind a false 127.0.0.1.
      console.log(bootBanner(server, bootBaseUrl(info.address, info.port)));
    },
  );

  // Graceful shutdown: stop accepting connections, end the DB pool, exit. Wired to SIGINT/SIGTERM.
  const shutdown = (signal: string) => {
    console.log(`\n[rayspec-serve] ${signal} received — shutting down…`);
    httpServer.close(async () => {
      await server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * True only when this module is the process entrypoint (`node dist/serve.js` / `tsx src/serve.ts` /
 * the `rayspec-serve` bin), NOT when it is imported. Guards the top-level `main()` so importing the
 * module has NO side effect — without it an `import`
 * would boot a server and `process.exit`, killing the test runner. Both paths are realpath-normalized
 * so a bin symlink (node_modules/.bin/rayspec-serve → dist/serve.js) still matches.
 */
function isProcessEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntrypoint()) {
  main().catch((err) => {
    if (
      err instanceof BootConfigError ||
      err instanceof DeployError ||
      err instanceof ProductBootError ||
      err instanceof BootTimeoutError
    ) {
      // A fail-closed CONFIG abort (a missing secret / a gated destructive delta / a missing agent
      // credential) or a boot timeout — an operator-actionable message, not an unexpected crash. Print
      // the message only, no stack. Anything else is genuinely unexpected: keep the stack.
      console.error(`[rayspec-serve] ${err.message}`);
    } else {
      console.error('[rayspec-serve] boot failed:', err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  });
}
