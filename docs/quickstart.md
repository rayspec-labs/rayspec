# Quickstart: a reference application from its bundle

This page takes you from `npm install` to a deployed application in about ten commands, with the
published CLI and no build of RaySpec itself. The application is
[team notes](../examples/team-notes/README.md), a small CRUD application with a web UI: you build
it, pack it into a `.ray` bundle, check the bundle, and deploy it from the bundle alone.

To build RaySpec from source and author your own spec instead, follow
[Getting started](./getting-started.md). To run a bundle someone else packed, on a server, see
[Deploying a bundle on your own server](./self-hosted-deployment.md).

Every command on this page runs in the repository's reference journeys
(`scripts/journeys/quickstart.mjs`), so the page and the CLI cannot drift apart. Two of them reach
the network there in a local form: the install installs the release's packed tarballs, and the
clone copies the application from the working tree.

## What you need

- **Node** `>=22.21.0`, with `npm` and `npx`.
- **PostgreSQL 16** you can reach: an empty database for the deployment, and a server where a
  throwaway database may be created and dropped while a change is planned (the same server is
  fine). In a clone of the repository, `pnpm db:up` starts one on port `5433` with both.
- **`git`, `openssl` and `curl`.**

Run everything below in a new, empty directory.

## 1. Install the CLI

```bash
npm install rayspec
npx rayspec --version
```

## 2. Get the application and build it

The application's source is in the repository, at the tag of the release you installed. Its build
needs Node only: it copies the spec and the UI and writes the version the UI shows.

```bash
VERSION=$(npx rayspec --version | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
git clone --depth 1 --branch "v$VERSION" https://github.com/rayspec-labs/rayspec.git rayspec-src
node rayspec-src/examples/team-notes/build.mjs --release=v1 --out=team-notes
```

## 3. Pack and check the bundle

```bash
npx rayspec pack --spec team-notes/rayspec.yaml --output team-notes-1.0.0.ray
npx rayspec bundle inspect team-notes-1.0.0.ray
npx rayspec bundle verify team-notes-1.0.0.ray
```

`inspect` reads the bundle without running anything in it: the application `team-notes` at
version `1.0.0`, the RaySpec runtime it pins, and that it needs no binding and declares no
outbound host. `verify` checks every file against the bundle's own digests. See
[Packing an application](./packing.md).

## 4. Point at the database and mint the boot secrets

A bundle deploy reads its configuration from the environment only, never from a `.env` file.

```bash
export DATABASE_URL=postgresql://rayspec:rayspec@localhost:5433/rayspec
export SHADOW_DATABASE_URL=postgresql://rayspec:rayspec@localhost:5433/rayspec_shadow
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.pem
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > pepper
chmod 600 jwt.pem pepper
export RAYSPEC_JWT_SIGNING_KEY_FILE=$PWD/jwt.pem
export RAYSPEC_API_KEY_PEPPER_FILE=$PWD/pepper
```

`jwt.pem` signs the access tokens and `pepper` keys the API-key hashes. Keep both: a deployment
started with other values does not accept the tokens and keys issued under these.

## 5. Deploy

The dry run plans the deploy and changes nothing; the deploy applies the plan you reviewed, named
by its digest, and serves on port `8080` (set `PORT` to use another). Leave it running.

```bash
npx rayspec deploy team-notes-1.0.0.ray --dry-run > plan.json
npx rayspec deploy team-notes-1.0.0.ray --plan-digest "$(node -p 'require("./plan.json").data.planDigest')"
```

## 6. Use it

In a second terminal, in the same directory: open `http://127.0.0.1:8080/` in a browser, or call
the API. A user registers, creates the organization, writes a note and reads it back.

```bash
BASE=http://127.0.0.1:8080
field() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).$1"; }
curl -s $BASE/app-version.json
ACCESS=$(curl -s -X POST $BASE/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.test","password":"a-long-enough-password"}' | field accessToken)
ORG=$(curl -s -X POST $BASE/v1/orgs -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -d '{"name":"My team"}' | field id)
TOKEN=$(curl -s -X POST $BASE/v1/orgs/$ORG/switch -H "authorization: Bearer $ACCESS" | field accessToken)
curl -s -X POST $BASE/api/notes -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"First note","content":"Hello from the bundle"}'
curl -s "$BASE/api/notes?limit=10" -H "authorization: Bearer $TOKEN"
```

`app-version.json` names the application version, `1.0.0` — the application's own, not the
runtime's. The last call lists the note you wrote.

Stop the deployment with Ctrl-C; its state stays in `.rayspec-state` and in the database, and the
same deploy command serves it again.

## Next

- Update the application to `1.1.0`, which adds a field, and see why `2.0.0` is refused:
  [team notes](../examples/team-notes/README.md#update-to-110-and-the-refused-200).
- The other reference applications: [document intake](../examples/document-intake/README.md), a
  durable workflow over uploaded files, and [asset catalog](../examples/asset-catalog/README.md),
  custom code with a dependency and a declared outbound host.
- Move the deployment to another environment: [Exporting](./export.md) and
  [Importing](./import.md) a deployment.
