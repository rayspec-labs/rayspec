# Architecture

RaySpec turns one declarative spec into a running, tenant-isolated AI backend.
This document explains how it is put together: the layered spine, the package
taxonomy, how a request and a durable job flow through it, the three structural
guarantees the design rests on, the security model, persistence, and how you
extend it.

For the vocabulary (specs, agents, stores, routes, the run journal, tenancy) read
[concepts](./concepts.md) first; this document assumes it.

---

## The layered spine

RaySpec is a stack of layers, each depending only on the ones below it:

```
┌──────────────────────────────────────────────────────────────────┐
│  App        CLI (rayspec) · boot bin (rayspec-serve)           │
├──────────────────────────────────────────────────────────────────┤
│  Declarative engine   validate → diff → gate → deploy a spec     │
│                       (compose the running backend from YAML)    │
├──────────────────────────────────────────────────────────────────┤
│  HTTP API   Hono + zod-openapi · routes mounted on the auth chain│
├──────────────────────────────────────────────────────────────────┤
│  Agent core   neutral Backend interface + 4 adapters (in-process)│
├──────────────────────────────────────────────────────────────────┤
│  Accounts & auth   orgs · memberships · users · API keys · OIDC  │
├──────────────────────────────────────────────────────────────────┤
│  Data & journal   Postgres/Drizzle · tenant chokepoint · run log │
├──────────────────────────────────────────────────────────────────┤
│  Durable execution   off-request worker · schedules · replay     │
└──────────────────────────────────────────────────────────────────┘
```

The bottom layers (accounts, data, the tenant chokepoint, the run journal) are the
platform's always-on foundation. The declarative engine sits on top and is what
reads your spec and wires the product-specific routes, stores, and agents onto
that foundation. The platform itself contains **no product**: everything
product-specific arrives as the spec you inject at boot.

---

## Package taxonomy

The monorepo is organized into tiers under `packages/`. Each tier depends only
downward.

| Tier            | Packages                                                                    | Role |
| --------------- | --------------------------------------------------------------------------- | ---- |
| **kernel**      | `core`, `spec`, `db`, `auth-core`, `platform`, `handler-sdk`, `stt-port`     | The neutral types, the spec grammar + parser, the tenant-scoped data layer, the auth primitives, the platform assembly, the handler authoring SDK, and the neutral speech-to-text port (the `SttAdapter` contract, registry, media-resolution seam, and fake adapter). |
| **adapters**    | `adapter-openai`, `adapter-anthropic`, `adapter-pi`, `adapter-codex`, `adapter-deepgram` | One anti-corruption adapter per agent backend, plus the Deepgram speech-to-text provider adapter behind the neutral `stt-port`. Each wraps a hard-pinned vendor SDK behind a neutral interface. |
| **capabilities**| `audio-runtime`, `conversation-runtime`, `file-runtime`, `record-runtime`, `capability-bridges` | The reusable ingress runtimes (audio/transcription, chat, files, records) and the bridge that wires them into workflows. |
| **workflow**    | `foundation`, `workflow-durable`, `durable-dbos`, `nodes/*` (`agent-runtime`, `grounding-runtime`, `views-runtime`) | The workflow composition primitives, the durable-execution engine, and the step-node runtimes. |
| **compose**     | `api-auth`, `product-yaml`, `product-yaml-workflow-bridge`                   | The composition layer: the Hono HTTP server + auth, the deploy composition that turns a spec into a running backend, and the workflow bridge for the product profile. |
| **app**         | `cli` (bin `rayspec`), `server` (bin `rayspec-serve`)                      | The two entry points: the diagnostic/dev CLI and the boot server. |
| **test**        | `parity`                                                                    | The cross-backend parity suite that holds every adapter to the same neutral contract. |

The neutral `core` types are the fixed point of the whole system: they sit at the
bottom, and the adapters above them absorb every difference between vendor SDKs so
those types never have to change when an SDK does.

---

## Data flow

### An HTTP request

1. A request arrives at the Hono app. Shared middleware applies security headers
   and authenticates the caller — a Bearer JWT, an API key (same header), or a
   session — and resolves the active organization (the tenant).
2. The router matches a declared route and its action.
3. For a **store** action, the data layer runs the CRUD operation through the
   tenant-scoped database handle — the query is filtered by tenant before it ever
   reaches Postgres.
4. For an **agent** action, the run surface invokes the declared agent through the
   neutral backend. The agent's tool calls dispatch through a single boundary; the
   response streams back (or returns JSON), and every step is recorded in the run
   journal.
5. For a **handler** or **stream** action, control passes to the declared
   escape-hatch module through the same chokepoints, then the response is returned.

The tenant filter, the tool boundary, and the journal write are not per-route
choices — they are structural, so no route can opt out of them.

### A durable job

1. A caller requests an agent run asynchronously, or a schedule fires a trigger.
2. The request returns immediately with a run id; the work is enqueued onto the
   durable worker.
3. The worker executes the run off-request. The run's start is recorded in the
   journal under a run-scoped idempotency key (the run id), and its steps, usage,
   and cost are written as it proceeds.
4. If the process restarts mid-run, the durable engine re-executes the run from the
   start rather than losing it — there is no intra-run checkpoint resume. A run that
   already completed is short-circuited from the journal; an in-flight run is
   guarded by a run-level single-flight keyed by the run id, so a recovery
   re-execution does not re-fire a non-idempotent side effect, and a run whose
   replay safety cannot be guaranteed is quarantined rather than blindly retried.
5. On completion the outputs are persisted and the run is marked terminal; usage
   and cost are already in the journal.

---

## The three structural guarantees

Three boundaries carry the weight of the whole design. Each is enforced by
construction — you cannot write ordinary code that bypasses it.

### 1. The neutral backend boundary

All four agent backends implement one neutral `Backend` interface, and everything
above the adapters speaks only that interface. Each adapter is an anti-corruption
layer: it translates the neutral request into its vendor SDK's shape and the
vendor's response back into neutral types, absorbing asymmetries (streaming
semantics, structured-output support, tool-call formats) internally. The rule is
that the neutral types do **not** move when a vendor SDK churns — the churn is
absorbed in the adapter. The parity suite holds every adapter to the identical
neutral contract, so "write the agent once, run it on any backend" is a tested
property, not an aspiration.

### 2. The fail-closed tenant chokepoint

Every query against tenant-owned data goes through a single tenant-scoped database
handle that injects the tenant predicate. The set of tenant-scoped tables is
**deny-by-default**: a table is reachable through the scoped handle only if it is
registered as committed source, and the deploy step *verifies* this rather than
registering it — a spec that declares a store which isn't registered refuses to
deploy. The only tables exempt from the predicate are the genuinely global ones
(identity, organizations, API keys, the audit log, and the auth provider's own
storage), and each exemption is explicit and reviewed. The practical consequence:
there is no ergonomic path to a cross-tenant read, because the unscoped handle is
not the one application code is given.

### 3. The tool-dispatch trust boundary

Agent tool calls run through one dispatch boundary, and everything that crosses it
from the outside — tool outputs, transcribed or uploaded content, and rehydrated
conversation history — is treated as **data, never as instructions**. This is the
defense against prompt-injection-style attacks: untrusted content can inform a
model's answer but cannot be allowed to redirect the agent's behavior or its tool
use. The boundary is also where each tool's declared idempotency is honored on
replay.

---

## Security model

RaySpec's core is built for a **trusted, self-hosted, single-node** posture. It
enforces a set of guarantees from the first boot, and it is explicit about a
further hardening layer that it does **not** include.

### Built in, from day one

- **Tenant isolation by construction** — the fail-closed chokepoint above, with a
  continuous-integration test that fails the build if any tenant-owned table can
  be read without the predicate.
- **No plaintext secrets** — signing keys, peppers, and provider credentials live
  in the environment or a secret manager, never in the database or in git. The
  server refuses to boot if a required secret is missing (fail-closed).
- **An untrusted-content trust boundary** — the tool-dispatch boundary above.
- **An out-of-band audit trail** — the append-only, tenant-scoped run journal
  records what ran, for whom, and under what authority, independently of the
  request path.
- **Per-backend credential isolation** — each agent backend uses its own
  operator-supplied credentials; the platform never proxies one party's
  credentials on behalf of another.

### The separate hardening layer (not in the core)

Running RaySpec for **untrusted, multi-tenant, public-internet** traffic requires
protections that are deliberately out of scope for the core and belong to a
distinct hardening layer:

- per-tenant data encryption with wrapped data-encryption keys,
- database row-level security as a second, in-database enforcement of tenancy,
- per-tenant execution sandboxing, and
- cryptographic binding of tokens to their client.

The core does not ship these, and it says so loudly at boot. **Do not place a core
deployment on a public address** for untrusted traffic without that layer. The
distinction is intentional: the core gives a self-hoster a correct, tenant-isolated
backend for trusted use, and the hardening layer is what a public multi-tenant
service additionally needs.

### Restore and key rotation

The boot secrets live in the environment, never in the database — which has a sharp
operational consequence when you **restore a database dump under different secrets**.
The data survives the restore at the row level, but it stays bound to the secrets that
created it:

- **The API-key pepper (`RAYSPEC_API_KEY_PEPPER`).** Every API-key row stores an HMAC
  of the key computed with the pepper. Restore the dump under a **freshly-minted**
  pepper and those stored HMACs no longer match, so the copied keys all fail to verify
  (`401`) — even though the rows are physically present. Worse, the restored data is
  tenant-locked to org identities you can no longer authenticate as, so the rows are
  intact on disk yet **unreachable through the API**. The fix is not to recover the old
  keys but to **mint new API keys** (and, as needed, re-establish the org identities)
  after a restore.
- **The JWT/OIDC signing key (`RAYSPEC_JWT_SIGNING_KEY`).** The same class of problem:
  tokens issued under the old key fail to verify under a new one. This one **self-heals**
  — a user simply signs in again and gets a fresh token minted under the current key.
  The pepper case does **not** self-heal, because an API key cannot "log in again."

The practical rule: **keep a restored dump paired with the secrets it was created under**
(back up the environment/secret material alongside the database), or plan to re-mint
credentials after a cross-environment restore. This is stated for the **trusted,
single-node** posture; it is not a claim that restoring a database into a public,
multi-tenant deployment is safe — that requires the separate hardening layer above (see
[`SECURITY.md`](../SECURITY.md)).

---

## Persistence and the run journal

RaySpec's request-handling core is stateless; all durable state lives in Postgres
via Drizzle. Each agent run follows a hydrate → run → persist cycle, and every step
is recorded in the **run journal** — the append-only, tenant-scoped log that is the
single source of truth for replay, cost accounting, and audit. Store schemas are
generated from the spec with the tenancy and data-lifecycle columns injected
automatically, and every migration is diffed against the current schema and passed
through a safety gate (a destructive change is blocked unless explicitly allowed)
before it is applied — including a from-clean-database check that the whole
migration chain bootstraps an empty database correctly.

A booted deploy applies this generated schema in one direction only: it materializes a
store on a clean database and mounts it when the live schema already matches. It is
**mount-only** against an existing deployment — a live schema that has **drifted** from
the spec **fails the boot closed** rather than being altered implicitly. Evolving an
existing deployment's schema is a deliberate, reviewed step: author the forward delta
and apply it with `rayspec deploy --apply-migration <delta.sql>` (which runs it through
the same safety gate). See the
[CLI reference](./cli-reference.md#deploy--boot-and-serve-a-declared-product).

---

## The extension model

RaySpec is designed to be extended in a deliberate order, from least to most
power:

1. **Configuration first.** The declarative spec is the primary surface. Most
   backends are fully expressed in stores, routes, agents, tools, and triggers —
   no code.
2. **Escape-hatch handlers next.** When logic genuinely doesn't fit the
   declarative surface, a `handler` points a route, tool, or trigger at a named
   export in a TypeScript module. Handlers load from a path-jailed root and
   dispatch through the same chokepoints declarative actions use — so custom code
   still can't escape tenancy or the trust boundary. Extension packs bundle
   handlers, stores, and tooling as a versioned, exactly-pinned unit.
3. **The core last.** Changing the platform itself is the last resort, reserved
   for genuinely new platform capabilities — not for product logic, which belongs
   in the spec or a handler.

This ordering keeps product concerns out of the platform and the platform reusable
across every product built on it.

---

## See also

- **[Concepts](./concepts.md)** — the definitions this document builds on.
- **[Getting started](./getting-started.md)** — run the stack and make a request.
