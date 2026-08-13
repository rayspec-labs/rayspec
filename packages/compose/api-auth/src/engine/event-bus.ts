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
 * PAYLOAD: must survive `JSON.stringify` WITH A VALUE — the row column is `jsonb NOT NULL`. Both of
 * that call's failure modes are refused here, and only ONE of them throws: a circular structure or a
 * BigInt throws, while a function, a symbol, or an object whose `toJSON()` returns `undefined`
 * serializes to `undefined` WITHOUT throwing. Both end the same way if they get past this point — the
 * batch the engine builds simply omits the key, the `NOT NULL` column rejects the row, and the failure
 * surfaces out of the ENGINE's flush after the handler returned successfully, as an anonymous 500 that
 * rolls back the handler's own writes with it. So the guard judges the RESULT, not just whether the
 * call threw. `undefined` (a one-argument `emit('topic')`) is a legitimate topic-only event and is
 * stored as JSON `null`; it is not a mis-call.
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
  // A LINE BREAK IN A TOPIC IS NOT SERVABLE. A subscriber receives the topic as the SSE `event:`
  // field, and that grammar has no representation for a line break — a frame carrying one cannot be
  // written at all, and the naive attempt would be the one place an author's data wrote SSE FIELDS
  // rather than a field value. Refused HERE, at the call, so the author learns immediately rather
  // than through a stream that dies on this row and dies again on every reconnect that resumes from
  // the cursor in front of it. (The subscription route also neutralises such a topic on read, for a
  // row that reached the table some other way — but nothing this capability writes can be one.)
  if (/[\r\n]/.test(topic)) {
    throw malformedCapabilityCall(
      'init.emit',
      'a topic string WITHOUT a line break as its FIRST argument',
      topic,
      `${CALL_FORM} A subscriber receives the topic as the SSE 'event:' field, whose grammar cannot ` +
        'carry a line break — so this event could not be delivered. Put multi-line content in the ' +
        'payload, where it is stored and served verbatim.',
    );
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw malformedCapabilityCall(
      'init.emit',
      'a JSON-serializable payload as its SECOND argument',
      payload,
      `${CALL_FORM} The payload could not be serialized to JSON (a circular reference or a BigInt).`,
    );
  }
  // The SILENT half of the same fault: `JSON.stringify` returns `undefined` — no throw — for a
  // function, a symbol, or a value whose `toJSON()` returns `undefined`. Such a payload has no JSON
  // form at all, so it would be DROPPED from the batch rather than stored, and the `NOT NULL` column
  // would reject the row inside the flush. Refuse it here, where the handler made the call. (A real
  // `undefined` payload is the topic-only event above and is not affected.)
  if (payload !== undefined && encoded === undefined) {
    throw malformedCapabilityCall(
      'init.emit',
      'a JSON-serializable payload as its SECOND argument',
      payload,
      `${CALL_FORM} The payload has no JSON form (a function, a symbol, or a value whose toJSON() ` +
        'returns undefined) — it would be dropped rather than stored. Pass a JSON value, or omit the ' +
        'argument for a topic-only event.',
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
