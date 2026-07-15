/**
 * The composition-side trigger-event vocabulary — the unit proofs compose.ts
 * relies on:
 *
 *   • the MOUNTED descriptor registry is exactly the audio vocabulary (the inventory source);
 *   • the per-trigger idempotency key derivation FOLLOWS THE DESCRIPTOR's declared key field (not a
 *     hardwired session default) and is fail-closed on a missing descriptor (the C10 contract);
 *   • the persist-scope check is PER-EVENT, never a union across events — the two-descriptor
 *     union case is the fail-the-fix arm (a union-based implementation FAILS this suite).
 *
 * The end-to-end audio byte-identity (the composed dispatcher enqueues with EXACTLY
 * `session_id:<id>:finalized`) is pinned in compose.test.ts through the real composed ingress.
 */
import { AUDIO_CAPABILITY_MANIFEST } from '@rayspec/audio-runtime';
import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { RECORD_CAPABILITY_MANIFEST } from '@rayspec/record-runtime';
import type { TriggerEventDescriptor } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { ProductComposeError } from './errors.js';
import {
  mountedTriggerEventDescriptors,
  requirePersistScopeInTriggerPayload,
  triggerRegistrationForWorkflow,
} from './event-vocabulary.js';

const AUDIO_EVENT = 'audio_input.finalized_session';

/** A synthetic SECOND event (generic-key-shaped) — exists ONLY to prove per-event binding vs a union. */
const TICKET_DESCRIPTOR: TriggerEventDescriptor = {
  id: 'ticket_received',
  contract: 'ticket_input.ticket_received',
  idempotency: 'entity_scoped',
  payload_keys: ['ticket_id', 'tenant_id'],
  idempotency_key_field: 'ticket_id',
};

function descriptorMap(
  ...descriptors: TriggerEventDescriptor[]
): ReadonlyMap<string, TriggerEventDescriptor> {
  return new Map(descriptors.map((d) => [d.contract, d]));
}

function workflowTriggeredBy(event: string): WorkflowSpec {
  return {
    id: 'wf_x',
    tier: 'A',
    status: 'runtime_foundation',
    trigger: { event },
    idempotency_key: 'session:wf_x:event',
    steps: [],
  };
}

function inputEvent(payload: Record<string, unknown>): WorkflowInputEvent {
  return { id: 'evt-1', type: AUDIO_EVENT, occurred_at: '2026-07-03T00:00:00.000Z', payload };
}

describe('mountedTriggerEventDescriptors (the inventory source)', () => {
  it('is EXACTLY the audio vocabulary by default: one canonical event with the adapter payload contract', () => {
    const descriptors = mountedTriggerEventDescriptors();
    expect([...descriptors.keys()]).toEqual([AUDIO_EVENT]);
    const audio = descriptors.get(AUDIO_EVENT);
    expect(audio?.id).toBe('session_finalized');
    expect(audio?.payload_keys).toEqual(['session_id', 'tenant_id', 'tracks', 'source_capability']);
    expect(audio?.idempotency_key_field).toBe('session_id');
  });

  it('the audio + record manifest UNION is coherent: both canonical ids, each descriptor intact', () => {
    const descriptors = mountedTriggerEventDescriptors([
      ...AUDIO_CAPABILITY_MANIFEST.capabilities,
      ...RECORD_CAPABILITY_MANIFEST.capabilities,
    ]);
    expect([...descriptors.keys()]).toEqual([AUDIO_EVENT, 'record_input.record_submitted']);
    const record = descriptors.get('record_input.record_submitted');
    expect(record?.id).toBe('record_submitted');
    expect(record?.payload_keys).toEqual(['record_id', 'tenant_id', 'source_capability']);
    expect(record?.idempotency_key_field).toBe('record_id');
  });
});

describe('mountedTriggerEventDescriptors — the fail-closed coherence guards', () => {
  // These three guards were UNREACHABLE before the additive `capabilities` test seam (the function
  // read only the frozen audio manifest, which trivially satisfies all three). Each arm feeds a
  // synthetic capability list that violates exactly one guard — RED-proven by neutering the guard.

  function throwsFrom(capabilities: Parameters<typeof mountedTriggerEventDescriptors>[0]): unknown {
    let thrown: unknown;
    try {
      mountedTriggerEventDescriptors(capabilities);
    } catch (e) {
      thrown = e;
    }
    return thrown;
  }

  it('REJECTS a descriptor whose contract disagrees with the shared normalization, naming BOTH ids (guard: contract mismatch)', () => {
    // normalizeProductTriggerEvent('ticket_input', 'ticket_received') = the default join
    // 'ticket_input.ticket_received' — the descriptor declares a diverged canonical id.
    const thrown = throwsFrom([
      {
        id: 'ticket_input',
        events: [{ ...TICKET_DESCRIPTOR, contract: 'ticket_input.wrong_canonical' }],
      },
    ]);
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('roll out');
    expect((thrown as ProductComposeError).message).toMatch(
      /'ticket_input\.wrong_canonical'.*'ticket_input\.ticket_received'/s,
    );
  });

  it('REJECTS an idempotency_key_field outside payload_keys (guard: C10 silent-weakening)', () => {
    const thrown = throwsFrom([
      {
        id: 'ticket_input',
        events: [
          { ...TICKET_DESCRIPTOR, payload_keys: ['ticket_id'], idempotency_key_field: 'tenant_id' },
        ],
      },
    ]);
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('roll out');
    expect((thrown as ProductComposeError).message).toMatch(
      /'tenant_id'.*not among its payload keys.*\(ticket_id\)/s,
    );
  });

  it('REJECTS two capabilities claiming ONE canonical event id (guard: duplicate descriptor)', () => {
    // Two mounted capability entries each declaring the same (valid) descriptor — one canonical id
    // must have exactly one owning descriptor, never a silently overwritten dispatch table entry.
    const thrown = throwsFrom([
      { id: 'ticket_input', events: [TICKET_DESCRIPTOR] },
      { id: 'ticket_input', events: [TICKET_DESCRIPTOR] },
    ]);
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('roll out');
    expect((thrown as ProductComposeError).message).toMatch(
      /'ticket_input\.ticket_received'.*exactly one owning descriptor/s,
    );
  });
});

describe('triggerRegistrationForWorkflow (C10: explicit descriptor-derived keys)', () => {
  it('derives the CLEAN GENERIC key for a NON-audio descriptor — not a hardwired session default, not the legacy suffix', () => {
    // DELIBERATE: a NEW event's key uses
    // the generic `<field>:<value>` format (payloadFieldIdempotencyKey) — the `:finalized` suffix
    // is AUDIO-ONLY legacy (byte-frozen live run identity, pinned below + in compose.test.ts).
    const registration = triggerRegistrationForWorkflow(
      workflowTriggeredBy(TICKET_DESCRIPTOR.contract),
      descriptorMap(TICKET_DESCRIPTOR),
    );
    expect(registration.workflow.id).toBe('wf_x');
    // A ticket event keys on ticket_id — proof the derivation follows the descriptor. If the
    // implementation fell back to the dispatcher's session_id default, this would be 'event:evt-1';
    // if it reverted to the blanket legacy format, this would be 'ticket_id:t-9:finalized'.
    expect(registration.idempotencyKeyForEvent?.(inputEvent({ ticket_id: 't-9' }))).toBe(
      'ticket_id:t-9',
    );
  });

  it('derives the REAL record_input descriptor key in the generic format (the mounted event)', () => {
    const capabilities = [
      ...AUDIO_CAPABILITY_MANIFEST.capabilities,
      ...RECORD_CAPABILITY_MANIFEST.capabilities,
    ];
    const registration = triggerRegistrationForWorkflow(
      workflowTriggeredBy('record_input.record_submitted'),
      mountedTriggerEventDescriptors(capabilities),
    );
    expect(registration.idempotencyKeyForEvent?.(inputEvent({ record_id: 'rec-7' }))).toBe(
      'record_id:rec-7',
    );
  });

  it('derives the byte-frozen audio key from the REAL mounted descriptor', () => {
    const registration = triggerRegistrationForWorkflow(
      workflowTriggeredBy(AUDIO_EVENT),
      mountedTriggerEventDescriptors(),
    );
    expect(registration.idempotencyKeyForEvent?.(inputEvent({ session_id: 'sess-abc' }))).toBe(
      'session_id:sess-abc:finalized',
    );
  });

  it('REJECTS a workflow whose trigger event has no mounted descriptor (never a silent default)', () => {
    let thrown: unknown;
    try {
      triggerRegistrationForWorkflow(
        workflowTriggeredBy('ghost_input.ghost_event'),
        mountedTriggerEventDescriptors(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).message).toMatch(
      /'ghost_input\.ghost_event'.*no mounted\s+capability declares a descriptor/s,
    );
  });
});

describe('requirePersistScopeInTriggerPayload (per-event, NEVER a union)', () => {
  it('accepts a scope the SPECIFIC triggering event carries', () => {
    expect(() =>
      requirePersistScopeInTriggerPayload({
        workflowId: 'wf_x',
        triggerEvent: AUDIO_EVENT,
        scope: 'session',
        persistingKinds: ['digest'],
        descriptors: mountedTriggerEventDescriptors(),
      }),
    ).not.toThrow();
  });

  it("REJECTS a scope only ANOTHER event's payload carries — the union re-opening this closed", () => {
    // With BOTH descriptors registered, scope 'ticket' (→ 'ticket_id') is in the UNION of payload
    // keys but NOT in the audio trigger's own contract. A union-based check would pass this and
    // every artifact.persist run would fail 'persist_scope_missing' at run time. Per-event rejects.
    const both = descriptorMap(
      ...[...mountedTriggerEventDescriptors().values()],
      TICKET_DESCRIPTOR,
    );
    let thrown: unknown;
    try {
      requirePersistScopeInTriggerPayload({
        workflowId: 'wf_x',
        triggerEvent: AUDIO_EVENT,
        scope: 'ticket',
        persistingKinds: ['digest', 'finding'],
        descriptors: both,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('unsupported_spec');
    expect((thrown as ProductComposeError).message).toMatch(
      /scope 'ticket'.*'audio_input\.finalized_session'.*'ticket_id'.*session_id, tenant_id, tracks, source_capability/s,
    );
  });

  it('REJECTS (fail-closed) when the trigger event has no descriptor at all', () => {
    let thrown: unknown;
    try {
      requirePersistScopeInTriggerPayload({
        workflowId: 'wf_x',
        triggerEvent: 'ghost_input.ghost_event',
        scope: 'session',
        persistingKinds: ['digest'],
        descriptors: mountedTriggerEventDescriptors(),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).message).toMatch(/cannot be validated/);
  });
});
