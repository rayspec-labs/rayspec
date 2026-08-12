/**
 * The `init.emit` capability — the tenant-scoped event-bus handle a declared ROUTE or TOOL handler
 * receives when the deployment enabled the bus.
 *
 * WHAT IS BUILT WHERE. The composition root builds ONE of these per deployment (its presence IS the
 * enablement); the per-request/per-run CLOSURE is built here from the handler's own tenant-bound
 * `TenantDb` — so, exactly like `init.enqueue`, the tenant is CAPTURED from the server-derived value
 * and the closure exposes NO tenant parameter. That is the whole cross-tenant argument: a handler
 * cannot emit into another tenant because there is nowhere to name one. (This is the deliberate
 * difference from `init.stt`/`init.tts`, which are deployment-static provider handles read once at
 * registration — those carry no tenant at all.)
 *
 * THE TWO FORMS mirror the two transaction boundaries, and the platform seam names them so neither
 * can be used where the other belongs (see `TenantEventBus` in @rayspec/platform):
 *   - BUFFERED (route): `emit()` validates and appends to a request-local array; the engine flushes
 *     the whole array in ONE statement as the last thing before COMMIT. Allocating a sequence number
 *     at the call site instead would hold the tenant's counter lock for the remainder of the handler
 *     and serialise every request of that tenant behind its slowest run.
 *   - IMMEDIATE (tool): a tool has no outer transaction by design, so each emit is its own statement.
 *
 * VALIDATION HAPPENS AT THE CALL, NOT AT THE FLUSH. A malformed topic or a payload that cannot be
 * JSON-serialized is refused by `emit()` itself, so the error surfaces where the handler made the
 * mistake — at the flush it would surface inside the engine, pointing at the wrong code.
 */

import { ApiError } from '@rayspec/auth-core';
import type { TenantDb, TenantEventInput } from '@rayspec/db';
import type { TenantEventBus } from '@rayspec/platform';
import { malformedCapabilityCall } from '../routes/runs.js';

/**
 * The call form this capability states in its refusals. Named once so the two guards below and the
 * documentation cannot drift from each other.
 */
const CALL_FORM = 'init.emit is POSITIONAL — emit(topic, payload).';

/**
 * Validate ONE emit call and return the entry to buffer/write. Refuses fail-closed, in the shared
 * capability-refusal register (a named 500 INTERNAL naming the capability, the expected shape and
 * what arrived — never a 404, never a silent no-op).
 *
 * TOPIC: a non-empty string. The sibling `init.enqueue` takes ONE request object, so
 * `emit({ topic, payload })` is the mis-call to expect from a handler author who learned that one
 * first — and it is the dangerous one: unguarded, the object stringifies into the column and the
 * stream fills with `[object Object]` rows that no subscriber can filter, with nothing anywhere
 * reporting a fault. A whitespace-only topic is refused for the same reason (it is not a topic
 * anything can subscribe to).
 *
 * PAYLOAD: must survive `JSON.stringify` — the row column is `jsonb`. A circular structure or a
 * BigInt would otherwise throw out of the ENGINE's flush, after the handler returned successfully, as
 * an anonymous 500. `undefined` (a one-argument `emit('topic')`) is a legitimate topic-only event and
 * is stored as JSON `null`; it is not a mis-call.
 */
function validateEmitCall(topic: unknown, payload: unknown): TenantEventInput {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    throw malformedCapabilityCall(
      'init.emit',
      'a non-empty topic string as its FIRST argument',
      topic,
      typeof topic === 'object' && topic !== null && !Array.isArray(topic)
        ? `${CALL_FORM} An object arrived where the topic belongs — that is the shape init.enqueue takes, not this one.`
        : CALL_FORM,
    );
  }
  try {
    JSON.stringify(payload);
  } catch {
    throw malformedCapabilityCall(
      'init.emit',
      'a JSON-serializable payload as its SECOND argument',
      payload,
      `${CALL_FORM} The payload could not be serialized to JSON (a circular reference or a BigInt).`,
    );
  }
  return { topic, payload };
}

/**
 * Build the deployment's event bus. Called by the composition root ONLY when the deployed spec turned
 * the bus on; the returned object is injected onto the engine, where its PRESENCE is what makes an
 * init carry `emit` at all.
 *
 * It holds no state and no handle: everything tenant-bound comes from the `TenantDb` each constructor
 * is handed at request/run time.
 */
export function makeTenantEventBus(): TenantEventBus {
  return {
    buffered(tdb: TenantDb) {
      // The REQUEST-LOCAL buffer. One array per invocation, captured by the closure — never shared
      // across requests, so one tenant's events can never be flushed into another's transaction.
      const pending: TenantEventInput[] = [];
      let flushed = false;
      return {
        emit: async (topic: unknown, payload?: unknown): Promise<void> => {
          // AFTER THE FLUSH THERE IS NOWHERE TO PUT IT. A `{handler}` route may return a STREAMING
          // response whose producer runs LATER, after the engine has already written this request's
          // events and closed its transaction; an emit from inside that producer would land in a
          // buffer nobody will ever flush and vanish without a trace. Refuse it loudly instead — a
          // dropped event is precisely the failure this whole feature exists to make impossible, so
          // it may not be the failure mode of the capability itself. Work that must emit belongs in
          // the handler body, before it returns.
          if (flushed) {
            throw new ApiError(
              'INTERNAL',
              "init.emit was called after this request's events were already written — most likely " +
                'from inside a streaming (sseResponse) producer, which runs after the handler ' +
                'returned and after the route transaction closed. There is no transaction left to ' +
                'append to, so the event would be silently lost. Emit from the handler body, before ' +
                'it returns.',
            );
          }
          pending.push(validateEmitCall(topic, payload));
        },
        flush: async (): Promise<void> => {
          flushed = true;
          if (pending.length === 0) return;
          // ONE statement for the whole request: one counter bump, one multi-row insert. `tdb` is the
          // TRANSACTIONAL handle the engine bound, so these rows commit with the handler's own writes.
          await tdb.appendEvents(pending);
          pending.length = 0;
        },
      };
    },
    immediate(tdb: TenantDb) {
      return async (topic: unknown, payload?: unknown): Promise<void> => {
        await tdb.appendEvents([validateEmitCall(topic, payload)]);
      };
    },
  };
}
