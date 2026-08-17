/**
 * The pack's first SERVICE — the CONTROL, the one that does NOT hold `TurnDispatch`.
 *
 * It is the ordinary shape: work with no caller. At boot it reads its own pack's configuration out of
 * the top-level section the pack CLAIMS (`auditing`), reads its own pack-owned platform table through
 * the database door, WRITES to it transactionally — the pair of rows that are only ever right
 * together, then a second transaction it abandons mid-write so the rollback is exercised too — and
 * records one journal entry for having done so; then it arms a timer that records another on every
 * tick, which is the thing no reactive contribution can do at all — a route is served, a tool is
 * invoked, a trigger fires, and none of them runs when nothing calls.
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
import type { PackDatabase, PackServiceContext, PackServiceModule } from '@rayspec/pack-sdk';
import { contexts, ENV_MARKER_KEY, recalls, record, specName, tick } from './observed.js';

/** The shape this pack's own `auditing` grammar accepts (see `../auditing.ts`). */
interface AuditingSection {
  readonly retentionDays: number;
  readonly redactPayloads: boolean;
}

/** How often the ledger sweep records a journal entry. Short, because the fixture is measured. */
const SWEEP_INTERVAL_MS = 50;

/**
 * The environment key naming the tenant the DEPLOYMENT bound. A pack that attributes rows has to be
 * told which tenant by the deployment — its context carries no `tenantId`, and the database door is
 * not a tenant filter — and this is the deployment's own name for it, read off `ctx.env`.
 */
const DEPLOYMENT_TENANT_ENV_KEY = 'RAYSPEC_CRON_TENANT_ID';

/** The two ledger rows that are only ever right TOGETHER — the atomic pair the boot writes. */
const LEDGER_OPENED = 'ledger-opened';
const LEDGER_CLOSED = 'ledger-closed';
/** The row the ABANDONED transaction attempts. Nothing may ever read it back. */
const LEDGER_ABANDONED = 'ledger-abandoned';
/** The message the abandoning callback throws — the exact value the caller must catch. */
const ABANDONED_MESSAGE = 'the ledger sweep was abandoned mid-write';

/** How many of its own journal entries a sweep reads back. Bounded, like every read on that door. */
const RECALL_PAGE_SIZE = 10;

/** The service's own correlation id for the work it does — one journal "run" per boot. */
let sweepRunId = '';
let timer: ReturnType<typeof setInterval> | undefined;
let sweeps = 0;
/** How many entries the last read back saw, and which steps they were — what a suite asserts on. */
let recalled = 0;
let recalledKeys: readonly string[] = [];

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

    // THE ATOMIC PAIR, through the TRANSACTIONAL half of the same door: two rows that are only ever
    // right together, written on one pinned connection so they land together or not at all. The rows
    // this pack already holds for the tenant are taken `FOR UPDATE` first — the read-decide-write a
    // pooled statement cannot hold, because the lock would be gone before the decision was written.
    //
    // THE TENANT COMES FROM THE DEPLOYMENT, not from this pack and not from the door. There is no
    // `tenantId` on a service's context, in a transaction or out of one, and the database door is no
    // tenant filter either — it runs the SQL a pack writes. So a pack that attributes rows has to be
    // TOLD which tenant, and this one reads the tenant the deployment bound off the environment it
    // was handed. A deployment that bound none writes nothing, which is a legitimate posture rather
    // than a fault.
    const tenantId = await deploymentTenant(ctx);
    let ledgerPairRows = 0;
    let abandonedError: string | undefined;
    if (tenantId !== undefined) {
      ledgerPairRows = await ctx.db.transaction(async (tx) => {
        const held = await tx.query(
          'SELECT id FROM fixture_pack_audit_events WHERE tenant_id = $1 FOR UPDATE',
          [tenantId],
        );
        await appendEvent(tx, tenantId, LEDGER_OPENED, { held: held.length });
        await appendEvent(tx, tenantId, LEDGER_CLOSED, { held: held.length });
        return 2;
      });

      // THE NEGATIVE CASE, kept beside the positive one on purpose: a callback that throws rolls the
      // WHOLE transaction back, and what the pack catches is the error the pack threw. Without it,
      // "the pair landed" would be indistinguishable from "every write lands".
      try {
        await ctx.db.transaction(async (tx) => {
          await appendEvent(tx, tenantId, LEDGER_ABANDONED, { abandoned: true });
          throw new Error(ABANDONED_MESSAGE);
        });
      } catch (e) {
        abandonedError = e instanceof Error ? e.message : String(e);
      }
    }

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
      ledgerPairRows,
      ...(abandonedError !== undefined ? { abandonedError } : {}),
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

/**
 * The tenant this pack attributes its ledger rows to — the one the DEPLOYMENT bound, named on the
 * environment the service was handed (`ctx.env`, which is on the contract for exactly this kind of
 * deployment-supplied value). Absent on a deployment that bound none, which is what makes the boot
 * above write nothing rather than fail.
 *
 * IT IS CHECKED, NOT PICKED. The pack does not enumerate the platform's tenant table and take
 * whichever row comes first — that would attribute a ledger to an arbitrary tenant on any deployment
 * with more than one. It asks whether the tenant it was NAMED is registered, because this pack's
 * ledger carries a foreign key onto that table: on a deployment whose bound tenant is not registered
 * yet, "write nothing" is the right answer and failing the whole boot is not.
 */
async function deploymentTenant(ctx: PackServiceContext): Promise<string | undefined> {
  const bound = ctx.env[DEPLOYMENT_TENANT_ENV_KEY]?.trim();
  if (!bound) return undefined;
  // Compared AS TEXT on purpose: a value that is not a UUID at all is then "not registered" rather
  // than a cast error that would fail the boot of a deployment this pack has no business judging.
  const rows = await ctx.db.query('SELECT id FROM orgs WHERE id::text = $1', [bound]);
  return rows.length === 1 ? bound : undefined;
}

/**
 * Append ONE ledger row. It takes a `PackDatabase`, so the SAME call serves the pooled door and the
 * transactional one — which is the whole point of the transactional handle being a `PackDatabase`
 * again: a pack writes one statement and decides elsewhere whether it runs inside a transaction.
 *
 * It is HANDED the door rather than closing over `ctx.db`, which is the shape that keeps working: a
 * helper that closed over the service's own door and opened a transaction on it would be REFUSED with
 * a `PackTransactionError` when called from inside another callback, because that second transaction
 * would be an independent one on a second connection rather than a nested one.
 */
async function appendEvent(
  db: PackDatabase,
  tenantId: string,
  action: string,
  payload: unknown,
): Promise<void> {
  await db.query(
    'INSERT INTO fixture_pack_audit_events (tenant_id, actor, action, payload) ' +
      'VALUES ($1, $2, $3, $4::jsonb)',
    [tenantId, auditLedger.name, action, JSON.stringify(payload)],
  );
}

/**
 * Record ONE journal entry for a sweep, then READ BACK what this service has recorded so far. A
 * deployment with no journal door does neither.
 *
 * THE READ IS WHY THIS FIXTURE EXISTS, and it is worth being exact about what it stands for. A
 * service is the surface that WRITES journal steps, and until the door carried both verbs its own
 * record was write-only to it: the only way back was the escape hatch with a core table name in a SQL
 * string. Out in the world the write side is in use and the read side is not yet — this fixture is
 * the repository's only exerciser of it. That is what a fixture is for: the seam gets a witness
 * before it gets a caller, rather than shipping with neither.
 *
 * It is SCOPED BY THE DEPLOYMENT, not by this pack: there is no tenant argument on either verb, so
 * the entries this reads are the bound tenant's and no other's. `runId` narrows to this boot's own
 * sweeps — the pack's own correlation id — rather than to the tenant's whole history.
 */
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
  // READ BACK what was just written, through the same door. A bounded page, oldest first, of this
  // service's own run — so the count this stashes rises with the sweeps and can be asserted against
  // what was recorded rather than against what the writer was called with.
  const page = await ctx.journal.read({ runId: sweepRunId, limit: RECALL_PAGE_SIZE });
  recalled = page.entries.length;
  recalledKeys = page.entries.map((entry) => entry.idempotencyKey);
  recalls.set(auditLedger.name, { recalled, recalledKeys });
}

export default auditLedger;
