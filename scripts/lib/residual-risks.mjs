/**
 * residual-risks.mjs — the residual risks a managed-posture receipt carries, each in plain words with
 * who owns it.
 *
 * PURE DATA, one list for two readers: `scripts/managed-receipt.mjs` copies it into the receipt's
 * `residualRisks`, and docs/threat-model.md ("Accepted residual risks") states every entry word for
 * word; `scripts/managed-receipt.test.mjs` holds the two equal. A risk is added or removed here and in
 * the document together.
 *
 * `CORE` owns what the runtime would have to change to remove the risk; `HOST` owns what only the
 * environment around the runtime can contain (the VM or container, the network, the disks, the
 * backups, the reverse proxy).
 */

export const CORE = 'RaySpec Core';
export const HOST = 'Hosting operator';

export const RESIDUAL_RISKS = [
  {
    owner: HOST,
    risk: "The runtime is not a sandbox. Handlers and extensions run inside the serving process: they can read its environment and files, open their own database connection as the runtime role and claim any tenant id in it, and read every credential that process holds — its JWT signing key, its API-key pepper, its runtime-role connection and the application's bindings. They do not hold the migration or snapshot connection: with role separation only the supervisor does, and it runs no application code. Only a boundary outside the process contains code that is not trusted: a dedicated VM or container, its own databases, and host egress rules.",
  },
  {
    owner: HOST,
    risk: "With role separation the migration and snapshot connections are held only by the supervisor — the process the operator starts (rayspec deploy, rayspec-serve), which re-executes itself to clear them from its environment block, never imports application code, and serves the application in a child process started without them. When the supervisor and that child run as the same operating-system user, three paths the runtime cannot close by itself remain open: a _FILE mount or a .env file the supervisor can read is readable by the child; the child can read the supervisor's memory on a kernel without Yama ptrace_scope of 1 or more; and a core file the supervisor can be made to write and then read. The managed posture refuses to boot while any of these is open and names it; every other posture warns. Close them by giving the supervisor inline connections on a host with ptrace_scope of 1 or more and a zero hard core-file limit, or by running the child as a different user.",
  },
  {
    owner: HOST,
    risk: "A deploy's boot rehearsal imports the bundle's handler modules before the platform's boot checks run, as every boot always has, so a bundle's top-level code runs on the host before a refusal can stop it.",
  },
  {
    owner: HOST,
    risk: 'A compromised dependency runs with the privileges of the runtime process. The pinned versions and the dependency SBOM record what ships; nothing inside the process contains it.',
  },
  {
    owner: HOST,
    risk: 'The runtime enforces no egress. An application declares the hosts it calls and the plan reports them; the host network policy must admit only those and deny the rest, including loopback, private, link-local and metadata addresses. The platform guards only the outbound requests it makes itself.',
  },
  {
    owner: HOST,
    risk: 'The runtime encrypts no data at rest. The databases, the blob volume, the deployment state directory and every backup and snapshot file are protected only by the encryption of the disks and the storage that hold them, with keys of their own per environment.',
  },
  {
    owner: HOST,
    risk: 'A stream ingest route hands the raw request body to its handler with no size cap of its own; the 1 MiB cap applies to JSON bodies. A handler that reads a whole body into memory can be made to hold a large one. Cap request bodies at the reverse proxy.',
  },
  {
    owner: CORE,
    risk: 'A member who is removed from the organization keeps read access (store reads, run reads, the event stream, organization and API-key listings) until their access token expires: RAYSPEC_ACCESS_TOKEN_TTL_SECONDS, 480 seconds by default. Every write, run start and administrative action rereads the membership at once.',
  },
  {
    owner: CORE,
    risk: 'Bearer credentials (access tokens, API keys, media tokens) are not bound to a client: whoever holds one can use it until it expires or is revoked.',
  },
  {
    owner: CORE,
    risk: "The workflow system database is outside row-level security: the runtime role reads every workflow's inputs and outputs there. It belongs to one environment, which holds one organization in single-tenant mode.",
  },
  {
    owner: CORE,
    risk: 'Workflow runs that a product document starts (a finalized session, a submitted file or record, a reprocess) run as the platform for the organization and are not checked again against the member whose action started them. A durable agent run enqueued before this release records no requester and is not checked again when it starts.',
  },
  {
    owner: CORE,
    risk: "A run that reaches its wall-time bound answers its caller within RAYSPEC_AGENT_RUN_MAX_MS plus the kill grace plus 6 seconds. When the database pool has no free connection by then, the run's terminal record is written later, and until it lands the run reads as running.",
  },
  {
    owner: CORE,
    risk: 'A tool call an agent has already dispatched runs to its own tool timeout after the run is cancelled or reaches its wall-time bound.',
  },
  {
    owner: CORE,
    risk: 'Cancelling a run does not stop a speech-to-text transcription or a text-to-speech synthesis already in flight; the provider call ends at its request timeout.',
  },
  {
    owner: CORE,
    risk: 'The anthropic, codex and pi agent backends are bounded but not certified for public hosting, so the managed posture refuses a boot that would use them: they run a local process or an in-process agent loop that needs a sandbox this runtime does not provide.',
  },
  {
    owner: HOST,
    risk: "The import's cutover token is shown once, on the import's standard error, and for 15 minutes it releases the target's fence. Keep that output as private as a credential.",
  },
  {
    owner: HOST,
    risk: "Restoring a paired backup of the application and workflow databases is an operator procedure, not a command. Backup storage, scheduling, retention, restore drills and incident response are the host's.",
  },
  {
    owner: CORE,
    risk: 'Export refuses an application whose extension provides its own blob backend; only the platform file store is carried in a snapshot.',
  },
  {
    owner: CORE,
    risk: "A lint refusal of a reviewed product schema change comes after the boot's first database write, because it depends on the live schema; every other configuration refusal comes before anything is written.",
  },
  {
    owner: CORE,
    risk: "The durable executor's bounded shutdown and the schedule loop reach into the workflow engine's internals; an upgrade of the engine must check both again.",
  },
  {
    owner: HOST,
    risk: "The runtime has no support-access path: no operator or vendor account reaches an organization's data through it. A host that adds one must cap and audit it.",
  },
  {
    owner: CORE,
    risk: 'One environment holds one application tenant. Separate keys per application tenant inside one runtime are not claimed; encryption per environment is the tenant boundary.',
  },
];
