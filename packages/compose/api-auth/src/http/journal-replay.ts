/**
 * JOURNAL REPLAY as SSE — the platform's one mechanism for handing a client a resumable, cursor-paged
 * feed of durable journal entries.
 *
 * ONE-SHOT, NOT A LIVE TAIL. It streams the persisted `run_events` rows with `seq > afterSeq`, in seq
 * order, and then ENDS the stream; it does not subscribe to, or poll for, entries persisted after this
 * read. That is what makes it a cursor-paged READ rather than a subscription: the durable table is the
 * source of truth, so a client that wants more RE-REQUESTS from the last seq it saw. `id:` is the seq,
 * which is the value a browser's `EventSource` sends back as `Last-Event-ID` on reconnect, so a resume
 * lands exactly one entry past the last one delivered.
 *
 * IT LIVES HERE, NOT ON A ROUTE. Any surface that has to replay journal entries — the run-event
 * surface, or a route a deployment or an extension pack contributes — needs the same bound, the same
 * order and the same cursor semantics. A second copy of this query is a second place for those to
 * drift, and the ones that drift silently (an inclusive instead of exclusive bound, an unordered read
 * that "usually" comes back sorted) are exactly the ones a client only discovers as a duplicated or
 * skipped entry. So the mechanism is platform machinery and the callers supply the two things that
 * legitimately differ: WHICH stream, and WHAT a stored payload is allowed to be.
 *
 * FAIL-CLOSED ON READ, BY THE CALLER'S OWN VOCABULARY. A stored jsonb payload is
 * corruption-/attacker-reachable, so it is re-validated when it is read, not trusted because it was
 * validated when it was written. The caller passes `serialize`: the step that turns a stored payload
 * into an SSE `data` string, or returns `undefined`. An entry it returns `undefined` for is DROPPED —
 * never served verbatim, never replaced by a fabricated one — and the replay continues, so one
 * unreadable entry cannot truncate the rest. Keeping that step with the caller is what lets this
 * module serve different read-side vocabularies without learning any of them.
 *
 * TENANT-SCOPED by construction: the read goes through the supplied `TenantDb`, so the chokepoint's
 * tenant predicate is AND-combined into it and a stream id belonging to another tenant reads as no
 * rows — indistinguishable from a stream that does not exist.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

/**
 * Resolve the resume cursor: the `Last-Event-ID` header (what a reconnecting client sends) takes
 * precedence over an explicit `?lastEventId=` query (what a first request can carry). An absent cursor
 * — or one that is not a number — means "from the beginning": a `NaN` cursor would compare false
 * against every stored seq and serve an EMPTY replay, which a client cannot tell apart from "there is
 * nothing left", so a malformed cursor must never be carried into the bound.
 */
export function resolveLastEventId(c: Context): number {
  const header = c.req.header('last-event-id');
  const query = c.req.query('lastEventId');
  const raw = header ?? query;
  if (raw === undefined) return -1; // -1 ⇒ replay from seq 0 (seq > -1)
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Replay the journal entries of `streamId` with `seq > afterSeq` as SSE, ascending by seq, ending the
 * stream when the rows are exhausted. `serialize` is the caller's read-path validator (see the module
 * header): an entry it rejects is omitted, never fabricated.
 */
export function replayJournalEventsAsSse(
  c: Context,
  tdb: TenantDb,
  streamId: string,
  afterSeq: number,
  serialize: (data: unknown) => string | undefined,
): Response {
  return streamSSE(c, async (stream) => {
    const rows = await tdb
      .select(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, streamId), gt(schema.runEvents.seq, String(afterSeq))))
      .orderBy(asc(schema.runEvents.seq));
    for (const row of rows as Array<{ seq: string; type: string; data: unknown }>) {
      if (stream.aborted) break;
      const data = serialize(row.data);
      if (data === undefined) continue; // omit a non-conforming / unserializable entry, never fabricate
      await stream.writeSSE({ id: String(row.seq), event: row.type, data });
    }
  });
}
