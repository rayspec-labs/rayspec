/**
 * Catch-up MODE wiring — pure + mock unit tests (no DB, no DBOS launch). These prove the production
 * mechanism that makes catch-up actually replay missed intervals: a `catchUp` trigger is registered
 * under DBOS's make-up-work mode (`ExactlyOncePerInterval`), so on startup DBOS replays each interval
 * missed while the app was down. The BEHAVIOURAL make-up path (a replayed interval fires once, bounded
 * by the look-back window, deduped by the reserve) is proven over a REAL engine in
 * cron-scheduler.db.test.ts; this file proves (a) the mode SELECTION and (b) that
 * `registerScheduledWorkflows` actually HANDS that mode to DBOS — a bug could pick the right mode yet
 * never pass it, which the behavioural tests (driven via the deterministic `fireScheduled` seam, not
 * DBOS's wall-clock loop) would not catch.
 */
import { DBOS, SchedulerMode } from '@dbos-inc/dbos-sdk';
import {
  invokeTriggerHandler,
  type ResolvedHandler,
  registerTriggers,
  type TriggerDescriptor,
} from '@rayspec/platform';
import { parseSpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catchUpSchedulerMode, DbosCronScheduler } from './index.js';

const handlerFn: ResolvedHandler & { kind: 'trigger' } = { kind: 'trigger', fn: async () => {} };

function cron(name: string, catchUp?: boolean): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 2 * * *',
    ...(catchUp !== undefined ? { catchUp } : {}),
    action: { kind: 'handler', handlerId: 'h', handler: handlerFn },
  };
}

describe('catchUpSchedulerMode — pure mode selection', () => {
  it('a catch-up trigger selects the make-up-work mode (ExactlyOncePerInterval)', () => {
    expect(catchUpSchedulerMode({ catchUp: true })).toBe(SchedulerMode.ExactlyOncePerInterval);
  });

  it('a non-catch-up trigger selects the when-active mode (no make-up work)', () => {
    expect(catchUpSchedulerMode({ catchUp: false })).toBe(
      SchedulerMode.ExactlyOncePerIntervalWhenActive,
    );
    expect(catchUpSchedulerMode({})).toBe(SchedulerMode.ExactlyOncePerIntervalWhenActive);
  });
});

describe('DECLARATIVE end-to-end — a YAML cron trigger opts into catch-up', () => {
  // The WHOLE declarative chain (D-931 acceptance): a spec-declared `catchUp: true` on a cron trigger
  // must flow parse → registerTriggers → TriggerDescriptor.catchUp === true → catchUpSchedulerMode →
  // ExactlyOncePerInterval (DBOS make-up-work). Proving it across all three layers here (the only place
  // spec + platform + this adapter meet) closes the "runtime-only, no declarative path" hidden-defer.
  const CRON_CATCHUP_YAML = `
version: '1.0'
metadata:
  name: catchup-e2e
deployment:
  durableWorker: true
agents:
  - id: digester
    name: digester
    backend: openai
    model: gpt-4o-mini
    instructions: summarize
triggers:
  - name: nightly-digest
    kind: cron
    schedule: '0 2 * * *'
    catchUp: true
    action: { kind: agent, agent: digester }
`;

  it('catchUp:true YAML → descriptor.catchUp === true → ExactlyOncePerInterval (make-up work)', () => {
    const parsed = parseSpec(CRON_CATCHUP_YAML);
    if (!parsed.ok) {
      throw new Error(`spec must parse:\n${JSON.stringify(parsed.errors, null, 2)}`);
    }
    // Registration threads the spec opt-in onto the descriptor the durable worker consumes.
    const registry = registerTriggers(parsed.value, {
      handlers: new Map(),
      agentIds: new Set(['digester']),
    });
    const descriptor = registry.get('nightly-digest');
    expect(descriptor?.kind).toBe('cron');
    expect(descriptor?.catchUp).toBe(true);
    // The runtime consumes descriptor.catchUp: catch-up selects DBOS's make-up-work mode.
    expect(catchUpSchedulerMode(descriptor ?? {})).toBe(SchedulerMode.ExactlyOncePerInterval);
  });

  it('the SAME spec WITHOUT catchUp stays when-active (no make-up work) — the additive default', () => {
    // Fail-the-fix control: strip only the catchUp line; the descriptor gains no catchUp key and the
    // mode falls back to when-active, so the make-up-work mode is DRIVEN by the declared opt-in, not
    // by the mere presence of a cron trigger.
    const parsed = parseSpec(CRON_CATCHUP_YAML.replace('    catchUp: true\n', ''));
    if (!parsed.ok) throw new Error('control spec must parse');
    const registry = registerTriggers(parsed.value, {
      handlers: new Map(),
      agentIds: new Set(['digester']),
    });
    const descriptor = registry.get('nightly-digest');
    expect(descriptor?.catchUp).toBeUndefined();
    expect(catchUpSchedulerMode(descriptor ?? {})).toBe(
      SchedulerMode.ExactlyOncePerIntervalWhenActive,
    );
  });
});

describe('registerScheduledWorkflows — hands the catch-up mode to DBOS', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers a catch-up trigger under ExactlyOncePerInterval and a plain trigger under ExactlyOncePerIntervalWhenActive', () => {
    // Mock the two static DBOS registration calls so nothing touches a real engine / the global
    // registry. `registerWorkflow` passes its function through; `registerScheduled` captures the config.
    vi.spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
    const scheduled = vi.spyOn(DBOS, 'registerScheduled').mockImplementation((() => {}) as never);

    const scheduler = new DbosCronScheduler([cron('makeup', true), cron('active', false)], {
      db: {} as never,
      tenantId: '00000000-0000-0000-0000-0000000000aa',
      executor: {} as never,
      productTables: new Map<string, PgTable>(),
      invokeTriggerHandler,
    });
    scheduler.registerScheduledWorkflows();

    const byName = new Map(
      scheduled.mock.calls.map((c) => {
        const cfg = c[1] as { name: string; crontab: string; mode: SchedulerMode };
        return [cfg.name, cfg];
      }),
    );
    // The catch-up trigger is handed the make-up-work mode; the plain one keeps when-active.
    expect(byName.get('cron:makeup')?.mode).toBe(SchedulerMode.ExactlyOncePerInterval);
    expect(byName.get('cron:active')?.mode).toBe(SchedulerMode.ExactlyOncePerIntervalWhenActive);
    // The crontab still flows through unchanged (the mode is additive to the existing registration).
    expect(byName.get('cron:makeup')?.crontab).toBe('0 2 * * *');
    expect(byName.get('cron:active')?.crontab).toBe('0 2 * * *');
  });
});
