/**
 * `rayspec tenant erase` — preview, or actually perform, the IRREVERSIBLE erasure of one tenant's
 * data, and emit exactly one JSON object describing what happened.
 *
 * It is the operator entry point to the `BootedServer.eraseTenantNow` control seam, which until now
 * had none: the seam is wired on every boot and gated fail-closed, and it was reachable only by an
 * embedder holding the boot handle. It is the destructive counterpart to `tenant ensure` — the group
 * that creates an organization is the group that erases its data — and it takes the same posture:
 * its authority is possession of `DATABASE_URL` and the platform boot secrets, it mounts NO route,
 * and it prints NO credential.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO KEYS, DELIBERATELY MODELLED ON THE DECISION DOOR'S BREAK-GLASS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Break-glass over a recorded approver needs an EXPLICIT ASK on the request (`override: true`) AND an
 * AUTHORITY the asker cannot mint (`workforce:override` — owner/admin only, never api-key-grantable),
 * and it journals. Erasure is strictly worse than break-glass: break-glass contradicts one recorded
 * decision, erasure destroys every record there is to contradict. So it gets the same two keys, one
 * notch tighter on each:
 *
 *   KEY 1 — THE EXPLICIT ASK. `--confirm <org-id>` must carry the SAME id as `--org-id`. You type the
 *     id of the thing you are destroying, which a copy-pasted command line does not survive. WITHOUT
 *     it the command is a PREVIEW: it passes `dryRun: true` and cannot delete under any gate. A
 *     mismatch is a usage error raised BEFORE anything boots, connects or is called.
 *   KEY 2 — THE OPERATOR GATE. `RAYSPEC_ERASURE_ENABLED === 'true'`, resolved at the composition root
 *     from the ambient environment. NOTHING here reads, writes, defaults or interprets it; a confirmed
 *     request against an unset or near-miss gate ("TRUE", "1", "yes", "True") still comes back as a
 *     counts-only preview. It is a DEPLOYMENT-POSTURE control, not an authority the invoker cannot
 *     grant — an operator setting it in their own shell is exactly the operator who could already
 *     `TRUNCATE` the database. What it stops is the accidental and the scripted invocation.
 *   AND `--reason <text>`, required whenever `--confirm` is given, because an irreversible act that
 *     records no stated cause is not auditable. It lands in the `tenant_erase_requested` audit row
 *     written before the seam is called.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DRY-RUN / REAL DISTINCTION IS IMPOSSIBLE TO MISREAD — BY CONSTRUCTION, NOT BY WORDING.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   - `mode` on the output is the SEAM'S OWN `mode`, copied field by field, never re-derived from the
 *     flags. A command that reasoned "an erase was requested, therefore an erase happened" would
 *     report success against a database still holding every row.
 *   - `gate` is the RESOLVED boolean off the booted server's `housekeeping` block, so an operator who
 *     set `"TRUE"` sees the `false` the strict comparison produced — never the string they typed.
 *   - A CONFIRMED request that did NOT delete is `ok:false` and exit 1, with an error naming the gate.
 *     A script cannot read a gate-refused erasure as success. A PREVIEW that came back as a dry run is
 *     `ok:true` and exit 0 — it did exactly what was asked.
 *
 * `@rayspec/server` is imported DYNAMICALLY inside the handler (the same reason `deploy` and
 * `tenant ensure` do it): the composition root drags in Drizzle, Hono and the durable worker, and
 * `rayspec doctor`'s cold start must not pay for a command it is not running.
 *
 * WHAT IT DOES TO THE DATABASE IT IS POINTED AT, stated plainly: it BOOTS the deployment (binding no
 * port), which applies the committed migration chain — the product-store delete order and the blob
 * backend come from the deployed document, and only the composition root knows them, so a
 * direct-to-database shortcut would erase the core half and silently leave every product row behind.
 */
import { parseArgs } from 'node:util';
import type { EraseBlobOutcome, eraseTenantData } from '@rayspec/server';
import { TenantCliError } from './errors.js';

/** The org id is an org UUID — the same 8-4-4-4-12 shape `tenant ensure` and the tenant chokepoint use. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantEraseResult {
  readonly ok: boolean;
  readonly command: 'tenant erase';
  readonly orgId?: string;
  /** What the OPERATOR asked for — `'preview'` without `--confirm`, `'erase'` with it. */
  readonly requested?: 'preview' | 'erase';
  /** The RESOLVED `RAYSPEC_ERASURE_ENABLED` gate for the booted deployment. Never the raw string. */
  readonly gate?: boolean;
  /** What the seam actually DID. Copied from its result; never inferred from `requested`. */
  readonly mode?: 'deleted' | 'dry-run';
  readonly dryRunReason?: 'gate-disabled' | 'dry-run-requested';
  readonly tables?: Record<string, number>;
  readonly totalRows?: number;
  readonly coreTables?: Record<string, number>;
  readonly coreTotalRows?: number;
  readonly journalScrubbed?: Record<string, number>;
  readonly journalScrubbedTotal?: number;
  readonly blobs?: EraseBlobOutcome;
  /** The correlation id of the audit row recording this attempt. */
  readonly auditRequestId?: string;
  readonly errors: { readonly code: string; readonly message: string }[];
}

/**
 * Injection seam for the suite: it defaults to the real implementation, dynamically imported. Supplying
 * it means `@rayspec/server` is never imported at all, so the seam is a real substitute rather than a
 * decoration on top of one.
 */
export interface TenantEraseDeps {
  readonly eraseImpl?: typeof eraseTenantData;
}

/**
 * Parse `tenant erase`'s flags. Every problem here is a `TenantCliError` (exit 2) rather than an
 * `ok:false` result, and every one of them is raised BEFORE the implementation is reached — this is
 * the command where "validated after calling" would be catastrophic rather than untidy.
 */
function parseEraseArgs(args: readonly string[]): {
  orgId: string;
  dryRun: boolean;
  journalScrub: boolean;
  reason?: string;
} {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        'org-id': { type: 'string' },
        confirm: { type: 'string' },
        reason: { type: 'string' },
        'journal-scrub': { type: 'boolean' },
      },
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    throw new TenantCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length > 0) {
    throw new TenantCliError(
      `tenant erase takes no positional arguments (got ${JSON.stringify(positionals[0])}) — the ` +
        'target is named by --org-id, and the confirmation by --confirm',
    );
  }

  const orgId = (values['org-id'] as string | undefined)?.trim();
  if (!orgId) {
    throw new TenantCliError(
      '--org-id <uuid> is required — it names the tenant whose data is previewed or erased',
    );
  }
  if (!UUID_SHAPE.test(orgId)) {
    throw new TenantCliError(
      `--org-id must be an org UUID (8-4-4-4-12), got ${JSON.stringify(orgId)}`,
    );
  }

  const confirm = (values.confirm as string | undefined)?.trim();
  const reason = (values.reason as string | undefined)?.trim() || undefined;

  // KEY 1. Absent ⇒ a preview, which is the default precisely so that the destructive reading is
  // never the one a half-typed command line lands on.
  if (confirm === undefined || confirm === '') {
    return {
      orgId,
      dryRun: true,
      journalScrub: values['journal-scrub'] === true,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  // A confirmation that is not compared to the target is not a confirmation — it degrades to "put
  // any value here", which is what every copy-pasted command line already has.
  if (confirm !== orgId) {
    throw new TenantCliError(
      `--confirm must repeat --org-id exactly (the id of the tenant whose data will be destroyed). ` +
        `Got --org-id ${JSON.stringify(orgId)} and --confirm ${JSON.stringify(confirm)}.`,
    );
  }
  if (reason === undefined) {
    throw new TenantCliError(
      '--reason <text> is required with --confirm: an irreversible erasure records why it was ' +
        'performed, and the reason is written to the audit trail before anything is deleted',
    );
  }
  return { orgId, dryRun: false, journalScrub: values['journal-scrub'] === true, reason };
}

/**
 * Run the command. A usage problem THROWS `TenantCliError` (exit 2); everything else comes back as a
 * result. `ok:false` (exit 1) covers a failed boot / failed audit / unwired seam AND the case this
 * command exists to make unmistakable: a CONFIRMED erasure that the operator gate refused.
 */
export async function runTenantErase(
  args: readonly string[],
  deps: TenantEraseDeps = {},
): Promise<TenantEraseResult> {
  const parsed = parseEraseArgs(args);
  const requested = parsed.dryRun ? 'preview' : 'erase';
  let erase = deps.eraseImpl;
  if (erase === undefined) {
    // Only for an implementation that was NOT supplied — the composition root is expensive to load.
    const real = await import('@rayspec/server');
    erase = real.eraseTenantData;
  }

  let report: Awaited<ReturnType<typeof eraseTenantData>>;
  try {
    report = await erase({
      orgId: parsed.orgId,
      dryRun: parsed.dryRun,
      journalScrub: parsed.journalScrub,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    });
  } catch (err) {
    // Only the erasure command's own error may name a code in the documented namespace; matched by
    // NAME rather than `instanceof` because `@rayspec/server` is loaded dynamically (and replaced
    // wholesale in tests), so the constructor identity here is not guaranteed to be the one that threw.
    const code = isEraseCommandError(err) ? err.code : 'ERASE_FAILED';
    return {
      ok: false,
      command: 'tenant erase',
      orgId: parsed.orgId,
      requested,
      errors: [{ code, message: errorMessage(err) }],
    };
  }

  // FIELD BY FIELD, never a spread. A structural pass-through would publish whatever property the
  // implementation's object happened to arrive with — a type stops a field being written in source,
  // not an object from carrying one at runtime — and this object is built from a connection the
  // command opened.
  const { result } = report;
  const gateRefused = requested === 'erase' && result.mode !== 'deleted';
  return {
    ok: !gateRefused,
    command: 'tenant erase',
    orgId: parsed.orgId,
    requested,
    gate: report.gate,
    mode: result.mode,
    ...(result.dryRunReason === undefined ? {} : { dryRunReason: result.dryRunReason }),
    tables: { ...result.tables },
    totalRows: result.totalRows,
    coreTables: { ...result.coreTables },
    coreTotalRows: result.coreTotalRows,
    ...(result.journalScrubbed === undefined
      ? {}
      : { journalScrubbed: { ...result.journalScrubbed } }),
    ...(result.journalScrubbedTotal === undefined
      ? {}
      : { journalScrubbedTotal: result.journalScrubbedTotal }),
    blobs: result.blobs,
    auditRequestId: report.auditRequestId,
    errors: gateRefused
      ? [
          {
            code:
              result.dryRunReason === 'gate-disabled'
                ? 'ERASURE_GATE_DISABLED'
                : 'ERASURE_NOT_PERFORMED',
            message:
              'An erasure was requested and NOTHING was deleted — the counts above are a preview. ' +
              'The operator gate RAYSPEC_ERASURE_ENABLED must be EXACTLY the string "true" in the ' +
              'environment this command boots from; anything else (unset, "TRUE", "1", "yes") ' +
              `resolves to false. This boot resolved it to ${String(report.gate)}.`,
          },
        ]
      : [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Did the erasure command layer itself throw this — i.e. may its `code` name the documented namespace? */
function isEraseCommandError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'TenantEraseCommandError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}
