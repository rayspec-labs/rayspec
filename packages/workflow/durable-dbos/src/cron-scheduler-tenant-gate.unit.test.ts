/**
 * The absent-tenant firing gate — pure + mock unit tests (no DB, no DBOS launch).
 *
 * Two properties the DB-backed suite cannot show, because both are about what the gate is told and
 * what it says rather than about what it writes:
 *
 *  1. THE PROBE IS ASKED ABOUT THE SCHEDULER'S OWN TENANT. The gate exists to guarantee that nothing
 *     dispatches under a tenant this deployment cannot resolve. A probe that takes no argument cannot
 *     express that guarantee — it answers about whatever tenant the wiring happened to close over, and
 *     the scheduler has no way to tell. Passing the id it is about to fire under makes the question
 *     structurally the right one.
 *  2. THE SKIP LINE STATES WHAT ACTUALLY HAPPENS NEXT. Not writing the reserve marker leaves the slot
 *     fireable on demand, which is true and load-bearing — but a SCHEDULED tick has already completed
 *     its engine-level per-instant workflow (`sched-cron:<name>-<ISO>`), so DBOS does not replay that
 *     occurrence on its own. A running deployment therefore resumes at the NEXT instant. An operator
 *     told that the skipped instant comes back by itself would wait for a firing that never arrives.
 *
 * The gate also runs BEFORE any database handle is used, which these tests get for free: they pass a
 * `db` that would throw on any access, so a skip that touched it could not stay green.
 */
import {
  invokeTriggerHandler,
  type ResolvedHandler,
  type TriggerDescriptor,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { cronTenantAbsentLog, DbosCronScheduler, firingInstantIso } from './index.js';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000b2';
const INSTANT = new Date('2026-06-24T03:00:00.000Z');

const handlerFn: ResolvedHandler & { kind: 'trigger' } = { kind: 'trigger', fn: async () => {} };

function cron(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 3 * * *',
    action: { kind: 'handler', handlerId: 'h', handler: handlerFn },
  };
}

/**
 * A scheduler whose tenant probe records the id it was asked about and answers "absent", so every
 * fire takes the skip path. `db` is a proxy that throws on ANY property access: the gate must decide
 * before the fire path reaches for a database handle.
 */
function makeSkippingScheduler(tenantId: string) {
  const asked: unknown[] = [];
  const logged: string[] = [];
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('the tenant gate must decide before any database handle is used');
      },
    },
  );
  const scheduler = new DbosCronScheduler([cron('nightly-digest')], {
    db: db as never,
    tenantId,
    executor: {} as never,
    productTables: new Map<string, PgTable>(),
    invokeTriggerHandler,
    tenantExists: async (id: string) => {
      asked.push(id);
      return false;
    },
    logger: { warn: (m: string) => logged.push(m) },
  });
  return { scheduler, asked, logged };
}

describe('the absent-tenant gate asks about the tenant it is about to fire under', () => {
  it('passes the scheduler OWN tenant id to the probe', async () => {
    const { scheduler, asked } = makeSkippingScheduler(TENANT);

    expect(await scheduler.fireNow('nightly-digest', INSTANT)).toBe(false);

    // The guarantee is "nothing fires under a tenant this deployment cannot resolve" — so the probe
    // must have been asked about THAT tenant, not about an unstated one.
    expect(asked).toEqual([TENANT]);
  });

  it('a second scheduler asks about ITS tenant — the question follows the scheduler, not the wiring', async () => {
    const { scheduler, asked } = makeSkippingScheduler(OTHER_TENANT);

    await scheduler.fireNow('nightly-digest', INSTANT);

    expect(asked).toEqual([OTHER_TENANT]);
  });

  it('decides before any database handle is touched (the db proxy would throw)', async () => {
    const { scheduler, logged } = makeSkippingScheduler(TENANT);

    // No rejection: the skip returned without reaching the reserve, which is the only db user here.
    await expect(scheduler.fireNow('nightly-digest', INSTANT)).resolves.toBe(false);
    expect(logged).toHaveLength(1);
  });
});

describe('the skip line describes the resumption that actually happens', () => {
  const line = cronTenantAbsentLog('nightly-digest', TENANT, INSTANT);

  it('names the trigger, the instant and the tenant on ONE line', () => {
    expect(line).not.toContain('\n');
    expect(line).toContain('nightly-digest');
    expect(line).toContain(firingInstantIso(INSTANT));
    expect(line).toContain(TENANT);
  });

  it('keeps the true half: no firing marker was written, so the slot stays fireable on demand', () => {
    expect(line).toMatch(/no firing marker was written/i);
    expect(line).toMatch(/on demand/i);
  });

  it('says scheduled firing resumes at the NEXT instant, not that this one returns by itself', () => {
    // The engine records the scheduled workflow for this instant as completed, so the skipped
    // occurrence is not replayed while the process stays up.
    expect(line).toMatch(/resumes at the next (scheduled )?instant/i);
    // and it must not promise the skipped instant back.
    expect(line).not.toMatch(/firing resumes as soon as the org exists/i);
  });
});
