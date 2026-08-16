/**
 * The pack's first SERVICE — the side of the dispatch boundary that does NOT hold `TurnDispatch`.
 *
 * It is the ordinary shape: work with no caller. At boot it reads its own pack's configuration out of
 * the top-level section the pack CLAIMS (`auditing`), reads its own pack-owned platform table through
 * the database door, and records one journal entry for having done so; then it arms a timer that
 * records another on every tick, which is the thing no reactive contribution can do at all — a route
 * is served, a tool is invoked, a trigger fires, and none of them runs when nothing calls.
 *
 * IT NAMES NO DISPATCH CAPABILITY. That is the point of having two services: this one demonstrates
 * that a service is not privileged BY BEING a service — it gets what its context carries, and it
 * carries no reach into the run surface unless the module asks for one. Its sibling
 * `turn-scheduler.ts` asks.
 *
 * EVERY CAPABILITY IS TREATED AS POSSIBLY ABSENT, because the contract says it may be: a deployment
 * that binds no tenant has no journal writer to give. The service degrades to doing less rather than
 * throwing — a boot that throws would fail the whole deployment, which is right for a service that
 * cannot work at all and wrong for one whose optional recording is simply not wired.
 */
import type { PackServiceContext, PackServiceModule } from '@rayspec/pack-sdk';
import { contexts, ENV_MARKER_KEY, record, specName, tick } from './observed.js';

/** The shape this pack's own `auditing` grammar accepts (see `../auditing.ts`). */
interface AuditingSection {
  readonly retentionDays: number;
  readonly redactPayloads: boolean;
}

/** How often the ledger sweep records a journal entry. Short, because the fixture is measured. */
const SWEEP_INTERVAL_MS = 50;

/** The service's own correlation id for the work it does — one journal "run" per boot. */
let sweepRunId = '';
let timer: ReturnType<typeof setInterval> | undefined;
let sweeps = 0;

const auditLedger: PackServiceModule = {
  name: 'audit-ledger',

  async boot(ctx: PackServiceContext): Promise<void> {
    record('audit-ledger:boot');

    // The pack's OWN configuration, out of the section the pack claims — already validated by this
    // pack's own grammar, so the service reads a value rather than re-checking a node. A deployment
    // that did not write the section leaves it absent, which is a legitimate posture, not a fault.
    const auditing = ctx.sections.auditing as AuditingSection | undefined;

    // The database door onto the platform table this pack's OWN migration chain created. It can only
    // answer if that chain has already applied, which is exactly the boot ordering this service is a
    // witness to: a service boots AFTER the migrations, never beside them.
    const rows = await ctx.db.query('SELECT count(*)::int AS n FROM fixture_pack_audit_events');
    const ledgerRows = Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);

    // The DOCUMENT and the ENVIRONMENT are on the contract too, so one fact off each is read back
    // here — a context handed an empty document or an empty environment then fails a suite instead of
    // passing unnoticed.
    const marker = ctx.env[ENV_MARKER_KEY];
    contexts.set(auditLedger.name, {
      sectionKeys: Object.keys(ctx.sections),
      ...(auditing ? { retentionDays: auditing.retentionDays } : {}),
      ...(specName(ctx.spec) !== undefined ? { specName: specName(ctx.spec) } : {}),
      ...(marker !== undefined ? { envMarker: marker } : {}),
      journal: ctx.journal !== undefined,
      dispatch: ctx.dispatch !== undefined,
      ledgerRows,
    });

    sweepRunId = `${ctx.packId}:audit-ledger:${Date.now()}`;
    // The first sweep runs NOW rather than one interval from now: a reconcile at boot is the whole
    // reason this kind exists, and a deployment that has just come up should not be a sweep behind.
    await sweep(ctx, ledgerRows);
    timer = setInterval(() => {
      void sweep(ctx, ledgerRows);
    }, SWEEP_INTERVAL_MS);
    // A pack timer must never be the reason a process stays alive: the deployment's lifetime is the
    // listener's, and this rides it.
    timer.unref?.();
  },

  shutdown(): void {
    record('audit-ledger:shutdown');
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  },
};

/** Record ONE journal entry for a sweep. A deployment with no journal writer records none. */
async function sweep(ctx: PackServiceContext, ledgerRows: number): Promise<void> {
  sweeps += 1;
  tick(auditLedger.name);
  if (ctx.journal === undefined) return;
  await ctx.journal.record({
    runId: sweepRunId,
    type: 'store',
    // One step per sweep: the journal's replay key is `(runId, idempotencyKey)`, so a sweep number is
    // what makes each sweep its own step rather than a re-record of the first.
    idempotencyKey: `sweep-${sweeps}`,
    input: { sweep: sweeps },
    output: { ledgerRows },
    status: 'ok',
  });
}

export default auditLedger;
