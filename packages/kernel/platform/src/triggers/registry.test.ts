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
const CRON_TO_AGENT_PERSIST: TriggerSpec = {
  name: 'nightly-extract',
  kind: 'cron',
  schedule: '0 3 * * *',
  action: { kind: 'agent', agent: 'extractor', persistTo: 'extracted_facts' },
};
const CRON_WITH_CATCHUP: TriggerSpec = {
  name: 'nightly-catchup',
  kind: 'cron',
  schedule: '0 4 * * *',
  catchUp: true,
  action: { kind: 'handler', handler: 'digest_handler' },
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

  it("threads an agent action's persistTo onto the resolved trigger descriptor (so the durable worker writes the run output)", () => {
    // FAIL-THE-FIX: an agent trigger action carries an optional persistTo (the store its run output is
    // written into). registerTriggers must carry it onto the resolved ResolvedTriggerAction so the
    // durable cron/trigger worker can thread it onto the enqueued RunJob. Dropping the persistTo
    // pass-through in the registry leaves the resolved action WITHOUT it → this deepEqual goes RED.
    const reg = registerTriggers(specWith([CRON_TO_AGENT_PERSIST]), {
      handlers: new Map(),
      agentIds: new Set(['extractor']),
    });
    const descriptor = reg.get('nightly-extract');
    expect(descriptor?.kind).toBe('cron');
    // The WHOLE resolved action, not just presence: kind + agentId + the threaded persistTo.
    expect(descriptor?.action).toEqual({
      kind: 'agent',
      agentId: 'extractor',
      persistTo: 'extracted_facts',
    });
  });

  it('is ADDITIVE: an agent action WITHOUT persistTo resolves to an action with NO persistTo key (never persistTo:undefined)', () => {
    // The complementary direction: the persistTo threading is conditional (spread only when present), so
    // an action without persistTo must resolve to the byte-identical no-key shape. An over-eager
    // unconditional spread would leave `persistTo: undefined` on the action → `'persistTo' in action`
    // would be true → this goes RED.
    const reg = registerTriggers(specWith([MANUAL_TO_AGENT]), {
      handlers: new Map(),
      agentIds: new Set(['summarizer']),
    });
    const action = reg.get('kick-summarizer')?.action ?? {};
    expect('persistTo' in action).toBe(false);
    expect(action).toEqual({ kind: 'agent', agentId: 'summarizer' });
  });

  it("threads a cron trigger's catchUp:true onto the resolved descriptor (so the durable worker registers make-up-work mode)", () => {
    // REGISTRATION TOOTH (fail-the-fix): the spec-declared catchUp opt-in must reach the descriptor
    // the durable worker consumes. Dropping the catchUp pass-through in registerTriggers leaves the
    // descriptor WITHOUT catchUp → the worker registers ExactlyOncePerIntervalWhenActive (no make-up
    // work) → this assertion goes RED.
    const reg = registerTriggers(specWith([CRON_WITH_CATCHUP]), {
      handlers: new Map([['digest_handler', resolved('trigger')]]),
      agentIds: new Set(),
    });
    const descriptor = reg.get('nightly-catchup');
    expect(descriptor?.kind).toBe('cron');
    expect(descriptor?.catchUp).toBe(true);
  });

  it('is ADDITIVE: a cron trigger WITHOUT catchUp resolves to a descriptor with NO catchUp key (never catchUp:undefined)', () => {
    // The complementary direction: the catchUp threading is conditional (spread only when present), so
    // a trigger without catchUp must resolve to the byte-identical no-key shape. An over-eager
    // unconditional spread would leave `catchUp: undefined` on the descriptor → `'catchUp' in d` true.
    const reg = registerTriggers(specWith([CRON_TO_HANDLER]), {
      handlers: new Map([['digest_handler', resolved('trigger')]]),
      agentIds: new Set(),
    });
    const descriptor = reg.get('nightly-digest');
    expect(descriptor).toBeDefined();
    expect('catchUp' in (descriptor ?? {})).toBe(false);
    expect(descriptor?.catchUp).toBeUndefined();
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
