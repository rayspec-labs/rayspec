# Threat model

This page is for the operator who hosts RaySpec runtimes for applications and users they do not fully
trust. It states where the boundaries are, whom the runtime defends against, what the runtime itself
enforces, what only the host around it can enforce, which backends the managed posture runs, and
every residual risk this release accepts. It describes the
[hardened posture](./hardened-posture.md) with `RAYSPEC_HOSTING_POSTURE=managed` fully on; without
it the runtime keeps its earlier, more open defaults.

Nothing here is a compliance certification. The [managed-posture receipt](#the-managed-posture-receipt)
of a release names exactly which protections were tested for that release, and nothing more.

## Boundaries

| Boundary | What it separates | Who holds it |
| --- | --- | --- |
| The environment | One application with its own VM or container, application database, workflow system database, blob volume, credentials and deployment state directory. Nothing is shared between environments. | the host: one environment per application, its own databases, its own keys |
| The application tenant | The one organization inside the runtime. Single-tenant mode (`RAYSPEC_SINGLE_TENANT=true`) refuses a second one on every path, export refuses a source with more than one and import a snapshot with more than one. An organization in the runtime is not an account, project or customer of the host, and the runtime never maps one to the other. | the runtime |
| The serving process | The platform, the application's handlers and its extensions run in one process and trust each other. The process is the unit the host contains. | the host |
| The database roles | A migration role changes the schema; the serving process connects as a runtime role that is no superuser, has no `BYPASSRLS`, owns nothing and is held to a forced row policy on every tenant table. See [Database roles and row-level security](./database-isolation.md). | the runtime, with roles the host creates |
| The request edge | Requests reach the runtime through the host's reverse proxy; forwarding headers are believed only from the addresses in `RAYSPEC_TRUSTED_PROXIES`, and only the allowed browser origins pass CORS. | the host's proxy, with the runtime's pinning |
| The network edge | Outbound connections from the process. The application declares the hosts it calls; the host's network policy admits them and nothing else. | the host |

The hypervisor, the cloud provider under it and the few people who administer the host
infrastructure are trusted. A dedicated VM limits what one application can do to another; it does
not make an environment immune to a compromise of the provider or to every side channel.

## Adversaries

| Adversary | What the runtime does |
| --- | --- |
| An anonymous client on the internet | Every store, run, upload, stream and event route needs a credential; `GET /recovery-scope` is not served under the managed posture; every error answer is a sanitized envelope; JSON request bodies are capped at 1 MiB and file uploads at their per-file limit (a stream ingest route's body is capped only by the reverse proxy: see the host's request edge); registration only creates the first organization, and after it accounts are made by invite. |
| A signed-in user, or a stolen ordinary credential | Authentication is not authorization: every object, upload part, stream, event subscription and queued run is checked against the caller's organization, and every write, run start and administrative action rereads the live membership. A stolen credential works until it expires or is revoked (see the residual risks). |
| A customer who uploads an executable bundle | The bundle reader refuses a hostile archive before anything is extracted or run; a bundle declares its execution level (`none` or `in-process`; `sandboxed` is refused), its bindings, its egress hosts and its capabilities, and the plan reports each before anything is applied. Once deployed, its code runs **inside** the runtime process with the process's rights, which include the migration role's connection: only the host contains it. |
| One compromised application | Holds whatever its environment holds and nothing else, as long as the host keeps environments apart: its own VM or container, databases, credentials, volume and egress rules. |
| A malicious file or model output | File uploads are bounded, a stream ingest body only by the reverse proxy, and every upload is kept in the organization's blob space; a model output reaches tools only through the agent's declared tool list; outbound requests the platform makes itself pass the outbound guard. |
| A hostile migration bundle or dump | `rayspec import` refuses a wrong identity, a broken ciphertext, a traversal entry, an invalid snapshot document, mismatched digests and a privileged dump before anything reaches the target. |
| A compromised dependency | Nothing inside the process contains it; the pinned versions and the dependency SBOM record what ships. |
| An operator mistake | Configuration refusals come before the first database write; a typo in a posture switch refuses the boot instead of leaving it off; a plan expires and is recomputed; an interrupted operation is recorded and recovered as [Runtime operations](./runtime-operations.md) describes. |

## What the runtime enforces

Each row names the check of the [certification lane](./hardened-posture.md#certifying-the-posture)
that proves it on a real database, as the ordinary runtime role.

| Protection | Check |
| --- | --- |
| The serving process's requests, jobs and streams run as the runtime role, and every tenant table has a forced row policy; the migration role's pool is closed once the boot's schema work is done. This binds the platform's own queries, not the application's code: the process keeps the migration role's connection in its environment (see the residual risks) | `runtime-role-evidence` |
| Object authorization on every store route, upload part, playback stream, event stream and queued run, for a member and a removed member | `object-authorization` |
| One organization per environment, on every path, in export and in import | `single-tenant-mode` |
| Forwarding headers believed only from the pinned proxies | `trusted-proxies` |
| CORS origins and CSRF where a cookie authenticates | `cors-and-csrf` |
| JSON bodies capped at 1 MiB and file uploads at their per-file limit; an upload cannot leave its organization's blob space. A stream ingest route's body has no cap of its own: the reverse proxy caps it | `upload-limits` |
| Sanitized error envelopes and one redaction path for every output | `sanitized-errors` |
| Outbound requests the platform makes refuse loopback, private, link-local and metadata addresses, after resolution and on every redirect, within a time limit | `outbound-guard` |
| `GET /recovery-scope` is not served | `recovery-scope` |
| No agent trace leaves the process unless the operator asks | `agent-trace-export-off` |
| Execution levels `none` and `in-process` only; a sandbox request is refused | `execution-levels` |
| Only the backends of the matrix below; each bounded and stopped as stated | `supported-backends` |
| A hostile application archive or migration bundle is refused before anything runs | `hostile-archives`, `hostile-migration-bundles` |
| A cancellation reaches a run in another worker process | `cross-process-cancel` |
| Runs, queues, sessions and memory stay within their bounds under load, with a provider that never answers | `resource-bounds` |
| A process killed during an apply, export or import leaves a state the next run recovers | `crash-recovery` |
| Export and import carry every row and file, and reset every credential the old secrets keyed | `export-import-round-trip` |

## What the host must enforce

The runtime cannot do these from inside its own process. A host that skips one has a gap no setting
of the runtime closes.

- **A process sandbox.** Run each environment in its own VM, or a container with no root user, no
  Docker socket and no host mounts. Code that needs a shell or arbitrary tools needs a separate
  sandbox; the managed posture refuses the backends that would need one.
- **An egress firewall.** Program the network policy from the hosts the application declares
  (`permissions.egressHosts` in the bundle, reported in every plan), and deny everything else:
  loopback, private ranges, link-local and metadata addresses, other environments' databases, and
  the control channels the application does not use. The runtime enforces none of it
  ([Egress](./hardened-posture.md#egress)).
- **Encrypted volumes.** Encrypt the application and workflow database files, the blob volume, the
  deployment state directory, and every backup and snapshot file, with keys of their own per
  environment, protected by a key the environment cannot read.
- **Backups.** Back up the application database and the workflow system database together, so they
  restore as a pair, and keep the blob volume with them; schedule them, store them away from the
  environment, keep them as long as your retention requires, and rehearse the restore.
  `rayspec export` and `rayspec import` move a whole deployment
  ([Export](./export.md), [Import](./import.md)); they are not a backup schedule.
- **The request edge.** Terminate TLS at a reverse proxy, pin its addresses in
  `RAYSPEC_TRUSTED_PROXIES`, keep the application port unreachable except through it, and cap
  request bodies there: the runtime caps JSON bodies and file uploads, but a stream ingest route's
  body reaches its handler uncapped.
- **Secrets.** Keep boot secrets and bindings files encrypted at rest and readable only by the user
  the runtime runs as; rotate them as [Credentials and rotation](./hardened-posture.md#credentials-and-rotation)
  describes. The serving process holds the migration role's connection, so the application's code
  can read it: deploy only code you trust with it, and before exporting an application whose code
  you do not trust, stop every runtime process of the source and keep it stopped until the target
  has taken over ([Export](./export.md#the-database-write-barrier)).
- **Management access.** Multi-factor authentication for whoever can deploy, export or read an
  environment's secrets; short-lived credentials for automation; audit every support access you add.
- **Quotas.** VM, network and provider budgets per environment. The runtime bounds each run, queue
  and pool; it does not know what an account may spend.
- **Telemetry.** Keep `RAYSPEC_AGENT_TRACING` unset or `off` and check the boot banner's
  `Trace export:` line.

## Supported backends

Under the managed posture the runtime boots only the backends marked `allowed`; a boot that would
use any other is refused, naming it. What each one's bounds and gaps are, and which test proves
them, is the full matrix in
[Hosting in the hardened posture → Supported backends](./hardened-posture.md#supported-backends).

| Backend | Kind | Managed posture |
| --- | --- | --- |
| `openai` | agent | allowed |
| `anthropic` | agent | self-host-only |
| `codex` | agent | self-host-only |
| `pi` | agent | self-host-only |
| `deepgram` | speech-to-text | allowed |
| `fake` | speech-to-text | test-only |
| `openai` | text-to-speech | allowed |
| `fake` | text-to-speech | test-only |

A receipt lists an allowed backend, and its capability, only when every test its matrix row names
passed in the certification lane.

## Accepted residual risks

Each risk below is accepted for this release and carried in the managed-posture receipt word for
word, with its owner: **RaySpec Core** where the runtime would have to change to remove it,
**Hosting operator** where only the environment around the runtime can contain it.

- **Hosting operator**: The runtime is not a sandbox. Handlers and extensions run inside the
  runtime process: they can read its environment and files, open their own database connection as
  the runtime role and claim any tenant id in it, and read every credential the process holds, the
  migration role's included. Only a boundary outside the process contains code that is not trusted:
  a dedicated VM or container, its own databases, and host egress rules.
- **RaySpec Core**: With role separation the serving process is given the migration role's
  connection (`RAYSPEC_MIGRATION_DATABASE_URL`, which a role-separated deploy requires, or its
  `_FILE` mount) and, when one is configured, the snapshot role's, and keeps them after the boot's
  schema work. The application's code in that process can read them; with the migration role it
  bypasses row-level security, writes while an export has fenced the source, gives the runtime role
  its writes back and opens the fence. Row-level security and the export's database barrier hold
  against requests and the platform's own queries, not against the application's own code: stop the
  source before exporting an application whose code is not trusted.
- **Hosting operator**: A deploy's boot rehearsal imports the bundle's handler modules before the
  platform's boot checks run, as every boot always has, so a bundle's top-level code runs on the host
  before a refusal can stop it.
- **Hosting operator**: A compromised dependency runs with the privileges of the runtime process.
  The pinned versions and the dependency SBOM record what ships; nothing inside the process contains
  it.
- **Hosting operator**: The runtime enforces no egress. An application declares the hosts it calls
  and the plan reports them; the host network policy must admit only those and deny the rest,
  including loopback, private, link-local and metadata addresses. The platform guards only the
  outbound requests it makes itself.
- **Hosting operator**: The runtime encrypts no data at rest. The databases, the blob volume, the
  deployment state directory and every backup and snapshot file are protected only by the encryption
  of the disks and the storage that hold them, with keys of their own per environment.
- **Hosting operator**: A stream ingest route hands the raw request body to its handler with no size
  cap of its own; the 1 MiB cap applies to JSON bodies. A handler that reads a whole body into memory
  can be made to hold a large one. Cap request bodies at the reverse proxy.
- **RaySpec Core**: A member who is removed from the organization keeps read access (store reads,
  run reads, the event stream, organization and API-key listings) until their access token expires:
  `RAYSPEC_ACCESS_TOKEN_TTL_SECONDS`, 480 seconds by default. Every write, run start and
  administrative action rereads the membership at once.
- **RaySpec Core**: Bearer credentials (access tokens, API keys, media tokens) are not bound to a
  client: whoever holds one can use it until it expires or is revoked.
- **RaySpec Core**: The workflow system database is outside row-level security: the runtime role
  reads every workflow's inputs and outputs there. It belongs to one environment, which holds one
  organization in single-tenant mode.
- **RaySpec Core**: Workflow runs that a product document starts (a finalized session, a submitted
  file or record, a reprocess) run as the platform for the organization and are not checked again
  against the member whose action started them. A durable agent run enqueued before this release
  records no requester and is not checked again when it starts.
- **RaySpec Core**: A run that reaches its wall-time bound answers its caller within
  `RAYSPEC_AGENT_RUN_MAX_MS` plus the kill grace plus 6 seconds. When the database pool has no free
  connection by then, the run's terminal record is written later, and until it lands the run reads
  as running.
- **RaySpec Core**: A tool call an agent has already dispatched runs to its own tool timeout after
  the run is cancelled or reaches its wall-time bound.
- **RaySpec Core**: Cancelling a run does not stop a speech-to-text transcription or a
  text-to-speech synthesis already in flight; the provider call ends at its request timeout.
- **RaySpec Core**: The anthropic, codex and pi agent backends are bounded but not certified for
  public hosting, so the managed posture refuses a boot that would use them: they run a local process
  or an in-process agent loop that needs a sandbox this runtime does not provide.
- **Hosting operator**: The import's cutover token is shown once, on the import's standard error,
  and for 15 minutes it releases the target's fence. Keep that output as private as a credential.
- **Hosting operator**: Restoring a paired backup of the application and workflow databases is an
  operator procedure, not a command. Backup storage, scheduling, retention, restore drills and
  incident response are the host's.
- **RaySpec Core**: Export refuses an application whose extension provides its own blob backend;
  only the platform file store is carried in a snapshot.
- **RaySpec Core**: A lint refusal of a reviewed product schema change comes after the boot's first
  database write, because it depends on the live schema; every other configuration refusal comes
  before anything is written.
- **RaySpec Core**: The durable executor's bounded shutdown and the schedule loop reach into the
  workflow engine's internals; an upgrade of the engine must check both again.
- **Hosting operator**: The runtime has no support-access path: no operator or vendor account
  reaches an organization's data through it. A host that adds one must cap and audit it.
- **RaySpec Core**: One environment holds one application tenant. Separate keys per application
  tenant inside one runtime are not claimed; encryption per environment is the tenant boundary.

## The managed-posture receipt

A release's receipt (`managed-receipt.schema.json` in `@rayspec/bundle-contract`) states, for one
runtime version, source commit, release manifest and artifact, which public-hosting protections were
tested, on which target, with the evidence and the residual risks above. `inspect()` reports the
managed posture as supported only when the runtime is given that receipt's SHA-256 and the posture
is fully on ([Checking it](./hardened-posture.md#checking-it)).

Its `capabilities` field is the vocabulary's list of what the managed posture allows an application
to use; apart from the provider capabilities, whose backends the lane tests, it is not a tested
claim.

`pnpm receipt:managed` makes it from one run of the certification lane, and refuses when any check
did not pass, a test was skipped, a suite file's run did not exit 0, the lane did not run on linux x64 with Node 22.21 or later, its
working tree was not clean, or the release manifest is for another version, commit or target. How to
run it, and which check each claim rests on, is in
[Hosting in the hardened posture → The managed-posture receipt](./hardened-posture.md#the-managed-posture-receipt).
