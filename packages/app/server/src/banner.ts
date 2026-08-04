/**
 * The loud LOCAL / pre-external-hardening boot banner.
 *
 * Printed at the entrypoint so an operator cannot miss that this server is LOCAL / single-node and
 * NOT hardened for external exposure: the external-hardening suite (RLS / KMS-wrapped DEKs / per-tenant sandbox / DPoP) is
 * the gate before any internet-facing deployment and is NOT built yet. CAPABILITIES.md says the
 * same. Pure string-building (no I/O) so it is unit-testable and the entrypoint just logs it.
 */
import type { BootedServer, StaticBootedServer } from './composition-root.js';

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
  lines.push('    GET  /recovery-scope');
  lines.push('    POST /v1/auth/register · POST /v1/auth/login · GET /v1/auth/me');
  lines.push('    POST /v1/orgs · POST /v1/orgs/{id}/switch · POST /v1/orgs/{id}/api-keys');
  lines.push('    POST /v1/agents/{id}/runs (JSON or SSE) · GET /v1/runs/{id} · /events');
  lines.push('    POST /v1/runs/{id}/cancel');

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

  // The RESOLVED housekeeping posture — the two irreversible-deletion operator gates and the daily
  // cleanup crontab. Printed on every boot this banner covers, because BOTH directions matter: an
  // operator who armed a gate gets the confirmation that irreversible deletion is now live, and one
  // whose `TRUE`/`1` the strict comparison rejected sees DRY-RUN instead of silence. Every line names
  // the variable behind every value it prints — the crontab line prints two settings and so names two —
  // including the lines that report the setting has nothing to act on.
  // `server.housekeeping` carries what the boot RESOLVED, so the supplied string is never echoed back
  // as though it had been accepted.
  const { cleanup, erasureEnabled } = server.housekeeping;
  lines.push('');
  lines.push('  Housekeeping (resolved):');
  if (cleanup.gdprPurgeEnabled) {
    lines.push(
      "    GDPR tombstone purge:  ARMED — RAYSPEC_GDPR_PURGE_ENABLED is exactly 'true'; when the cleanup runs it DELETES irreversibly",
    );
  } else {
    lines.push(
      "    GDPR tombstone purge:  DRY-RUN — counts what it would delete, deletes nothing (set RAYSPEC_GDPR_PURGE_ENABLED to exactly 'true' to arm)",
    );
  }
  // `eraseTenantNow` is undefined for an auth-only / no-product boot (a spec with zero product
  // stores) — there is nothing there for the gate to act on, so say that instead of a gate posture.
  if (server.eraseTenantNow === undefined) {
    lines.push(
      '    Tenant data erasure:   NOT WIRED — this boot deployed no product stores, so there is nothing for RAYSPEC_ERASURE_ENABLED to act on',
    );
  } else if (erasureEnabled) {
    lines.push(
      "    Tenant data erasure:   ARMED — RAYSPEC_ERASURE_ENABLED is exactly 'true'; an erasure call DELETES irreversibly",
    );
  } else {
    lines.push(
      "    Tenant data erasure:   DRY-RUN — counts what it would delete, deletes nothing (set RAYSPEC_ERASURE_ENABLED to exactly 'true' to arm)",
    );
  }
  // `runCleanupNow` is undefined for an auth-only / no-durable-worker boot (DBOS is not launched
  // there, so the cleanup workflow is not wired). The crontab still RESOLVES on such a boot — printing
  // it would advertise a schedule that never fires, so the banner reports the absence instead.
  if (server.runCleanupNow === undefined) {
    lines.push(
      '    Daily cleanup:         NOT SCHEDULED — this boot wires no durable worker, so RAYSPEC_CLEANUP_SCHEDULE fires nothing here',
    );
  } else {
    lines.push(
      `    Daily cleanup:         '${cleanup.schedule}'   (RAYSPEC_CLEANUP_SCHEDULE; RAYSPEC_GDPR_RETENTION_DAYS = ${cleanup.gdprRetentionDays} days)`,
    );
  }

  // The OBSERVED agent trace-export posture. Printed on every boot this banner covers, in BOTH
  // directions, because the defect class here is silence: nobody should lose tracing without being
  // told, and nobody should have their prompts and tool arguments leave for a third party without
  // being told either. `server.agentTracing` was read off the SDK's own global trace provider, not
  // derived from any variable — so this line stays honest on the entry points that never change the
  // SDK default, and it cannot say OFF on a boot that is still exporting. Like the housekeeping block
  // above, every line names the variable behind the value it prints.
  lines.push('');
  lines.push('  Agent tracing (observed):');
  if (server.agentTracing === 'openai') {
    lines.push(
      '    Trace export:          EXPORTING TO OPENAI — agent traces carry prompts and tool arguments, ' +
        "and they leave this process (on 'rayspec deploy' that is RAYSPEC_AGENT_TRACING=openai; " +
        'elsewhere it is the agent SDK default)',
    );
  } else {
    lines.push(
      '    Trace export:          OFF — no agent trace (prompts, tool arguments) leaves this process ' +
        "(set RAYSPEC_AGENT_TRACING=openai on 'rayspec deploy' to export them to OpenAI)",
    );
  }
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the boot banner for a STATIC-PROFILE (frontend-only) server. Distinct from `bootBanner`: this
 * boot mounts NO auth/OIDC/runs/API route and opens no database, so the banner honestly advertises ONLY
 * the served static frontend(s) + the mount-readiness `/health` — it never claims the platform
 * auth/run routes a static boot does not have. It carries neither resolved-posture block either: a
 * static boot schedules no cleanup, wires no erasure and runs no agent, so there is nothing to state.
 */
export function staticBootBanner(server: StaticBootedServer, base: string): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(RULE);
  lines.push('  RaySpec server — STATIC PROFILE (frontend-only) — no database, no auth surface');
  lines.push(RULE);
  lines.push(
    '  This boot serves ONLY the declared static frontend(s). No auth/OIDC/runs/API route is mounted,',
  );
  lines.push('  and no database, JWT signing key, or api-key pepper is required.');
  lines.push(RULE);
  lines.push(`  Base URL:     ${base}`);
  lines.push('');
  lines.push('  Readiness:');
  lines.push("    GET  /health   (no db field — reports the declared mounts' boot-time");
  lines.push('                    readiness as `frontend`; 503 when a mount cannot be served)');
  lines.push('');
  lines.push('  Served static frontend mounts:');
  for (const m of server.frontendMounts) {
    lines.push(`    ${m.route.padEnd(12)} → ${m.dir}${m.spa ? '   (SPA fallback)' : ''}`);
  }
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}
