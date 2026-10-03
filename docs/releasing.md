# Releasing

This is the maintainer runbook for a RaySpec release: how a release candidate is built and tested,
how a candidate or a release is verified, and how the owner publishes. Nothing in this repository
publishes on its own. Every registry write happens in the release workflow
(`.github/workflows/release.yml`), which a maintainer dispatches by hand from the release tag, the
approver signs for on their own machine, and a reviewer approves.

## What a release ships

| Artifact | Where | Made by |
|---|---|---|
| The npm packages of the publish set (the `rayspec` launcher, `@rayspec/cli`, `@rayspec/server` and every `@rayspec` package they depend on), with npm provenance | npm | `scripts/publish.mjs --publish --from <tarballs>` |
| The linux/amd64 runtime image ([The runtime image](./runtime-image.md)) | `ghcr.io/rayspec-labs/rayspec`, by digest | `deployments/runtime-image/Dockerfile` |
| `release-manifest.json` and `release-manifest.json.sig`: the release catalog of the shared contract, signed by the approver with the Ed25519 release key | GitHub release | `scripts/release-manifest.mjs generate`, `sign` (on the approver's machine) |
| `release-evidence.json`: everything else, each bound by SHA-256 to the manifest | GitHub release | `scripts/release-manifest.mjs evidence` |
| `managed-receipt.json`: the managed-posture receipt | GitHub release | `scripts/managed-receipt.mjs` |
| `rayspec-release-identity.json`: the closure mapped back to its commit (also inside the launcher package) | GitHub release, npm | `scripts/release-identity.mjs` |
| `closure-sbom.cdx.json`: the CycloneDX 1.5 SBOM of the published closure as the workspace lockfile resolves it, with each tarball's SHA-512 | GitHub release | `scripts/gen-closure-sbom.mjs --tarballs` |
| `image-sbom.cdx.json`: the CycloneDX 1.5 SBOM of the npm packages installed in the image, naming the image by digest | GitHub release | `scripts/gen-image-sbom.mjs` |
| `package-lock.json` of the image: the tree the image was installed from with `npm ci` | GitHub release, and `/opt/rayspec/package-lock.json` in the image | the Dockerfile's `lock` stage |
| The packed tarballs | GitHub release | `scripts/publish.mjs --pack` |

The release manifest is exactly the contract's `release-manifest.schema.json`, a closed schema: the
version, the source commit, the identity manifest's SHA-256, the targets, every package with its npm
integrity, and the image with its platform, Node version, repository and digest. The managed receipt
names the manifest's SHA-256, so the receipt and everything else a release hands over live in
`release-evidence.json` beside it: the contract version and digest, every package with its SHA-256,
the image's registry reference, the schemas with their SHA-256, the fixture corpus digest, the
previous supported version and the upgrade results from it, the platform schema head, the
capabilities, the receipt, both SBOMs and an index of every evidence file. The evidence accepts an
image SBOM only when it names the manifest's image and shows each release tarball installed in the
image at the tarball's integrity, and an upgrade report only when the harness ran the CLI of the
candidate install and that CLI reported the release version. Neither document is written with a
value that was not read from its artifact: a missing input, or a value that looks like a
placeholder, refuses the run.

## Versions

A release candidate is stamped `x.y.z-rc.N` while its artifacts are built and the stamp is removed
afterwards: the committed tree keeps its version, and `scripts/release-candidate.mjs` refuses to go
on unless every manifest is back at its committed bytes. A candidate version is always a pre-release
above the committed version; the builder refuses a release version. The version is committed only
in the release pull request. A version that reached npm is never published again: a failed release
continues under the next pre-release or patch version.

## Building a candidate

In CI, `candidate.yml` builds and tests a candidate on every push to `main` (version
`<next minor>.0-main.<run number>`) and on a manual dispatch with the version you name, and keeps
everything as workflow artifacts (`release-candidate`, `candidate-conformance`, `upgrade-*`).

Locally, from a clean checkout of the commit:

```bash
pnpm install --frozen-lockfile && pnpm build
docker buildx create --name rayspec-release --driver docker-container
pnpm release:candidate --version 1.9.0-rc.0 --out ./candidate --builder rayspec-release
```

`./candidate` then holds `tarballs/`, `rayspec-release-identity.json`, `closure-sbom.cdx.json`,
`image/rayspec-runtime.oci.tar`, `image/lock/package-lock.json` (the tree the image installed),
`image/image-sbom.cdx.json`, `release-manifest.json`, `candidate.json` (every artifact with its
SHA-256 and the outcome of each step) and `logs/`. Check that `git status` shows nothing.

The image is built in two steps. The Dockerfile's `lock` stage resolves the dependency tree of the
tarballs once, the way a consumer's npm resolves it: every `@rayspec` package from its tarball,
every third-party package from the registry at that moment. The image then installs exactly that
lockfile with `npm ci`, and the builder checks that the image holds it. So the third-party versions
in the image are the ones the registry served when the candidate was built, which can be newer than
the ones the workspace lockfile pins and `closure-sbom.cdx.json` lists; `image-sbom.cdx.json` lists
what the image holds, and the candidate workflow scans the lockfile with osv-scanner as ci.yml scans
a consumer install.

Then test exactly those artifacts. DATABASE_URL names a PostgreSQL 16 server where databases and
roles may be created (see `.env.example`).

```bash
# The tarballs installed into an empty directory, the way a consumer installs them.
node scripts/check-consumer-install.mjs --tarballs ./candidate/tarballs --out ./consumer

# The contract corpus through the installed CLI. One corpus case is generated, not committed.
pnpm --filter @rayspec/bundle-contract exec tsx scripts/gen-corpus.ts --uncommitted "$PWD/generated"
node scripts/corpus-conformance.mjs --cli ./consumer/node_modules/rayspec/dist/bin.js \
  --expectations ./consumer/node_modules/@rayspec/bundle-contract/contract/fixtures/EXPECTATIONS.json \
  --corpus packages/kernel/bundle-contract/corpus --generated ./generated

# The three reference applications and the quickstart through the installed release (the
# quickstart installs the tarballs itself, as its page does).
node scripts/reference-journeys.mjs --consumer ./consumer --tarballs ./candidate/tarballs

# The image: loaded from the archive, checked, the corpus through its CLI, team-notes served.
docker load -i ./candidate/image/rayspec-runtime.oci.tar
node scripts/image-conformance.mjs --oci ./candidate/image/rayspec-runtime.oci.tar \
  --image rayspec-candidate:1.9.0-rc.0 --consumer ./consumer --generated ./generated

# The three reference applications with every rayspec command in a container of the image.
# Linux only: the containers share the host network with the journey's servers and database.
node scripts/reference-journeys.mjs --consumer ./consumer --image rayspec-candidate:1.9.0-rc.0

# The upgrade with data from each supported previous release onto the candidate install.
for from in 1.7.0 1.8.0; do
  node scripts/upgrade-with-data.mjs --from "$from" --candidate ./consumer
  node scripts/upgrade-with-data.mjs --from "$from" --candidate ./consumer --roles
done
```

`scripts/upgrade-with-data.mjs` also takes `--app team-notes` and `--app asset-catalog`; the candidate
workflow runs every application from both versions.

A candidate carries no managed receipt. The receipt binds the certification lane's commit and the
runtime version that commit carries, and a candidate's version exists only while its artifacts are
built. The receipt and the evidence document are made for the release, from the certification lane
the release workflow runs at the release tag.

## Verifying a release

Anyone with the approver's public key verifies a release, or a candidate's manifest, with the
repository's tools:

```bash
# The manifest: canonical, its schema, the contract's rules, the signature by the release key, and
# the tarballs and image it names (every layer of the image archive with its own bytes).
node scripts/release-manifest.mjs verify --manifest release-manifest.json \
  --signature release-manifest.json.sig --trusted-key release-key.pub.pem \
  --tarballs ./tarballs --image-oci rayspec-runtime.oci.tar

# The identity manifest against the tarballs (and against the checkout at its commit).
node scripts/release-identity.mjs --verify --tarballs ./tarballs --manifest rayspec-release-identity.json

# What the registries serve.
npm view rayspec@1.9.0 dist.integrity   # the integrity the manifest lists for rayspec
docker buildx imagetools inspect ghcr.io/rayspec-labs/rayspec@<digest from the manifest>
```

The signature is the contract's detached signature file: Ed25519 over
`rayspec-release-manifest-v1\nsha256:<SHA-256 of the manifest file>\n`, naming the SHA-256 of the
release public key. A `.ray` signature uses another domain string, so neither verifies as the other.

### What a rebuild reproduces

A release is checked against its own published artifacts, not against a rebuild. A rebuild of the
same commit is not byte for byte the same: pnpm writes the dependencies of a packed manifest in its
own order, `tsc` can emit the members of a union type in another order in a declaration file (so
the file-list digest of `@rayspec/server` in the identity manifest can differ), and the image's
third-party packages are resolved from the registry when its lockfile is written. The image's
timestamps are the commit's time (`SOURCE_DATE_EPOCH`), so they do not differ between builds.
Verify a release with `release-identity.mjs --verify` and `release-manifest.mjs verify` against the
tarballs and the image archive the release ships.

## Publishing

The owner publishes. The release key is held by the approver: it never leaves their machine and is
never given to a workflow. Before the first release, once:

1. The approver generates the Ed25519 release key on their machine and keeps the private key there,
   readable by them only:
   `openssl genpkey -algorithm ed25519 -out release-key.pem && chmod 600 release-key.pem` and
   `openssl pkey -in release-key.pem -pubout -out release-key.pub.pem`.
2. Create the GitHub environment `release` with at least one required reviewer, and give it the
   secret `NPM_TOKEN` and the variable `RAYSPEC_RELEASE_PUBLIC_KEY` (the approver's public key
   PEM). Publish the public key where integrators read it. The workflow refuses to run while the
   environment has no required reviewer.

   `NPM_TOKEN` is an npm **granular access token** (npm no longer issues classic or automation
   tokens): read and write on the package `rayspec` and on the `@rayspec` scope (the scope, not a
   list of packages, so a package new in the release can be created), **Bypass 2FA** enabled (the
   workflow cannot answer a one-time password), and an expiry later than the day of the publish. A
   granular write token lasts 90 days at most, so create or renew it shortly before each release and
   check it before the publish dispatch:
   `npm whoami --//registry.npmjs.org/:_authToken="$TOKEN"` prints the publishing account.
3. Allow the workflow to write the `ghcr.io/rayspec-labs/rayspec` package.

For each release:

1. Build and test a candidate (above) and fix what it finds; a fix gets a new `-rc.N`.
2. Open the release pull request: the version in the root `package.json` and in every RaySpec
   member manifest (`scripts/publish.mjs` refuses any that disagree), and the CHANGELOG's
   Unreleased heading renamed to the version and date. Merge it when CI and the candidate workflow
   are green.
3. Tag the merge commit: `git tag -a v1.9.0 -m "RaySpec 1.9.0"` and push the tag.
4. Dispatch **Release** from the tag `v1.9.0` with `version` `1.9.0` and `confirm`
   `publish rayspec 1.9.0`, and nothing else. The workflow refuses anything else, and refuses a
   version npm already has. It builds the release's own artifacts from the tag
   (`release-candidate.mjs --release`, nothing stamped), runs the whole conformance and the upgrade
   matrix on them, runs the certification lane at the tag, and verifies the release manifest. It
   signs and publishes nothing.
5. The approver downloads the `release-candidate` artifact of that run, checks it and signs the
   manifest on their machine, from a checkout of the tag with `pnpm build` run:

   ```bash
   node scripts/release-manifest.mjs verify --manifest release-candidate/release-manifest.json \
     --tarballs release-candidate/tarballs --image-oci release-candidate/image/rayspec-runtime.oci.tar
   node scripts/release-manifest.mjs sign --manifest release-candidate/release-manifest.json \
     --key-file release-key.pem --trusted-key release-key.pub.pem
   ```

6. Dispatch **Release** again from the tag, with the same `version` and `confirm`, `build_run` the
   id of the run of step 4, and `signature` the signature file in base64:

   ```bash
   gh workflow run release.yml --ref v1.9.0 -f version=1.9.0 -f confirm='publish rayspec 1.9.0' \
     -f build_run=<run id> -f signature="$(base64 < release-candidate/release-manifest.json.sig | tr -d '\n')"
   ```

   The workflow checks that the run is a successful release build of the same commit and, in the
   `release` environment after a reviewer approves, verifies the signature against
   `RAYSPEC_RELEASE_PUBLIC_KEY`, makes the managed receipt from that run's certification lane,
   writes the evidence, publishes that run's tarballs themselves with npm provenance, copies its
   archived image to GHCR without conversion and checks the registry serves its digest, checks npm
   serves every integrity the manifest lists, and creates the GitHub release with every artifact
   attached. The artifacts of step 4 are kept for 30 days: sign and publish within that time, or
   build again.

### When a release fails

- **Before the publish step:** nothing reached a registry. Fix the cause, and dispatch again (a new
  commit means a new tag and, once anything was public, a new version).
- **During the npm publish:** `publish.mjs` publishes in dependency order, the `rayspec` launcher
  last, and stops at the first failure; the packages before it are public. Never unpublish and never
  publish other bytes under a published version. Fix the cause (an expired token, for example) and
  dispatch the publish again with the same `build_run` and `signature`: the guard admits it while
  the launcher is not on npm, and `publish.mjs --from` skips every package npm already serves with
  the integrity of its tarball, publishes the rest with provenance from the workflow, and refuses
  before the first call when npm serves a package with other bytes (then move to the next version).
  Do not publish the rest from a workstation: a publish outside the workflow carries no provenance.
- **During the image push or the release creation:** the npm packages are public. The image archive
  and the signed documents are the workflow's artifacts: push the archive with
  `skopeo copy --preserve-digests oci-archive:rayspec-runtime.oci.tar docker://ghcr.io/rayspec-labs/rayspec:1.9.0`
  and check the digest, then create the GitHub release by hand with the same files.
- **A defect found after the release:** stop recommending the version, say which versions are
  affected and why, and release a fix. Never downgrade a database: a runtime from 1.9.0 on refuses a
  platform schema newer than its own chain, and an older one does not notice, so going back starts
  from the backup taken before the upgrade.

## Known limits

- The image journeys need host networking, so they run on Linux (the candidate workflow); on macOS
  the image check (`image-conformance.mjs`) serves one reference application through a container
  network instead.
- The closure SBOM describes the closure as the workspace lockfile resolves it. A consumer's npm
  resolves afresh; `scripts/check-consumer-install.mjs` scans that tree separately. The image holds
  the tree its own lockfile records, resolved when the image was built: `image-sbom.cdx.json`
  describes it, and its third-party versions can differ from the closure SBOM's.
- A rebuild of a commit is not byte-reproducible (see What a rebuild reproduces).
- The release workflow's publish steps have not run yet: the first release is their first run.
