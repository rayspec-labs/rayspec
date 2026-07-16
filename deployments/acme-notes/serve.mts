#!/usr/bin/env -S node --import tsx
/**
 * A neutral single-repo Product-YAML VPS boot entrypoint (the deploy-entrypoint gate's subject).
 *
 * The generic `rayspec-serve` bin boots auth-only / classic specs; a Product-YAML boot additionally
 * needs the LOCAL A1 stand-in (`registerProductTables`) so `deploy()`'s identity-keyed chokepoint
 * verify sees the exact product-table instances (a real deployment commits a `product-schema.ts`; the
 * LOCAL/single-node posture registers them at boot). The
 * LIVE extraction, the STT provider, and the store bindings are all read from ENV by the composition
 * root's Product-YAML boot — this wrapper injects NO product meaning.
 *
 * It exists so `check:deploy-entrypoint` has a REAL subject: every bare import here must be a
 * root-linked dependency and resolvable (the ERR_MODULE_NOT_FOUND crash-loop guard).
 */
import { serve } from '@hono/node-server';
import { registerProductStores } from '@rayspec/db/composition';
import {
  assembleServer,
  BootConfigError,
  bootBanner,
  bootBaseUrl,
  loadServerConfig,
} from '@rayspec/server';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const server = await assembleServer(config, {
    // Register the built product tables through the SANCTIONED registrar (@rayspec/db/composition),
    // which VALIDATES every table (tenant_id column / shape / FK) before deploy()'s identity-keyed
    // verify — closing the unscoped-INSERT escalation the raw registerScopedTables seam leaves open.
    registerProductTables: registerProductStores,
  });

  const httpServer = serve(
    { fetch: server.app.fetch, hostname: config.host, port: config.port },
    (info) => {
      console.log(bootBanner(server, bootBaseUrl(info.address, info.port)));
    },
  );

  const shutdown = (signal: string): void => {
    console.log(`\n[acme-notes-serve] ${signal} received — shutting down…`);
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
    console.error(`[acme-notes-serve] ${err.message}`);
  } else {
    console.error('[acme-notes-serve] boot failed:', err instanceof Error ? err.stack : err);
  }
  process.exit(1);
});
