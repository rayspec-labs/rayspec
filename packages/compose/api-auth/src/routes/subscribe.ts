/**
 * `GET /v1/subscribe` — the tenant-scoped SSE subscription surface over the durable event stream
 * `init.emit` writes.
 *
 * Mounted on the SAME createAuthApp middleware chain as every other route
 * (requestId → securityHeaders → authenticate → resolveTenant → requirePermission), so the tenant is
 * SERVER-DERIVED and the rows are read through `forTenant` — a subscriber can only ever be handed its
 * own tenant's stream, and there is no query parameter through which another one could be named.
 *
 *   GET /v1/subscribe?topics=a,b&since=<cursor>      (Accept: text/event-stream)
 *
 * THE WIRE CONTRACT
 *   - A DATA frame is one event: `id:` is the cursor, `event:` is the author's topic (verbatim, bar
 *     the one character an SSE field cannot carry — see `sseEventName`), and `data:` is the author's
 *     payload as JSON (a topic-only emit arrives as `null`).
 *   - A CONTROL frame carries NO `id:`. That is the discriminator, and it is structural rather than
 *     nominal on purpose: a topic is author data, so a handler could emit `rayspec.truncated` itself
 *     — but it could never emit a frame WITHOUT an id, because every event has a sequence number.
 *     A client that keys on the presence of `id:` cannot be spoofed by a topic name.
 *   - A RESUME CHECKPOINT is an `id:` line and nothing else — no frame at all. See
 *     `formatResumeCheckpoint`, which is what keeps the server's own mandatory close from costing a
 *     subscriber events.
 *   - `at` is NOT on the wire. It is transaction-start time while `seq` is flush time, so the two
 *     disagree on order under concurrency; shipping it would invite clients to sort by it. A handler
 *     that wants a timestamp puts one in its payload.
 *
 * THE CURSOR IS TENANT-QUALIFIED — `<tenant_id>:<seq>`, never a bare number. A bare seq is a number
 * that means something different in every tenant's stream, so a cursor that survived a logout, an org
 * switch, or a copy-paste between environments would silently resume at the wrong place and hand the
 * subscriber a plausible-looking stream of the wrong rows. Tagging it makes that mismatch DETECTABLE,
 * and a cursor whose tag is not this request's server-derived tenant is refused outright.
 *
 * WHY A SEPARATE PERMISSION (`events:read`) rather than `store:read`: an event payload is whatever a
 * handler chose to emit, so it can carry values from capabilities no declared store route serves.
 * See the permission's own note in @rayspec/auth-core authz.ts.
 *
 * STREAM LIFETIME IS CAPPED, and this is the one genuinely new authorization property here.
 * `requirePermission` is MIDDLEWARE: it runs once, at connect. A member revoked an hour into a
 * long-lived stream would keep receiving frames for as long as the connection lived, because nothing
 * in the SSE loop re-enters the auth chain. So the server closes the stream at or below the
 * access-token TTL and lets the client reconnect — a reconnect is a fresh request through the WHOLE
 * chain (authenticate → resolveTenant → requirePermission), which is the same live re-check every
 * other route gets. A second, bespoke re-authorization path inside the loop was rejected: it would be
 * a parallel authorization implementation that could drift from the middleware, and the reconnect
 * already re-runs the real one.
 *
 * THE CAP IS THE SERVER'S OWN CLOSE, SO THE RESUME POSITION MUST ALWAYS BE ON THE WIRE BEFORE IT.
 * That is `formatResumeCheckpoint`, and it is the reason this route can promise a reconnect costs no
 * events. Without it the cap is a silent-loss window: an `EventSource` last-event-ID starts EMPTY and
 * is only ever set by an `id:`, control frames deliberately carry none, and a cursor-less subscriber
 * therefore reaches the cap holding nothing to send back — its automatic reconnect omits
 * `Last-Event-ID` entirely, lands in the no-cursor branch below, and resumes at the NEW tail, so
 * everything emitted during the browser's reconnect delay is skipped while `rayspec.live` asserts the
 * backlog is drained.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import { forTenant, type TenantDb, type TenantEventPage } from '@rayspec/db';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppDeps, AppEnv } from '../app-context.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

/** The separator between a cursor's tenant tag and its sequence number. */
const CURSOR_SEPARATOR = ':';

/** The ONLY shape a cursor's sequence half may take — see `parseEventCursor` for why it is lexical. */
const DECIMAL_SEQUENCE = /^[0-9]+$/;

/**
 * How long a subscriber waits for a wake before reading anyway — the correctness BACKSTOP and the
 * heartbeat in one.
 *
 * ON BY DEFAULT, which is a DELIBERATE departure from this repo's posture that every interval knob is
 * opt-in. The reason is that the notify is explicitly a hint: it is delivered iff the emitting
 * transaction committed, but it can be MISSED (a listener reconnect, a process that has not finished
 * building its LISTEN, a deployment that wires no listener at all). An opt-in poll would mean the
 * default posture loses events until someone notices — the exact silent failure this whole feature
 * exists to remove. The same timer doubles as the SSE heartbeat: an idle stream writes a comment
 * every interval, which is what keeps intermediaries from reaping a connection they think is dead.
 *
 * WHAT IT COSTS, stated plainly so an operator can size it: one indexed range read per subscriber per
 * interval on the request pool, even when the tenant is silent. Five seconds is the middle of the
 * trade — long enough that idle subscribers are cheap, short enough that a deployment whose wake is
 * down (or unwired) is late by seconds rather than minutes. A deployment tunes it on the engine.
 */
export const DEFAULT_EVENT_POLL_INTERVAL_MS = 5_000;

/** Rows scanned per read. The (tenant_id, seq) primary key makes this an ordered range scan. */
export const EVENT_PAGE_LIMIT = 500;

/** The most topics one subscription may filter on (a bound on the filter, not a product limit). */
const MAX_SUBSCRIBE_TOPICS = 64;

/** The control frame announcing that the cursor was below the retention floor. */
export const TRUNCATED_FRAME_EVENT = 'rayspec.truncated';

/** The control frame announcing that the backlog is drained and the stream is live from here. */
export const LIVE_FRAME_EVENT = 'rayspec.live';

/** Format the SSE `id:` for one event — the tenant-qualified cursor a client resumes from. */
export function formatEventCursor(tenantId: string, seq: number): string {
  return `${tenantId}${CURSOR_SEPARATOR}${seq}`;
}

/**
 * The RESUME CHECKPOINT: an `id:` line, a blank line, and nothing else.
 *
 * WHY IT EXISTS. This server forces a close on every subscription (the lifetime cap), so a reconnect
 * is not an accident to tolerate but a step in the protocol — and a reconnect only resumes if the
 * client is holding a cursor. An `EventSource`'s last-event-ID string starts EMPTY and is set by
 * nothing but an `id:` field, while control frames deliberately carry none. A subscriber that has not
 * yet been handed a DATA frame therefore reaches the cap with nothing to send back: its automatic
 * reconnect omits `Last-Event-ID`, the server reads that as "fresh subscriber", starts it at the tail
 * it probes THEN, and everything emitted during the reconnect delay is gone — silently, with
 * `rayspec.live` announcing the backlog is drained. That is the exact class of failure this whole
 * protocol exists to remove, arriving through a close the server itself schedules.
 *
 * WHY IT IS NOT A FRAME. Per the HTML event-stream grammar, dispatching sets the last-event-ID string
 * from the id buffer BEFORE it returns early on an empty data buffer. So an `id:`-only block updates
 * exactly one thing — what the client will send back — and dispatches no event at all. Nothing in the
 * frame contract moves: a data frame still carries an `id:`, a control frame still carries none, and
 * a client that discriminates on that is unaffected because it never sees this block.
 *
 * IT IS WRITTEN WHENEVER THE CURSOR MOVES WITHOUT A DELIVERY — a fresh subscriber parked at the tail,
 * and a topic-filtered one whose window matched nothing (there the cursor legitimately runs ahead of
 * the last delivered seq). When a delivery already published the position, nothing is written.
 */
export function formatResumeCheckpoint(tenantId: string, seq: number): string {
  return `id: ${formatEventCursor(tenantId, seq)}\n\n`;
}

/**
 * Neutralise a line break in a stored topic before it becomes the SSE `event:` field.
 *
 * The SSE grammar has no representation for a line break inside a field, so a frame carrying one
 * cannot be written: the attempt throws, this stream dies on that row, and every reconnect resuming
 * from the cursor in front of it dies on the same row — ONE unrepresentable topic would silence a
 * tenant permanently. It would also be the only place an author's data could write SSE FIELDS rather
 * than a field value. `init.emit` refuses such a topic at the call, so nothing this platform writes
 * can be one; this is the read-side backstop for a row that reached the table another way, and it
 * DELIVERS the event (with the break rendered as a space) rather than dropping it.
 */
export function sseEventName(topic: string): string {
  return topic.replace(/[\r\n]+/g, ' ');
}

/**
 * Parse a client-supplied cursor against the request's SERVER-DERIVED tenant.
 *
 * Refuses, rather than coerces, on every failure: a malformed cursor, a cursor carrying another
 * tenant's tag, and a sequence that is not decimal digits. Coercing any of these would resume the
 * subscriber somewhere it did not ask for and look successful while doing it.
 *
 * THE SEQUENCE IS CHECKED LEXICALLY BEFORE IT IS CONVERTED, which is not pedantry: `Number()` accepts
 * hexadecimal, exponent, fractional, signed and whitespace-padded forms AND the empty string, and
 * every one of those coerces to a perfectly plausible sequence. `<tenant>:0x10` would resume at 16
 * and silently skip fifteen events; `<tenant>:` would coerce to 0 and replay the whole stream. Both
 * are a `200` that reads exactly like a working subscription — the failure this route exists to make
 * impossible — so only `[0-9]+` is a cursor.
 */
export function parseEventCursor(raw: string, tenantId: string): number {
  const at = raw.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'The subscription cursor must be `<tenant_id>:<seq>` (the value this stream sends as an SSE ' +
        '`id:`). A bare sequence number is not accepted — a sequence means something different in ' +
        "every tenant's stream, so an untagged cursor cannot be checked against the caller.",
    );
  }
  const tag = raw.slice(0, at);
  if (tag !== tenantId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'The subscription cursor belongs to a different tenant than this request. Resuming it here ' +
        "would reinterpret its sequence number against this tenant's stream and deliver unrelated " +
        'events. Start a fresh subscription (omit `since`) after switching orgs.',
    );
  }
  const rest = raw.slice(at + 1);
  if (!DECIMAL_SEQUENCE.test(rest) || !Number.isSafeInteger(Number(rest))) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'The subscription cursor carries a sequence that is not a non-negative whole number. It must ' +
        'be decimal digits, exactly as this stream wrote them: a hexadecimal, exponent, fractional, ' +
        'signed, padded or empty sequence is refused rather than coerced, because coercing it would ' +
        'resume the subscriber at a position it never asked for and look successful while doing it.',
    );
  }
  return Number(rest);
}

/**
 * Parse `?topics=a,b`.
 *
 * OMITTED MEANS EVERY TOPIC — the filter is then left out of the query entirely (see
 * `readTenantEventPage`). An EXPLICITLY EMPTY filter (`?topics=` or `?topics=,,`) is a 400 and not a
 * silently-empty subscription: it can only ever mean "deliver nothing", which is indistinguishable
 * from a healthy but quiet stream, so a client that wrote it by accident — a template that rendered
 * an empty array, a join over an empty list — would sit forever on a stream that reports itself fine.
 */
export function parseSubscribeTopics(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const topics = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (topics.length === 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'The `topics` filter was supplied but empty, which can only match nothing. OMIT `topics` to ' +
        'subscribe to every topic; an empty filter is refused rather than served as a silent stream.',
    );
  }
  if (topics.length > MAX_SUBSCRIBE_TOPICS) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `The \`topics\` filter names more than ${MAX_SUBSCRIBE_TOPICS} topics. Subscribe to every ` +
        'topic (omit the filter) and select client-side instead.',
    );
  }
  return [...new Set(topics)];
}

/** Register `GET /v1/subscribe` on the shared authenticated chain. */
export function registerSubscribeRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.get(
    '/v1/subscribe',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'events:read'),
    async (c) => subscribeToTenantEvents(c, deps),
  );
}

async function subscribeToTenantEvents(c: Context<AppEnv>, deps: AppDeps): Promise<Response> {
  // The ENABLEMENT is the bus itself — the same single signal that decides whether an init carries
  // `init.emit`. A clean fail-closed 501 (the posture an unwired durable worker / reprocessor takes),
  // never a 404: the route exists, the deployment simply has not turned the stream on, and an
  // operator reading a 404 would go looking for a routing bug instead.
  if (!deps.engine?.eventBus) {
    throw new ApiError(
      'NOT_IMPLEMENTED',
      'The tenant event bus is not enabled for this deployment, so there is no stream to ' +
        'subscribe to. Set `deployment.eventBus.enabled: true` in the deployed document.',
    );
  }
  const tenantId = c.get('tenantId');
  if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');

  const topics = parseSubscribeTopics(c.req.query('topics'));
  // The SSE reconnect header FIRST (that is the mechanism a browser resumes with, and it is what the
  // client sends without being asked), the explicit query second for a non-EventSource client.
  const rawCursor = c.req.header('last-event-id') ?? c.req.query('since');

  const tdb = forTenant(deps.db, tenantId);
  const opening = await openSubscription(tdb, tenantId, rawCursor, topics);

  const engine = deps.engine;
  const pollIntervalMs = engine.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
  // The cap can only be LOWERED below the access-token TTL, never raised past it: the TTL is what
  // bounds how long a stale authorization can survive, and a deployment must not be able to opt out
  // of that bound by configuring a longer stream.
  const ttlMs = deps.signer.accessTokenTtlSeconds * 1000;
  const maxStreamMs = Math.min(
    engine.eventStreamMaxSeconds !== undefined ? engine.eventStreamMaxSeconds * 1000 : ttlMs,
    ttlMs,
  );

  return streamSSE(c, async (stream) => {
    const deadline = Date.now() + maxStreamMs;
    let cursor = opening.cursor;
    // The page the classification above already read — delivered rather than re-read, so the opening
    // read is one round trip and not two.
    let prefetched: TenantEventPage | undefined = opening.page;
    let announcedLive = false;
    // The cursor the CLIENT is holding — what its reconnect would send back. Every data frame sets
    // it, and `formatResumeCheckpoint` publishes it whenever the server's cursor moved without one.
    let published: number | undefined;

    // The wake: one process-local listener fans out to this subscriber. A wake is a hint to read NOW;
    // the poll below is what makes a MISSED wake cost latency instead of an event. A wake that cannot
    // advance us (its high-water seq is at or behind what we have already scanned) is ignored, so a
    // busy tenant does not make every subscriber re-read for events it has already passed.
    let signal: (() => void) | undefined;
    // A wake that lands while this loop is READING (rather than waiting) has nobody to hand it to.
    // Dropping it would cost a whole poll interval for an event that was announced on time, so it is
    // LATCHED and consumed by the next wait — which then returns immediately.
    let pendingWake = false;
    const wakeUp = (): void => {
      const s = signal;
      signal = undefined;
      if (s) s();
      else pendingWake = true;
    };
    const unsubscribe = engine.eventWake?.subscribe(tenantId, (lastSeq) => {
      if (lastSeq > cursor) wakeUp();
    });
    // A client that walks away must not keep the loop parked on its poll timer.
    stream.onAbort(() => wakeUp());

    try {
      while (!stream.aborted && Date.now() < deadline) {
        const page =
          prefetched ??
          (await tdb.readEventPage({
            after: cursor,
            limit: EVENT_PAGE_LIMIT,
            ...(topics ? { topics } : {}),
          }));
        prefetched = undefined;

        // R2 — THE FLOOR IS CHECKED ON EVERY READ, not once at connect. A stream held open for hours
        // can outlive the retention of its own unread history; only a per-read check catches that.
        // The floor and the rows came from ONE snapshot, so this cannot be told "you are fine" about
        // rows the sweep removed between the two. Announce, jump to the floor, and re-read: the page
        // in hand was read from below the floor and may be missing rows.
        if (cursor < page.truncatedThrough) {
          await stream.writeSSE({
            event: TRUNCATED_FRAME_EVENT,
            data: JSON.stringify({
              truncatedThrough: page.truncatedThrough,
              requestedFrom: cursor,
            }),
          });
          cursor = page.truncatedThrough;
          continue;
        }

        for (const event of page.events) {
          if (stream.aborted) break;
          await stream.writeSSE({
            id: formatEventCursor(tenantId, event.seq),
            event: sseEventName(event.topic),
            data: JSON.stringify(event.payload ?? null),
          });
          published = event.seq;
        }
        // Advance past everything SCANNED, not just what was delivered: a window whose rows were all
        // filtered out still moves the cursor, or a topic-filtered subscriber would re-scan the same
        // window forever and never reach the events it does want.
        cursor = Math.max(cursor, page.scannedThrough);

        // Put the resume position on the wire BEFORE this connection can end — the cap can close it
        // at any await from here on, and a client holding no cursor resumes at the tail. See
        // `formatResumeCheckpoint`.
        if (cursor !== published) {
          published = cursor;
          await stream.write(formatResumeCheckpoint(tenantId, cursor));
        }

        // More backlog behind this page — drain it without waiting.
        if (page.scannedThrough < page.lastSeq) continue;

        if (!announcedLive) {
          announcedLive = true;
          await stream.writeSSE({
            event: LIVE_FRAME_EVENT,
            data: JSON.stringify({ from: cursor }),
          });
        }

        if (pendingWake) {
          pendingWake = false;
          continue;
        }
        const wait = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (wait === 0) break;
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            signal = undefined;
            resolve(false);
          }, wait);
          signal = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        // The heartbeat: an SSE comment on a poll that nothing woke. It carries no data and is not a
        // frame, so a client parser never sees it; its job is to keep the connection observably alive.
        if (!woken && !stream.aborted) await stream.write(': keepalive\n\n');
      }
    } finally {
      unsubscribe?.();
    }
    // Falling out of the loop CLOSES the stream (the lifetime cap, or the client leaving). A client
    // reconnects with its `Last-Event-ID`, which re-runs the whole auth chain — see the file header.
    // That header is never empty by the time this line is reached: the checkpoint above published the
    // cursor, so the reconnect resumes rather than restarting at the tail.
  });
}

/** The classified opening state of one subscription: where to resume, and the page already read. */
interface OpeningRead {
  readonly cursor: number;
  readonly page: TenantEventPage | undefined;
}

/**
 * Classify the requested cursor and take the first page — BEFORE any byte of the SSE response is
 * flushed, which is what lets a bad cursor be a real HTTP status instead of a frame nobody checks.
 *
 * NO CURSOR IS NOT A TRUNCATION. A fresh subscriber starts at the TAIL and receives no signal: its
 * cursor is the head, which is by construction at or above the floor. Treating "cursor 0" as "below
 * the floor" would hand every first-time subscriber of an aged stream a spurious truncation notice —
 * telling it that it lost history it never had, and training clients to ignore the one signal that
 * matters. That tail is then PUBLISHED as a resume checkpoint by the loop above, so "no cursor" means
 * "start here" exactly once and never again silently re-means it on the reconnect the cap forces.
 *
 * A CURSOR FROM THE FUTURE IS REFUSED. A sequence above the head was never issued to this tenant, so
 * it cannot be resumed; served as an ordinary subscription it would be an "ok" stream that stays
 * empty until the tenant emits past it, which reads exactly like a working-but-quiet stream. It is a
 * corrupt/foreign cursor and is answered as one.
 */
async function openSubscription(
  tdb: TenantDb,
  tenantId: string,
  rawCursor: string | undefined,
  topics: readonly string[] | undefined,
): Promise<OpeningRead> {
  if (rawCursor === undefined) {
    // The head probe: no rows (limit 0), so this reads the counter row only and starts the subscriber
    // at the tail. Deliberately the SAME page read as everything else rather than the stream-state
    // helper beside it — one read path for the whole route means one place the snapshot rule lives.
    const head = await tdb.readEventPage({ after: 0, limit: 0 });
    return { cursor: head.lastSeq, page: undefined };
  }
  const requested = parseEventCursor(rawCursor, tenantId);
  const page = await tdb.readEventPage({
    after: requested,
    limit: EVENT_PAGE_LIMIT,
    ...(topics ? { topics } : {}),
  });
  if (requested > page.lastSeq) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'The subscription cursor is ahead of this stream — no such sequence has been issued to this ' +
        'tenant. It is refused rather than served as an empty subscription, which would be ' +
        'indistinguishable from a healthy stream that has simply gone quiet.',
    );
  }
  return { cursor: requested, page };
}
