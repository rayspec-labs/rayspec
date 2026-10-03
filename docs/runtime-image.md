# The runtime image

Each release ships a linux/amd64 container image of the RaySpec runtime on GHCR, listed by digest
in the signed release manifest. It holds Node at the release's pinned 22 patch, the published npm
packages installed from the release tarballs, and the PostgreSQL 16 client tools that `rayspec
export` and `rayspec import` run. Its entrypoint is `rayspec`, so every command of the
[CLI reference](./cli-reference.md) runs as `docker run <image> <command> ...`; `rayspec-serve` is on
`PATH` as well.

Pull it by digest, never by tag. The digest is `images[0].digest` of `release-manifest.json`, whose
signature you verify first ([Releasing → Verifying a release](./releasing.md#verifying-a-release)):

```bash
docker pull ghcr.io/rayspec-labs/rayspec@sha256:<digest from the signed release manifest>
```

## What the image is

| | |
|---|---|
| Platform | `linux/amd64` only. Other platforms are not built and not supported. |
| Base | `node:<pinned 22 patch>-trixie-slim`, pinned by digest in `deployments/runtime-image/Dockerfile` |
| User | `rayspec` (uid and gid 10001). The image never runs as root. |
| Installation | `/opt/rayspec`, owned by root and not writable by any other user, installed from the release tarballs with install scripts disabled |
| Working directory | `/var/lib/rayspec`, owned by `rayspec`, mode 0700: put the state directory and the blob root here, on a volume |
| Listening | port 8080 (`PORT`), on every address of the container (`RAYSPEC_HOST=0.0.0.0`); `docker run -p` decides what the host exposes |
| Health check | `node /opt/rayspec/healthcheck.mjs`: `/livez` must answer 200 |
| Labels | `org.opencontainers.image.version` (the release) and `org.opencontainers.image.revision` (the source commit) |
| Kept | `/bin/sh`, which the supervisor of a role-separated deploy needs; `pg_dump` and `pg_restore` of PostgreSQL 16 |
| Removed | npm, npx, corepack and yarn. The Debian base userland otherwise stays as the base image ships it. |

The candidate and release workflows check every row of this table on the archived image before it
is published (`scripts/image-conformance.mjs`).

## Running it

A bundle deploy with database role separation, the state on a volume and the bundle read-only:

```bash
docker volume create rayspec-state
docker run -d --name team-notes \
  --ulimit core=0 \
  -p 127.0.0.1:8080:8080 \
  -v rayspec-state:/var/lib/rayspec \
  -v "$PWD/bundles:/srv/app:ro" \
  -e DATABASE_URL -e RAYSPEC_MIGRATION_DATABASE_URL -e RAYSPEC_SNAPSHOT_DATABASE_URL \
  -e RAYSPEC_JWT_SIGNING_KEY -e RAYSPEC_API_KEY_PEPPER \
  -e RAYSPEC_BLOB_ROOT=/var/lib/rayspec/blobs \
  ghcr.io/rayspec-labs/rayspec@sha256:<digest> \
  deploy /srv/app/team-notes-1.0.0.ray --plan-digest <digest from the dry run> \
  --state-dir /var/lib/rayspec/state
```

Plan first with the same mounts and environment and `deploy /srv/app/team-notes-1.0.0.ray --dry-run
--state-dir /var/lib/rayspec/state --json`. `-e NAME` without a value passes the variable from your
shell, so no secret appears on the command line. [Self-hosted deployment](./self-hosted-deployment.md)
describes every variable; [Database isolation](./database-isolation.md) prepares the three roles.

`docker stop` sends SIGTERM; the deploy drains and exits 0.

## Host settings

Some prerequisites of the managed posture belong to the host, not to the image
([Hardened posture](./hardened-posture.md)):

- **A zero hard core-file limit.** Start the container with `--ulimit core=0`. The entrypoint also
  sets it through `/bin/sh`, which the image keeps for that reason.
- **Yama `ptrace_scope` of 1 or more.** The setting is the host kernel's and cannot be changed from a
  container: on the host, `sysctl -w kernel.yama.ptrace_scope=1`, and persist it in
  `/etc/sysctl.d/`. Docker Desktop's virtual machine kernel has no Yama, so the managed posture
  refuses to boot there; other postures warn.
- **The installation and the spec read-only to the application's user.** The image installs
  `/opt/rayspec` as root; mount bundles and specs read-only (`:ro`).
- **The privileged connection strings in the environment**, not in a file the application could
  read: pass `RAYSPEC_MIGRATION_DATABASE_URL` and `RAYSPEC_SNAPSHOT_DATABASE_URL` with `-e`.

## Building it

`scripts/release-candidate.mjs` builds the image from the packed release tarballs, never from the
workspace (see [Releasing](./releasing.md)). It needs a buildx builder of the `docker-container`
driver, because it writes the image as an OCI image layout archive; `docker load -i` reads the same
archive, so the image you test is the image the release manifest names:

```bash
docker buildx create --name rayspec-release --driver docker-container
pnpm release:candidate --version 1.9.0-rc.0 --out ./candidate --builder rayspec-release
docker load -i ./candidate/image/rayspec-runtime.oci.tar
```
