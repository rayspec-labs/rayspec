/**
 * Shared journal replay-as-SSE — ONE-SHOT, not a live tail (the durable `run_events` table makes
 * resume a real read path: a client pulls newly-persisted events by re-requesting from the last
 * seq it saw). Extracted from the run events route so the task-engine's per-task replay serves the
 * SAME durable table through the SAME mechanics with a DIFFERENT read-side validator: each caller
 * supplies `serialize`, the fail-closed re-validate-on-read step that turns a stored jsonb `data`
 * into an SSE data string or `undefined` — a row whose payload does not match the caller's
 * vocabulary is DROPPED, never served verbatim and never fabricated. Tenant-scoped via the
 * supplied TenantDb; `id:` = seq so the client resumes from Last-Event-ID.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

/** Resolve the resume cursor: Last-Event-ID header takes precedence over ?lastEventId=. */
export function resolveLastEventId(c: Context): number {
  const header = c.req.header('last-event-id');
  const query = c.req.query('lastEventId');
  const raw = header ?? query;
  if (raw === undefined) return -1; // -1 ⇒ replay from seq 0 (seq > -1)
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : -1;
}

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
      if (data === undefined) continue; // omit a non-conforming / unserializable row, never fabricate
      await stream.writeSSE({ id: String(row.seq), event: row.type, data });
    }
  });
}
