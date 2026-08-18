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
 * THE POSTURE HEADLINE — the fragment BOTH banners carry in their title line.
 *
 * It is a named constant rather than two inlined literals because it used to be two inlined
 * literals in one banner and nothing at all in the other: `staticBootBanner` shipped with no
 * posture statement, though a static boot binds through the same host/port path and honours the
 * same non-loopback `RAYSPEC_HOST` opt-in. `banner.test.ts` asserts this constant against its own
 * shipped bytes, so a rewording is an explicit edit there and never a silent one here.
 */
export const NOT_INTERNET_FACING = 'NOT internet-facing';

/**
 * THE POSTURE WARNING — the two-line block BOTH banners print, verbatim and unconditionally.
 *
 * One literal, two call sites: the full-platform boot and the static-profile boot state the SAME
 * posture in the SAME bytes, so neither can drift into a softer sentence while the other keeps the
 * hard one. The block reads the same on a static boot for a reason worth stating rather than
 * assuming: the external-hardening suite is the gate before external exposure of THIS SERVER, and
 * it is unbuilt for every profile — a boot that opens no database has less to lose, not more
 * protection in front of it.
 *
 * Unconditional by construction: no branch, no env var, no verbosity flag reads it. `banner.test.ts`
 * pins the bytes of both constants and both banners, and asserts neither banner names a suppression
 * variable — so the warning cannot be deleted, softened, or made opt-out without a RED.
 */
export const POSTURE_WARNING_LINES: readonly string[] = Object.freeze([
  '  The external-hardening suite (RLS / KMS-wrapped DEKs / per-tenant sandbox / DPoP) is the gate before external',
  '  exposure and is NOT built yet. Do not place this server behind a public address.',
]);

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
    `  RaySpec server — LOCAL / single-node / pre-external-hardening — ${NOT_INTERNET_FACING}`,
  );
  lines.push(RULE);
  lines.push(...POSTURE_WARNING_LINES);
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
  // `eraseTenantNow` is undefined for a boot that declares NEITHER product stores NOR a workforce, so
  // there is no seam for the gate to arm and a gate posture would be misleading here. What this line
  // must NOT do is claim the database holds nothing to erase: a declared workforce puts a tenant's whole
  // task graph and its journal in the database with no product store in sight, and that shape wires the
  // seam — so it never reaches this branch. State the WIRING, and name both halves of what would change
  // it; the database's contents are not something this line can speak for.
  if (server.eraseTenantNow === undefined) {
    lines.push(
      '    Tenant data erasure:   NOT WIRED — this boot declared no product stores and no workforce, so RAYSPEC_ERASURE_ENABLED has no erasure seam to arm here',
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
  // told, and nobody should have their tool arguments and tool outputs leave for a third party
  // without being told either. `server.agentTracing` was read off the SDK's own global trace provider,
  // not derived from any variable — so this line stays honest on the entry points that never change
  // the SDK default, and it cannot say OFF on a boot that is still exporting. Like the housekeeping
  // block above, every line names the variable behind the value it prints.
  //
  // WHAT THE TRANSPORT CARRIES, stated the way the SDK actually behaves rather than as "prompts leave
  // the machine": the model input and the model response are held in PRIVATE span fields (`_input` /
  // `_response`, set by `@openai/agents-openai`'s responses model) and `@openai/agents-core` strips
  // every `_`-prefixed key in `Span.toJSON` (`removePrivateFields`) before the exporter serializes it.
  // Function spans carry `input`/`output` unprefixed, so tool arguments and tool outputs DO leave.
  //
  // WHY THE REMEDIATION HINT NAMES NO ENTRY POINT. This banner has four call sites — serve.ts, the
  // `deploy` command, examples/local-boot/serve.ts and deployments/acme-notes/serve.mts — and every
  // one of them applies a trace-export posture before it prints, so "set RAYSPEC_AGENT_TRACING=…" is
  // an instruction that works wherever this line appears. It used to be true of only the first two,
  // which is why the hint used to name them. What keeps the unqualified form honest is not a
  // convention: wrapper-agent-tracing.test.ts DISCOVERS the `bootBanner(` call sites by reading the
  // tree and requires each to apply a posture, so a fifth boot that printed this banner without
  // reading the variable REDs there instead of quietly making this sentence false.
  lines.push('');
  lines.push('  Agent tracing (observed):');
  if (server.agentTracing === 'openai') {
    lines.push(
      '    Trace export:          EXPORTING TO OPENAI — agent traces leave this process: run metadata ' +
        'and, once an agent calls tools, its tool arguments and outputs (the agent SDK strips the ' +
        'model prompt fields before export). Stop it with RAYSPEC_AGENT_TRACING=off — every boot ' +
        'that prints this banner reads it',
    );
  } else {
    lines.push(
      '    Trace export:          OFF — no agent trace (run metadata, and tool arguments and outputs ' +
        'once an agent calls tools) leaves this process. Export them to OpenAI with ' +
        'RAYSPEC_AGENT_TRACING=openai — every boot that prints this banner reads it',
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
  lines.push(`  RaySpec server — STATIC PROFILE (frontend-only) — ${NOT_INTERNET_FACING}`);
  lines.push(RULE);
  lines.push(
    '  This boot serves ONLY the declared static frontend(s). No auth/OIDC/runs/API route is mounted,',
  );
  lines.push('  and no database, JWT signing key, or api-key pepper is required.');
  // The SAME posture block the full boot prints. Opening no database and mounting no auth surface
  // is a smaller blast radius, not a hardened one: this boot still binds a TCP host/port and still
  // has nothing external in front of it. The title says which profile; the block says where it may
  // be placed, and both banners say it in the same bytes (`banner.test.ts`).
  lines.push(...POSTURE_WARNING_LINES);
  lines.push(RULE);
  lines.push(`  Base URL:     ${base}`);
  lines.push('');
  lines.push('  Readiness:');
  lines.push("    GET  /health   (no db field — reports the declared mounts' boot-time");
  lines.push('                    readiness as `frontend`; 503 when a mount cannot be served)');
  lines.push('');
  lines.push('  Served static frontend mounts:');
  for (const m of server.frontendMounts) {
    // BOTH declared mount options, so this line and the `deploy --dry-run` verdict (which echoes each
    // mount whole) agree on what is worth naming: `cleanUrls` decides how every extensionless path
    // under the mount resolves, which is not something an operator should have to read the spec for.
    const options = [m.spa ? '(SPA fallback)' : '', m.cleanUrls ? '(clean URLs)' : '']
      .filter(Boolean)
      .join(' ');
    lines.push(`    ${m.route.padEnd(12)} → ${m.dir}${options === '' ? '' : `   ${options}`}`);
  }
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}
