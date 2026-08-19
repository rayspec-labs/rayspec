/**
 * OPERATOR TENANT DATA-ERASURE — the shipped entry point to the `BootedServer.eraseTenantNow` control
 * seam, so an operator has a path to it that is not a private embedder.
 *
 * THE PROBLEM THIS SOLVES. The erasure seam is built on EVERY boot (`composition-root.ts` — the
 * product deploy, the classic deploy and the document-free auth-only boot all assign it) and is gated
 * fail-closed on `RAYSPEC_ERASURE_ENABLED === 'true'`. What it did not have was a way in: no HTTP
 * route and no CLI verb. The only way to exercise a tenant's right to erasure was to write a wrapper
 * that assembled the server by hand and called the seam — which is what the M1 live acceptance run
 * had to do. A documented capability with no path to use it is the same defect class as an unwired
 * one, one layer up.
 *
 * WHY IT BOOTS THE COMPOSITION ROOT RATHER THAN TALKING TO THE DATABASE. This is the one place it
 * departs from `tenant-provision.ts`, which speaks to `DATABASE_URL` directly. Erasure's PRODUCT half
 * needs the deployed document's store list (for the FK-safe children-first delete order) and its blob
 * backend; only the composition root knows those. A direct-to-database reimplementation would erase
 * the core half, silently leave every product row behind, and report success. Booting the shipped
 * root is what makes this command exactly as powerful as the seam, with no second implementation to
 * drift away from it. It binds no port and serves nothing.
 *
 * THE COST, STATED. Booting applies the committed migration chain, and a document that declares a
 * durable worker launches one, which `close()` then drains — the same thing `rayspec-serve` does on
 * every start, and the same caveat `provisionTenant` already carries about `applyMigrations`. So this
 * command migrates whatever `DATABASE_URL` it is pointed at, exactly like every other boot.
 *
 * THE GATE IS NOT TOUCHED. `RAYSPEC_ERASURE_ENABLED` is resolved by `loadServerConfig` at the
 * composition root, from the ambient environment, by a strict `=== 'true'`. Nothing here reads it,
 * writes it, defaults it or interprets it. What this module reports is `config.erasureEnabled` — the
 * RESOLVED boolean off the booted server's own `housekeeping` block — so an operator who set `"TRUE"`
 * is shown the `false` the comparison actually produced, never the string they typed.
 *
 * AUDIT-BEFORE-ACT, FAIL-CLOSED. A `tenant_erase_requested` row is written BEFORE the seam is called
 * and a failed write ABORTS the command. That row is the only record of an attempt the gate REFUSED —
 * `eraseTenant`'s own `tenant_data_erased` row is written only on the path that actually deletes, so
 * without this one, someone trying to destroy a tenant and being stopped leaves no trace whatsoever.
 * `auth_audit` is a global/auth table that tenant erasure deliberately does not erase, so both rows
 * survive the erasure they describe.
 */

import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { AuditStore, type EraseResult } from '@rayspec/api-auth';
import { makeDb } from '@rayspec/db';
import {
  assembleServer,
  type BootedServer,
  loadServerConfig,
  type ServerConfig,
} from './composition-root.js';
import { assembleOptsFromEnv } from './serve-opts.js';

/** A fail-closed erasure abort. `code` is a documented namespace this command's callers may match on. */
export class TenantEraseCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TenantEraseCommandError';
    this.code = code;
  }
}

/** What the operator asked for. `dryRun: true` is a preview; the gate still governs the other case. */
export interface TenantEraseInput {
  /** The org whose data is to be erased (or previewed). Validated by the seam's own `forTenant`. */
  readonly orgId: string;
  /**
   * `true` ⇒ force a counts-only preview regardless of the gate. `false` ⇒ ASK to erase; the
   * operator gate then decides, and an unset/near-miss gate still produces a preview. Never
   * defaulted here — the caller states its intent, because a defaulted destructive flag is exactly
   * the ambiguity this surface exists to remove.
   */
  readonly dryRun: boolean;
  /** The softer content-erasure posture (see `eraseTenant`'s `journalScrub`). */
  readonly journalScrub: boolean;
  /** The operator's stated reason. Recorded in the audit row; never interpreted. */
  readonly reason?: string;
}

/** The outcome, plus the two facts the seam's own result cannot carry. */
export interface TenantEraseReport {
  /**
   * The RESOLVED operator gate for THIS boot (`BootedServer.housekeeping.erasureEnabled`) — never the
   * raw environment string. A rejected `"TRUE"` reads here as the `false` it produced.
   */
  readonly gate: boolean;
  /** The correlation id of the `tenant_erase_requested` audit row this run wrote. */
  readonly auditRequestId: string;
  /** The seam's own structured result, forwarded unmodified. */
  readonly result: EraseResult;
}

/**
 * Boot this deployment, record the attempt, and drive the erasure seam once.
 *
 * A usage-level impossibility (no seam on the assembled server, a failed audit write) is a
 * `TenantEraseCommandError` with a code; the ORDINARY outcomes — a preview, a gate-refused preview,
 * a real deletion — all come back as a `TenantEraseReport`, because none of them is an error:
 * distinguishing them is the caller's job and the values it needs are all on the report.
 *
 * It takes NO injection seam. `provisionTenant` has two, and each is exercised by its suite; a
 * `loadConfig`/`assemble` pair here would be an untested substitute for the very thing this module
 * exists to use unchanged — and a stand-in for the composition root is exactly how a gate resolved
 * "somewhere else" would get in. `tenant-erase.db.test.ts` drives the real boot against a real
 * database instead, and the CLI layer above has its own seam for the arg/output contract.
 */
export async function eraseTenantData(input: TenantEraseInput): Promise<TenantEraseReport> {
  const now = new Date();

  // The boot-config abort is the SHIPPED refusal text — it names the variables and, for a broken file
  // mount, the path, but never a byte of content (the boot-secret suite pins that), so it is safe to
  // surface verbatim. It is given its own code because "the environment is not sufficient to boot" is
  // a different thing for an operator to fix than "the boot itself failed".
  let config: ServerConfig;
  try {
    config = loadServerConfig();
  } catch (err) {
    throw new TenantEraseCommandError('BOOT_CONFIG_INVALID', oneLine(err));
  }

  let server: BootedServer;
  try {
    server = await assembleServer(config, assembleOptsFromEnv(config));
  } catch (err) {
    throw new TenantEraseCommandError(
      'BOOT_FAILED',
      'Assembling the deployment failed, so nothing was previewed or erased. This command boots the ' +
        'same composition root `rayspec-serve` does (it binds no port), because the product-store ' +
        `order and the blob backend come from the deployed document. Reported: ${redactBootSecrets(oneLine(err), config)}`,
    );
  }

  // The seam is wired on every boot `assembleServer` produces, but the type keeps it OPTIONAL so an
  // embedder assembling a `BootedServer` by hand is not forced to supply one. Fail closed rather than
  // report a no-op erasure as a success.
  const seam = server.eraseTenantNow;
  if (!seam) {
    await server.close().catch(() => {});
    throw new TenantEraseCommandError(
      'ERASURE_SEAM_UNWIRED',
      'This boot carries no tenant data-erasure seam, so there is nothing to drive. Every boot ' +
        '`assembleServer` produces wires one; a server assembled by hand may not.',
    );
  }

  // AUDIT BEFORE ACT. Its own connection: the booted server does not publish its audit store, and
  // opening one here keeps this module from having to reach inside the composition root. Written
  // after the boot (the boot is what applies the migration chain that creates `auth_audit`) and
  // before the seam, so no attempt — including one the gate then refuses — is unrecorded.
  const auditRequestId = randomUUID();
  const auditDb = makeDb(config.databaseUrl);
  try {
    await new AuditStore(auditDb).appendTenantErasureRequested({
      tenantId: input.orgId,
      requestId: auditRequestId,
      meta: {
        requested: input.dryRun ? 'preview' : 'erase',
        // The RESOLVED gate, so the record says what this boot would actually do.
        gate: server.housekeeping.erasureEnabled,
        journalScrub: input.journalScrub,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        // The observed invoker. An OS user is not an authenticated principal and is not claimed to
        // be one — it is the honest answer to "which shell ran this", which is more than the zero
        // the record carried before, and it is why `--reason` exists beside it.
        invoker: { user: safeUser(), host: hostname(), pid: process.pid },
        at: now.toISOString(),
      },
    });
  } catch (err) {
    await auditDb.$client.end().catch(() => {});
    await server.close().catch(() => {});
    throw new TenantEraseCommandError(
      'AUDIT_FAILED',
      `Recording the erasure attempt for org '${input.orgId}' failed, so the attempt was abandoned ` +
        `before the seam was called — no preview and no delete. Reported: ${redactBootSecrets(oneLine(err), config)}`,
    );
  }

  try {
    const result = await seam(input.orgId, {
      dryRun: input.dryRun,
      journalScrub: input.journalScrub,
    });
    return { gate: server.housekeeping.erasureEnabled, auditRequestId, result };
  } catch (err) {
    // The THIRD library-error path, and it was the one left bare. `eraseTenant` fail-closes on an
    // absent org and can surface a driver error from inside the delete transaction, so this is no
    // less likely to quote a connection string back than the other two — and a caller that reads
    // `code` would otherwise get whatever `name` the thrown value happened to carry.
    throw new TenantEraseCommandError(
      'ERASE_FAILED',
      `The erasure seam refused or failed for org '${input.orgId}'. The attempt is recorded in ` +
        `auth_audit under request id ${auditRequestId}. Reported: ${redactBootSecrets(oneLine(err), config)}`,
    );
  } finally {
    await auditDb.$client.end().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** The invoking OS user, or `'unknown'` where the platform refuses to say (a container without a passwd entry). */
function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** A driver/library error collapsed to one line so an operator's JSON stays one object. */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

/**
 * Blank out the resolved boot secrets if a driver or library quoted one back at us.
 *
 * The same posture `runTenantEnsure`'s `redactSecrets` takes, for the same reason: a connection
 * string carries a password, and a failure deep in a driver is exactly the moment nobody is auditing
 * what an error string happens to contain. Enforced on the way out rather than assumed of every
 * dependency — and it has to happen HERE, because the CLI above never holds these values and so
 * cannot strip them.
 *
 * EXPORTED FOR ITS OWN PROOF. The failure this defends against is one no *shipped* driver error is
 * known to produce today (a refused connection reports `connect ECONNREFUSED host:port` and nothing
 * more), so a suite that drove a real failure through it would pass whether or not the stripping
 * happened — a vacuous arm dressed as a proof. It is a pure function of a string and the resolved
 * config, so `tenant-erase.test.ts` proves it directly instead, with an accept control.
 */
export function redactBootSecrets(message: string, config: ServerConfig): string {
  return message
    .split(config.databaseUrl)
    .join('<DATABASE_URL>')
    .split(config.apiKeyPepper)
    .join('<RAYSPEC_API_KEY_PEPPER>')
    .split(config.jwtSigningKeyPem)
    .join('<RAYSPEC_JWT_SIGNING_KEY>');
}
