# Expense-Claim Auto-Coder — a tool-using agent with an auto-persist loop

This is a **backend showcase**: a tool-using agent that, *inside its run*, **looks data up in a
store** (the org's expense-category catalog) and **writes its result back to a store** (the coded
claim row) — the agent→store auto-persist loop, generated end-to-end from a plain-language brief.

> Trusted, self-hosted posture (see the root [SECURITY.md](../../oss-authored/SECURITY.md)). The
> generated handlers are **trusted-author, NOT sandboxed** — they run in-process; the two CI gates
> (`gate:handler-imports`, `gate:extension-capability`) are TRIPWIRES, not a sandbox. Per-tenant
> execution sandboxing lives in the separate hardening layer (deferred, not in the core).

## What's here

- `PRD.md` — the plain-language **product brief**. Written the way a finance/ops owner would describe
  the backend — NOT as a spec. The rest of this directory is the corresponding backend config: the
  spec, the codegen holes, and the generated handlers.
- `rayspec.yaml` — the **golden spec**: 2 stores, 2 tools, 1 tool-using agent (NO agent `outputSchema`
  — the structured shape lives on `code_claim.parameters`), CRUD routes + the `POST /claims/{id}/code`
  loop route. Passes `rayspec doctor` (`ok:true`) + `rayspec plan` (`ok:true` + shadow-applies). The
  category `code` is deliberately **NOT** `unique:true` — the platform's generated single-column
  `UNIQUE` is GLOBAL (cross-tenant), so a per-tenant catalog code must not be DB-enforced unique (two
  orgs would collide on the same code → 500). The catalog is admin-curated and the persist handler
  FK-revalidates the chosen code, so no DB-enforced unique is needed; a tenant-scoped unique would need
  the tenant-namespaced `*_ref` pattern (not exercised by this example).
- `holes/*.holes.json` — the **codegen holes** (the typed contract the renderer consumes). The skill
  derives these from the PRD; here they are committed fixtures.
- `handlers/*.gen.ts` — the **GENERATED handlers**, rendered deterministically by `rayspec gen-handler`
  from the holes (NOT LLM output; byte-stable; golden-gated in `@rayspec/cli`). Each imports
  `@rayspec/handler-sdk` TYPE-ONLY, takes ZERO npm deps, and reaches the DB only through the injected
  tenant-bound `init.db`. **Do NOT edit them by hand** — regenerate (see below).
- `smoke.sh` — a live **smoke test** that PROVES the loop end-to-end against a live backend (seed the
  catalog with an UNGUESSABLE meals code → create a claim whose description embeds an out-of-catalog
  prompt-injection → `POST /claims/{id}/code` **with the claim data as the run `input`** → **assert the
  WRITTEN row** → **strong lookup proof** (the stored code == the unguessable meals code, so lookup
  actually fired) → **injection proof** (the untrusted-content trust boundary holds: the stored code is
  a real catalog code, not the injected value) → idempotency → tenant isolation incl. a cross-tenant
  **write-isolation re-read**). See "Run the live smoke" below.

## Regenerate the handlers (deterministic)

From the repo root:

```sh
node --import tsx packages/app/cli/src/index.ts gen-handler \
  --holes examples/expense-claim-coder/holes/lookup-categories.holes.json \
  --out   examples/expense-claim-coder/handlers
node --import tsx packages/app/cli/src/index.ts gen-handler \
  --holes examples/expense-claim-coder/holes/code-claim.holes.json \
  --out   examples/expense-claim-coder/handlers
```

The render is a pure function: the output is byte-identical to the committed files (the
`@rayspec/cli` golden test enforces it).

## The two templates exercised

- **`lookup-categories.gen.ts`** — Template **T2** (store-lookup): `init.db.select` over a CLOSED filter
  allowlist + a fixed `active:true` predicate + a row cap + an in-memory substring filter. Read-only;
  tenant predicate auto-injected by the facade.
- **`code-claim.gen.ts`** — Template **T1** (auto-persist, update-by-id arm): coerces every UNTRUSTED model
  arg (never throws — returns `{status:'failed'}`), re-validates the chosen `category_code` against the
  catalog server-side (never trusts the model), server-stamps `status:'coded'`, then `init.db.update`s
  the existing claim row by id. (The upsert-by-natural-key arm — with a tenant-namespaced `*_ref` — is
  in the template catalog but not exercised by this update-keyed golden.)

## Where the loop is proven

**Deterministically (no LLM):** `packages/kernel/platform/src/gen-handler-loop.db.test.ts` wires these
generated handlers through the REAL `dispatchTool` + a fake backend and asserts the coded row LANDED in
`expense_claims` via the tenant-bound db — plus idempotency (one row on re-code), coercion + FK
re-validation of the untrusted model arg are load-bearing, and tenant isolation.

**Live (model-driven, end-to-end):** `smoke.sh` drives a real OpenAI run through the deployed backend
and asserts the WRITTEN row.

## Run the live smoke

From the repo root, with a local Postgres up and a filled repo-root `.env` (DATABASE_URL,
RAYSPEC_API_KEY_PEPPER, RAYSPEC_JWT_SIGNING_KEY, OPENAI_API_KEY):

```sh
pnpm db:up                                                          # Docker Postgres on :5433
RAYSPEC_SPEC_PATH="$PWD/examples/expense-claim-coder/rayspec.yaml" \
  pnpm --filter @rayspec/local-boot serve                         # boot the authored backend
# in another shell:
BASE=http://127.0.0.1:8788 bash examples/expense-claim-coder/smoke.sh
```

The wrapper provisions a FRESH throwaway dev DB (`rayspec_local_expense_claim_coder`, derived from the
spec directory name — an explicit `RAYSPEC_DEV_DB` overrides it; DROP+CREATE on every boot), runs the
real `deploy()` pipeline, resolves the `kind:'tool'` handlers via the path-jailed
loader, builds the tenant-bound `HandlerDb` facade, and wires the OpenAI backend. `RAYSPEC_HANDLER_ROOT`
defaults to the spec directory, so the relative `handlers/*.gen.ts` paths resolve.

> **Trusted-author, NOT sandboxed.** The generated handlers run in-process; `gate:handler-imports` +
> `gate:extension-capability` are TRIPWIRES, not a sandbox; per-tenant execution sandboxing lives in
> the separate hardening layer (deferred). LOCAL/internal-only — never put this boot behind a public
> address without that layer.
