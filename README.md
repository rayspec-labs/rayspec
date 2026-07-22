# RaySpec

**File-deployable AI infrastructure.** Describe a product's backend in one
declarative YAML file, and RaySpec stands up accounts and authentication,
in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that
single file.

RaySpec is a TypeScript/Node monorepo (pnpm + Turborepo). It is source-available
under [FSL-1.1-ALv2](./LICENSE).

---

## The problem it solves

Standing up the backend for an AI product means re-building the same scaffolding
every time: tenant-isolated accounts and auth, a place to store data, an HTTP
surface, a way to call a model provider, background jobs, an audit trail, and the
glue that holds them together. That scaffolding is where the bugs, the security
holes, and the weeks go — not in the product.

RaySpec moves that scaffolding into the platform and lets you declare the
product. You write one spec:

```yaml
version: '1.0'
metadata:
  name: acme-notes
stores:
  - name: notes
    columns:
      - { name: title, type: text }
      - { name: body, type: text }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: GET,  path: '/notes',  action: { kind: store, store: notes, op: list } }
```

...and the platform materializes the tenant-scoped tables, mounts the routes on
the authenticated HTTP surface, and serves them. Nothing product-specific lives
in the platform — everything comes from the spec you inject.

---

## What you get

- **A declarative backend.** One `version: '1.0'` spec declares your stores, HTTP
  routes, agents, tools, triggers, and escape-hatch handlers. The platform reads
  it and builds the running backend — no bespoke wiring code. (A spec that declares
  only a static frontend even boots as a database-less, auth-less static profile.)
- **Owned accounts, auth, and tenancy.** Organizations, memberships, users, API
  keys, JWT/OIDC — all first-class and yours. Every data query carries a tenant
  predicate, enforced structurally so a query can't accidentally cross tenants.
- **Four swappable agent backends.** OpenAI Agents, Anthropic's Claude Agent SDK,
  Pi, and OpenAI Codex all run in-process behind **one neutral interface**. Write
  an agent once; pick or switch the backend from the spec. The neutral types stay
  put when an SDK churns.
- **Durable background work.** Long-running agent runs and scheduled jobs execute
  off-request on a durable worker, with a per-step run journal that is the single
  source of truth for replay, cost accounting, and audit.
- **A real database, generated for you.** Stores become tenant-scoped
  Postgres/Drizzle tables with the tenancy and data-lifecycle columns injected
  automatically. A boot materializes stores on a clean database and mounts them when
  they already match; migrations are diffed and gated before they apply, and a schema
  change against a running deployment is a deliberate, reviewed forward migration
  (`rayspec deploy --apply-migration`) — a drifted schema fails the boot closed rather
  than being altered on its own.
- **Security by construction, not by convention.** No plaintext secrets, a
  fail-closed tenant chokepoint, an explicit trust boundary around untrusted
  content, and an append-only audit log — from the first boot.

---

## Quickstart

### From npm (fastest)

No clone and no build — [`npx`](https://docs.npmjs.com/cli/commands/npx) fetches the
published CLI (`rayspec`; Node `>=22`). Scaffold a project, validate it, and preview
the deploy — none of which needs a database:

```bash
npx -y rayspec init                    # writes a starter rayspec.yaml (one store + its CRUD routes)
npx -y rayspec doctor ./rayspec.yaml   # static validation — no database
npx -y rayspec plan   ./rayspec.yaml   # read-only deploy preview (the migration SQL) — no database
```

Their real output (the `plan` migration SQL abridged), each a single JSON object on
stdout:

```jsonc
// npx -y rayspec init
{ "ok": true, "command": "init", "created": ["rayspec.yaml"],
  "nextSteps": ["rayspec doctor rayspec.yaml", "rayspec plan rayspec.yaml",
                "rayspec dev gen-secrets   # mint the boot secrets, then set DATABASE_URL to deploy"] }

// npx -y rayspec doctor ./rayspec.yaml          (exit 0)
{ "ok": true, "errors": [], "warnings": [] }

// npx -y rayspec plan ./rayspec.yaml            (exit 0)
{ "ok": true,
  "stores": [{ "name": "items", "columns": 2, "foreignKeys": 0 }],
  "migrationSql": "CREATE TABLE \"items\" ( \"id\" uuid PRIMARY KEY …, \"tenant_id\" uuid NOT NULL, … );",
  "routes": [{ "method": "POST", "path": "/items", "action": "store" }, … ],
  "gateSummary": "destructive-scan: no destructive statements.",
  "breakingChangeBlocked": false, "errors": [] }
```

To put the `rayspec` command on your `PATH` instead of prefixing each call with
`npx`, run `npm i -g rayspec`.

**Deploying** the scaffolded backend needs a reachable Postgres and the boot
secrets. Mint the secrets (`npx -y rayspec dev gen-secrets` writes a `chmod 600`
`.env`), point `DATABASE_URL` at your database, then `rayspec deploy ./rayspec.yaml`.
The full walkthrough — creating the database, provisioning the first tenant, and
making an authenticated request — is in
**[getting-started](./docs/getting-started.md)**.

### From source

Prerequisites: Node `>=22`, pnpm `10.12.4`, and a Postgres you can reach
(`pnpm db:up` brings up a local one and needs Docker with Compose v2). No pnpm on
your PATH? Prefix each command with `npx -y pnpm@10.12.4`. Run these from the repo
root; `dist/index.js` is the `rayspec` CLI and `dist/serve.js` is the
`rayspec-serve` boot bin.

```bash
git clone <this-repo> rayspec && cd rayspec
pnpm install && pnpm build
pnpm db:up                                              # local Postgres on :5433
# Already ran this before? If pnpm db:up reports the container name
# "/rayspec-pg" is already in use, reuse it: docker start rayspec-pg

# Mint the boot secrets into ./.env, then point at the database
node packages/app/cli/dist/index.js dev gen-secrets
echo 'DATABASE_URL=postgresql://rayspec:rayspec@localhost:5433/rayspec' >> .env
node packages/app/cli/dist/index.js dev db             # create the database

# Validate the example product spec (read-only — no database needed):
node packages/app/cli/dist/index.js doctor examples/acme-notes/acme-notes.product.yaml

# Deploy that single file GitOps-style: the platform materializes the declared
# tenant-scoped tables, mounts the declared routes on the authenticated HTTP
# surface, and serves it. (Dry-run first — validate + compose, touches no DB:
#   node packages/app/cli/dist/index.js deploy --dry-run examples/acme-notes/acme-notes.product.yaml)
#
# acme-notes declares audio + speech-to-text + a note-extraction agent, so it asks
# for a few capability env vars at boot (fail-closed if one is missing). For a
# local, no-network hello-world, select the built-in fake STT and pass any
# placeholder OpenAI key — the key is inert until a recording is processed:
RAYSPEC_PRODUCT_TENANT_ID=$(uuidgen) \
RAYSPEC_BLOB_ROOT=/tmp/rayspec-blobs \
STT_PROVIDER=fake \
RAYSPEC_EXTRACTION_MODE=live \
OPENAI_API_KEY=sk-placeholder \
node packages/app/cli/dist/index.js deploy examples/acme-notes/acme-notes.product.yaml --port 8080

# In a second terminal — the declared backend is live:
curl -s localhost:8080/health                          # → {"status":"ok","db":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/sessions
#   → 401: GET /sessions is a declared, bearer-guarded view. See getting-started
#     to provision a tenant and call it with a token.

# Or boot auth-only (no product spec):
node packages/app/server/dist/serve.js
```

See **[getting-started](./docs/getting-started.md)** for the full walkthrough,
including provisioning the first tenant and making an authenticated request.

The quickstart above deploys a **product-profile** document — pure declaration, no
build step. A **backend-profile** document that ships custom `.ts` escape-hatch
handlers (or an extension pack authored in `.ts`) must be compiled to `.js` first:
the runtime loads compiled JavaScript only and fail-closed-rejects a `.ts` module
deterministically. The bundled examples ship a `build.mjs` build step — see
[getting-started → the backend profile](./docs/getting-started.md#the-backend-profile-direct-agent-boot).

---

## Architecture at a glance

```
          one declarative spec  (version: '1.0')
                     │
                     ▼
   ┌─────────────────────────────────────────────────┐
   │  Declarative engine — validate → diff → deploy  │
   └─────────────────────────────────────────────────┘
     │            │            │            │
     ▼            ▼            ▼            ▼
  accounts     HTTP API     agents      stores
  & auth      (Hono +      (neutral    (Postgres/
  (tenancy)   OpenAPI)     backend +   Drizzle,
                           4 adapters) tenant-scoped)
                     │
                     ▼
          durable worker + run journal
          (off-request jobs · replay · audit · cost)
```

Every request runs under a tenant predicate enforced by a single fail-closed
database chokepoint. Agent tool calls run through one dispatch boundary that
treats model and tool output as data, never as instructions. See
**[ARCHITECTURE](./docs/ARCHITECTURE.md)** for the full design.

---

## Documentation

- **[Getting started](./docs/getting-started.md)** — clone to first
  authenticated request.
- **[Concepts](./docs/concepts.md)** — the mental model: specs, agents, stores,
  routes, workflows, tenancy, and the run journal.
- **[Architecture](./docs/ARCHITECTURE.md)** — the layered design, the package
  taxonomy, data flow, and the security model.
- **[Spec reference](./docs/spec-reference.md)** — every section of the two
  document profiles (backend and product), field by field.
- **[The v1 posture](./docs/v1-posture.md)** — the closed capability / operation /
  trigger sets a product document may declare, and the shape guarantees the
  runtime enforces.

The security policy and contributing guide are published with this release.

---

## Security posture

RaySpec's core is built for **trusted, self-hosted, single-node** deployment. It
enforces day-one safety — tenant isolation, no plaintext secrets, an untrusted-content
boundary, and an audit trail — out of the box. Hardening for **untrusted,
multi-tenant, public-internet hosting** (per-tenant data encryption, database
row-level security, per-tenant sandboxing, and token binding) is a separate layer
and is **not** part of the core. Do not put a core deployment on a public address
without that layer. The boot process says so loudly, and so does
[ARCHITECTURE](./docs/ARCHITECTURE.md).

Boot secrets never have to sit in the environment: each of `DATABASE_URL`,
`RAYSPEC_JWT_SIGNING_KEY`, and `RAYSPEC_API_KEY_PEPPER` can instead be read from a
`<VAR>_FILE` file mount (mode `600`), which keeps the value out of `docker inspect`
and the process environment and fails the boot closed on a broken mount.

---

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — see
[`LICENSE`](./LICENSE). In short: you may use, modify, and self-host it freely for
any purpose that is not a competing commercial offering, and each release converts
to Apache-2.0 two years after publication. Third-party dependency attributions are
in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
