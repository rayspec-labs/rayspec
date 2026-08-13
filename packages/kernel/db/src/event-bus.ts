/**
 * The tenant event bus — the three statements the durable per-tenant event stream is made of.
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
