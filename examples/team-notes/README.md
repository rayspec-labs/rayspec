# Team notes — CRUD and a static UI, in three releases

A reference application: one organization's shared notes, kept by its members through a CRUD API
and a small static web UI served by the same deployment. It needs no model credential and no
custom code — a store, declarative routes and a frontend mount.

It comes in three releases of one application (`metadata.id: team-notes`):

| Release | Version | What changes |
| --- | --- | --- |
| [`releases/v1.yaml`](./releases/v1.yaml) | `1.0.0` | `notes` store (`title`, `content`, deleted softly), CRUD routes, the UI |
| [`releases/v2.yaml`](./releases/v2.yaml) | `1.1.0` | adds an optional `label` column, which the UI edits, and an optional `bigint` counter and `numeric` amount — an additive change |
| [`releases/v3.yaml`](./releases/v3.yaml) | `2.0.0` | drops the `content` column — a destructive change that is refused |

The **application version** is the application's own (`metadata.version`); the UI shows it. It is
not the version of the RaySpec runtime the bundle pins (`runtime.version` in the bundle manifest,
which `rayspec bundle inspect` reports as `runtimeVersion`).

- `web/` — the UI: `index.html`, `app.js`, `app.css`. Files, not inline code: the default
  `Content-Security-Policy` a served frontend carries blocks inline script and style.
- `build.mjs` — builds one release into a directory to pack.
- `seed/` — 100 notes for two users, with the inventory a deployment holding them reproduces.

## What it serves

```
GET    /                    the UI (index.html); any other unmatched path answers it too
GET    /app-version.json    { application, version, fields } — written by the build
GET    /api/notes           list the organization's notes, by keyset pages
POST   /api/notes           create a note        (Idempotency-Key makes a retry replay)
GET    /api/notes/{id}      read one
PATCH  /api/notes/{id}      update fields of one
DELETE /api/notes/{id}      delete one
```

A `DELETE` keeps the note as a tombstone (`deleted_at` set, `softDelete: true` on the store):
every read hides it, and an export carries it like any other row.

Every `/api` route needs an organization-scoped bearer token, and every read and write is held to
the caller's organization: a member of another organization sees an empty list and a `404` for a
note id it does not own. `GET /api/notes?limit=<n>` returns at most `n` notes (1–200) and an
`X-Next-Cursor` header; pass it as `?after=` for the next page.

## Build and pack

```bash
node examples/team-notes/build.mjs --release=v1 --out=build/team-notes-v1
rayspec pack --spec build/team-notes-v1/rayspec.yaml --output team-notes-1.0.0.ray
rayspec bundle inspect team-notes-1.0.0.ray
rayspec bundle verify  team-notes-1.0.0.ray
```

The build needs Node only. It copies the release spec and the UI and writes
`web/dist/app-version.json` from the release table in `build.mjs`; it refuses a release spec whose
`metadata.id` or `metadata.version` disagrees with that table, so the version the UI shows is the
version the bundle carries. See [Packing an application](../../docs/packing.md).

## Deploy

On the server, with the [environment a bundle deploy reads](../../docs/self-hosted-deployment.md#what-you-need)
(`DATABASE_URL`, `SHADOW_DATABASE_URL`, `RAYSPEC_JWT_SIGNING_KEY` or its `_FILE`, and
`RAYSPEC_API_KEY_PEPPER` or its `_FILE`) and only the bundle:

```bash
rayspec deploy team-notes-1.0.0.ray --dry-run          # prints the plan and its planDigest
rayspec deploy team-notes-1.0.0.ray --plan-digest <planDigest from the dry-run>
```

The plan needs no binding. The deployment serves on port `8080` of the loopback interface unless
`--port` and `--host` say otherwise.

## Two users in one organization

The first user registers and creates the organization; the second joins by an invite:

```bash
BASE=http://127.0.0.1:8080
FIRST=$(curl -s -X POST $BASE/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"first@example.test","password":"a-long-enough-password"}' | jq -r .accessToken)
ORG=$(curl -s -X POST $BASE/v1/orgs -H "authorization: Bearer $FIRST" \
  -H 'content-type: application/json' -d '{"name":"Team"}' | jq -r .id)
FIRST=$(curl -s -X POST $BASE/v1/orgs/$ORG/switch -H "authorization: Bearer $FIRST" | jq -r .accessToken)
INVITE=$(curl -s -X POST $BASE/v1/orgs/$ORG/invites -H "authorization: Bearer $FIRST" \
  -H 'content-type: application/json' -d '{"email":"second@example.test"}' | jq -r .inviteToken)
SECOND=$(curl -s -X POST $BASE/v1/invites/accept -H 'content-type: application/json' \
  -d "{\"token\":\"$INVITE\",\"password\":\"a-long-enough-password\"}" | jq -r .accessToken)
```

The UI signs in with an email and password and uses the user's first organization.

## The seed

`seed/notes.json` holds 100 notes, 50 for each user, some with non-ASCII text, each with a stable
`key`. Its `inventory` is the note count, the count per user and `digest`: the SHA-256 of the JSON
array of `[title, content]` pairs sorted by title, then content, in code-point order — so a changed
or swapped value is noticed, not only a missing row. `seed/build-seed.mjs` regenerates the file
byte for byte.

```bash
printf '%s' "$FIRST"  > first.token
printf '%s' "$SECOND" > second.token
node examples/team-notes/seed/load-seed.mjs --base=$BASE \
  --first-token-file=first.token --second-token-file=second.token
```

It creates each note as its user with the note's `key` as the `Idempotency-Key`, so running it
again replays the notes and creates none; then it reads every note back by keyset pages and exits
`0` only when the store's inventory equals the seed's.

## Update to 1.1.0, and the refused 2.0.0

A release that changes the stores is packed against the spec the deployment runs:

```bash
node examples/team-notes/build.mjs --release=v2 --out=build/team-notes-v2
SHADOW_DATABASE_URL=… rayspec pack --spec build/team-notes-v2/rayspec.yaml \
  --output team-notes-1.1.0.ray --against build/team-notes-v1/rayspec.yaml
rayspec deploy team-notes-1.1.0.ray --dry-run
rayspec deploy team-notes-1.1.0.ray --plan-digest <planDigest>
```

The `label`, `counter` and `amount` columns are nullable, so the delta is additive: every note
keeps its data and reads back with `label: null`. `counter` is a `bigint`, which the API carries as a
JSON number up to `9007199254740991`, and `amount` a `numeric(30, 6)`, which it carries as a string
so no digit is rounded; the UI edits only the label. See
[the column types](../../docs/spec-reference.md#stores).

`2.0.0` drops `content`. Packed against `1.1.0`, `rayspec pack` refuses it (`RAY_USAGE`, naming the
dropped column) unless a reviewed `--allowlist` clears the drop. Packed on its own, the bundle
carries no reviewed delta; its dry-run reports the change as destructive with the blocker
`RAY_MIGRATION_REQUIRED`, and the deploy refuses it (exit `3`) naming `drop-column on
notes.content`, leaving `1.1.0` active and every note as it was. See
[A product schema change](../../docs/packing.md#a-product-schema-change).

## Move it: export and import

The deployment moves to a new environment with [`rayspec export`](../../docs/export.md) and
[`rayspec import`](../../docs/import.md). The reference journey does it twice — from the source to
a first target, and after a new write there from that target to a second one — and finds every note
(tombstones included), user, password hash and membership carried, while every access token and
API key of the earlier environment is refused and an owner who held only an API key gets in again
through `rayspec tenant recover-owner`. An environment with two organizations is refused by the
export (`RAY_MULTI_TENANT_UNSUPPORTED`).

## Where it is tested

- `packages/app/cli/src/reference-apps.test.ts` — the builds, the versions the UI reads, pack,
  inspect, verify and the seed, without a database.
- `packages/app/cli/src/reference-apps-team-notes.db.test.ts` — the deployment from the bundle
  alone, the two users, the refusals, the seed and its inventory, the update to `1.1.0` and the
  refused `2.0.0`, with the real built CLI and a database.
- `scripts/journeys/team-notes.mjs` — the whole life of the application with the CLI installed from
  the packed release, never the workspace: the three releases, the two users, the seed, the
  key-only owner, export while serving, two imports, the identity reset, owner recovery and
  `rayspec resume`; and the refused export of a source with two organizations. Run with
  `pnpm test:journeys --app team-notes` (see [Reference journeys](../../CONTRIBUTING.md#reference-journeys)).
