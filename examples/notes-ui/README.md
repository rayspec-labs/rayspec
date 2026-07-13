# Notes UI — a backend that serves its own static web frontend

A small, real **backend-profile** document that pairs a CRUD API with a bundled single-page web UI.
It declares a `notes` store, three declarative store routes under `/api/notes`, and a `frontend[]`
mount that serves the built assets in `web/dist` at `/`. No handler code and no agent — just stores,
declarative routes, and static serving.

- `rayspec.yaml` — the authored backend document (a `notes` store + `/api/notes` CRUD + a `frontend`
  mount).
- `web/dist/index.html` — the bundled static page the backend serves at `/` (a real build would emit
  this directory; here it is a single hand-written page).

## What it does

```
GET  /             →  the static web UI (index.html) from web/dist
GET  /<any path>   →  index.html again (spa:true — single-page History-API routing)
POST /api/notes    →  create a note                 (declarative store route — no handler code)
GET  /api/notes    →  list this tenant's notes       (declarative store route — no handler code)
GET  /api/notes/{id}→ read one note                  (declarative store route — no handler code)
GET  /health       →  the platform readiness probe   (never shadowed by the / static mount)
```

The API routes, `/health`, and every `/v1/*` platform path are registered **before** the static mount,
so an API call is always answered by its route — never by the SPA shell. A static miss falls through to
the platform's uniform 404 (or, for this `spa:true` mount, back to `index.html`). Every store touch is
tenant-scoped by the platform's structural predicate.

## Validate (no DB, no deploy)

```bash
rayspec doctor  examples/notes-ui/rayspec.yaml
rayspec plan    examples/notes-ui/rayspec.yaml
```

`doctor` also checks that `frontend.dir` (`web/dist`) resolves to a readable directory of built assets.

## Boot it directly on the shipped entrypoint (LOCAL, trusted posture)

This document boots through the **real** server entrypoint (`@rayspec/server`) with **no hand-written
wrapper** — the shipped `rayspec-serve` reads the spec, materializes the `notes` store, mounts the
routes, and serves `web/dist` at `/`:

```bash
pnpm db:up   # Postgres on :5433

# Point DATABASE_URL at a FRESH, EMPTY database — rayspec-serve applies the migration chain but does
# NOT drop/create the DB. (examples/local-boot is the dev convenience that provisions a throwaway one.)
RAYSPEC_SPEC_PATH=$(pwd)/examples/notes-ui/rayspec.yaml \
DATABASE_URL="postgres://…:5433/<a-fresh-empty-db>" \
RAYSPEC_JWT_SIGNING_KEY="<an RS256 PEM>" \
RAYSPEC_API_KEY_PEPPER="<any string>" \
  pnpm --filter @rayspec/server serve
```

No `PORT` is set, so it listens on **`http://localhost:8080`** (the `rayspec-serve` default); the boot
banner prints the exact `Base URL:`.

## Drive it end-to-end (curl)

```bash
BASE=http://localhost:8080   # the rayspec-serve default; use whatever the boot banner printed

# 1. The static UI is public (no token needed).
curl -s "$BASE/"          # → the index.html page
curl -s "$BASE/dashboard" # → the SAME index.html (spa:true fallback)

# 2. Register a user, create an org, and switch into it to get a scoped token.
ACCESS=$(curl -s -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-enough-password"}' | jq -r .accessToken)
ORG=$(curl -s -X POST "$BASE/v1/orgs" -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -d '{"name":"Acme"}' | jq -r .id)
TOKEN=$(curl -s -X POST "$BASE/v1/orgs/$ORG/switch" -H "authorization: Bearer $ACCESS" | jq -r .accessToken)

# 3. Create a note, then list this tenant's notes (JSON — never the SPA shell).
curl -s -X POST "$BASE/api/notes" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Buy milk","body":"2%"}'
curl -s "$BASE/api/notes" -H "authorization: Bearer $TOKEN" | jq '.[].title'
```

## Posture

LOCAL / single-node / trusted-author. The static assets are served read-only from `web/dist`; the
static handler is hardened against dotfiles, path traversal, and symlink-escape, but this document is
**not** internet-facing without the separate external-exposure hardening layer.
