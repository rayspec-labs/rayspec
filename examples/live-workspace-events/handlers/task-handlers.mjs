/**
 * Escape-hatch handlers for the live-workspace-events backend — the two ROUTE handlers that write a
 * task and ANNOUNCE the change on the tenant's event stream.
 *
 * Self-contained native ESM (NO imports): the engine injects the tenant-bound HandlerInit and the
 * handlers return neutral data. Kept import-free on purpose so the module loads through the REAL
 * path-jailed handler loader in a plain `node` boot — which is the property this example proves: the
 * shipped entrypoint boots the backend directly, handlers and all.
 *
 * WHAT `init.emit` IS, in two sentences. It is TENANT-BOUND BY CONSTRUCTION: the engine builds it
 * from this request's server-derived tenant, and it has no tenant parameter, so a handler cannot emit
 * into somebody else's stream. And on a route it is ATOMIC with the handler's own writes — the events
 * are flushed as the last statement before the request's transaction commits — so a subscriber can
 * never receive an event announcing a row it cannot yet read, and a handler that throws after emitting
 * leaves neither the row nor the event.
 *
 * THE CALL IS POSITIONAL: `emit(topic, payload)`. The sibling `init.enqueue` takes one request object,
 * so `emit({ topic, payload })` is the mis-call to expect — and it fail-closes loudly rather than
 * filling the stream with rows no subscriber can filter.
 */

/**
 * The reserved brand key the engine's `isHttpResponse` discriminator checks (see
 * `@rayspec/handler-sdk`'s `HTTP_RESPONSE_BRAND`). A route handler returns a plain object for a 200,
 * or this branded envelope to choose the status / headers. Inlined here (single literal) because the
 * SDK does not resolve from a plain example `.mjs`; the value is a stable part of the route contract.
 */
const HTTP_RESPONSE_BRAND = '__rayspecHttpResponse';

/** Build the enriched route response envelope (status + JSON body). */
function httpResponse({ status, headers, body }) {
  return {
    [HTTP_RESPONSE_BRAND]: true,
    ...(status !== undefined ? { status } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Fail closed, and loudly, when the deployment did not enable the bus. An `init.emit` that is simply
 * absent is the shape of a document without `deployment.eventBus.enabled: true`; silently skipping the
 * announcement would leave every open client stale with nothing anywhere reporting a fault.
 */
function requireEmit(init) {
  if (typeof init.emit !== 'function') {
    throw new Error(
      'init.emit is not available — this deployment did not enable the event bus. Set ' +
        'deployment.eventBus.enabled: true in the deployed document. Fail-closed.',
    );
  }
  return init.emit;
}

/**
 * `POST /tasks` — create a task and announce it.
 *
 * @param {{
 *   body?: unknown,
 *   db: { insert: (store: string, values: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   emit?: (topic: string, payload?: unknown) => Promise<void>,
 * }} init
 */
export async function createTask(init) {
  const emit = requireEmit(init);
  // The request body is UNTRUSTED caller DATA — validate the shape fail-closed (a route handler owns
  // its own body validation; a bad payload is a 400, never a persisted half-row).
  const body = init.body && typeof init.body === 'object' ? init.body : {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const assignee = typeof body.assignee === 'string' ? body.assignee.trim() : '';
  if (!title) {
    return httpResponse({
      status: 400,
      body: { error: 'invalid_task', detail: 'title (a non-empty string) is required.' },
    });
  }

  const row = await init.db.insert('tasks', {
    title,
    status: 'open',
    ...(assignee ? { assignee } : {}),
  });

  // The announcement. It rides this request's transaction, so it becomes visible to subscribers at
  // exactly the moment the row does — never before it can be read, and never at all if the request
  // fails after this line.
  await emit('task.created', { id: row.id, title, assignee: assignee || null, status: 'open' });

  return httpResponse({ status: 201, body: row });
}

/**
 * `POST /tasks/{id}/done` — complete a task and announce it.
 *
 * A no-op when the id is absent (or belongs to another tenant, which reads identically because the
 * store facade is tenant-scoped beneath): nothing is written and NOTHING is emitted, because an event
 * announcing a change that did not happen is worse than no event at all.
 *
 * @param {{
 *   params: Record<string, string>,
 *   db: { update: (store: string, filter: Record<string, unknown>, patch: Record<string, unknown>) => Promise<Record<string, unknown>[]> },
 *   emit?: (topic: string, payload?: unknown) => Promise<void>,
 * }} init
 */
export async function completeTask(init) {
  const emit = requireEmit(init);
  const id = init.params.id;
  const updated = await init.db.update('tasks', { id }, { status: 'done' });
  const row = updated[0];
  if (!row) {
    return httpResponse({ status: 404, body: { error: 'not_found' } });
  }

  await emit('task.completed', { id: row.id, title: row.title });

  return httpResponse({ status: 200, body: row });
}
