# Releasing

This is the maintainer runbook for a RaySpec release: how a release candidate is built and tested,
how a candidate or a release is verified, and how the owner publishes. Nothing in this repository
publishes on its own. There are two supported ways to publish a release that the release workflow
(`.github/workflows/release.yml`) built and tested at its tag:

- **From the workflow** ([Publishing](#publishing)): a second dispatch from the release tag, signed
  for by the approver on their own machine and approved by a reviewer, makes every registry write.
  Its publish steps have not run yet.
- **From the owner's machine**
  ([Publishing from the owner's machine](#publishing-from-the-owners-machine)): the owner downloads
  the artifacts the workflow built, verifies them, and publishes those tarballs with
  `scripts/publish.mjs`. This is the path 1.9.1 takes. 1.9.0 was published from the owner's machine
  too, by hand with `npm publish <tarball> --access public`, because the script could not yet wait
  for a browser approval.

Both publish the same tested bytes. They differ in what the release carries besides the packages.

## How 1.9.0 and 1.9.1 are published

1.9.0 was published by the owner from their own machine with npm, not by the release workflow, and
1.9.1 is published the same way
([Publishing from the owner's machine](#publishing-from-the-owners-machine)). What such a release
carries differs from the table below in three places, and the documentation for users says so ([The runtime image](./runtime-image.md),
[Self-hosted deployment](./self-hosted-deployment.md)):

- **No npm provenance attestation.** npm attests provenance only for a publish from a supported CI
  workflow. The packages are the tarballs the release build packed and tested, and the release
  manifest lists their integrities; nothing attests where they were built.
- **An unsigned release manifest.** `release-manifest.json` is attached to the GitHub release
  without `release-manifest.json.sig`. It is the catalog the release build wrote. It proves nothing
  about who published the release.
- **No image in a registry.** The release build builds the runtime image and runs the image checks
  on it; the image is not pushed to `ghcr.io/rayspec-labs/rayspec` or anywhere else, and its archive
  is not attached to the GitHub release. The manifest's `images[0]` still names that repository and
  the digest of the image the build made, because the contract's schema requires both: read it as
  the record of what was built, not as something to pull. Users build the image from the release's
  tarballs ([Getting the image](./runtime-image.md#getting-the-image)).

The GitHub release of 1.9.0 has the packed tarballs, `release-manifest.json`,
`rayspec-release-identity.json` and `closure-sbom.cdx.json` attached, and none of the other files of
the table.

## What a release ships

The artifacts of a release the release workflow publishes:

| Artifact | Where | Made by |
|---|---|---|
| The npm packages of the publish set (the `rayspec` launcher, `@rayspec/cli`, `@rayspec/server` and every `@rayspec` package they depend on), with npm provenance | npm | `scripts/publish.mjs --publish --from <tarballs>`, which hands each tarball to `npm publish` |
| The linux/amd64 runtime image ([The runtime image](./runtime-image.md)) | `ghcr.io/rayspec-labs/rayspec`, by digest | `deployments/runtime-image/Dockerfile` |
| `release-manifest.json` and `release-manifest.json.sig`: the release catalog of the shared contract, signed by the approver with the Ed25519 release key | GitHub release | `scripts/release-manifest.mjs generate`, `sign` (on the approver's machine) |
| `release-evidence.json`: everything else, each bound by SHA-256 to the manifest | GitHub release | `scripts/release-manifest.mjs evidence` |
| `managed-receipt.json`: the managed-posture receipt | GitHub release | `scripts/managed-receipt.mjs` |
| `rayspec-release-identity.json`: the closure mapped back to its commit (also inside the launcher package) | GitHub release, npm | `scripts/release-identity.mjs` |
| `closure-sbom.cdx.json`: the CycloneDX 1.5 SBOM of the published closure as the workspace lockfile resolves it, with each tarball's SHA-512 | GitHub release | `scripts/gen-closure-sbom.mjs --tarballs` |
| `image-sbom.cdx.json`: the CycloneDX 1.5 SBOM of the npm packages installed in the image and of the Debian packages its dpkg record names (the base userland, ffmpeg and what it depends on), naming the image by digest | GitHub release | `scripts/gen-image-sbom.mjs` |
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

The image also installs ffmpeg, which a product that records audio needs: Debian's package at the
version the Dockerfile pins (`FFMPEG_VERSION`), from the Debian archive as it stood at the pinned
moment (`DEBIAN_SNAPSHOT`, served by snapshot.debian.org), so the build needs that host besides the
npm registry and Docker Hub. The build itself stitches two generated Ogg-Opus chunks and fails
when ffmpeg cannot; `image-conformance.mjs` repeats that through the audio capability installed in
the image, and `gen-image-sbom.mjs` refuses an image without an installed ffmpeg. To take a Debian
security update of ffmpeg, move both values together: the version must be the one that snapshot
offers (`apt-cache policy ffmpeg` in the base image, with its package sources pointed at the
snapshot). The Debian packages are listed in the image SBOM and are not scanned for advisories by
the candidate workflow, which scans the npm lockfile.

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

A release, or a candidate's manifest, is verified with the repository's tools. They run from a
checkout of the release tag that has been installed and built
(`git clone --depth 1 --branch v1.9.1 …`, then `pnpm install --frozen-lockfile && pnpm build`);
without the build, `release-manifest.mjs verify` refuses and names the missing package. The files
to check are the ones attached to the GitHub release (`gh release download v1.9.1`, with the
`.tgz` files moved into `./tarballs`).

For a release published from the owner's machine, which 1.9.0 and 1.9.1 are:

```bash
# The manifest: canonical, its schema, the contract's rules, and the tarballs it names.
node scripts/release-manifest.mjs verify --manifest release-manifest.json --tarballs ./tarballs

# The identity manifest against the tarballs (and against the checkout at its commit).
node scripts/release-identity.mjs --verify --tarballs ./tarballs --manifest rayspec-release-identity.json

# What npm serves.
npm view rayspec@1.9.1 dist.integrity   # the integrity the manifest lists for rayspec
```

Such a release has no signature file and no image archive, and its image is in no registry. The
verify shows that the manifest is well formed and that the tarballs are the bytes it lists, and
`npm view` that npm serves those bytes; it does not show who wrote the manifest.

A release published by the workflow adds a signature by the release key, the image archive and
the image in the registry. Anyone with the approver's public key then checks those too:

```bash
# As above, plus the signature by the release key and the image (every layer of the image archive
# with its own bytes).
node scripts/release-manifest.mjs verify --manifest release-manifest.json \
  --signature release-manifest.json.sig --trusted-key release-key.pub.pem \
  --tarballs ./tarballs --image-oci rayspec-runtime.oci.tar

# What the container registry serves.
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
tarballs, and the image archive when the release has one.

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

### Publishing from the owner's machine

The same release, published with npm from a terminal instead of by the workflow's second dispatch.
Steps 1 to 4 above are the same: the candidate, the release pull request, the tag, and the build
pass (the first dispatch of **Release**, which builds and tests the release's artifacts at the tag
and publishes nothing). That dispatch needs the `release` environment with its required reviewer;
it reads neither `NPM_TOKEN` nor the release key. Then, on the owner's machine:

1. **Download the artifacts of the build pass** into an empty directory:

   ```bash
   gh run download <run id> --name release-candidate --dir release-candidate
   ```

   It holds `tarballs/`, `release-manifest.json`, `rayspec-release-identity.json`,
   `closure-sbom.cdx.json` and `image/` (the image archive, its SBOM and its lockfile). The artifact
   is kept for 30 days.

2. **Verify them**, from a checkout of the tag with `pnpm install --frozen-lockfile && pnpm build`
   run (`git status` shows nothing, `git describe --exact-match` prints `v1.9.1`):

   ```bash
   # The release manifest against the tarballs and the image archive it names.
   node scripts/release-manifest.mjs verify --manifest release-candidate/release-manifest.json \
     --tarballs release-candidate/tarballs --image-oci release-candidate/image/rayspec-runtime.oci.tar

   # The identity manifest against the tarballs and against this checkout.
   node scripts/release-identity.mjs --verify --tarballs release-candidate/tarballs \
     --manifest release-candidate/rayspec-release-identity.json
   ```

   Both must report no failure. Publish nothing otherwise.

3. **Publish the tarballs** with the script, from a terminal (not through a script runner or a CI
   job) and do not pipe its output (no `| tee publish.log`): npm waits for a browser approval only
   while both its input and its output are the terminal. Be signed in to npm as the publishing
   account (`npm whoami`):

   ```bash
   RAYSPEC_ALLOW_PUBLISH=1 node scripts/publish.mjs --publish --yes-really-publish \
     --version 1.9.1 --from release-candidate/tarballs
   ```

   The script refuses unless the tag `v1.9.1` is annotated and points at the checkout, and unless
   the directory holds exactly one tarball per package of the publish set at that version. It then
   asks npm for each package's integrity and hands each tarball that is not on npm yet to
   `npm publish <tarball> --access public`, in dependency order, the `rayspec` launcher last. The
   packed files are published as they are; nothing is packed again.

   Each `npm publish` runs attached to your terminal. With a passkey or a security key as the
   account's second factor, npm prints an authentication URL and waits: open it, approve in the
   browser, and the publish goes on. npm can ask again for a later package (its approval page
   offers to remember an approval for a few minutes only), so stay at the terminal until the
   launcher is through. An account with an authenticator app passes its current code instead with
   `--otp <code>`; the code goes to every publish call and expires within about a minute, so the
   run stops when npm refuses it and the next run takes a new code.

   When a publish fails, the script names the package and the packages this run published before
   it, and exits 1. Fix the cause and run the same command again: every package npm already serves
   with the integrity of its tarball is skipped and the rest are published. A package npm serves
   with other bytes stops the run before anything is published, and the release then moves to the
   next version. Never publish a tarball by hand under a version that is partly public: the script
   compares the bytes, a hand does not.

4. **Check that npm serves what the manifest lists**, every package at its integrity:

   ```bash
   node --input-type=module -e "
     import { execFileSync } from 'node:child_process';
     import { readFileSync } from 'node:fs';
     const m = JSON.parse(readFileSync('release-candidate/release-manifest.json', 'utf8'));
     let bad = 0;
     for (const p of m.packages) {
       let served = '';
       try {
         served = execFileSync('npm', ['view', p.name + '@' + p.version, 'dist.integrity', '--prefer-online'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
       } catch {}
       if (served !== p.integrity) { console.error(p.name + ': the registry serves ' + (served || 'nothing')); bad++; }
     }
     if (bad > 0) process.exit(1);
     console.log(m.packages.length + ' packages resolve to the integrity the manifest names');
   "
   ```

   Every package npm does not serve, or serves with other bytes, is listed before the check exits
   1. The registry can take a minute to serve a version it has just accepted; a package it does not
   serve yet fails the check, so run it again before concluding anything.

5. **Create the GitHub release** from the tag, with the tested artifacts attached:

   ```bash
   gh release create v1.9.1 --verify-tag --title "RaySpec 1.9.1" \
     --notes "See CHANGELOG.md and docs/releasing.md. Published from the owner's machine: no npm provenance, an unsigned release manifest, no image in a registry." \
     release-candidate/release-manifest.json \
     release-candidate/rayspec-release-identity.json \
     release-candidate/closure-sbom.cdx.json \
     release-candidate/tarballs/*.tgz
   ```

#### What this path does not produce

- **npm provenance.** npm attests provenance only for a publish from a supported CI workflow, and
  an attestation cannot be added to a version afterwards. The packages of such a release carry
  none; the first release with provenance is the first one the workflow publishes.
- **A signed release manifest**, unless the approver signs it by hand (below). The unsigned
  manifest shows which bytes the release build made; it does not show who published them.
- **An image in a registry.** The release build built and tested the image; nothing pushed it.
  Users build the image from the release's tarballs
  ([Getting the image](./runtime-image.md#getting-the-image)).
- **`release-evidence.json` and `managed-receipt.json`.** The workflow's publish job writes them
  from the signature and the certification lane of the build pass; the local path does not.

The user documentation says the first three for 1.9.0 and 1.9.1. When a release adds the signature
or the image afterwards, change those pages in the same change
([The runtime image](./runtime-image.md), [Self-hosted deployment](./self-hosted-deployment.md), and
[How 1.9.0 and 1.9.1 are published](#how-190-and-191-are-published) above).

#### Adding the signature afterwards

The approver signs the manifest of the build pass with the release key, on their machine, and
attaches the signature file to the GitHub release. The manifest must be the file that is attached
to the release, byte for byte: the signature names its SHA-256.

```bash
node scripts/release-manifest.mjs sign --manifest release-candidate/release-manifest.json \
  --key-file release-key.pem --trusted-key release-key.pub.pem
gh release upload v1.9.1 release-candidate/release-manifest.json.sig
```

The public key has to be published where integrators read it
([Publishing](#publishing), step 2 of the one-time setup); a signature nobody can check against a
key they trust adds nothing. From then on the release verifies with `--signature` and
`--trusted-key` ([Verifying a release](#verifying-a-release)).

#### Pushing the image afterwards

The image archive of the build pass is the image the release build tested and the manifest names
by digest. Copy it without conversion, so the registry serves that digest, and compare:

```bash
repository="$(node -p "require('./release-candidate/release-manifest.json').images[0].repository")"
digest="$(node -p "require('./release-candidate/release-manifest.json').images[0].digest")"
skopeo login ghcr.io --username <github user>      # a token with write:packages
skopeo copy --preserve-digests \
  oci-archive:release-candidate/image/rayspec-runtime.oci.tar "docker://${repository}:1.9.1"
# shasum is the macOS tool; on Linux use sha256sum.
served="sha256:$(skopeo inspect --raw "docker://${repository}@${digest}" | shasum -a 256 | cut -d' ' -f1)"
[ "${served}" = "${digest}" ] && echo "the registry serves ${digest}"
```

Push only the archive of the build pass: an image built again from the tarballs has another digest
than the one the manifest names. Make the package public in the repository's package settings, and
attach `release-candidate/image/image-sbom.cdx.json` and the image's lockfile
(`release-candidate/image/lock/package-lock.json`, as `image-package-lock.json`) to the GitHub
release with `gh release upload`.

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
  Do not finish a workflow release from a workstation: a publish outside the workflow carries no
  provenance, and the release would carry it for some packages only. A release published from the
  owner's machine continues there, with the same command
  ([Publishing from the owner's machine](#publishing-from-the-owners-machine), step 3).
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
- The release workflow's publish steps have not run yet: 1.9.0 and 1.9.1 are published from the
  owner's machine (see How 1.9.0 and 1.9.1 are published), so the first release the workflow
  publishes is their first run.
- The image's Debian packages, ffmpeg among them, are pinned by the base image's digest and the
  Debian snapshot and listed in the image SBOM; no step scans them for advisories.
