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
| `RAYSPEC_HOSTING_POSTURE=managed` | The public `/recovery-scope` probe is not registered, and cross-process run cancellation is on by default. | `local` |
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
  receipt, the database isolation posture is active (`runtimeRole` given to the adapter), **and**
  single-tenant mode is on ([Runtime operations](./runtime-operations.md)).
- From outside: a second `POST /v1/auth/register` answers `403`, and `POST /v1/orgs` answers `403`.

## What the runtime checks on every request and job

Authentication comes first; then every surface decides whether **this** principal may perform
**this** operation on **this** resource. The resource check is the tenant: a principal reaches only
rows of the organization it is a member of (the chokepoint's predicate, and with role separation the
database policy), and an id from another organization answers `404`, like one that does not exist.
Within an organization, members share its data; a role decides what they may administer.

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

An error a handler throws answers `500` with `Internal server error.` and nothing else; a streamed
run that fails ends with an `error` frame carrying the neutral class and a fixed message. The detail
goes to the server log.

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
- Egress is not enforced by the runtime; the host's network policy does that.

## Upgrading

Nothing about the posture changes unless you turn it on: without `RAYSPEC_SINGLE_TENANT` the number
of organizations is not limited and registration stays open; without
`RAYSPEC_MIGRATION_DATABASE_URL` one role migrates and serves. With either setting on, a stream
handler no longer sees `authorization`, `proxy-authorization`, `cookie`, or a playback route's
`?token=` — a handler that read the caller from them reads `init.principal` instead.

These checks apply to every deployment from this release on, whether or not the posture is on. Each
refuses only a principal that no longer has access, or removes internal detail from an answer:

- starting or cancelling an agent run rereads the membership, like every other write;
- a durable agent run is re-checked when the worker starts it;
- a playback token stops working once its user is no longer a member;
- the `error` frame of a streamed run carries a fixed message per class instead of the thrown
  error's text.
