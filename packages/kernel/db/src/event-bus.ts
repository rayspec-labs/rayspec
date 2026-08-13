/**
 * The tenant event bus — the statements the durable per-tenant event stream is made of.
 *
 * WHY THE SQL LIVES HERE, IN THE DB PACKAGE: each of these is ONE statement whose correctness comes
 * from what Postgres does inside it (a row lock held to COMMIT, a DELETE and its watermark write
 * sharing one snapshot). Expressing them through the query-builder facade would split them into
 * several statements and lose exactly those properties, and reaching for a raw handle from a scoped
 * root is what the tenant-chokepoint gate exists to catch. So the statements live in the chokepoint's
 * own package, and the request path reaches the append through `TenantDb.appendEvents` — which binds
 * the tenant from the handle, so there is no tenant parameter for a caller to get wrong.
 *
 * ORDERING (the property the whole feature rests on): the append bumps a per-tenant counter row and
 * inserts its rows in ONE statement. The counter UPDATE takes a row lock Postgres holds until COMMIT,
 * so a later transaction physically cannot obtain seq N+1 before the holder of N commits or rolls
 * back — ALLOCATION ORDER EQUALS COMMIT ORDER. A `bigserial` would NOT give this: a sequence hands
 * out values before commit, so a subscriber that saw 101 loses row 100 permanently when the slower
 * writer commits behind it. A rolled-back append returns its number and the next append reissues it,
 * so the visible sequence is GAP-FREE and a hole means retention, never a lost write.
 *
 * THE NOTIFY IS A HINT, NEVER THE TRUTH. The append issues one `pg_notify` carrying ONLY the tenant
 * and the new high-water seq — never the payload — inside the same statement, so it is delivered iff
 * the transaction commits. A consumer woken by it re-reads the durable rows; a consumer that misses
 * it entirely is still correct, just later. That is why the payload has no business being in it.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * The one LISTEN/NOTIFY channel the bus wakes consumers on. A per-tenant CHANNEL would need the
 * listener to LISTEN on every tenant it serves (and to re-issue LISTEN as tenants appear), so the
 * tenant travels in the PAYLOAD of one channel instead — the listener fans out in process. Exported
 * so the emitting statement and any consumer name the same string.
 */
export const TENANT_EVENT_CHANNEL = 'rayspec_tenant_events';

/** One event to append: the author's topic + the JSON-serializable body. */
export interface TenantEventInput {
  /** The author-chosen topic (DATA). Non-empty — validated at the capability edge, before buffering. */
  readonly topic: string;
  /** The event body (DATA). JSON-serializable — validated at the capability edge, before buffering. */
  readonly payload: unknown;
}

/** The seq range one append allocated (absent when the append had nothing to write). */
export interface TenantEventAppendResult {
  /** The seq of the FIRST row this append wrote. */
  readonly firstSeq: number;
  /** The seq of the LAST row this append wrote — the tenant's new high-water mark. */
  readonly lastSeq: number;
}

/** A tenant's stream state: where it ends, and how far retention has eaten into its start. */
export interface TenantEventStreamState {
  /** The last seq ISSUED to this tenant (0 before the first emit) — the high-water mark. */
  readonly lastSeq: number;
  /** The highest seq RETENTION has deleted (0 when nothing has aged out) — the floor. */
  readonly truncatedThrough: number;
}

/** One event as a READER sees it. `at` is deliberately absent — see `readTenantEventPage`. */
export interface TenantEventFrame {
  /** This event's sequence number — the tenant-scoped cursor a subscriber resumes from. */
  readonly seq: number;
  /** The author's topic, verbatim. */
  readonly topic: string;
  /** The author's payload, verbatim (JSON `null` for a topic-only emit). */
  readonly payload: unknown;
}

/**
 * ONE snapshot of a tenant's stream: where it ends, how far retention has eaten into its start, how
 * far this read SCANNED, and the matching events in between. Every field comes from the SAME
 * statement — see `readTenantEventPage` for why that is the whole point.
 */
export interface TenantEventPage extends TenantEventStreamState {
  /**
   * The highest seq this read LOOKED AT, whether or not it matched the topic filter (the cursor the
   * caller advances to). Equals the caller's `after` when the window was empty. Without it, a page
   * whose every row was filtered out would leave the cursor where it was and the reader would scan
   * the same window forever.
   */
  readonly scannedThrough: number;
  /** The matching events in the scanned window, ascending by seq. */
  readonly events: readonly TenantEventFrame[];
}

/** What one retention sweep did, across all tenants. */
export interface TenantEventSweepResult {
  /** Rows deleted across every tenant (0 when nothing had aged out). */
  readonly deleted: number;
  /** Tenants whose truncation floor advanced — in the SAME statement as their delete. */
  readonly tenants: number;
}

/** Coerce a driver value (bigint columns arrive as strings) to a JS number, defaulting to 0. */
function toNumber(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Append `events` to `tenantId`'s stream in ONE statement: bump the counter row, insert the rows at
 * the numbers it just issued, and notify the tenant's new high-water mark. Returns the allocated seq
 * range (undefined for an empty input — an emit-free request must not touch the counter).
 *
 * Runs on whatever handle it is given: inside a route handler's engine-opened transaction it is the
 * LAST statement before COMMIT, so the events are atomic with the handler's own writes (a subscriber
 * can never see an event announcing a state change that is not yet readable); on a tool handler's
 * plain handle — a tool has no outer transaction by design — it is a standalone statement.
 *
 * The counter row is created by the same statement that bumps it (`ON CONFLICT DO UPDATE`), so a
 * tenant's first emit needs no seeding pass, and the conflict path takes the same row lock the update
 * path does. `ord` from `WITH ORDINALITY` preserves the caller's order, so the numbers a handler's
 * successive `emit()` calls receive follow the order it made them in.
 */
export async function appendTenantEvents(
  db: Db,
  tenantId: string,
  events: readonly TenantEventInput[],
): Promise<TenantEventAppendResult | undefined> {
  if (events.length === 0) return undefined;
  const count = events.length;
  // The batch travels as ONE jsonb parameter (an array of {topic, payload}) rather than parallel
  // arrays: the payload is already JSON, so this is the shape that needs no per-element casting and
  // no array-binding assumptions from the driver.
  const batch = JSON.stringify(
    events.map((e) => ({ topic: e.topic, payload: e.payload === undefined ? null : e.payload })),
  );
  const rows = (await db.execute(sql`
    with allocated as (
      insert into tenant_event_streams as s (tenant_id, last_seq)
      values (${tenantId}::uuid, ${count}::bigint)
      on conflict (tenant_id) do update
        set last_seq = s.last_seq + ${count}::bigint, updated_at = now()
      returning s.last_seq - ${count}::bigint as base
    ), inserted as (
      insert into tenant_events (tenant_id, seq, topic, payload)
      select ${tenantId}::uuid, allocated.base + e.ord, e.entry->>'topic', e.entry->'payload'
      from allocated
      cross join lateral (
        select value as entry, ordinality as ord
        from jsonb_array_elements(${batch}::jsonb) with ordinality
      ) as e
      returning seq
    ), bounds as (
      select min(seq) as first_seq, max(seq) as last_seq from inserted
    )
    select
      first_seq,
      last_seq,
      pg_notify(
        ${TENANT_EVENT_CHANNEL},
        json_build_object('tenant', ${tenantId}::text, 'seq', last_seq)::text
      ) as notified
    from bounds
  `)) as unknown as { first_seq: unknown; last_seq: unknown }[];
  const row = rows[0];
  if (!row) return undefined;
  return { firstSeq: toNumber(row.first_seq), lastSeq: toNumber(row.last_seq) };
}

/**
 * Read `tenantId`'s stream state — the head it ends at and the floor retention has raised. Both come
 * from the SAME counter row in ONE read, which is what lets a consumer classify a cursor (below the
 * floor ⇒ truncated; above the head ⇒ not issued yet) without a second round trip that retention
 * could run inside. A tenant that has never emitted has no row: reported as `{0, 0}`, which is the
 * truth (nothing issued, nothing truncated), never a fabricated floor.
 */
export async function readTenantEventStream(
  db: Db,
  tenantId: string,
): Promise<TenantEventStreamState> {
  const rows = (await db.execute(sql`
    select last_seq, truncated_through
    from tenant_event_streams
    where tenant_id = ${tenantId}::uuid
  `)) as unknown as { last_seq: unknown; truncated_through: unknown }[];
  const row = rows[0];
  if (!row) return { lastSeq: 0, truncatedThrough: 0 };
  return { lastSeq: toNumber(row.last_seq), truncatedThrough: toNumber(row.truncated_through) };
}

/**
 * Read ONE page of `tenantId`'s stream — the head, the retention floor, how far the read scanned, and
 * the matching events — in ONE statement, therefore ONE snapshot.
 *
 * THE ONE-SNAPSHOT RULE IS THE WHOLE POINT, and it is why `readTenantEventStream` above is NOT the
 * function a subscriber calls. Reading the floor and then reading the rows is two round trips, and
 * the retention sweep can run BETWEEN them: the floor says "your cursor is fine", the sweep deletes
 * the rows the cursor pointed at, and the row read returns the SURVIVORS. The subscriber is told
 * everything is well and silently receives a stream with a hole in it — no error, no signal, nothing
 * to retry. Both halves must therefore come from one statement, which under Postgres's read-committed
 * default is one snapshot. A caller that re-assembles this from two reads reintroduces exactly that
 * window, so this is the only sanctioned read path for a subscriber.
 *
 * THE FLOOR IS RETURNED ON EVERY PAGE, not just the first, because a subscriber outlives retention: a
 * connection held open for hours can have its own unread history swept out from under it, and only a
 * per-read floor catches that. The caller compares its cursor to `truncatedThrough` on EVERY page.
 *
 * `topics` OMITTED MEANS EVERY TOPIC — expressed by leaving the predicate out of the statement
 * entirely, never by binding a null/empty filter. `topic = any(NULL)` is NULL for every row, so such
 * a "filter" matches nothing and the subscriber gets a permanently silent stream that reports itself
 * healthy. An EMPTY array is a caller bug for the same reason (it can only mean a dead stream) and is
 * refused here rather than served; the HTTP surface rejects it as a 400 before it ever gets this far.
 *
 * `at` IS NOT READ AND NOT RETURNED. It is transaction-START time while `seq` is flush time, so the
 * two disagree on order for a large share of adjacent rows under concurrency (see schema.ts). `seq`
 * is the sole ordering authority; a reader that never receives `at` cannot accidentally sort by it.
 * A handler that wants a timestamp on the wire puts one in its own payload.
 */
export async function readTenantEventPage(
  db: Db,
  tenantId: string,
  opts: {
    /** Deliver events with `seq > after`. */
    readonly after: number;
    /** Scan at most this many rows (the window, before the topic filter). */
    readonly limit: number;
    /** Deliver only these topics. OMIT for every topic; an empty array is refused. */
    readonly topics?: readonly string[];
  },
): Promise<TenantEventPage> {
  if (opts.topics !== undefined && opts.topics.length === 0) {
    throw new Error(
      'readTenantEventPage: `topics` was an EMPTY array, which can only ever match nothing. Omit ' +
        'the option to read every topic — a filter that silently matches nothing is the failure ' +
        'mode this refusal exists to prevent.',
    );
  }
  // The filter travels as ONE jsonb parameter for the same reason the append's batch does: no
  // per-element casting and no array-binding assumptions about the driver. When `topics` is omitted
  // the predicate is not in the statement at all — an omitted filter must never become a bound null.
  const topicFilter =
    opts.topics === undefined
      ? sql``
      : sql`where topic in (select jsonb_array_elements_text(${JSON.stringify(opts.topics)}::jsonb))`;
  const rows = (await db.execute(sql`
    with state as (
      select last_seq, truncated_through
      from tenant_event_streams
      where tenant_id = ${tenantId}::uuid
    ), page as (
      select seq, topic, payload
      from tenant_events
      where tenant_id = ${tenantId}::uuid and seq > ${opts.after}::bigint
      order by seq
      limit ${opts.limit}
    )
    select
      coalesce((select last_seq from state), 0) as last_seq,
      coalesce((select truncated_through from state), 0) as truncated_through,
      coalesce((select max(seq) from page), ${opts.after}::bigint) as scanned_through,
      coalesce(
        (
          select json_agg(json_build_object('seq', seq, 'topic', topic, 'payload', payload) order by seq)
          from page
          ${topicFilter}
        ),
        '[]'::json
      ) as events
  `)) as unknown as {
    last_seq: unknown;
    truncated_through: unknown;
    scanned_through: unknown;
    events: unknown;
  }[];
  const row = rows[0];
  if (!row) return { lastSeq: 0, truncatedThrough: 0, scannedThrough: opts.after, events: [] };
  const raw = Array.isArray(row.events)
    ? (row.events as { seq: unknown; topic: unknown; payload: unknown }[])
    : [];
  return {
    lastSeq: toNumber(row.last_seq),
    truncatedThrough: toNumber(row.truncated_through),
    scannedThrough: toNumber(row.scanned_through),
    events: raw.map((e) => ({
      seq: toNumber(e.seq),
      topic: String(e.topic),
      payload: e.payload ?? null,
    })),
  };
}

/**
 * Delete every event older than `cutoff` and raise each affected tenant's truncation floor — in ONE
 * statement, therefore ONE transaction and ONE snapshot. That is the whole point of the shape: a
 * consumer reading the floor can never land between the delete and the floor write and be told "you
 * are fine" about rows that are already gone.
 *
 * The floor is the HIGHEST seq deleted for that tenant, and the write is a `greatest(...)` so it can
 * only move forward. `at` is not monotone with `seq` (see schema.ts), so an age cutoff can leave a
 * row with a seq below that maximum alive — which makes this floor CONSERVATIVE: it may declare a
 * cursor truncated whose next row happens to survive, and it can never declare a cursor fine whose
 * rows are gone. Over-signalling is recoverable; under-signalling is the silent hole.
 *
 * CROSS-TENANT BY DESIGN (like the OIDC prune and the GDPR purge it runs beside): this is platform
 * housekeeping over every tenant's stream, driven by the scheduled cleanup arm, never by a product
 * request. Nothing here is gated on a per-request tenant, and no product request can trigger it.
 */
export async function sweepTenantEvents(
  db: Db,
  opts: { readonly cutoff: Date },
): Promise<TenantEventSweepResult> {
  const rows = (await db.execute(sql`
    with doomed as (
      delete from tenant_events where at < ${opts.cutoff.toISOString()}::timestamptz
      returning tenant_id, seq
    ), per_tenant as (
      select tenant_id, max(seq) as floor, count(*)::bigint as removed
      from doomed group by tenant_id
    ), marked as (
      insert into tenant_event_streams as s (tenant_id, last_seq, truncated_through)
      select tenant_id, floor, floor from per_tenant
      on conflict (tenant_id) do update
        set truncated_through = greatest(s.truncated_through, excluded.truncated_through),
            updated_at = now()
      returning s.tenant_id
    )
    select
      (select coalesce(sum(removed), 0) from per_tenant) as deleted,
      (select count(*) from marked) as tenants
  `)) as unknown as { deleted: unknown; tenants: unknown }[];
  const row = rows[0];
  return { deleted: toNumber(row?.deleted), tenants: toNumber(row?.tenants) };
}

/** The cutoff instant for a retention window of `hours`, measured back from `now`. */
export function eventRetentionCutoff(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

/** What one wake carries: which tenant advanced, and how far. Never the payload. */
export interface TenantEventWakeNotice {
  /** The tenant whose stream advanced. */
  readonly tenantId: string;
  /** That tenant's new high-water seq. ADVISORY — the durable rows are the truth. */
  readonly lastSeq: number;
}

/** A live LISTEN, and the way to stop it. */
export interface TenantEventListenHandle {
  /** Stop listening. Idempotent enough to call from a shutdown path that may run twice. */
  unlisten(): Promise<void>;
}

/**
 * LISTEN on the one bus channel and hand every wake to `onWake`. Built ONCE per process at the
 * composition root; the process fans out to its subscribers in memory.
 *
 * WHY THIS LIVES HERE rather than in the route that wants it: LISTEN is not expressible through the
 * query-builder facade at all — it needs the driver connection — and reaching for that from a scoped
 * root is precisely the reach-around the tenant-chokepoint gate exists to catch. So the driver call
 * lives in the chokepoint's own package, and the consumer receives a neutral callback carrying a
 * tenant id and a number. (postgres-js opens a DEDICATED connection for listeners and re-issues the
 * LISTEN itself after a reconnect, so this neither borrows from the request pool nor goes deaf when
 * the connection drops.)
 *
 * A WAKE IS A HINT AND MAY BE WRONG IN ONE DIRECTION ONLY: it can be MISSED (a reconnect gap, a
 * dropped frame), never fabricated — it is issued inside the appending statement, so it is delivered
 * iff that transaction committed. A consumer must therefore treat it purely as "read again now", and
 * must keep its own periodic read so a missed wake costs latency rather than an event. A malformed
 * or foreign payload is DROPPED silently rather than thrown: this callback runs on the driver's
 * connection, where a throw would take the listener down and make every subscriber in the process go
 * quiet — and the periodic read already covers whatever the dropped wake would have announced.
 */
export async function listenTenantEvents(
  db: Db,
  onWake: (notice: TenantEventWakeNotice) => void,
): Promise<TenantEventListenHandle> {
  const listener = await db.$client.listen(TENANT_EVENT_CHANNEL, (raw: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const { tenant, seq } = parsed as { tenant?: unknown; seq?: unknown };
      if (typeof tenant !== 'string' || tenant.length === 0) return;
      onWake({ tenantId: tenant, lastSeq: toNumber(seq) });
    } catch {
      /* a wake we cannot read is a wake we do without — the periodic read still covers it */
    }
  });
  return { unlisten: () => listener.unlisten() };
}
