# The RaySpec runtime image: linux/amd64, Node at the pinned 22 patch, the published closure installed
# from the packed release tarballs (never from workspace links) and a lockfile, run as a non-root
# user that cannot write the installation.
#
# Built by scripts/release-candidate.mjs (see docs/releasing.md) in two steps, with the tarballs as a
# named build context. First the dependency tree is resolved once and written out:
#
#   docker buildx build --platform linux/amd64 --build-context tarballs=<dir of the packed .tgz files> \
#     --target lock --output type=local,dest=<lock dir> deployments/runtime-image
#
# then the image is built from that lockfile, which replaces the `lock` stage below:
#
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     --build-context tarballs=<dir of the packed .tgz files> --build-context lock=<lock dir> \
#     --build-arg RAYSPEC_VERSION=<version> --build-arg SOURCE_COMMIT=<40-hex commit> \
#     --build-arg SOURCE_DATE_EPOCH=<commit time> \
#     --output type=docker,oci-mediatypes=true,rewrite-timestamp=true,dest=<image.oci.tar> \
#     deployments/runtime-image
#
# The lockfile is kept with the release (image/lock/package-lock.json) and inside the image
# (/opt/rayspec/package-lock.json); scripts/gen-image-sbom.mjs lists what the image installed.
#
# What the image keeps, and why: /bin/sh, because the supervisor of a role-separated deploy
# re-executes itself through it to set a zero hard core-file limit; pg_dump and pg_restore of
# PostgreSQL 16, because export and import run them; ffmpeg and ffprobe, because a product that
# declares audio_input or media_playback stitches its recordings with them and fails closed without
# them; Node. The package managers of the base image (npm, npx, corepack, yarn) are removed. The
# Debian base userland stays as the base image ships it, plus the packages ffmpeg depends on.
#
# The host settings the managed posture requires are the host's, not the image's: see
# docs/runtime-image.md (`docker run --ulimit core=0`, kernel.yama.ptrace_scope of 1 or more).

ARG NODE_IMAGE=node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
ARG POSTGRES_IMAGE=postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c
# ffmpeg is Debian's own package at this version, installed from the archive as it stood at this
# moment (snapshot.debian.org), so a later build resolves the same packages. Move both together: the
# version must be the one that snapshot offers for Debian 13.
ARG DEBIAN_SNAPSHOT=20261001T000000Z
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1

# pg_dump and pg_restore of the pinned PostgreSQL image, with the shared libraries they load. Both
# images are Debian 13, so the libraries are the ones the binaries were built against.
FROM ${POSTGRES_IMAGE} AS pgtools
RUN set -eu; \
    bin=/usr/lib/postgresql/16/bin; \
    mkdir -p /out/bin /out/lib; \
    cp "$bin/pg_dump" "$bin/pg_restore" /out/bin/; \
    ldd "$bin/pg_dump" "$bin/pg_restore" \
      | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | sort -u \
      | while read -r lib; do cp -L "$lib" /out/lib/; done

# The dependency tree of the published closure, resolved once the way a consumer's npm resolves it:
# every @rayspec package from its tarball, everything else from the registry. Only the manifest and
# the lockfile leave this stage.
FROM ${NODE_IMAGE} AS resolve
COPY --from=tarballs . /build/tarballs/
WORKDIR /opt/rayspec
RUN set -eu; \
    printf '{"name":"rayspec-runtime","private":true}\n' > package.json; \
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund /build/tarballs/*.tgz

FROM scratch AS lock
COPY --from=resolve /opt/rayspec/package.json /opt/rayspec/package-lock.json /

# The published closure, installed with `npm ci` from that lockfile and nothing else: the versions
# and integrities it records, the tarballs at theirs, no install scripts.
FROM ${NODE_IMAGE} AS install
ARG RAYSPEC_VERSION
ARG SOURCE_COMMIT
RUN test -n "${RAYSPEC_VERSION}" && test -n "${SOURCE_COMMIT}"
COPY --from=tarballs . /build/tarballs/
COPY --from=lock /package.json /package-lock.json /opt/rayspec/
WORKDIR /opt/rayspec
RUN set -eu; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    node -e 'const v = require("/opt/rayspec/node_modules/rayspec/package.json").version; if (v !== process.argv[1]) { console.error(`installed rayspec ${v}, expected ${process.argv[1]}`); process.exit(1); }' "${RAYSPEC_VERSION}"
COPY healthcheck.mjs /opt/rayspec/healthcheck.mjs

FROM ${NODE_IMAGE}
ARG DEBIAN_SNAPSHOT
ARG FFMPEG_VERSION
# ffmpeg and ffprobe, without the packages Debian only recommends. The package lists, the logs and
# the caches the install leaves behind are removed, and the base image's own package sources are put
# back. The build then stitches two generated Ogg-Opus chunks the way the audio capability does
# (concat demuxer, stream copy, Ogg input through the file protocol only, the first error ends the
# run) and probes the result, so an ffmpeg that cannot do that fails here.
RUN set -eu; \
    sources=/etc/apt/sources.list.d; \
    mv "$sources/debian.sources" /tmp/debian.sources; \
    for archive in "debian trixie trixie-updates" "debian-security trixie-security"; do \
      set -- $archive; name="$1"; shift; \
      printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/%s/%s\nSuites: %s\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\nCheck-Valid-Until: no\n\n' \
        "$name" "${DEBIAN_SNAPSHOT}" "$*"; \
    done > "$sources/snapshot.sources"; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_VERSION}"; \
    apt-get clean; \
    rm "$sources/snapshot.sources"; \
    mv /tmp/debian.sources "$sources/debian.sources"; \
    rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log \
      /var/log/fontconfig.log /var/cache/debconf/*-old /var/cache/ldconfig/aux-cache \
      /var/cache/fontconfig; \
    ffmpeg -version; \
    ffprobe -version; \
    ffmpeg -hide_banner -demuxers | grep -Eq '^ *D[A-Za-z]* +concat '; \
    ffmpeg -hide_banner -muxers | grep -Eq '^ *E[A-Za-z]* +opus '; \
    work="$(mktemp -d)"; \
    for i in 0 1; do \
      ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:duration=1' \
        -c:a libopus "$work/chunk_$i.opus"; \
      printf "file 'chunk_%s.opus'\n" "$i" >> "$work/list.txt"; \
    done; \
    ffmpeg -nostdin -hide_banner -loglevel error -xerror -format_whitelist concat,ogg -protocol_whitelist file \
      -f concat -safe 0 -i "$work/list.txt" -c copy "$work/out.opus"; \
    test "$(ffprobe -v error -select_streams a -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 "$work/out.opus")" = opus; \
    ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \
      "$work/out.opus" | awk '{ d = $1 } END { exit !(d > 1.5) }'; \
    rm -rf "$work"
ARG RAYSPEC_VERSION
ARG SOURCE_COMMIT
COPY --from=pgtools /out/bin/ /usr/local/bin/
COPY --from=pgtools /out/lib/ /opt/pgtools/lib/
COPY --from=install /opt/rayspec /opt/rayspec
RUN set -eu; \
    for lib in /opt/pgtools/lib/*; do \
      name="$(basename "$lib")"; \
      if [ -e "/usr/lib/x86_64-linux-gnu/$name" ] || [ -e "/lib/x86_64-linux-gnu/$name" ]; then rm "$lib"; fi; \
    done; \
    echo /opt/pgtools/lib > /etc/ld.so.conf.d/pgtools.conf; \
    ldconfig; \
    pg_dump --version; \
    pg_restore --version; \
    ffmpeg -version > /dev/null; \
    ffprobe -version > /dev/null; \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh /opt/yarn-*; \
    groupadd --gid 10001 rayspec; \
    useradd --no-log-init --uid 10001 --gid rayspec --home-dir /var/lib/rayspec --no-create-home \
      --shell /usr/sbin/nologin rayspec; \
    install -d -o rayspec -g rayspec -m 0700 /var/lib/rayspec; \
    chown -R root:root /opt/rayspec /opt/pgtools; \
    chmod -R go-w /opt/rayspec /opt/pgtools
# RAYSPEC_HOST binds every address of the container's own network namespace; which of them the host
# exposes is decided by `docker run -p`.
ENV PATH=/opt/rayspec/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RAYSPEC_HOST=0.0.0.0 \
    PORT=8080
LABEL org.opencontainers.image.title="rayspec" \
      org.opencontainers.image.description="The RaySpec runtime: deploy and serve RaySpec applications" \
      org.opencontainers.image.source="https://github.com/rayspec-labs/rayspec" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.version="${RAYSPEC_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"
USER rayspec:rayspec
WORKDIR /var/lib/rayspec
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "/opt/rayspec/healthcheck.mjs"]
ENTRYPOINT ["rayspec"]
CMD ["--help"]
