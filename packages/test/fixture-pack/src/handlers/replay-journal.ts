/**
 * The fixture pack's INCREMENTAL route handler — the in-tree witness that a pack can read the run
 * journal back and answer with a resumable event stream, writing against `@rayspec/pack-sdk` alone.
 *
 * It exists because both halves of that claim were previously unwitnessed. A pack could WRITE journal
 * steps (through a service's `PackJournalWriter`) and had no contracted way to read one back, so the
 * only route to its own record was the escape hatch with a core table name spelled out as text; and a
 * route could return exactly one value, so an incremental answer was not expressible at all. This
 * module is what those two doors look like used together, in the repository, reached through a real
 * declaration and served by the real interpreter.
 *
 * WHAT IT DOES, DELIBERATELY LITERALLY. It reads bounded PAGES of the journal for the run named in its
 * path and emits one frame per entry, carrying the entry's own `cursor` as the frame `id` — so a
 * client that drops the connection reconnects with `Last-Event-ID` and resumes exactly one entry past
 * the last one it received. It stops after a fixed number of pages and closes with a frame stating
 * whether more entries were waiting; a client that wants them asks again from the cursor it has. The
 * page size and the page cap are deliberately SMALL: a fixture whose every read exhausts the journal
 * would never exercise `hasMore`, the cursor, or a resume.
 *
 * WHERE THE FIRST READ HAPPENS, AND WHY IT IS NOT INSIDE THE PRODUCER. The FIRST page is read in the
 * handler BODY, before the response shape is chosen. That is not a detail: a producer runs after the
 * response status has been flushed, so a failure there can only tear a 200 down mid-stream, while the
 * same failure in the body is an ordinary refusal a caller can read. A cursor the reader did not issue
 * is exactly that kind of failure, so it belongs where it can still be answered properly. Every
 * FURTHER page is read from inside the producer, after the route transaction has committed — which the
 * journal reader is built to survive.
 *
 * WHAT IT DOES NOT DO. It never names a tenant: the reader is bound to the invocation's
 * server-derived tenant, so the entries it can see are its own tenant's and asking for another one is
 * not expressible. It never names a table. It reads `init.resumeFrom` as the client's position rather
 * than parsing a header itself — the deployment resolved that already.
 *
 * BOTH DOORS ARE FEATURE-DETECTED and fail CLOSED. Each is optional on the contract because a
 * deployment older than the contract injects neither, and a handler that read `undefined` would
 * answer with a broken stream instead of an error a deployer can act on.
 */
import type { PackJournalPage, PackRouteHandler, PackRouteResponse } from '@rayspec/pack-sdk';

/** The page size this fixture reads — small on purpose, so a second page and a resume are reachable. */
const PAGE_SIZE = 2;
/** How many pages one response drains before telling the client to come back. */
const MAX_PAGES = 2;

/**
 * `GET /ext/fixture-pack/journal/{run_id}` — replay this run's journal entries as an event stream,
 * resuming from `Last-Event-ID` when the client reconnects.
 */
export const replayJournal: PackRouteHandler<PackRouteResponse> = async (init) => {
  const journal = init.journal;
  const respond = init.sseResponse;
  if (!journal || !respond) {
    throw new Error(
      'fixture-pack replayJournal: this deployment injected no journal reader or no incremental ' +
        'response constructor, so the route cannot answer. Fail-closed rather than serving a ' +
        'stream with nothing in it.',
    );
  }
  const runId = init.params.run_id ?? '';
  // THE FIRST PAGE, IN THE BODY. A refused cursor surfaces here, as a refusal, rather than as a
  // 200 that dies after its first byte.
  const first: PackJournalPage = await journal.read({
    runId,
    limit: PAGE_SIZE,
    // The client's own position, as the deployment resolved it. Absent ⇒ from the beginning.
    ...(init.resumeFrom !== undefined ? { after: init.resumeFrom } : {}),
  });
  return respond(async (emit, signal) => {
    let page = first;
    for (let pages = 1; ; pages += 1) {
      for (const entry of page.entries) {
        // A disconnected client is not a reason to keep reading; the entries are durable either way.
        if (signal.aborted) return;
        await emit({
          // THE RESUME CURSOR. Without it a reconnecting client can only start over.
          id: entry.cursor,
          event: 'journal_step',
          data: JSON.stringify({
            stepId: entry.stepId,
            runId: entry.runId,
            tenantId: entry.tenantId,
            type: entry.type,
            status: entry.status,
            idempotencyKey: entry.idempotencyKey,
            output: entry.output,
          }),
        });
      }
      const next = page.nextCursor;
      if (!page.hasMore || next === undefined || pages >= MAX_PAGES || signal.aborted) break;
      // A read from INSIDE the producer — after the route transaction has committed. The journal
      // reader is bound to the tenant handle rather than to that transaction, so it still answers.
      page = await journal.read({ runId, limit: PAGE_SIZE, after: next });
    }
    await emit({
      event: 'journal_end',
      data: JSON.stringify({ hasMore: page.hasMore, nextCursor: page.nextCursor ?? null }),
    });
  });
};
