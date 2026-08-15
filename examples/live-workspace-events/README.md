# Live Workspace Events — one event stream drives every open client

A small, real **backend-profile** document for the shape a product hits the moment its UI has to
reflect *everything happening in the workspace*: a change made by any request must show up on every
open client. This example is the whole loop — handlers **announce** with `init.emit`, clients hold one
`GET /v1/subscribe` connection open, and nobody polls.

- `live-workspace-events.rayspec.yaml` — the authored backend document (`deployment.eventBus`, one
  store, two `{handler}` routes, one declarative read). No agents, no credentials: it boots with
  nothing but a database.
- `handlers/task-handlers.mjs` — the two route handlers. Each writes a row and emits one event.
- `smoke.sh` — an end-to-end curl walkthrough that opens a subscription, drives changes, disconnects,
  and **resumes from its last cursor**.

## What it does

```
POST /tasks            → create_task inserts the task and emits `task.created`      → 201
POST /tasks/{id}/done  → complete_task flips it to done and emits `task.completed`  → 200
GET  /tasks            → list this tenant's tasks   (declarative store route — no handler code)
GET  /v1/subscribe     → the tenant's live event stream (SSE) — a platform route, no declaration
```

Everything is tenant-scoped by construction. `init.emit` is built from the request's server-derived
tenant and has **no tenant parameter**, so a handler cannot emit into another tenant's stream; the
subscription reads through the same tenant predicate every other read uses.

## The two properties worth understanding

**An event never announces something you cannot read yet.** On a route handler the emit is buffered
and flushed as the last statement before the request's transaction commits, so the row and the event
become visible together. A handler that emits and then fails leaves neither.

**A hole in the sequence is a real signal, never noise.** Sequence numbers are gap-free: a rolled-back
write returns its number and the next write reuses it. So the only way a subscriber can be missing a
number is retention — and when that happens it is *told*, with a control frame, rather than quietly
resuming into a gap.

## Subscribe

```
GET /v1/subscribe?topics=task.created,task.completed&since=<cursor>
Accept: text/event-stream
Authorization: Bearer <token>          # needs the events:read permission
```

- **Data frames** carry `id:` (the cursor), `event:` (your topic) and `data:` (your payload
  as JSON).
- **Control frames carry no `id:`** — that is how you tell them apart, and it is why a control frame
  can never come back as a cursor:
  - `rayspec.live` — your backlog is drained; everything after this is live.
  - `rayspec.truncated` — the cursor you sent is older than retention. `data` carries
    `{ truncatedThrough, requestedFrom }`; refetch your state and keep reading.
- **The cursor is `<tenant_id>:<seq>`**, not a bare number. Sequences are per tenant, so an untagged
  cursor would silently resume against the wrong stream after an org switch. A cursor tagged with
  another tenant is refused, so is one from the future, and so is a sequence that is not plain
  decimal digits — `:0x10` is a **400**, not a stream that quietly starts at 16.
- **A block that is an `id:` line and nothing else** is the *resume checkpoint*, not a frame: it
  dispatches no event and only updates the cursor your client will send back. `EventSource` handles it
  for you; a hand-written parser must not treat a block with no `data:` as an event.
- **Omitting `topics` means every topic.** An explicitly empty `?topics=` is a **400**, not a stream
  that quietly delivers nothing, and so is a filter naming more than **64** topics — omit it and
  select client-side instead.
- **The stream is closed after a bounded lifetime** (at most the access-token TTL) and your client
  reconnects with `Last-Event-ID`. That reconnect re-runs the whole auth chain, which is how a revoked
  principal stops receiving events.

A browser client is three lines, because all of the above is what `EventSource` already does:

```js
const es = new EventSource('/v1/subscribe?topics=task.created,task.completed');
es.addEventListener('task.created', (e) => board.add(JSON.parse(e.data)));
es.addEventListener('task.completed', (e) => board.complete(JSON.parse(e.data)));
```

`EventSource` resends the last `id:` it saw as `Last-Event-ID` on every reconnect, so the resume is
free — including across the server's lifetime cap. That holds even on a workspace so quiet that this
client has never received an event: its last-event-ID string would otherwise still be empty at the
cap, and it would come back with no cursor and silently skip whatever was created in the gap. The
route publishes the resume checkpoint above precisely so that cannot happen.

## Validate (no DB, no deploy)

```bash
rayspec doctor examples/live-workspace-events/live-workspace-events.rayspec.yaml
rayspec plan   examples/live-workspace-events/live-workspace-events.rayspec.yaml
```

## Boot it on the shipped entrypoint

No wrapper: the shipped `rayspec-serve` reads the document, materializes the `tasks` store, mounts the
routes and enables the bus. (It prints one warning about the retention sweep — see the last section.)

```bash
pnpm db:up   # Postgres on :5433

# Point DATABASE_URL at a FRESH, EMPTY database — rayspec-serve applies the migration chain but does
# NOT drop/create the DB. The RS256 key goes in through a FILE rather than an inline assignment (the
# value `rayspec dev gen-secrets` writes carries literal \n escapes that only the entrypoint's own
# .env loader un-escapes, and that loader skips a variable already present in the environment).
RAYSPEC_SPEC_PATH=$(pwd)/examples/live-workspace-events/live-workspace-events.rayspec.yaml \
RAYSPEC_HANDLER_ROOT=$(pwd)/examples/live-workspace-events \
DATABASE_URL="postgres://…:5433/<a-fresh-empty-db>" \
RAYSPEC_JWT_SIGNING_KEY_FILE=/path/to/jwt-signing-key.pem \
RAYSPEC_API_KEY_PEPPER="<any string>" \
  pnpm --filter @rayspec/server serve
```

Then drive it:

```bash
BASE=http://localhost:8080 ./examples/live-workspace-events/smoke.sh
```

## The warning this example prints, and why it is correct

The boot emits one line:

```
[events] deployment.eventBus is enabled with retentionHours=48, but this boot wired NO durable
worker — the daily housekeeping pass that sweeps aged-out events runs on it, so NOTHING is ever
swept and tenant_events grows without bound. init.emit itself is fully live. …
```

That is accurate and expected here. The retention sweep runs on the daily housekeeping pass, the pass
runs on the durable worker, and the worker is only wired for a deployment that also supplies agent
backends — which this deliberately agent-free example does not. **Nothing about the live surface
depends on it**: emitting and subscribing work exactly as documented above; what is missing is only
the pruning, so the declared 48-hour window never takes effect and the stream grows unbounded.

A deployment that wants the window honoured declares `deployment.durableWorker: true` and wires its
agent backends (see `examples/lead-qualifier`), or treats the stream as unbounded and prunes it out of
band. The two keys are independent on purpose: a bus without a worker still does its whole job, so
refusing that boot would break a posture that works.
