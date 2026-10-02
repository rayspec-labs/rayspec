# Hosting in the hardened posture

A RaySpec runtime can run in a **hardened posture**: one application, one organization, database
roles that keep the serving process from bypassing tenancy, and an authorization check on every
request and job. It is meant for an environment whose runtime is reachable by people you do not
fully trust, such as a hosted environment with its own VM and database.

It is **opt-in**. A deployment that upgrades and sets nothing new keeps working as before: one
database role migrates and serves, any number of organizations can be created and registration is
open. The posture is turned on by explicit configuration, and the runtime reports the managed
hosting posture as supported only when all of it is on.

Who the posture defends against, what the host around the runtime must enforce itself, and every
residual risk this release accepts are in the [Threat model](./threat-model.md).

## What turns it on

| Setting | What it does | Without it |
| --- | --- | --- |
| `RAYSPEC_MIGRATION_DATABASE_URL` (or `_FILE`), with the roles from `database-roles.sql` | Role separation and row-level security: the migration role changes the schema, the server serves as a runtime role that cannot bypass the tenant policies. See [Database roles and row-level security](./database-isolation.md). | one role migrates and serves |
| `RAYSPEC_SINGLE_TENANT=true` | Single-tenant mode: the runtime holds one organization. Creating a second one is refused on every path (the HTTP routes, the operator bootstrap, `rayspec tenant ensure`); open registration only creates that first one, and after it an account is made by redeeming an invite. | any number of organizations; open registration |
| `RAYSPEC_HOSTING_POSTURE=managed` | The public `/recovery-scope` probe is not registered, cross-process run cancellation is on by default, every execution bound has a default ([Bounded execution](#bounded-execution)), a boot that would use a backend outside the [supported-backend matrix](#supported-backends) is refused, agent traces are not exported unless `RAYSPEC_AGENT_TRACING=openai` ([Telemetry](#telemetry)), and every handler must declare its rights ([Tool rights](#tool-rights)). | `local` |
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

With role separation, `rayspec deploy` and `rayspec-serve` hold the migration and snapshot
connections in a supervisor and run the application in a child process of the same operating-system
user. The managed posture refuses to boot while that child could still reach them, and names each
condition; every other posture warns. On the host:

- pass `RAYSPEC_MIGRATION_DATABASE_URL` and `RAYSPEC_SNAPSHOT_DATABASE_URL` in the environment, not
  as `_FILE` and not in a `.env` file (the child could read the file);
- on Linux, set `kernel.yama.ptrace_scope` to 1 or more, so the child cannot read the supervisor's
  memory. Docker Desktop's VM kernel has no Yama at all, and RHEL/Fedora-style kernels default to 0;
  the boot refuses either until the setting is there;
- on Linux, keep `/bin/sh` in the image (the entrypoint sets a zero hard core-file limit through
  it), or start the process with a hard core-file limit of 0 (`docker run --ulimit core=0`): a
  distroless image has no `/bin/sh`;
- keep the runtime installation (the RaySpec packages and their dependencies) and the deployment's
  spec read-only to the application process's user. The supervisor reads the spec and loads the
  workflow engine's migration code before it starts the child, so a later change to those files
  does not reach the privileged steps of this boot, but it would reach the next one.

A host that booted the managed posture before this release can be refused by these checks after
the upgrade; they are prerequisites of the managed posture, not of the others.

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

## Certifying the posture

`pnpm test:certification` (`scripts/certification.mjs`) runs, on a real PostgreSQL, the suites that
prove each check a public host must hold, and prints one JSON verdict per check. CI runs it in the
`certification` job on every pull request.

```bash
pnpm build
DATABASE_URL=postgres://rayspec:rayspec@localhost:5433/rayspec pnpm test:certification \
  --out certification.json --log-dir certification-logs
pnpm test:certification --check object-authorization    # one check
```

`DATABASE_URL` names a superuser of a PostgreSQL 16 server on which the roles of
`packages/kernel/db/sql/database-roles.sql` exist (`pnpm db:up` creates them on a new volume); each
suite creates databases and roles of its own and drops them. `pg_dump` and `pg_restore` of the
server's major come from `PATH` or from Docker. The run takes about half an hour.

Two kinds of suite run:

- **The certification suites** (`packages/app/cli/src/certification/`) pack an application, deploy
  it with the real `rayspec deploy <file.ray>` with every part of this posture on — role separation
  with forced row-level security, `RAYSPEC_SINGLE_TENANT=true`, `RAYSPEC_HOSTING_POSTURE=managed`,
  `RAYSPEC_TRUSTED_PROXIES` pinned to an address the test client is not, one allowed origin — and
  drive it over HTTP, reading every outcome from the database as the superuser. The model provider
  is a local stand-in on `OPENAI_BASE_URL`; nothing leaves the machine.
- **The existing suites** of the packages that hold each protection, in the runtime-role lane
  (`RAYSPEC_TEST_DATABASE_ISOLATION=roles`): every server boot migrates as a migration role and
  serves as a runtime role. These suites set single-tenant mode and the managed posture where their
  case needs it, not throughout.

| Check | What the certification suites show |
| --- | --- |
| `runtime-role-evidence` | every session the served process holds after its boot is the runtime role, which is no superuser, has no `BYPASSRLS` and owns nothing; the application's tables have their row policy enabled and forced. The process that imports the application holds only the runtime role |
| `privileged-credentials` | with role separation the migration and snapshot connections are held only by the supervisor — the process the operator starts, which never imports application code and serves the application in a child process started without them. The process that runs handler and extension code never holds a privileged connection in its environment block, through the database driver or over its channel to the supervisor, so in-process code can neither bypass row security nor lift the export fence; boot, readiness, graceful drain, the supervisor's non-zero exit when the child crashes, and single-role mode all behave as before ([Threat model → Accepted residual risks](./threat-model.md#accepted-residual-risks) covers the same-user conditions the managed posture refuses to boot with) |
| `object-authorization` | a member reaches every store operation, an upload part, a playback stream and the event stream; nothing is reached without a credential; once the member is removed, every write, upload part, run start and the playback token minted before are refused at once, and the run they had queued is ended by the worker without calling the provider. The event stream keeps serving the removed member's unexpired token, as stated above for every read. No route serves an export: the snapshot is written by the operator's CLI |
| `trusted-proxies` | a forwarded-for header from an address that is not pinned is not believed: the audit records the socket peer and the rate limit is the peer's; the port listens on loopback |
| `cors-and-csrf` | a preflight from another origin gets no `access-control-allow-origin`; a refresh authenticated by the session cookie is refused cross-site |
| `upload-limits` | a JSON body over 1 MiB is refused with `413` before it is stored; the file capability's suites refuse a file over its per-file limit; an upload key that climbs out of the blob space is refused and writes nothing. A stream ingest route's body has no cap of its own and is not bounded by this check: cap request bodies at the reverse proxy ([Threat model → What the host must enforce](./threat-model.md#what-the-host-must-enforce)) |
| `sanitized-errors` | a handler's internal detail, malformed JSON, a bad id, an unknown route and a bad token each answer an error envelope with no stack, SQL or secret, and the server log carries no secret |
| `outbound-guard` | the guard's own suites (no outbound path of this release takes a URL from a spec or a request) |
| `recovery-scope` | `GET /recovery-scope` answers `404` under the managed posture |
| `single-tenant-mode` | a second registration and a second organization are refused; the single-tenant suites, the boot over more than one organization, and export and import of more than one, in their own suites |
| `agent-trace-export-off` | the trace-export suites, including the one that asks the agent SDK itself whether it would export |
| `execution-levels` | the application every certification suite deploys is `in-process` code; the runtime-control and bundle deploy suites report exactly `none` and `in-process` and deploy a `none` bundle; the corpus refuses a bundle that asks for `sandboxed` |
| `supported-backends` | the matrix suite (every other backend refused under the posture) and the hanging-provider suite of every allowed backend |
| `hostile-archives` | every archive of the contract's corpus that the reader refuses is refused by `rayspec deploy <file.ray> --dry-run` against a serving deployment with the contract's code, and the state directory, the temporary directory and the database are unchanged |
| `hostile-migration-bundles` | a wrong identity, a truncated ciphertext, a passphrase recipient, a traversal entry in the inner archive, an invalid snapshot document, outer and inner metadata that disagree, a wrong application digest, a wrong object digest, a gap in the object ranges and a target that is not empty are each refused by `rayspec import --dry-run` with the contract's code, and nothing reaches the target |
| `cross-process-cancel` | the platform's and the workflow engine's own suites |
| `crash-recovery` | the apply, deploy, export and import suites, which kill the process at named points and run the recovery |
| `resource-bounds` | with a provider that never answers: in-request runs past `RAYSPEC_AGENT_SYNC_RUNS_MAX` and queued runs past `RAYSPEC_AGENT_QUEUE_MAX` are refused with `429` `queue-full`; store traffic beside them is served; every admitted run ends (`timeout`, or `cancelled` for the one cancelled), none is left running; the runtime role's sessions never exceed the serving pool (4), the worker's pool (its concurrency plus one) and the event bus's listener; resident memory returns near its baseline; the provider is left with no open request |
| `export-import-round-trip` | a deployment in this posture is exported while it serves, imported into an empty target, cut over and served there in the same posture: every row and file is equal, every access token, refresh session, API key and invite of the source is refused, every password signs in, and the source stays fenced |

A skipped test fails its check: a test that did not run is not evidence. So does a file whose vitest
run did not exit 0 — an unhandled rejection or a crash outside every test — even when its report
lists every test as passed, and a file that wrote no report: a report an earlier run left in the log
directory is removed before the file runs. The summary also names
what the posture asks for that Core has no surface for: support access (Core has no path by which an
operator or vendor account reaches an organization's data). The lane sets every provider credential
empty for the suites, so no run spends.

The log directory holds the whole evidence of a run: each suite file's output and vitest JSON
report, and `summary.json`, which names each report and the exit status of the vitest run that
wrote it, and records what the lane ran on — the commit,
whether the working tree was clean, the runtime version, the platform, the architecture and the Node
version.

### The managed-posture receipt

A release's managed-posture receipt states which public-hosting protections were tested for it
(`managed-receipt.schema.json` in `@rayspec/bundle-contract`). `pnpm receipt:managed`
(`scripts/managed-receipt.mjs`) makes it from one lane directory:

```bash
pnpm build
pnpm test:certification --log-dir certification-logs
pnpm receipt:managed --lane certification-logs \
  --release-manifest rayspec-release-manifest.json \
  --artifact-sha256 <sha256 of the runtime artifact> --out managed-receipt.json
```

It writes the receipt as canonical JSON, validated with `validateReceipt`, and prints its SHA-256 on
stderr; that digest is what the runtime-control adapter is given as `managedReceiptSha256`. It
refuses (exit 1, nothing written), naming the reason, when:

- the lane did not pass, a check of this checkout's lane is missing or ran other suite files, or any
  report — each is read and judged again against the one suite file it is named for, not taken from
  the summary — shows a failed or skipped test, is of another file, or cannot be read;
- one report is named for two suite files, or the summary records a file whose vitest run did not
  exit 0;
- the lane did not run as the runtime role, ran on a working tree with changes, or at another commit
  than the checkout running the generator;
- the lane did not run on linux x64 with Node 22.21 or a later 22 release, the only targets a
  receipt names;
- the release manifest is not canonical JSON its schema admits, or is for another version, commit
  or target than the lane.

Each fixed protection of the receipt is claimed through the checks that establish it:

| Receipt field | Value | Checks |
| --- | --- | --- |
| `maxApplicationTenants`, `singleTenantModeEnforced` | `1`, `true` | `single-tenant-mode` |
| `publicHostingPosture` | `isolated-environment-v1` | every mandatory public-hosting check and recovery case: `runtime-role-evidence`, `object-authorization`, `trusted-proxies`, `cors-and-csrf`, `upload-limits`, `sanitized-errors`, `outbound-guard`, `recovery-scope`, `hostile-archives`, `hostile-migration-bundles`, `crash-recovery`, `resource-bounds`, `export-import-round-trip` |
| `executionLevels` | `none`, `in-process` | `execution-levels` |
| `databaseIsolation` | `dedicated-db-and-rls` | `runtime-role-evidence`, `object-authorization` |
| `databaseRoleSeparation` | `true` | `runtime-role-evidence`, `privileged-credentials` |
| `crossProcessCancellation` | `true` | `cross-process-cancel` |
| `agentTraceExport` | `off` | `agent-trace-export-off` |
| `recoveryScopeEndpoint` | `disabled` | `recovery-scope` |
| `trustedProxiesPinned` | `true` | `trusted-proxies` |
| `egressEnforcement` | `host-network-policy` | `outbound-guard` (the runtime guards only its own requests; the host enforces egress) |

`supportedBackends` lists an agent backend of the [matrix](#supported-backends) that the posture
allows only when every test its row names passed in the lane. `capabilities` is not a tested claim:
as the contract defines it, it lists the capability vocabulary's available ids that the managed
posture allows, and the generator leaves out a provider capability whose row was not proven the same
way. Only the provider capabilities rest on lane evidence; the others are what the posture permits
an application to use, not protections the lane certifies. `evidence` names every report, by its
file name in the lane directory with its SHA-256, under the check it proves, and the summary
itself. `residualRisks` is the list in [Threat model → Accepted residual risks](./threat-model.md#accepted-residual-risks).
The CI `certification` job runs the lane on linux x64 and keeps its log directory as the workflow
artifact `certification-lane`; download it and pass it as `--lane`, from a checkout of the commit the
job ran at. A lane run on a developer machine of another platform is not evidence for a receipt.

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
| `RAYSPEC_AGENT_SYNC_RUNS_MAX` | in-request runs one process holds at once: synchronous `POST /v1/agents/{id}/runs`, conversation reply runs and record normalize runs together | 32 | no bound |
| `RAYSPEC_RUN_CANCEL_POLL_MS` | how soon a cancellation reaches a run in another worker process | 2000 | off |

`RAYSPEC_AGENT_RUN_MAX_MS` bounds the provider call; the end of the run as the caller sees it comes
at most a fixed time later. At expiry the call is told to stop and run-core waits up to the kill
grace plus one second for it to settle. It then drains the run's events and writes the terminal
record, which needs a database connection from the pool and waits at most 2 seconds for the run's
header row; run-core gives that tail 5 seconds. So a run that hits its wall time ends for its caller
no later than

    RAYSPEC_AGENT_RUN_MAX_MS + RAYSPEC_AGENT_KILL_GRACE_MS + 1 s + 5 s

after it started (the managed defaults: 900 s + 5 s + 1 s + 5 s). A record that has not landed by
then is not abandoned: it completes when the pool hands out a connection, and until it does the run
reads as `running`; a record that fails is logged. Under heavy parallel load that wait for a
connection is what the 5 seconds cover, so keep `RAYSPEC_AGENT_SYNC_RUNS_MAX` and
`RAYSPEC_AGENT_WORKER_CONCURRENCY` in proportion to the connections the database pool holds. A
cancelled run ends under the same tail.

A run past a queue or in-request bound is refused with `429 RATE_LIMITED`, a `Retry-After`, and
`error.details` `{ reason: "queue-full", scope, limit }`, before anything is recorded for it. A
conversation reply or record normalize past the in-request bound runs nothing either; it answers
with its capability's own failure (`502` `conversation_reply_failed` or `record_normalize_failed`)
carrying the neutral `rate_limited` class, rather than with `429`. A retry with the same message or record converges as for any failed reply. Under
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
lapses, and an execution whose lease was taken over stops its own run. A dispatch that takes a run
over re-runs it only when the run never reached an outcome (its header still `enqueued` or
`running`) and fired no non-idempotent tool; a run whose header is terminal — `completed`, or `error`
with its recorded end, whatever the phase — is left as it is, its record intact.

## Supported backends

The managed posture runs only the backends below marked `allowed`. A boot under the posture whose
agents, product model calls or speech providers use any other backend is refused before anything is
written, with a message naming the backend, what uses it and why; nothing is swapped silently. The
columns state what this repository's tests prove; `inspectHosting().supportedBackends` reports the
same matrix.

| Backend | Kind | Managed posture | Provider-call bound | Cancellation and the wall-clock bound | Child process | Not covered | Proven by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | agent | allowed | every HTTP request, response body included: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`, at most `RAYSPEC_AGENT_MAX_ATTEMPTS` attempts | the run's signal aborts the HTTP request | none | a tool call already dispatched runs to its own tool timeout | `packages/adapters/openai/src/hanging-provider.test.ts` |
| `anthropic` | agent | self-host-only | silence of the child: no message for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | the SDK query ends; stdin closes at once, SIGTERM after 2 s, SIGKILL 5 s later | killed 7 s after the abort (fixed by the SDK) | the child's own children are not signalled; a host that exits inside the ladder can orphan a child that ignores SIGTERM | `packages/adapters/anthropic/src/cancellation.real-process.test.ts` |
| `codex` | agent | self-host-only | silence of the turn: no event for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | the streamed turn ends; the launcher forwards SIGTERM to the child's process group | the group is killed `RAYSPEC_AGENT_KILL_GRACE_MS` after an ignored SIGTERM, and run() settles even while a grandchild holds the output open | a process the child starts in a session of its own is not signalled; on Windows only the child is; without the bundled binary the escalation is unavailable (logged) | `packages/adapters/codex/src/cancel.integration.test.ts` |
| `pi` | agent | self-host-only | silence of the session: no event for `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | `session.abort()` aborts the HTTP request | none | compaction and branch-summary requests are not reached by the abort; a tool ignores its own abort signal | `packages/adapters/pi/src/hanging-provider.test.ts` |
| `deepgram` | speech-to-text | allowed | every request, body included: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | none: no run signal reaches a transcription | none | a cancelled run does not stop a transcription in flight | `packages/adapters/deepgram/src/hanging-provider.test.ts` |
| `fake` | speech-to-text | test-only | not applicable | not applicable | none | staging and conformance only | — |
| `openai` | text-to-speech | allowed | every request, body included: `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS` | none: no run signal reaches a synthesis | none | a cancelled run does not stop a synthesis in flight | `packages/adapters/openai-tts/src/hanging-provider.test.ts` |
| `fake` | text-to-speech | test-only | not applicable | not applicable | none | staging and conformance only | — |

The [deterministic extraction provider](./spec-reference.md#the-deterministic-extraction-provider)
(`RAYSPEC_EXTRACTION_MODE=deterministic`) is test-only too: no model runs, so it is not a row of
this matrix, and a boot under the posture that would run it is refused, naming its capability
`extraction-deterministic`.

## Credentials and rotation

### Provider credentials

The model and speech provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CODEX_API_KEY`, `DEEPGRAM_API_KEY`) are read in one place, in this order:

1. a value a bundle deploy took from its bindings file;
2. `<NAME>_FILE`, a file the operator names: a regular file (not a link), owned by the user the
   runtime runs as, closed to group and others. A set `_FILE` never falls back to the plain
   variable; a file that is missing, insecure, larger than 64 KiB or empty refuses the boot (or the
   bundle deploy, as `RAY_BINDINGS_FILE_INSECURE` or `RAY_USAGE`), naming the variable and the path
   and nothing read from the file;
3. the plain variable.

A provider credential from a file or a bindings file never enters the process environment. Each
credential is handed only to the component that uses it, and each agent backend has exactly one
source for it:

| Credential | Handed to |
| --- | --- |
| `OPENAI_API_KEY` | the `openai` and `pi` agent backends, and the OpenAI speech adapter (`TTS_PROVIDER=openai`) |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | the `anthropic` backend's `claude` child process |
| `DEEPGRAM_API_KEY` | the Deepgram speech adapter (`STT_PROVIDER=deepgram`) |
| `CODEX_API_KEY` | nothing: the `codex` backend runs on the login in `CODEX_HOME` and strips the key from its child |

The `claude` child is started with this process's environment **minus** the other providers' keys,
every `_FILE` variant, the database URLs (`DATABASE_URL`, `SHADOW_DATABASE_URL`, `DBOS_…`, `PG…`) and
every `RAYSPEC_…` and `CLOUD_…` setting; it gets its own credential and its per-tenant config
directory. Each `openai` backend holds its own HTTP client with its own key; none registers a
process-wide default that another backend could pick up, so two agents (or two tenants behind a
backend factory) configured with different keys never send each other's.

**A refused key fails closed.** When the provider answers `401` or `403`, the run (or the
transcription, or the synthesis) fails with a message that names the credential — "refused the
credential `OPENAI_API_KEY` (HTTP 401): it is invalid, expired, revoked or not permitted" — and
not the provider's own text, which can quote part of the key. It is not retried, and no other
credential is tried in its place. The `anthropic` backend reports what its child reports.

**Application bindings.** On a bundle deploy (`rayspec deploy <file.ray>`) the bindings file may
supply only the names the bundle's manifest declares, plus the speech provider key the operator
selected (`DEEPGRAM_API_KEY` under `STT_PROVIDER=deepgram`, `OPENAI_API_KEY` under
`TTS_PROVIDER=openai`); any other name is refused with `RAY_USAGE`, a reserved one with
`RAY_BINDING_RESERVED`. The application's own declared bindings go where the bindings contract puts
application-defined names, the application process environment, and also reach its handlers as
`init.bindings.get(name)`; asking `init.bindings` for a name the bundle does not declare, or for a
provider credential, throws (`BindingNotGrantedError`). See
[Spec reference → `init.bindings`](./spec-reference.md#initbindings--application-bindings). A
provider credential supplied in the bindings file is handed to its adapter alone and is not written
into the environment, so it does not reach a child process; the application's own values are, and
do. Handler code runs in the runtime process either way (see [What it does not protect
against](#what-it-does-not-protect-against)).

### The JWT signing key

`RAYSPEC_JWT_SIGNING_KEY` signs every access token and the OIDC provider's tokens. To rotate it
without logging anyone out:

1. Generate a new key (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`).
2. Restart with the new key in `RAYSPEC_JWT_SIGNING_KEY` and the old one in
   `RAYSPEC_JWT_SIGNING_KEY_PREVIOUS` (or `RAYSPEC_JWT_SIGNING_KEY_PREVIOUS_FILE`). New tokens are
   signed with the new key; both public keys are published (`GET /v1/oauth/jwks`, `/oidc/jwks`), so a
   token signed before the restart verifies until it expires.
3. After the overlap window, restart without `RAYSPEC_JWT_SIGNING_KEY_PREVIOUS`. The window is the
   access-token lifetime (`RAYSPEC_ACCESS_TOKEN_TTL_SECONDS`, 480 s by default) plus 30 s of clock
   tolerance, or one hour if OIDC clients use the provider's access tokens. A token the old key signed
   is refused from then on.

A previous key that is not a PKCS#8 PEM refuses the boot, naming the variable and nothing of the
value. A previous key equal to the current one changes nothing. Refresh sessions are not signed with
this key and are unaffected.

### The API-key pepper

`RAYSPEC_API_KEY_PEPPER` is the HMAC key of four stored credentials: API keys (machine-client
secrets included), refresh sessions, invite tokens and owner-recovery tokens. Passwords are argon2id with their own salt and
never touch it. The pepper has a versioned form:

**Rotation, with an overlap window.**

1. Restart with a new pepper in `RAYSPEC_API_KEY_PEPPER` and the old one in
   `RAYSPEC_API_KEY_PEPPER_PREVIOUS` (or `_FILE`). Everything new is hashed under the new pepper; a
   credential hashed under the old one still verifies and is renewed when it is used: an API key is
   re-hashed under the new pepper on its first use, a refresh session is replaced by one hashed under
   the new pepper when it refreshes, and an invite stays redeemable until it is redeemed or expires.
2. Keep the window open long enough for the credentials that matter to be used: your automation's
   API keys at least once, your users' refresh sessions (30 days at most).
3. Restart without `RAYSPEC_API_KEY_PEPPER_PREVIOUS`. A credential renewed in the window keeps
   working; one that was not is refused like any unknown credential (`401`; an invite answers that it
   is invalid or expired). Users sign in again with their passwords; mint new API keys for anything
   still refused.

**Reset, for a pepper that leaked.** Restart with a new pepper and **no** previous pepper. Every API
key, refresh session and outstanding invite is refused at once; users sign in again with their
passwords; mint new API keys; reissue invites, and for an owner whose only credential was an API key
(who holds no password), issue a one-time recovery token with
`rayspec tenant recover-owner --email <e>` ([CLI reference](./cli-reference.md#tenant-recover-owner)).
The old rows stay in the database and simply never verify again; revoke them through the API-key
routes to keep the listings tidy.

During a rotation every presented API key is checked under both peppers, found or not, so the work an
unknown key costs stays the same as a known one's. Both behaviours are proven against a running
server in `packages/app/server/src/api-key-pepper-rotation.db.test.ts`.

## Redaction

Everything the runtime writes passes one redaction path (`redactText` and `redactValue` in
`@rayspec/core`), in every posture:

| Sink | What passes it |
| --- | --- |
| Log lines | every write to stdout and stderr of a server boot and of `rayspec deploy <file.ray>`, whoever prints it — the platform, a library, a handler |
| HTTP error envelopes | the `message` and `details` of every error response |
| Runtime-control envelopes | the error and warning messages of `inspect`, `prepare`, `quiesce`, `resume` and `health` |
| Receipts | the `detail` of every apply and fence receipt, before it is written |
| Traces | the error a failed run records in its journal step and on the run, and every agent trace the SDK exports |
| Workflow engine | the error a failed durable run throws (message, stack and fields), before the engine stores it in its system database |

It removes two kinds of thing:

- **Values the process holds**, wherever they occur: every boot secret as it is resolved (the
  database URLs, the JWT signing keys, the peppers, the media signing key), every provider key as it
  is read, and every binding value a bundle deploy supplies, of either kind. A value shorter than 8
  characters is not registered: it occurs in ordinary text.
- **Shapes of a credential**, whoever holds it: a bearer token; the value of an `authorization`,
  `proxy-authorization`, `cookie`, `set-cookie` or `x-api-key` header; the password of a URL; a PEM
  private key; a JSON web token; a RaySpec API key; a provider key of the `sk-…` form.

It is a last line, not a licence to log secrets: a value split across two writes, or encoded before
it is written, is not recognised. A run's journal and events keep tool arguments and outputs as the
run produced them (they are the organization's data, under its row policies, and a replay depends on
them); only their error messages are redacted. A canary of every binding kind is driven through
every sink in `packages/app/server/src/redaction-canaries.test.ts`.

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
  documentation or benchmarking address, including an IPv4 address embedded in IPv6 (mapped,
  translated, NAT64 `64:ff9b::/96`, 6to4), which is judged by the IPv4 address it carries, and any
  IPv6 address outside global unicast (`2000::/3`), the local-use NAT64 prefix `64:ff9b:1::/48`
  among them;
- a host name that resolves to such an address: the check runs on the address the connection
  actually uses, so a name that answers a public address once and a private one later (DNS
  rebinding) is refused too;
- a redirect to any of the above, each hop checked again; a redirect to another origin drops the
  `authorization`, `cookie` and `proxy-authorization` headers.

A guarded request connects directly, never through `HTTP_PROXY`/`HTTPS_PROXY`, because behind a proxy
the guard would see the proxy's address instead of the destination's.

Every guarded request has a time limit: 30 seconds unless the caller sets `timeoutMs`. It covers the
name resolution, every redirect hop and the response body, so a destination that accepts the
connection and never answers, or sends its body a byte at a time, is ended at the limit
(`OutboundRequestTimedOut`) instead of holding the request open.

This release has **no** such outbound path: no grammar field, node or request field makes the
platform fetch a URL. The provider adapters call the endpoints the operator configures
(`OPENAI_BASE_URL` and `DEEPGRAM_BASE_URL` are reserved operator settings a bundle cannot set). A test
holds the list of every outbound call site in the shipped source, so a new one is either routed
through the guard or reviewed.

## Tool rights

A handler states the capabilities it uses in `handlers[].uses`
([Spec reference](./spec-reference.md#handlers)): `blob`, `fsSource`, `stt`, `tts`, `emit`,
`enqueue`, `mintPlayToken`, `bindings`. A declaring handler gets exactly those; one it did not
declare throws `ToolRightNotGrantedError` when the handler reaches for it, rather than arriving or
silently missing. Every refusal comes before the handler runs:

| Asked for | Refused |
| --- | --- |
| a right outside the vocabulary | when the document is parsed (`schema_violation`) |
| a right the handler's kind never receives | by the lint (`capability_violation`) |
| a right this deployment does not grant | by the boot, before anything is written, naming the handler, the right and the missing setting |
| nothing, under `RAYSPEC_HOSTING_POSTURE=managed` | by the boot: every handler lists its rights (an empty list when it uses none) |

An agent's tools are the declared `tooling[]` entries it references: a reference to a tool that is
not declared is refused when the document is parsed, and a tool call the model makes to a name the
agent does not have is answered with a `tool_error` and never runs. The `anthropic` and `pi`
backends offer the model none of their own built-in tools; the `codex` backend keeps its own tools
inside a read-only sandbox with no network (one reason it is self-host-only). Every tool of the
spec is dispatched through the platform. This scopes what the platform hands a handler; it is not a sandbox
(see [What it does not protect against](#what-it-does-not-protect-against)).

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

The [Threat model](./threat-model.md) lists every residual risk this release accepts, with its
owner, and what the host must enforce.

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

With role separation the deploy runs as a supervisor and a child process; under the managed posture
on Linux the host must keep the supervisor private from that child, as [Turning it on](#turning-it-on)
lists, or the boot is refused.
