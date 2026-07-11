/**
 * Triggers seam tests.
 *
 * Each test is FAIL-THE-FIX: the registration tests assert the EXACT fail-closed
 * abort on a dangling/wrong-kind ref (not "it didn't crash"); the fire test asserts the runtime fire
 * is REJECTED with the deferred error (not a silent no-op), and would FAIL if `fireTrigger` ever
 * returned instead of throwing.
 */
import type { RaySpec, TriggerSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import type { ResolvedHandler } from '../handlers/handler-runtime.js';
import {
  registerTriggers,
  TriggerDeferredError,
  TriggerRegistrationError,
  TriggerRegistry,
} from './registry.js';

/** A no-op resolved handler of a given kind (the fn is never invoked — firing is deferred). */
function resolved(kind: ResolvedHandler['kind']): ResolvedHandler {
  const fn = (() => {}) as never;
  return { kind, fn };
}

/** Build a minimal spec carrying only the supplied triggers (every other section empty). */
function specWith(triggers: TriggerSpec[]): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 'trigger-test' },
    stores: [],
    api: [],
    agents: [],
    tooling: [],
    triggers,
    handlers: [],
  };
}

const CRON_TO_HANDLER: TriggerSpec = {
  name: 'nightly-digest',
  kind: 'cron',
  schedule: '0 2 * * *',
  action: { kind: 'handler', handler: 'digest_handler' },
};
const MANUAL_TO_AGENT: TriggerSpec = {
  name: 'kick-summarizer',
  kind: 'manual',
  action: { kind: 'agent', agent: 'summarizer' },
};

describe('registerTriggers — fail-closed boot resolution', () => {
  it('registers a cron→handler + a manual→agent trigger, preserving descriptor fields', () => {
    const reg = registerTriggers(specWith([CRON_TO_HANDLER, MANUAL_TO_AGENT]), {
      handlers: new Map([['digest_handler', resolved('trigger')]]),
      agentIds: new Set(['summarizer']),
    });
    expect(reg.size).toBe(2);

    const cron = reg.get('nightly-digest');
    expect(cron?.kind).toBe('cron');
    expect(cron?.schedule).toBe('0 2 * * *');
    expect(cron?.action).toEqual({
      kind: 'handler',
      handlerId: 'digest_handler',
      handler: expect.objectContaining({ kind: 'trigger' }),
    });

    const manual = reg.get('kick-summarizer');
    expect(manual?.kind).toBe('manual');
    expect(manual?.action).toEqual({ kind: 'agent', agentId: 'summarizer' });
  });

  it('an empty triggers[] yields an empty registry (stores/api/agents-only spec)', () => {
    const reg = registerTriggers(specWith([]), {
      handlers: new Map(),
      agentIds: new Set(),
    });
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('FAIL-CLOSED: a dangling handler ref aborts the deploy (TriggerRegistrationError)', () => {
    expect(() =>
      registerTriggers(specWith([CRON_TO_HANDLER]), {
        handlers: new Map(), // digest_handler NOT loaded
        agentIds: new Set(),
      }),
    ).toThrow(TriggerRegistrationError);
  });

  it("FAIL-CLOSED: a handler of the WRONG kind ('tool'/'route') aborts the deploy", () => {
    expect(() =>
      registerTriggers(specWith([CRON_TO_HANDLER]), {
        handlers: new Map([['digest_handler', resolved('tool')]]), // wrong kind
        agentIds: new Set(),
      }),
    ).toThrow(/kind 'tool', expected 'trigger'/);
  });

  it('FAIL-CLOSED: a dangling agent ref aborts the deploy (TriggerRegistrationError)', () => {
    expect(() =>
      registerTriggers(specWith([MANUAL_TO_AGENT]), {
        handlers: new Map(),
        agentIds: new Set(), // summarizer NOT declared
      }),
    ).toThrow(/references agent 'summarizer' which is not a declared agent/);
  });
});

describe('TriggerRegistry.fireTrigger — fail-closed-rejected', () => {
  it('firing a registered trigger THROWS TriggerDeferredError (never a silent no-op)', () => {
    const reg = registerTriggers(specWith([CRON_TO_HANDLER]), {
      handlers: new Map([['digest_handler', resolved('trigger')]]),
      agentIds: new Set(),
    });
    // FAIL-THE-FIX: if fireTrigger ever returned (a silent no-op or a half-run), this expectation
    // would NOT see a throw and the test fails. The reject names the durable-worker deferral.
    let thrown: unknown;
    try {
      reg.fireTrigger('nightly-digest');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TriggerDeferredError);
    expect((thrown as Error).message).toMatch(/deferred to the durable worker/);
    expect((thrown as Error).message).toMatch(/fail-closed/);
  });

  it('firing an UNKNOWN trigger name throws a distinct registration error (not the deferred error)', () => {
    const reg = new TriggerRegistry([]);
    expect(() => reg.fireTrigger('does-not-exist')).toThrow(TriggerRegistrationError);
    expect(() => reg.fireTrigger('does-not-exist')).not.toThrow(TriggerDeferredError);
  });
});
