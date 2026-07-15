/**
 * The conversation_input conditional mount at the COMPOSE layer
 * (following the record and file conditional-mount test pattern, designed for the two-JSON-route surface):
 *
 *   1. WHEN DECLARED: BOTH capability-owned stores + BOTH routes — asserted as WHOLE TUPLES
 *      (method/path/action.kind/action.handler; both are plain `{kind:'handler'}` JSON routes — no
 *      byte streams in this capability) — + the handler map + the DEFAULT-join trigger vocabulary.
 *   2. THE C10 KEY PIN: the composed ingress derives the CLEAN GENERIC
 *      `turn_ref:<conversation_id>:<message_id>` idempotency key — PER-TURN (the descriptor's
 *      `idempotency_key_field: 'turn_ref'`; keying on `conversation_id` would dedupe every later
 *      turn of a conversation into its FIRST durable run — silent turn loss), and NEVER the
 *      audio-only ':finalized' suffix.
 *   3. THE CONDITIONAL (fail-the-fix): a doc NOT declaring conversation_input mounts ZERO
 *      conversation surface — no stores, no routes, no handlers, no trigger event (both the
 *      record-only and the file doc).
 *   4. ROLLOUT THREADING: `rollout.conversation.basePath` moves both mounted routes; a
 *      `rollout.conversation.capability` override reaches the REAL `resolveConversationConfig`
 *      (an invalid byte cap fail-closes AT COMPOSE — proving the override seam is wired, not
 *      decorative; a cap above the 64 KiB ceiling likewise).
 *   5. ROUTE-COLLISION fail-closed: a declared POST view on the turn-submit route key is a compose
 *      rejection naming both owners, never a silent second owner.
 * 6. A conversation-declaring doc REQUIRES a wired responder (fail-closed, the
 *      declared-agents executor-coverage mirror); the turn-submit handler entry carries the
 *      handler-managed tx posture; a responder-declared store-context read is cross-checked
 *      against the composed stores (store exists / limit within the STORE_READ cap / closed
 *      filter keys / text filter columns — each fail-closed at compose).
 */
import type {
  ConversationStoreContextRead,
  ConversationTurnResponderFactory,
} from '@rayspec/conversation-runtime';
import { describe, expect, it } from 'vitest';
import { composeCapabilityStores, declaresConversationInput } from './capability-stores.js';
import { composeProductDeploy, type ProductYamlRollout } from './compose.js';
import { deriveProductStores } from './derive-stores.js';
import {
  CONVERSATION_INTAKE_YAML,
  FILE_INTAKE_YAML,
  INTAKE_YAML,
  parseFixture,
  RecordingEnqueuer,
} from './test-support/fixture.js';

const TENANT = '00000000-0000-0000-0000-0000000000c3';

/** A deterministic responder factory for compose tests (the REQUIRED rollout seam). */
function fakeResponder(
  storeContext?: ConversationStoreContextRead,
): ConversationTurnResponderFactory {
  return () => ({
    agentId: 'test_responder',
    historyWindow: { turns: 20, chars: 64 * 1024 },
    ...(storeContext ? { storeContext } : {}),
    respond: async ({ turnRef }) => ({
      status: 'completed',
      runId: `run-${turnRef}`,
      text: 'ok',
    }),
  });
}

/** The conversation rollout: no stt/agents/blob (the fixture uses none); stores derived from the doc. */
function conversationRollout(
  overrides: Partial<ProductYamlRollout> = {},
  yaml: string = CONVERSATION_INTAKE_YAML,
): ProductYamlRollout {
  const spec = parseFixture(yaml);
  const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    // The responder is REQUIRED for a conversation-declaring doc; overrides may replace
    // the whole conversation block (basePath/capability arms spread their own).
    conversation: { responder: fakeResponder() },
    ...overrides,
  };
}

describe('composeProductDeploy — the conversation_input capability (conditional mount + the per-TURN key)', () => {
  it('mounts the conversation capability WHEN DECLARED: BOTH stores + BOTH routes as WHOLE TUPLES + handlers + trigger event', () => {
    const spec = parseFixture(CONVERSATION_INTAKE_YAML);
    expect(declaresConversationInput(spec)).toBe(true);
    const composed = composeProductDeploy(spec, conversationRollout());

    // BOTH capability-owned stores join the composed read surface (engineSpec.stores).
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    expect(storeNames).toContain('conversations');
    expect(storeNames).toContain('conversation_turns');

    // BOTH routes, WHOLE-TUPLE: the PUT idempotent create + the POST turn submit — both plain
    // `{kind:'handler'}` JSON routes (this capability moves no bytes; a route that silently
    // regressed to a stream kind would change what the engine hands the handler).
    const create = composed.engineSpec.api.find(
      (r) => r.path === '/conversations/{conversation_id}',
    );
    expect(create).toEqual({
      method: 'PUT',
      path: '/conversations/{conversation_id}',
      action: { kind: 'handler', handler: 'conversation_input_create' },
    });
    const turn = composed.engineSpec.api.find(
      (r) => r.path === '/conversations/{conversation_id}/turns',
    );
    expect(turn).toEqual({
      method: 'POST',
      path: '/conversations/{conversation_id}/turns',
      action: { kind: 'handler', handler: 'conversation_input_turn_submit' },
    });

    // The resolved handler map carries exactly the two capability handlers.
    expect(composed.handlers.has('conversation_input_create')).toBe(true);
    expect(composed.handlers.has('conversation_input_turn_submit')).toBe(true);

    // The workflow compiled onto the canonical DEFAULT-join event; the dispatcher listens on it.
    expect(composed.workflows.get('log_turn')?.trigger.event).toBe(
      'conversation_input.turn_submitted',
    );
    expect(composed.triggerEvents).toEqual(['conversation_input.turn_submitted']);
  });

  it('enqueues through the composed ingress with the PER-TURN generic key `turn_ref:<conv>:<msg>` (never conversation-scoped, never the audio suffix)', async () => {
    const enqueuer = new RecordingEnqueuer();
    const composed = composeProductDeploy(
      parseFixture(CONVERSATION_INTAKE_YAML),
      conversationRollout({ enqueuer }),
    );
    const emitTurn = (messageId: string, turnSeq: number) =>
      composed.ingress.emit({
        id: `${TENANT}:c-1:${messageId}`,
        type: 'conversation_input.turn_submitted',
        occurred_at: '2026-07-05T00:00:00.000Z',
        payload: {
          conversation_id: 'c-1',
          message_id: messageId,
          turn_ref: `c-1:${messageId}`,
          tenant_id: TENANT,
          source_capability: 'conversation_input',
          turn_seq: turnSeq,
          role: 'user',
          message: 'hello there',
        },
      });

    const first = await emitTurn('m-1', 1);
    expect(first.enqueued).toHaveLength(1);
    expect(enqueuer.calls[0]?.workflow.id).toBe('log_turn');
    expect(enqueuer.calls[0]?.tenantId).toBe(TENANT);
    // ★ THE C10 KEY PIN: the descriptor-derived key is the generic `<field>:<value>` format over
    // the PER-TURN `turn_ref` field — the ':finalized' suffix stays audio-only (its byte-frozen
    // pin lives in compose.test.ts).
    expect(enqueuer.calls[0]?.idempotencyKey).toBe('turn_ref:c-1:m-1');

    // ★ THE TURN-LOSS PIN: a SECOND turn of the SAME conversation derives a DIFFERENT key (its
    // own durable run) — a conversation-scoped key would collapse it into the first run.
    await emitTurn('m-2', 2);
    expect(enqueuer.calls[1]?.idempotencyKey).toBe('turn_ref:c-1:m-2');
    expect(enqueuer.calls[1]?.idempotencyKey).not.toBe(enqueuer.calls[0]?.idempotencyKey);
  });

  it('does NOT mount the conversation surface when the doc does not declare conversation_input (record-only doc)', () => {
    const spec = parseFixture(INTAKE_YAML);
    expect(declaresConversationInput(spec)).toBe(false);
    const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
    const composed = composeProductDeploy(spec, {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
    });
    expect(composed.engineSpec.stores.map((s) => s.name)).not.toContain('conversations');
    expect(composed.engineSpec.stores.map((s) => s.name)).not.toContain('conversation_turns');
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).not.toContain('PUT /conversations/{conversation_id}');
    expect(paths).not.toContain('POST /conversations/{conversation_id}/turns');
    expect(composed.handlers.has('conversation_input_create')).toBe(false);
    expect(composed.handlers.has('conversation_input_turn_submit')).toBe(false);
    expect(composed.triggerEvents).toEqual(['record_input.record_submitted']);
  });

  it('does NOT mount the conversation surface for a FILE doc either (the second undeclared class)', () => {
    const spec = parseFixture(FILE_INTAKE_YAML);
    expect(declaresConversationInput(spec)).toBe(false);
    const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
    const composed = composeProductDeploy(spec, {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
    });
    expect(composed.engineSpec.stores.map((s) => s.name)).not.toContain('conversations');
    // Route absence asserted here too — symmetric with the record-only arm.
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).not.toContain('PUT /conversations/{conversation_id}');
    expect(paths).not.toContain('POST /conversations/{conversation_id}/turns');
    expect(composed.handlers.has('conversation_input_turn_submit')).toBe(false);
    expect(composed.triggerEvents).toEqual(['file_input.file_submitted']);
  });

  it('threads rollout.conversation.basePath into BOTH mounted routes (the deployment option seam)', () => {
    const composed = composeProductDeploy(
      parseFixture(CONVERSATION_INTAKE_YAML),
      conversationRollout({ conversation: { basePath: '/chats', responder: fakeResponder() } }),
    );
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('PUT /chats/{conversation_id}');
    expect(paths).toContain('POST /chats/{conversation_id}/turns');
    expect(paths).not.toContain('PUT /conversations/{conversation_id}');
  });

  it('threads rollout.conversation.capability into the REAL config resolution (an invalid cap fail-closes at compose)', () => {
    // resolveConversationConfig rejects a non-positive byte cap AT CONSTRUCTION (the fail-closed
    // belt); reaching that error through composeProductDeploy proves the override seam is wired.
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({
          conversation: { capability: { maxMessageBytes: -1 }, responder: fakeResponder() },
        }),
      ),
    ).toThrow(/maxMessageBytes must be a positive integer/);
  });

  it('fail-closes a rollout.conversation.capability byte cap ABOVE the 64 KiB ceiling at compose (the class bound)', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({
          conversation: {
            capability: { maxMessageBytes: 64 * 1024 + 1 },
            responder: fakeResponder(),
          },
        }),
      ),
    ).toThrow(/exceeds the 65536-byte ceiling/);
  });

  it('rejects a route collision between a declared POST view and the turn-submit route (fail-closed)', () => {
    // A POST view landing on the turn-submit route key must be a LOUD compose rejection (no
    // delegation exists for a conversational submit route) — never a silent second owner.
    const yaml = `${CONVERSATION_INTAKE_YAML}
views:
  - id: shadowing_view
    route:
      method: POST
      path: "/conversations/{conversation_id}/turns"
    auth: bearer_tenant
    params:
      conversation_id: { in: path, shape: safe_id }
    source: { kind: store, ref: turn_log }
    read:
      mode: single
      filter:
        conversation_id: { param: conversation_id }
      shape:
        fields:
          conversation_id: { kind: param, param: conversation_id }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          conversation_id: { kind: param, param: conversation_id }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: convintake.status_response
`.replace(
      'contracts:\n  convintake.row:\n    type: object',
      `contracts:
  convintake.row:
    type: object
  convintake.status_response:
    type: object
    additional_properties: false
    properties:
      conversation_id: { type: string }
      status: { type: [string, "null"] }
    required: [conversation_id, status]`,
    );
    expect(() => composeProductDeploy(parseFixture(yaml), conversationRollout({}, yaml))).toThrow(
      /route collision: 'POST \/conversations\/\{conversation_id\}\/turns'/,
    );
  });
});

describe('composeProductDeploy — the responder laws', () => {
  it('FAIL-CLOSES a conversation-declaring doc WITHOUT a wired responder (the executor-coverage mirror)', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({ conversation: {} }),
      ),
    ).toThrow(/rollout\.conversation\.responder is absent/);
  });

  it('the turn-submit handler ENTRY carries the handler-managed tx posture; create stays default', () => {
    const composed = composeProductDeploy(
      parseFixture(CONVERSATION_INTAKE_YAML),
      conversationRollout(),
    );
    const turn = composed.handlers.get('conversation_input_turn_submit') as
      | { routeTx?: string }
      | undefined;
    const create = composed.handlers.get('conversation_input_create') as
      | { routeTx?: string }
      | undefined;
    // THE WHOLE-TUPLE POSTURE PIN: the engine must NOT wrap the turn route in a tx (the three-leg
    // law depends on it); the create route keeps the default engine tx.
    expect(turn?.routeTx).toBe('handler-managed');
    expect(create?.routeTx).toBeUndefined();
  });

  it('a responder store-context read targeting a CAPABILITY-OWNED conversation store fail-closes at compose (the cross-conversation leak class)', () => {
    for (const store of ['conversations', 'conversation_turns']) {
      expect(
        () =>
          composeProductDeploy(
            parseFixture(CONVERSATION_INTAKE_YAML),
            conversationRollout({
              conversation: {
                responder: fakeResponder({ store, limit: 10 }),
              },
            }),
          ),
        `store '${store}'`,
      ).toThrow(/capability-owned store/);
    }
  });

  it('a responder store-context read against an UNDECLARED store fail-closes at compose', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({
          conversation: {
            responder: fakeResponder({ store: 'no_such_store', limit: 10 }),
          },
        }),
      ),
    ).toThrow(/store-context read of 'no_such_store'/);
  });

  it('a responder store-context limit outside the STORE_READ cap fail-closes at compose', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({
          conversation: {
            responder: fakeResponder({ store: 'turn_log', limit: 100000 }),
          },
        }),
      ),
    ).toThrow(/store-context limit \(100000\)/);
  });

  it('a responder store-context filter outside the closed payload-key set fail-closes at compose', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(CONVERSATION_INTAKE_YAML),
        conversationRollout({
          conversation: {
            responder: fakeResponder({
              store: 'turn_log',
              filter: { conversation_id: 'tenant_id' as never },
              limit: 10,
            }),
          },
        }),
      ),
    ).toThrow(/only the closed turn-payload keys/);
  });

  it('a VALID responder store-context (declared store, text filter column, sane limit) composes', () => {
    const composed = composeProductDeploy(
      parseFixture(CONVERSATION_INTAKE_YAML),
      conversationRollout({
        conversation: {
          responder: fakeResponder({
            store: 'turn_log',
            filter: { conversation_id: 'conversation_id' },
            limit: 50,
          }),
        },
      }),
    );
    expect(composed.handlers.has('conversation_input_turn_submit')).toBe(true);
  });
});
