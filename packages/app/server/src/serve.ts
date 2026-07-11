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
import { registerProductStores } from '@rayspec/db/composition';
import { agentBackendsFactoryFromEnv } from './agent-backends-from-env.js';
import { bootBanner } from './banner.js';
import {
  type AgentBackendsFactory,
  assembleServer,
  BootConfigError,
  loadServerConfig,
  type ProductTableRegistrar,
  type ServerConfig,
} from './composition-root.js';
import { ProductBootError } from './product-boot.js';

/**
 * LOCAL-DX-ONLY optional `.env` loader. A real deployment sets env via its orchestrator/secret
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
 * Build the two deployer-seam opts `assembleServer` needs from the ambient env + the (optional) spec.
 * EXTRACTED out of `main()` so serve.ts's OWN wiring is unit-testable: the DB e2e drives assembleServer
 * with SUBSTITUTE opts (for determinism), so without this the fact that serve.ts feeds the RIGHT seams
 * would be untested — a revert that stopped wiring them would pass CI. `serve-opts.test.ts` pins this
 * by identity. Behavior is identical to the inline construction it replaces:
 *   - NO spec (auth-only boot) → {} (no registrar, no agent factory).
 *   - ANY spec → the SANCTIONED validating product-table registrar (registerProductStores VALIDATES
 *     every table before it joins the deny-by-default chokepoint Set); harmless when the spec declares
 *     no stores. deploy.ts is untouched — these are its existing opts.
 *   - a BACKEND-profile spec WITH ≥1 declared agent → additionally an `agentBackendsFactory` built from
 *     env (agentBackendsFactoryFromEnv); a PRODUCT-profile or agent-free spec needs none (undefined),
 *     and the product deploy path builds its own backends.
 */
export function assembleOptsFromEnv(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): { registerProductTables?: ProductTableRegistrar; agentBackendsFactory?: AgentBackendsFactory } {
  if (!config.specPath) return {};
  const factory = agentBackendsFactoryFromEnv(readFileSync(config.specPath, 'utf8'), env);
  return {
    registerProductTables: registerProductStores,
    ...(factory ? { agentBackendsFactory: factory } : {}),
  };
}

async function main(): Promise<void> {
  loadLocalDotenvIfPresent();
  const config = loadServerConfig();
  const server = await assembleServer(config, assembleOptsFromEnv(config));

  const httpServer = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
    const base = `http://127.0.0.1:${info.port}`;
    console.log(bootBanner(server, base));
  });

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
 * the `rayspec-serve` bin), NOT when it is imported (e.g. a unit test importing `assembleOptsFromEnv`).
 * Guards the top-level `main()` so importing the module has NO side effect — without it an `import`
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
      err instanceof ProductBootError
    ) {
      // A fail-closed CONFIG abort (a missing secret / a gated destructive delta / a missing agent
      // credential) — an operator-actionable message, not an unexpected crash. Print the message only,
      // no stack. Anything else is genuinely unexpected: keep the stack.
      console.error(`[rayspec-serve] ${err.message}`);
    } else {
      console.error('[rayspec-serve] boot failed:', err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  });
}
