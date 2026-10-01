# Hosting in the hardened posture

A RaySpec runtime can run in a **hardened posture**: one application, one organization, database
roles that keep the serving process from bypassing tenancy, and an authorization check on every
request and job. It is meant for an environment whose runtime is reachable by people you do not
fully trust, such as a hosted environment with its own VM and database.

It is **opt-in**. A deployment that upgrades and sets nothing new keeps working as before: one
database role migrates and serves, any number of organizations can be created and registration is
open. The posture is turned on by explicit configuration, and the runtime reports the managed
hosting posture as supported only when all of it is on.

## What turns it on

| Setting | What it does | Without it |
| --- | --- | --- |
| `RAYSPEC_MIGRATION_DATABASE_URL` (or `_FILE`), with the roles from `database-roles.sql` | Role separation and row-level security: the migration role changes the schema, the server serves as a runtime role that cannot bypass the tenant policies. See [Database roles and row-level security](./database-isolation.md). | one role migrates and serves |
| `RAYSPEC_SINGLE_TENANT=true` | Single-tenant mode: the runtime holds one organization. Creating a second one is refused on every path (the HTTP routes, the operator bootstrap, `rayspec tenant ensure`); open registration only creates that first one, and after it an account is made by redeeming an invite. | any number of organizations; open registration |
| `RAYSPEC_HOSTING_POSTURE=managed` | The public `/recovery-scope` probe is not registered, cross-process run cancellation is on by default, every execution bound has a default ([Bounded execution](#bounded-execution)), a boot that would use a backend outside the [supported-backend matrix](#supported-backends) is refused, and agent traces are not exported unless `RAYSPEC_AGENT_TRACING=openai` ([Telemetry](#telemetry)). | `local` |
| `RAYSPEC_TRUSTED_PROXIES` | Behind a reverse proxy, the proxy addresses whose forwarding headers are believed; nothing else can set the client address. | the socket peer is the client |

`RAYSPEC_SINGLE_TENANT` accepts exactly `true` or `false`; any other value refuses the boot, so a
typo never leaves the limit off by accident.

## Turning it on

1. **Create the database roles** and point the runtime at them, as
   [Database roles and row-level security → Turning it on](./database-isolation.md#turning-it-on)
   describes.
2. **Set the posture:**

   ```bash
   export RAYSPEC_SINGLE_TENANT=true
   export RAYSPEC_HOSTING_POSTURE=managed
   ```

3. **Settle the one organization.** On a fresh database, either the first
   `POST /v1/auth/register` with an `orgName` creates it (and its owner), or
   `rayspec tenant ensure --org-id <uuid> --name <n> --owner-email <e> --owner-invite-out <path>`
   reserves it and writes an owner invite (it reads the same `RAYSPEC_SINGLE_TENANT`). Everyone
   else joins by an invite (`POST /v1/orgs/{orgId}/invites`, redeemed at
   `POST /v1/invites/accept`).
4. **Boot.** A single-tenant boot of a database that already holds more than one organization
   (soft-deleted ones included) is refused with a message naming the count; nothing is picked or
   hidden. Decide what happens to the others first.

## Checking it

- `BootedServer.singleTenant` is `true` and `BootedServer.databaseIsolation` reports
  `role-separated` and `active`. A failed isolation check prints one warning line per failure.
- `createRuntimeControl(...).inspectHosting()` reports
  `applicationTenants: { singleTenantMode: true, maxApplicationTenants: 1 }`, read from the same
  setting the boot reads.
- `inspect()` reports `managedPosture.supported: true` only when the release carries a capability
  receipt, the database isolation posture is active (`runtimeRole` given to the adapter),
  single-tenant mode is on, **and** no agent trace is exported (`inspectHosting().agentTraceExport`
  is `off`) ([Runtime operations](./runtime-operations.md)).
- From outside: a second `POST /v1/auth/register` answers `403`, and `POST /v1/orgs` answers `403`.

## What the runtime checks on every request and job

Authentication comes first; then every surface decides whether **this** principal may perform
**this** operation on **this** resource. The resource check is the tenant: a principal reaches only
rows of the organization it is a member of (the chokepoint's predicate, and with role separation the
database policy), and an id from another organization answers `404`, like one that does not exist.
Within an organization, members share its data; a role decides what they may administer.

The table describes the posture turned on (role separation or single-tenant mode). Four rows differ
without it, as they did before the posture existed: an agent run start or cancel trusts the token's
role, a playback token alone admits playback until it expires, a queued durable run is not checked
again when it starts, and a streamed run's `error` frame carries the error's own text (see
[Upgrading](#upgrading)).

| Surface | Authorization decision |
| --- | --- |
| Organization, member, invite and API-key routes | a write or administrative action (create, change or remove an organization, member, invite or API key) takes its permission from the **live** membership row, never the token's claim; `org:read` and `apikey:read` trust the token's role for its lifetime (see below); the organization in the URL must be the caller's |
| Declared store routes (list, get, create, update, delete) | `store:read` or `store:write`; a write rereads the membership; the row must belong to the caller's organization |
| Agent runs: start, cancel | `agent:run`, from the live membership; a run id of another organization is `404` |
| Agent runs: read, event replay | `agent:read`; the run must belong to the caller's organization |
| `{handler}` routes | `store:write` from the live membership, or `store:read` for a handler declared `readonly` |
| Stream ingest (each uploaded part) | `store:write` from the live membership; the blob handle and the pointer row are bound to the caller's organization |
| Stream playback | a media token (signature, expiry, the distinct media key) **and** the token's user is still a member of its organization, reread on every request; the handler re-checks the resource's owner in the database |
| Event subscription (`GET /v1/subscribe`) | `events:read`; the tenant comes from the principal, never a parameter, and a cursor of another organization is refused; the stream closes at the access-token lifetime so the reconnect is checked again |
| Durable agent runs (async runs, `init.enqueue`) | authorized when enqueued; the job records who asked (the member or API key), and the worker checks again when it starts the run — a member removed or a key revoked meanwhile gets no run: it is recorded ended with `errorClass: 'cancelled'` and a message saying why, and the model is never called |
| Manual trigger fire, session reprocess | `store:write` from the live membership |
| Scheduled triggers | run as the platform under the deployment's organization (`RAYSPEC_CRON_TENANT_ID`); a firing is skipped while that organization does not exist |

A read (`store:read`, `agent:read`, `events:read`, `org:read`, `apikey:read`) trusts the role in the
access token for that token's lifetime (`RAYSPEC_ACCESS_TOKEN_TTL_SECONDS`, 480 seconds by default).
Every write, run start and administrative action rereads the membership.

## Bounded execution

Every bound on agent execution is one **execution policy**, read at boot and reported by
`createRuntimeControl(...).inspectHosting().executionPolicy` with where each value came from
(`explicit`, `hosting-posture`, `default` or `off`). Under the managed posture every bound has a
default; without it the defaults are the behaviour before the policy existed, except the two that hold
in every posture.

| Variable | Bounds | Managed default | Without the posture |
| --- | --- | --- | --- |
| `RAYSPEC_AGENT_RUN_MAX_MS` | one whole run, wall clock; on expiry the run's signal is aborted and the run is recorded `error` with the neutral `timeout` class | 900000 | no bound |
| `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | one provider call (see the matrix below for what that means per backend) | 120000 | the client's own default |
| `RAYSPEC_AGENT_MAX_ATTEMPTS` | attempts per HTTP model request | 2 | the client's own default |
| `RAYSPEC_AGENT_KILL_GRACE_MS` | SIGTERM to SIGKILL for a child process; how long run-core waits for a stopped call to settle | 5000 | 5000 |
| `RAYSPEC_AGENT_QUEUE_MAX` | queued and executing `async` runs, in total | 1000 | no bound |
| `RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT` | queued and executing `async` runs, per organization | 100 | no bound |
| `RAYSPEC_AGENT_WORKER_CONCURRENCY` | durable runs one worker process executes at once | 4 | 4 |
| `RAYSPEC_AGENT_SYNC_RUNS_MAX` | in-request runs one process holds at once | 32 | no bound |
| `RAYSPEC_RUN_CANCEL_POLL_MS` | how soon a cancellation reaches a run in another worker process | 2000 | off |

A run past a queue or in-request bound is refused with `429 RATE_LIMITED`, a `Retry-After`, and
`error.details` `{ reason: "queue-full", scope, limit }`, before anything is recorded for it. Under
the managed posture an unusable value of any of these variables refuses the boot; without it, the
variables added with the policy refuse the boot and the older four treat an unusable value as unset.

**What a run that is ended records.** A run ended by a cancellation or by its wall-clock bound is
recorded terminal `error` with one journal step whose output states what happened to its provider
call, as observed by the process executing it: `before-call` (nothing was sent), `call-aborted` (the
call settled within the kill grace after it was told to stop), `after-call` (the call had already
finished; its result was discarded) or `outcome-unknown` (it did not settle in time, or the executing
process could not report). A run whose outcome is unknown is never re-run automatically; one that
fired a non-idempotent tool stays quarantined as before.

**No transaction across the model call.** A run's database statements commit as they are made, on
the durable worker as on the in-request path, so a run waiting on a slow provider holds no
database connection. One execution per run is kept by a lease on the run's started-once marker, which
the executing worker renews: a second dispatch of the same run waits until the lease is given up or
lapses, and an execution whose lease was taken over stops its own run.

## Supported backends

The managed posture runs only the backends below marked `allowed`. A boot under the posture whose
agents, product model calls or speech providers use any other backend is refused before anything is
written, with a message naming the backend, what uses it and why; nothing is swapped silently. The
columns state what this repository's tests prove; `inspectHosting().supportedBackends` reports the
same matrix.

| Backend | Kind | Managed posture | Provider-call bound | Cancellation and the wall-clock bound | Child process | Not covered | Proven by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | agent | allowed | every HTTP request: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`, at most `RAYSPEC_AGENT_MAX_ATTEMPTS` attempts | the run's signal aborts the HTTP request | none | a tool call already dispatched runs to its own tool timeout | `packages/adapters/openai/src/hanging-provider.test.ts` |
| `anthropic` | agent | self-host-only | silence of the child: no message for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | the SDK query ends; stdin closes at once, SIGTERM after 2 s, SIGKILL 5 s later | killed 7 s after the abort (fixed by the SDK) | the child's own children are not signalled; a host that exits inside the ladder can orphan a child that ignores SIGTERM | `packages/adapters/anthropic/src/cancellation.real-process.test.ts` |
| `codex` | agent | self-host-only | silence of the turn: no event for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | the streamed turn ends; the launcher forwards SIGTERM to the child | killed `RAYSPEC_AGENT_KILL_GRACE_MS` after an ignored SIGTERM | the child's own children are not signalled; without the bundled binary the escalation is unavailable (logged) | `packages/adapters/codex/src/cancel.integration.test.ts` |
| `pi` | agent | self-host-only | silence of the session: no event for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | `session.abort()` aborts the HTTP request | none | compaction and branch-summary requests are not reached by the abort; a tool ignores its own abort signal | `packages/adapters/pi/src/hanging-provider.test.ts` |
| `deepgram` | speech-to-text | allowed | every request, body included: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | none: no run signal reaches a transcription | none | a cancelled run does not stop a transcription in flight | `packages/adapters/deepgram/src/hanging-provider.test.ts` |
| `fake` | speech-to-text | test-only | not applicable | not applicable | none | staging and conformance only | — |
| `openai` | text-to-speech | allowed | every request, body included: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | none: no run signal reaches a synthesis | none | a cancelled run does not stop a synthesis in flight | `packages/adapters/openai-tts/src/hanging-provider.test.ts` |
| `fake` | text-to-speech | test-only | not applicable | not applicable | none | staging and conformance only | — |

## Telemetry

The agent SDK of the `openai` backend exports agent traces to OpenAI by default: run metadata and,
once an agent calls tools, the tool arguments and outputs. Whether this process exports them is
`inspectHosting().agentTraceExport` (`off` or `openai`), and the boot banner's `Trace export:` line
states what the SDK will actually do.

| Entrypoint | `RAYSPEC_AGENT_TRACING` unset | To change it |
| --- | --- | --- |
| `rayspec deploy <spec.yaml>` and `rayspec deploy <file.ray>` | off | `RAYSPEC_AGENT_TRACING=openai` |
| any entrypoint under `RAYSPEC_HOSTING_POSTURE=managed` | off | `RAYSPEC_AGENT_TRACING=openai` |
| `rayspec-serve` (and the boot wrappers that print the banner), without the managed posture | **exported** (the SDK's default) | **`RAYSPEC_AGENT_TRACING=off`** |

`rayspec-serve` keeps the SDK's default in this release so that a deployment that relies on it does
not lose its traces on upgrade. If the code it serves is not yours, set `RAYSPEC_AGENT_TRACING=off`.
`inspect()` does not report the managed posture as supported while traces are exported.

## Egress

An application **declares** the hosts it calls: `deployment.egressHosts` in a backend spec,
`deployment_overrides.egress_hosts` in a product spec ([Spec reference](./spec-reference.md#deployment)).
`rayspec pack` carries the list into the bundle manifest (`permissions.egressHosts`),
`rayspec bundle verify` refuses a manifest whose list differs from the spec's, and `prepare()`
reports it as a permission change covered by the plan digest. `inspectHosting().egress` states who
enforces it.

**The runtime enforces none of it.** A call to an undeclared host is not blocked by RaySpec. Program
the host's network policy from the declared list — an egress firewall, a security group, or an
egress proxy that admits only those hosts — and deny everything else, including the database and
control channels the application does not need. Handlers and extensions run in the runtime process
and can open any connection the process can; only the host's policy contains them.

**What the platform guards itself.** When the platform makes an outbound request on behalf of a spec
or a request — to a URL it did not choose — it goes through one guard (`guardedFetch` in
`@rayspec/platform`) that refuses:

- a scheme other than `http:` or `https:`, and a URL carrying a user name or password;
- a loopback, private (RFC 1918, unique-local IPv6, carrier-grade NAT), link-local, metadata
  (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`), unspecified, multicast, broadcast, reserved,
  documentation or benchmarking address, including an IPv4 address embedded in IPv6;
- a host name that resolves to such an address: the check runs on the address the connection
  actually uses, so a name that answers a public address once and a private one later (DNS
  rebinding) is refused too;
- a redirect to any of the above, each hop checked again; a redirect to another origin drops the
  `authorization`, `cookie` and `proxy-authorization` headers.

A guarded request connects directly, never through `HTTP_PROXY`/`HTTPS_PROXY`, because behind a proxy
the guard would see the proxy's address instead of the destination's.

This release has **no** such outbound path: no grammar field, node or request field makes the
platform fetch a URL. The provider adapters call the endpoints the operator configures
(`OPENAI_BASE_URL` and `DEEPGRAM_BASE_URL` are reserved operator settings a bundle cannot set). A test
holds the list of every outbound call site in the shipped source, so a new one is either routed
through the guard or reviewed.

## What handler code is given

- the tenant id the server derived, and the caller as plain values (`kind`, `id`, `role`);
- a store facade over its own organization's declared stores, a blob store bound to that
  organization, and capabilities (`emit`, `enqueue`, `mintPlayToken`) bound to the organization and
  the caller — none takes a tenant or a user argument;
- **no** database handle, no connection pool and no migration connection: the migration role's pool
  is closed before the server serves;
- a `{handler}` route receives only an allowlist of request headers (conditional-read and
  content-negotiation headers);
- in the hardened posture (role separation or single-tenant mode on) a stream handler receives the
  request **without** `authorization`, `proxy-authorization` and `cookie`, and a playback handler
  without its `?token=`; every other header and the body arrive. Without either setting it receives
  the request as the caller sent it, as before.

An error a handler throws answers `500` with `Internal server error.` and nothing else. In the
posture, a streamed run that fails ends with an `error` frame carrying the neutral class and a fixed
message, and an agent definition its backend cannot run answers `400` without the validator's
detail; the detail goes to the server log.

## What it does not protect against

- **It is not a sandbox for custom code.** Handlers and extensions are imported into the runtime
  process. They can read the process environment and any file the process can read, open their own
  database connection with the runtime role's credentials, and within a transaction of their own set
  any tenant id — row-level security enforces what a connection claims, not who wrote the code.
  If the migration credential is given to the serving process (as the variable or as a file), code
  in that process can read it: it is never handed to a handler, but nothing stops code that goes
  looking. Only a boundary outside the process — a dedicated VM or container, its own database,
  host egress rules — contains code you do not trust. Run custom code only from authors you trust,
  or where such a boundary exists.
- A member removed from the organization keeps **read** access for the rest of their access token's
  lifetime (see above).
- Workflow runs of a product document (a finalized session, a submitted file or record, a reprocess)
  run as the platform for the organization; they are not re-checked against the member whose action
  started them.
- A durable run enqueued before this release carries no requester and is not re-checked.
- Bearer credentials (access tokens, API keys, media tokens) are not bound to a client: whoever holds
  one can use it until it expires or is revoked.
- Egress is not enforced by the runtime; the host's network policy does that ([Egress](#egress)).

## Upgrading

Nothing about the posture changes unless you turn it on: without `RAYSPEC_SINGLE_TENANT` the number
of organizations is not limited and registration stays open; without
`RAYSPEC_MIGRATION_DATABASE_URL` one role migrates and serves, and every authorization check and
error answer behaves as before.

With either setting on, the runtime also:

- no longer hands a stream handler `authorization`, `proxy-authorization`, `cookie`, or a playback
  route's `?token=` — a handler that read the caller from them reads `init.principal` instead;
- rereads the membership when an agent run is started or cancelled, like every other write;
- re-checks a durable agent run when the worker starts it (a run enqueued before the upgrade
  carries no requester and runs as before);
- stops a playback token once its user is no longer a member;
- puts a fixed message per class on the `error` frame of a streamed run, and answers an agent
  definition its backend cannot run without the validator's detail.

Each check refuses only a principal that no longer has access, or removes internal detail from an
answer.
