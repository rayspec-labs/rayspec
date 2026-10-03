# The RaySpec runtime image: linux/amd64, Node at the pinned 22 patch, the published closure installed
# from the packed release tarballs (never from workspace links), run as a non-root user that cannot
# write the installation.
#
# Built by scripts/release-candidate.mjs (see docs/releasing.md), with the tarballs as a named build
# context:
#
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     --build-context tarballs=<dir of the packed .tgz files> \
#     --build-arg RAYSPEC_VERSION=<version> --build-arg SOURCE_COMMIT=<40-hex commit> \
#     --output type=docker,oci-mediatypes=true,dest=<image.oci.tar> deployments/runtime-image
#
# What the image keeps, and why: /bin/sh, because the supervisor of a role-separated deploy
# re-executes itself through it to set a zero hard core-file limit; pg_dump and pg_restore of
# PostgreSQL 16, because export and import run them; Node. The package managers of the base image
# (npm, npx, corepack, yarn) are removed. The Debian base userland stays as the base image ships it.
#
# The host settings the managed posture requires are the host's, not the image's: see
# docs/runtime-image.md (`docker run --ulimit core=0`, kernel.yama.ptrace_scope of 1 or more).

ARG NODE_IMAGE=node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
ARG POSTGRES_IMAGE=postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c

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

# The published closure, installed from the tarballs the way a consumer installs them: every
# @rayspec package from its tarball, everything else from the registry, no install scripts.
FROM ${NODE_IMAGE} AS install
ARG RAYSPEC_VERSION
ARG SOURCE_COMMIT
RUN test -n "${RAYSPEC_VERSION}" && test -n "${SOURCE_COMMIT}"
COPY --from=tarballs . /build/tarballs/
WORKDIR /opt/rayspec
RUN set -eu; \
    printf '{"name":"rayspec-runtime","private":true}\n' > package.json; \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund /build/tarballs/*.tgz; \
    node -e 'const v = require("/opt/rayspec/node_modules/rayspec/package.json").version; if (v !== process.argv[1]) { console.error(`installed rayspec ${v}, expected ${process.argv[1]}`); process.exit(1); }' "${RAYSPEC_VERSION}"
COPY healthcheck.mjs /opt/rayspec/healthcheck.mjs

FROM ${NODE_IMAGE}
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
