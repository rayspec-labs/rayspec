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
// Product-free: an auth-only boot is the default. If RAYSPEC_SPEC_PATH points at a rayspec.yaml,
// the REAL deploy() pipeline materializes the declared product stores/routes/agents — the platform
// ships NO spec; the deployer injects it. A spec WITH agents also needs its backend instances wired;
// this generic entrypoint ships none, so a spec-with-agents boot must use a wrapper that
// supplies an AgentBackendsFactory (see examples/local-boot). An auth-only or stores/api/handler-only
// spec needs no backends and boots here directly.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { bootBanner } from './banner.js';
import { assembleServer, BootConfigError, loadServerConfig } from './composition-root.js';

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

async function main(): Promise<void> {
  loadLocalDotenvIfPresent();
  const config = loadServerConfig();
  const server = await assembleServer(config);

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

main().catch((err) => {
  if (err instanceof BootConfigError) {
    // A fail-closed config abort — print the actionable message only, no stack.
    console.error(`[rayspec-serve] ${err.message}`);
  } else {
    console.error('[rayspec-serve] boot failed:', err instanceof Error ? err.stack : err);
  }
  process.exit(1);
});
