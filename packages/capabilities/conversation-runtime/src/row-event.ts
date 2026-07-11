/**
 * The ONE `SubmittedTurnEvent` construction — always from a STORED ledger row (never a request):
 * the first-persist path, the identical-re-POST redelivery, AND the divergent-message 409 heal
 * build the event HERE, so a deduped redelivery is byte-consistent with the first delivery and no
 * call site can drift onto request-derived values. `occurred_at` is per-delivery (like the
 * record/file redelivery); the identity + the message are what the downstream dedup keys on.
 */
import type { StoreRow } from '@rayspec/handler-sdk';
import { eventTurnRef, submittedTurnEventId } from './keys.js';
import type { SubmittedTurnEvent } from './types.js';

export function submittedTurnEventFromRow(tenantId: string, row: StoreRow): SubmittedTurnEvent {
  if (row.role !== 'user') {
    // Only user turns trigger workflows (the S3 assistant reply row emits nothing) — an event
    // built from any other row is a construction bug, fail-closed.
    throw new Error(
      `conversation-runtime: turn_submitted may only be built from a 'user' ledger row ` +
        `(got role '${String(row.role)}') — fail-closed.`,
    );
  }
  const conversationId = String(row.conversation_id);
  const messageId = String(row.message_id);
  const seqRaw = Number(row.turn_seq);
  return {
    event_id: submittedTurnEventId(tenantId, conversationId, messageId),
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_id: messageId,
    turn_ref: eventTurnRef(conversationId, messageId),
    turn_seq: Number.isFinite(seqRaw) && seqRaw > 0 ? seqRaw : 0,
    role: 'user',
    message: String(row.message),
    occurred_at: new Date().toISOString(),
    source_capability: 'conversation_input',
  };
}
