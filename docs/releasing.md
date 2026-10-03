# Releasing

This is the maintainer runbook for a RaySpec release: how a release candidate is built and tested,
how a candidate or a release is verified, and how the owner publishes. Nothing in this repository
publishes on its own. Every registry write happens in the release workflow
(`.github/workflows/release.yml`), which a maintainer dispatches by hand from the release tag and a
reviewer approves.

## What a release ships

| Artifact | Where | Made by |
|---|---|---|
| The npm packages of the publish set (the `rayspec` launcher, `@rayspec/cli`, `@rayspec/server` and every `@rayspec` package they depend on), with npm provenance | npm | `scripts/publish.mjs --publish --from <tarballs>` |
| The linux/amd64 runtime image ([The runtime image](./runtime-image.md)) | `ghcr.io/rayspec-labs/rayspec`, by digest | `deployments/runtime-image/Dockerfile` |
| `release-manifest.json` and `release-manifest.json.sig`: the release catalog of the shared contract, signed with the Ed25519 release key | GitHub release | `scripts/release-manifest.mjs generate`, `sign` |
| `release-evidence.json`: everything else, each bound by SHA-256 to the manifest | GitHub release | `scripts/release-manifest.mjs evidence` |
| `managed-receipt.json`: the managed-posture receipt | GitHub release | `scripts/managed-receipt.mjs` |
| `rayspec-release-identity.json`: the closure mapped back to its commit (also inside the launcher package) | GitHub release, npm | `scripts/release-identity.mjs` |
| `closure-sbom.cdx.json`: the CycloneDX 1.5 SBOM of the published closure, with each tarball's SHA-512 | GitHub release | `scripts/gen-closure-sbom.mjs --tarballs` |
| The packed tarballs | GitHub release | `scripts/publish.mjs --pack` |

The release manifest is exactly the contract's `release-manifest.schema.json`, a closed schema: the
version, the source commit, the identity manifest's SHA-256, the targets, every package with its npm
integrity, and the image with its platform, Node version, repository and digest. The managed receipt
names the manifest's SHA-256, so the receipt and everything else a release hands over live in
`release-evidence.json` beside it: the contract version and digest, every package with its SHA-256,
the image's registry reference, the schemas with their SHA-256, the fixture corpus digest, the
previous supported version and the upgrade results from it, the platform schema head, the
capabilities, the receipt, the SBOM and an index of every evidence file. Neither document is written
with a value that was not read from its artifact: a missing input, or a value that looks like a
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
`image/rayspec-runtime.oci.tar`, `release-manifest.json`, `candidate.json` (every artifact with its
SHA-256 and the outcome of each step) and `logs/`. Check that `git status` shows nothing.

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
# the tarballs and image it names.
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

## Publishing

The owner publishes. Before the first release, once:

1. Generate the Ed25519 release key on the approver's machine and keep the private key there:
   `openssl genpkey -algorithm ed25519 -out release-key.pem` and
   `openssl pkey -in release-key.pem -pubout -out release-key.pub.pem`.
2. Create the GitHub environment `release` with at least one required reviewer, and give it the
   secrets `RAYSPEC_RELEASE_SIGNING_KEY` (the private key PEM) and `NPM_TOKEN` (an npm automation
   token for the `rayspec` packages), and the variable `RAYSPEC_RELEASE_PUBLIC_KEY` (the public key
   PEM). Publish the public key where integrators read it.
3. Allow the workflow to write the `ghcr.io/rayspec-labs/rayspec` package.

For each release:

1. Build and test a candidate (above) and fix what it finds; a fix gets a new `-rc.N`.
2. Open the release pull request: the version in the root `package.json` and in every RaySpec
   member manifest (`scripts/publish.mjs` refuses any that disagree), and the CHANGELOG's
   Unreleased heading renamed to the version and date. Merge it when CI and the candidate workflow
   are green.
3. Tag the merge commit: `git tag -a v1.9.0 -m "RaySpec 1.9.0"` and push the tag.
4. Dispatch **Release** from the tag `v1.9.0` with `version` `1.9.0` and `confirm`
   `publish rayspec 1.9.0`. The workflow refuses anything else, and refuses a version npm already has.
5. The workflow builds the release's own artifacts from the tag (`release-candidate.mjs --release`,
   nothing stamped), runs the whole conformance and the upgrade matrix on them, and runs the
   certification lane at the tag. Then, in the `release` environment, after a reviewer approves:
   it makes the managed receipt, signs the release manifest and verifies the signature against the
   approver's public key, writes the evidence, publishes the tested tarballs themselves with npm
   provenance, copies the archived image to GHCR without conversion and checks the registry serves
   its digest, checks npm serves every integrity the manifest lists, and creates the GitHub release
   with every artifact attached.

### When a release fails

- **Before the publish step:** nothing reached a registry. Fix the cause, and dispatch again (a new
  commit means a new tag and, once anything was public, a new version).
- **During the npm publish:** `publish.mjs` publishes in dependency order and stops at the first
  failure; the packages before it are public. Never unpublish and never publish other bytes under a
  published version. Publish the remaining tarballs of the same artifact with
  `node scripts/publish.mjs --publish --yes-really-publish --from <tarballs>` only if every published
  integrity matches the manifest; otherwise move to the next version.
- **During the image push or the release creation:** the npm packages are public. The image archive
  and the signed documents are the workflow's artifacts: push the archive with
  `skopeo copy --preserve-digests oci-archive:rayspec-runtime.oci.tar docker://ghcr.io/rayspec-labs/rayspec:1.9.0`
  and check the digest, then create the GitHub release by hand with the same files.
- **A defect found after the release:** stop recommending the version, say which versions are
  affected and why, and release a fix. Never downgrade a database: a runtime refuses a platform schema
  newer than its own chain.

## Known limits

- The image journeys need host networking, so they run on Linux (the candidate workflow); on macOS
  the image check (`image-conformance.mjs`) serves one reference application through a container
  network instead.
- The closure SBOM describes the closure as the workspace lockfile resolves it. A consumer's npm
  resolves afresh; `scripts/check-consumer-install.mjs` scans that tree separately.
- The release workflow's publish steps have not run yet: the first release is their first run.
