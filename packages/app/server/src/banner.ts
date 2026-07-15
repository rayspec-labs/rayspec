/**
 * The loud LOCAL / pre-external-hardening boot banner.
 *
 * Printed at the entrypoint so an operator cannot miss that this server is LOCAL / single-node and
 * NOT hardened for external exposure: the external-hardening suite (RLS / KMS-wrapped DEKs / per-tenant sandbox / DPoP) is
 * the gate before any internet-facing deployment and is NOT built yet. CAPABILITIES.md says the
 * same. Pure string-building (no I/O) so it is unit-testable and the entrypoint just logs it.
 */
import type { BootedServer } from './composition-root.js';

const RULE = '─'.repeat(86);

/**
 * Build the base URL for the ACTUAL bound address — the banner must never claim `127.0.0.1` while the
 * server is actually listening on another interface. Pass the listener's real `address`/`port` (from
 * `@hono/node-server`'s listen callback). An IPv6 literal is bracketed so the URL stays well-formed
 * (e.g. `::1` → `http://[::1]:8080`, `::` → `http://[::]:8080`).
 */
export function bootBaseUrl(address: string, port: number): string {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** Build the multi-line boot banner for a booted server listening on `base`. */
export function bootBanner(server: BootedServer, base: string): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(RULE);
  lines.push(
    '  RaySpec server — LOCAL / single-node / pre-external-hardening — NOT internet-facing',
  );
  lines.push(RULE);
  lines.push(
    '  The external-hardening suite (RLS / KMS-wrapped DEKs / per-tenant sandbox / DPoP) is the gate before external',
  );
  lines.push('  exposure and is NOT built yet. Do not place this server behind a public address.');
  lines.push(RULE);
  lines.push(`  Base URL:     ${base}`);
  lines.push(`  OIDC issuer:  ${server.issuer}`);
  // tell the operator whether this boot MOUNTED an existing product schema (data preserved)
  // or MATERIALIZED a fresh one — so a restart that should preserve data is visibly confirmed.
  if (server.deployMode === 'mounted') {
    lines.push(
      '  Product DB:   MOUNTED — existing product stores were preserved (no DDL; data survived)',
    );
  } else if (server.deployMode === 'materialized') {
    lines.push(
      '  Product DB:   MATERIALIZED — first roll-out created the product stores on a clean DB',
    );
  } else if (server.deployMode === 'updated') {
    // a reviewed forward delta evolved the EXISTING schema in place — existing rows survived
    // (no drop/recreate), and the post-migrate drift gate confirmed the delta fully reconciled the spec.
    lines.push(
      '  Product DB:   UPDATED — reviewed forward delta applied in place; existing data survived',
    );
  }
  lines.push('');
  lines.push('  Platform auth/run routes:');
  lines.push('    GET  /health');
  lines.push('    POST /v1/auth/register · POST /v1/auth/login · GET /v1/auth/me');
  lines.push('    POST /v1/orgs · POST /v1/orgs/{id}/switch · POST /v1/orgs/{id}/api-keys');
  lines.push('    POST /v1/agents/{id}/runs (JSON or SSE) · GET /v1/runs/{id} · /events');

  if (server.declaredAgents.length > 0) {
    lines.push('');
    lines.push('  Declared agents (from the injected spec):');
    for (const a of server.declaredAgents) {
      lines.push(`    '${a.id}' → backend ${a.backend}, model ${a.model}`);
    }
  }
  if (server.declaredRoutes.length > 0) {
    lines.push('');
    lines.push('  Declared routes (from the injected spec):');
    for (const r of server.declaredRoutes) {
      lines.push(`    ${r.method.padEnd(6)} ${r.path.padEnd(28)} → ${r.action}`);
    }
  }
  if (server.declaredCronTriggers.length > 0) {
    lines.push('');
    lines.push('  Scheduled cron triggers (fired off-request on the durable worker):');
    for (const name of server.declaredCronTriggers) {
      lines.push(`    cron '${name}'`);
    }
    lines.push('    (webhook/event/manual trigger kinds are RESERVED per-kind — not fired.)');
  }
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}
