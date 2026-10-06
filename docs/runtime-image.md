# The runtime image

Each release defines a linux/amd64 container image of the RaySpec runtime
(`deployments/runtime-image/Dockerfile`). It holds Node at the release's pinned 22 patch, the
published npm packages installed from the release tarballs, the PostgreSQL 16 client tools that
`rayspec export` and `rayspec import` run, and, from 1.9.1, ffmpeg with ffprobe for products that
record audio ([an image of 1.9.0 has neither](#an-image-of-190-has-no-ffmpeg)).
Its entrypoint is `rayspec`, so every command of the [CLI reference](./cli-reference.md) runs as
`docker run <image> <command> ...`; `rayspec-serve` is on `PATH` as well.

## Getting the image

**The image is not in a registry.** The release build builds it and runs the checks below on it,
and nothing pushes it: `ghcr.io/rayspec-labs/rayspec` serves no RaySpec image, and no image archive
is attached to the GitHub release. You build the image yourself, from the tarballs the release
attaches and the Dockerfile at the release's tag:

```bash
git clone --depth 1 --branch v<version> https://github.com/rayspec-labs/rayspec && cd rayspec
gh release download v<version> --pattern '*.tgz' --dir ./tarballs

docker buildx create --name rayspec-image --driver docker-container
# 1. Resolve the dependency tree of the tarballs once, into ./lock/package-lock.json.
docker buildx build --builder rayspec-image --platform linux/amd64 \
  --build-context tarballs=./tarballs \
  --target lock --output type=local,dest=./lock deployments/runtime-image
# 2. Build the image from that lockfile, into an archive `docker load` reads.
docker buildx build --builder rayspec-image --platform linux/amd64 --provenance=false --sbom=false \
  --build-context tarballs=./tarballs --build-context lock=./lock \
  --build-arg RAYSPEC_VERSION=<version> \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" \
  --output type=docker,oci-mediatypes=true,rewrite-timestamp=true,dest=./rayspec-runtime.oci.tar,name=rayspec:<version> \
  deployments/runtime-image
docker load -i ./rayspec-runtime.oci.tar
```

The build refuses when the `rayspec` package among the tarballs is not `<version>` and, from
1.9.1, when ffmpeg or ffprobe does not run or ffmpeg cannot stitch two Ogg-Opus chunks into one
stream. It needs the npm registry (for the third-party packages), Docker Hub (for the two base
images, pinned by digest) and, from 1.9.1, snapshot.debian.org (for ffmpeg), and several gigabytes
of free disk: the build cache, the archive and the loaded image together take about 10 GB. The examples below call the result `rayspec:<version>`;
push it to a registry of your own if your hosts pull images, and refer to it there by the digest
that registry reports.

**What the release manifest tells you about the image, and what it does not.** The release attaches
`release-manifest.json`: the version, the source commit, every package with its npm integrity, and
under `images[0]` the platform, the Node version and the digest of the image the release build made.

- The manifest is **not signed**: no `release-manifest.json.sig` is attached. It shows what the
  release build recorded, to anyone who trusts the GitHub release it is attached to. It does not
  show who built the release, and it protects nothing against someone who can change the release's
  files.
- The npm packages carry **no npm provenance attestation**: they were published from a maintainer's
  machine, not by a workflow. The manifest's integrities let you check that the tarballs you
  downloaded, and the packages npm serves (`npm view rayspec@<version> dist.integrity`), are the
  bytes the release build packed; [Releasing](./releasing.md#verifying-a-release) has the command.
- `images[0].digest` names an image you cannot pull, and **your own build has another digest**: the
  third-party npm packages are resolved from the registry when the lockfile of step 1 is written, so
  two builds differ. Do not look for that digest in a registry and do not expect to reproduce it.
  What you can check about your own image is its content: `node scripts/gen-image-sbom.mjs
  --image-oci ./rayspec-runtime.oci.tar --out image-sbom.cdx.json` lists every npm package in it and, from 1.9.1,
  every Debian package, each `@rayspec` package with the SHA-512 of the tarball it was installed from, which
  is the integrity the manifest lists.

## What the image is

| | |
|---|---|
| Platform | `linux/amd64` only. Other platforms are not built and not supported. |
| Base | `node:<pinned 22 patch>-trixie-slim`, pinned by digest in `deployments/runtime-image/Dockerfile` |
| User | `rayspec` (uid and gid 10001). The image never runs as root. |
| Installation | `/opt/rayspec`, owned by root and not writable by any other user, installed from the release tarballs with `npm ci` from the lockfile the build's first step wrote, kept in the image as `/opt/rayspec/package-lock.json`, install scripts disabled |
| SBOM | `scripts/gen-image-sbom.mjs` writes `image-sbom.cdx.json` from the image archive: every npm package installed under `/opt/rayspec` and from 1.9.1, every Debian package of the image's dpkg record (the base userland, ffmpeg and what ffmpeg depends on), with the image's digest |
| Working directory | `/var/lib/rayspec`, owned by `rayspec`, mode 0700: put the state directory and the blob root here, on a volume |
| Listening | port 8080 (`PORT`), on every address of the container (`RAYSPEC_HOST=0.0.0.0`); `docker run -p` decides what the host exposes |
| Health check | `node /opt/rayspec/healthcheck.mjs`: `/livez` must answer 200 |
| Labels | `org.opencontainers.image.version` (the release) and `org.opencontainers.image.revision` (the source commit) |
| Kept | `/bin/sh`, which the supervisor of a role-separated deploy needs; `pg_dump` and `pg_restore` of PostgreSQL 16 |
| Media tools | From 1.9.1, `ffmpeg` and `ffprobe` in `/usr/bin`: Debian's `ffmpeg` package at the version the Dockerfile pins (`FFMPEG_VERSION`), installed without recommended packages from the Debian archive as it stood at the pinned moment (`DEBIAN_SNAPSHOT`, served by snapshot.debian.org) |
| Removed | npm, npx, corepack and yarn. The Debian base userland otherwise stays as the base image ships it, plus, from 1.9.1, the packages ffmpeg depends on. |

The candidate and release workflows check this table on the archived image
(`scripts/image-conformance.mjs`): the platform, the Node patch the Dockerfile pins, the user, the
installation's owner and that no file of it is writable by the user, the working directory's owner
and mode, the port and address, the health check, the labels, `/bin/sh`, the client tools, the
removed package managers, and the media tools (below). The base image's digest is pinned in the
Dockerfile and not checked again; that the image holds the lockfile it was built from is checked by
`scripts/release-candidate.mjs`, and the image SBOM by `scripts/release-manifest.mjs evidence`.

## ffmpeg and ffprobe

A product that declares `audio_input` or `media_playback` receives a recording as a series of
Ogg-Opus chunks. The audio capability stitches them into one stream with ffmpeg (its concat
demuxer, copying the audio without re-encoding it) and checks the result with ffprobe, once before
the recording goes to the speech-to-text provider and once to make it playable. Both steps fail
closed when a tool is missing: the deployment starts and serves, and no recording is transcribed or
played. An image without the tools could therefore not run such a product, which is why the one
image carries them from 1.9.1; there is no second image without them, and a product without audio
never starts them.

### An image of 1.9.0 has no ffmpeg

Everything in this section, the build's ffmpeg checks and the Debian entries of the image SBOM
describe the image from 1.9.1. The Dockerfile at the `v1.9.0` tag installs no ffmpeg, its build
checks none, and its SBOM lists npm packages only. An image built from that tag with the commands
above builds, starts and serves, and a product that declares `audio_input` or `media_playback`
transcribes and plays nothing on it. The 1.9.0 CLI does not warn about it either: the
`media tools missing` warning of `rayspec bundle verify` and of the dry-run is in the CLI from
1.9.1.

With such a product on 1.9.0, do one of two things:

- **Move to 1.9.1**: repack the application for 1.9.1 and build that release's image.
- **Stay on 1.9.0 and add ffmpeg in an image of your own**, built on the one you built:

  ```dockerfile
  FROM rayspec:1.9.0
  USER root
  RUN apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*
  USER rayspec:rayspec
  ```

  Debian's `ffmpeg` package brings ffprobe. This installs the version Debian serves on the day
  you build, not a pinned one, and none of the checks below run on it: confirm `ffmpeg -version`
  and `ffprobe -version` in the image, and a recording end to end, before you rely on it.

**What ffmpeg is given, and what holds it.** The chunks are bytes a signed-in caller uploaded
through the product's audio route, each at most 8 MiB and a track at most 512 MiB by default.
ffmpeg and ffprobe run as children of the serving process, as the same user (`rayspec`, uid 10001
in the image, never root), with the files that user can read and the network the container has.

- The capability refuses a chunk that does not begin as an Ogg stream before ffmpeg sees it, so a
  text file, a concat script or another container is not handed over.
- The command line names what ffmpeg may use: the concat and Ogg demuxers
  (`-format_whitelist concat,ogg`) and the file protocol (`-protocol_whitelist file`). The audio
  is copied, not decoded. Of Debian's full build, with every demuxer and decoder it carries, this
  path reaches the Ogg demuxer and its codec header parsers.
- An error ends the run (`-xerror`), and a run in which ffmpeg could not open a chunk is refused
  even when ffmpeg exits 0, so a recording is never stitched around a chunk.
- Each child is killed after `RAYSPEC_FFMPEG_TIMEOUT_MS` (120 seconds by default).
- **Not provided:** the runtime sets no memory or CPU limit on these children, does not limit how
  many run at once, and does not sandbox them. A flaw in ffmpeg's Ogg parsing would run with the
  rights of the runtime user. Give the container memory and CPU limits, and keep it the boundary
  the [Threat model](./threat-model.md#what-the-host-must-enforce) asks for.
- A security fix of ffmpeg reaches the image only when the pin below is moved and the image is
  built again; a built image does not update itself.

- **Pinned.** `FFMPEG_VERSION` names Debian's package version and `DEBIAN_SNAPSHOT` the moment of
  the archive it and its dependencies are installed from, so a later build installs the same
  packages. Debian's package is the only source: nothing is downloaded from elsewhere or compiled.
  A security update of ffmpeg in Debian reaches the image when both values are moved; move them
  together, since the version must be the one that snapshot offers.
- **Checked when the image is built.** The build runs `ffmpeg -version` and `ffprobe -version`,
  requires the concat demuxer and the Ogg-Opus muxer, encodes two one-second Opus chunks, stitches
  them with the capability's command line and requires one Opus stream of their combined length. A build
  without a working ffmpeg fails.
- **Checked on the built image.** `scripts/image-conformance.mjs` requires both tools at the pinned
  version and runs the audio capability installed in the image (`remuxChunks` of
  `@rayspec/audio-runtime`) on two chunks, as the image's own user, and requires it to refuse a
  chunk that is not Ogg and one the image's ffmpeg cannot read. `scripts/gen-image-sbom.mjs`
  refuses an image whose dpkg record names no installed ffmpeg.
- **Its cost.** Debian's ffmpeg is the full build, and it brings 206 packages with it (codec,
  filter and display libraries). Measured on an image built from the 1.9.0 tarballs, the unpacked
  image grew from 1.30 GB to 1.75 GB and its archive from 402 MB to 572 MB.
- **Outside the image** the tools are yours to install. `rayspec bundle verify` and the dry-run of a
  bundle deploy write a warning to stderr when the bundle requires an audio capability and ffmpeg
  or ffprobe is not found on the host ([CLI reference](./cli-reference.md#bundle-verify));
  `RAYSPEC_FFMPEG_BIN` and `RAYSPEC_FFPROBE_BIN` name executables that are not on `PATH`.

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
  rayspec:<version> \
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

[Getting the image](#getting-the-image) builds the image of a release from its tarballs. A
maintainer builds a candidate's image from a checkout instead: `scripts/release-candidate.mjs` packs
the tarballs and then runs the same two builds, never installing from the workspace (see
[Releasing](./releasing.md)). It first resolves the dependency tree once into a lockfile (the
Dockerfile's `lock` stage), then builds the image from that lockfile with `npm ci`, its timestamps
set to the commit's time. The third-party versions are therefore the ones the registry served when
the lockfile was written, which can be newer than the workspace lockfile's; the image SBOM lists
them. It needs a buildx builder of the `docker-container` driver, because it writes the image as an
OCI image layout archive; `docker load -i` reads the same archive, so the image you test is the
image the candidate's release manifest names:

```bash
docker buildx create --name rayspec-release --driver docker-container
pnpm release:candidate --version 1.9.0-rc.0 --out ./candidate --builder rayspec-release
docker load -i ./candidate/image/rayspec-runtime.oci.tar
```
