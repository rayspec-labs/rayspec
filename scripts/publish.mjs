#!/usr/bin/env node
/**
 * RaySpec release packer/publisher — the single sanctioned path to put the CLI + its runtime closure
 * on npm.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Every RaySpec package is committed as `private: true` at the current release version — the
 * `private: true` flag (not the version) is the deliberate accidental-publish guard: a bare
 * `pnpm publish` / `npm publish` at the repo root or in any package refuses, and no CI job
 * publishes except the manually dispatched release workflow (`.github/workflows/release.yml`), which
 * runs this script behind a protected environment and a typed confirmation. This script is the ONLY
 * place that lifts that guard, and it
 * does so TRANSIENTLY and IN MEMORY of the working tree: for the duration of a pack/publish run it
 * rewrites each publish target's `package.json` to
 *   - `version`  → the release version DERIVED from the repo-root `package.json` (see below),
 *   - `private`  → `false`,
 *   - `files`    → `["dist"]` if the package does not already declare it (so the tarball ships compiled
 *                  `dist/` only — never `src/`, tests, a stray `.env`, or `.turbo` logs),
 * runs the requested command, and ALWAYS restores the original bytes in a `finally` (even on error /
 * SIGINT). After a run the committed tree is byte-identical to before — the guard is never weakened on
 * disk, and the byte-frozen adapter manifests under `packages/adapters/**` are touched only in this
 * transient, self-reverting way (mirroring the sanctioned private-flip).
 *
 * WHERE THE VERSION COMES FROM
 * ----------------------------
 * There is no default version and no way to override one. The release version is DERIVED from the ONE
 * authoritative manifest — the repo-root `package.json` `version` — and a PREFLIGHT then refuses,
 * before the first manifest is stamped and before the first `pnpm` child process, unless
 *   - every RaySpec manifest already carries that version (the `@rayspec/*` members plus the unscoped
 *     launcher, including the ones that are never published), and
 *   - every package in the publish set declares the Node requirement (see below), and
 *   - HEAD does not carry an annotated release tag naming a DIFFERENT version, and
 *   - in `--publish` only: the annotated tag `v<version>` exists and points at HEAD.
 * `--version <v>` is an ASSERTION against the derived value, never an override: given and unequal, the
 * run refuses. So no input makes this script pack or publish a version the tree does not carry.
 *
 * THE NODE REQUIREMENT
 * --------------------
 * `engines.node` is the only thing that makes a CONSUMER's package manager check the Node floor at
 * install time, so every publish target declares it in its COMMITTED manifest and the preflight
 * refuses when a target omits it or declares a value other than the repo-root `engines.node` (the one
 * source of the string — a future Node bump moves one number). The stamping step deliberately does NOT
 * inject it: injecting it would let a package ship a requirement its committed manifest never carried,
 * which is exactly what the guard exists to prevent. Members outside the publish set are not checked —
 * they are never installed by anyone.
 *
 * THE SOURCE REPOSITORY
 * ---------------------
 * The release workflow publishes with npm provenance, and the registry accepts a provenance statement
 * only when the package's `repository.url` names the repository the workflow ran in; a package
 * without one is refused at publish time, after the packages before it in the order are already
 * public. So every publish target declares `repository` in its COMMITTED manifest: the repo-root
 * `repository.url` (the one source of the string) and `directory`, its own path in the repository.
 * The preflight refuses a target that omits either or disagrees, and `--from` refuses a tarball whose
 * packed manifest does, before the first call. Like the Node requirement, nothing injects it.
 *
 * WORKSPACE VERSION COUPLING
 * --------------------------
 * Internal deps are declared `@rayspec/x: "workspace:*"`. Because ALL targets are stamped to the SAME
 * version before anything is packed, pnpm rewrites every `workspace:*` to that exact version in the
 * packed manifest (measured by unpacking a `--pack` tarball: each `workspace:*` dep is rewritten to the
 * stamped version). One version string, one tag, the whole closure in lockstep — no changesets, no
 * per-package drift.
 *
 * MODES (default: --dry-run; a real registry write is opt-in and double-gated)
 * ---------------------------------------------------------------------------
 *   --pack         `pnpm pack` each target into --out (default a temp dir), writing one .tgz per
 *                  target. TOKENLESS, no registry contact. The tarball-contents proof: the archives
 *                  are on disk to inspect (the child's own output is captured, not printed).
 *   --dry-run      `pnpm publish --dry-run --no-git-checks` each target (the default). Simulates the
 *                  publish incl. workspace resolution; no registry write. Tokenless in normal operation
 *                  (if your registry demands auth even for a dry-run, use --pack instead). npm asks
 *                  the registry in a dry run too, and refuses a version that is already published.
 *   --publish      REAL publish. Double-gated: also requires `--yes-really-publish` AND
 *                  `RAYSPEC_ALLOW_PUBLISH=1`. Publishes in dependency order (deps before dependents),
 *                  each target with `--access public`, so a scoped package that is new in the
 *                  release is created public. Intended for the founder-run release window only.
 *
 * PUBLISHING THE TESTED BYTES (--from <dir>)
 * --------------------------------------------
 * `--publish` and `--dry-run` repack each target by default, so the registry receives a tarball
 * nobody tested (packing is not byte-reproducible). With `--from <dir>` — the output of an earlier
 * `--pack` that the candidate conformance ran on — the run stamps nothing and hands each tarball to
 * `npm publish <file>` (with `--dry-run` in a dry run) instead, in dependency order. Before the
 * first call it refuses unless the directory holds exactly one tarball per publish target, each
 * declaring that target's name and the release version. The release manifest's integrities then
 * match the registry's.
 *
 * THE SECOND FACTOR
 * -----------------
 * A real publish runs attached to the terminal this script was started from: its child inherits
 * stdin, stdout and stderr. An account whose two-factor authentication is a browser passkey gets an
 * authentication URL from npm, which then waits on that terminal for the approval. npm waits only
 * when both its stdin and its stdout are a terminal: with either one piped (`| tee publish.log`
 * is enough) it cannot wait and the first target fails with EOTP, so do not pipe this script's
 * output. `--otp <code>` hands a one-time code of an authenticator app to every publish call
 * instead (a code is short-lived: when it expires part way, the run stops and the next run
 * continues with a new code). The release workflow needs neither: its token bypasses the second
 * factor. With `--json` the child's stdout goes to this script's stderr,
 * so stdout stays the one JSON document.
 *
 * CONTINUING A PUBLISH THAT STOPPED PART WAY
 * ------------------------------------------
 * A version on npm can never be published again, so a `--publish --from` run first asks the
 * registry for each target's `dist.integrity` at the release version. A target the registry already
 * serves with the integrity of its tarball here is skipped; one it serves with any other integrity
 * refuses the whole run before the first call (those bytes are public, and the release must move to
 * a new version); a lookup that fails for any reason other than "not found" refuses too. Running the
 * same publish again over the same tarballs therefore publishes exactly the targets that are
 * missing (from the release workflow, with provenance). The `rayspec` launcher always goes last, so
 * the launcher being on npm means the whole closure is: the release workflow's guard reads that.
 *
 * A publish call that fails stops the run: the manifests are restored, the failed target is named
 * with the targets this run published before it, and the exit code is 1 (a dry run that fails
 * names its target the same way). After a `--from` run the
 * same command continues. A run without `--from` packed its own bytes and cannot be continued: what
 * it published stays, and the next pack of those targets has other bytes.
 *
 * Other flags: --version <v> (asserts the derived version) · --otp <code> (with --publish only) ·
 * --out <dir> (pack destination; a
 * relative path is resolved against the current working directory once, before anything is packed,
 * so every target lands in that ONE directory and the run prints the absolute path) ·
 * --json (machine output).
 *
 * This script performs no git WRITES — it only READS the workspace state (`git ls-files`, tag identity)
 * and never creates a commit, a tag or a release. No package lifecycle hook runs it. CI runs it with
 * `--pack` for the consumer-install audit and the release candidate; a `--publish` runs only in the
 * release workflow, which a human dispatches, or on the owner's machine (docs/releasing.md describes
 * both). CI also executes a copy of it against a throwaway fixture repo with the package manager
 * and the registry stubbed (`scripts/publish.test.mjs`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The ONE manifest the release version is read from; every other manifest is checked against it.
const VERSION_SOURCE = 'package.json';
// The opt-in gate for a REAL registry write (read via computed access — this is a release-tool env var,
// not a turbo task input, so it is intentionally not declared in turbo.json).
const ALLOW_PUBLISH_ENV = 'RAYSPEC_ALLOW_PUBLISH';

/** Parse the tiny flag grammar (no positionals). `version: null` = the flag was not given at all. */
function parseFlags(argv) {
  const flags = {
    mode: 'dry-run',
    version: null,
    out: undefined,
    from: undefined,
    json: false,
    really: false,
    otp: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack') flags.mode = 'pack';
    else if (a === '--dry-run') flags.mode = 'dry-run';
    else if (a === '--publish') flags.mode = 'publish';
    else if (a === '--yes-really-publish') flags.really = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--version') flags.version = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--from') flags.from = argv[++i] ?? '';
    else if (a === '--otp') flags.otp = argv[++i] ?? '';
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

/** Read-only git in the repo root; returns trimmed stdout, or null when git refuses (e.g. no such ref). */
function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** All workspace package.json paths (excludes node_modules/dist), via git ls-files for determinism. */
function allManifestPaths() {
  const out = execFileSync('git', ['ls-files', '*package.json', '**/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\n').filter(Boolean))]
    .filter((p) => !p.includes('node_modules/'))
    .map((p) => join(REPO_ROOT, p));
}

/**
 * Load {name -> {path, json}} for every publishable workspace package: the scoped `@rayspec/*`
 * packages PLUS the unscoped `rayspec` launcher (the bare `npx rayspec` entrypoint). The repo-root
 * workspace manifest is ALSO named `rayspec`, so it is explicitly excluded — only the member package
 * under `packages/` is a publish target.
 */
function loadRayspecPackages() {
  const rootManifest = join(REPO_ROOT, 'package.json');
  const map = new Map();
  for (const path of allManifestPaths()) {
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      // A manifest this loader cannot read is a manifest the version and engines preflights cannot
      // check. Skipping it would make a tracked, unreadable RaySpec package invisible to exactly the
      // guards that exist to catch it, so the run refuses instead.
      console.error(`cannot read ${relative(REPO_ROOT, path)}: ${err.message}`);
      console.error('nothing was packed. Every tracked manifest must be readable to be checked.');
      process.exit(2);
    }
    const isScoped = typeof json.name === 'string' && json.name.startsWith('@rayspec/');
    const isLauncher = json.name === 'rayspec' && path !== rootManifest;
    if (isScoped || isLauncher) {
      map.set(json.name, { path, json });
    }
  }
  return map;
}

/**
 * The publish set = the runtime closure of the bin packages — the unscoped `rayspec` launcher plus
 * `@rayspec/cli` + `@rayspec/server` — over PRODUCTION `dependencies` only. The launcher's only
 * dependency is `@rayspec/cli`, so it pulls in the same closure. Excludes dev/test-only packages
 * (e.g. `@rayspec/parity`) and the `@spike/*` / example fixtures (they are not publish targets).
 * Derived — not hardcoded — so it stays correct as the graph evolves.
 */
function computePublishSet(pkgs) {
  const roots = ['rayspec', '@rayspec/cli', '@rayspec/server'];
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const entry = pkgs.get(n);
    if (!entry) continue;
    for (const dep of Object.keys(entry.json.dependencies ?? {})) {
      if (dep.startsWith('@rayspec/') && !seen.has(dep)) stack.push(dep);
    }
  }
  return [...seen];
}

/** Topological order (dependencies BEFORE dependents) over the publish set — the safe real-publish order. */
function topoOrder(names, pkgs) {
  const inSet = new Set(names);
  const ordered = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (done.has(n)) return;
    if (visiting.has(n)) return; // defensive: a cycle would just fall back to insertion order
    visiting.add(n);
    for (const dep of Object.keys(pkgs.get(n)?.json.dependencies ?? {})) {
      if (inSet.has(dep)) visit(dep);
    }
    visiting.delete(n);
    done.add(n);
    ordered.push(n);
  };
  for (const n of names) visit(n);
  // The launcher last: nothing depends on it, and the release workflow's guard reads "the launcher
  // is on npm" as "the whole closure is", which holds only if it is the final publish.
  const launcher = ordered.indexOf('rayspec');
  if (launcher !== -1) ordered.push(...ordered.splice(launcher, 1));
  return ordered;
}

/** Transiently rewrite a manifest for publish; returns the ORIGINAL bytes so the caller can restore. */
function stampManifest(path, version) {
  const original = readFileSync(path, 'utf8');
  const json = JSON.parse(original);
  json.version = version;
  json.private = false;
  if (!json.files) json.files = ['dist'];
  // Preserve trailing-newline convention.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return original;
}

/** The release version, read from the ONE authoritative manifest. No default, no fallback. */
function deriveVersion() {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, VERSION_SOURCE), 'utf8'));
  if (typeof json.version !== 'string' || json.version === '') {
    console.error(
      `${VERSION_SOURCE} carries no "version" — the release version is derived from it.`,
    );
    process.exit(2);
  }
  return json.version;
}

/**
 * The Node requirement every publish target must declare, read from the SAME authoritative manifest
 * as the version. One string in one place, so a Node bump moves one number.
 */
function deriveNodeEngine() {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, VERSION_SOURCE), 'utf8'));
  const node = json.engines?.node;
  if (typeof node !== 'string' || node === '') {
    console.error(
      `${VERSION_SOURCE} carries no "engines.node" — every publish target is checked against it.`,
    );
    process.exit(2);
  }
  return node;
}

/**
 * Every publish target that does not DECLARE the Node requirement itself, or declares a different
 * one. A package that ships without `engines.node` gives its consumers no engine check, and the
 * incompatibility then surfaces as a runtime failure in code that uses Node 22 APIs.
 * Returns EVERY offender, so one run names the whole gap instead of the first manifest of it.
 */
function engineMismatches(engine, names, pkgs) {
  const offenders = [];
  for (const name of names) {
    const entry = pkgs.get(name);
    const declared = entry?.json.engines?.node;
    if (declared === engine) continue;
    offenders.push({
      name,
      path: entry ? relative(REPO_ROOT, entry.path) : name,
      value: typeof declared === 'string' ? declared : '(none)',
    });
  }
  return offenders.sort((a, b) => a.path.localeCompare(b.path));
}

/** The repo-root `repository.url`, which every publish target must declare. */
function deriveRepositoryUrl() {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, VERSION_SOURCE), 'utf8'));
  const url = json.repository?.url;
  if (typeof url !== 'string' || url === '') {
    console.error(
      `${VERSION_SOURCE} carries no "repository.url" — every publish target is checked against it.`,
    );
    process.exit(2);
  }
  return url;
}

/** The repository path of a package directory, with forward slashes. */
const repositoryDirectory = (path) => relative(REPO_ROOT, dirname(path)).split(/[\\/]/).join('/');

/** What is wrong with a manifest's `repository` for the target at `path`, or null. */
function repositoryProblem(repository, url, path) {
  const directory = repositoryDirectory(path);
  if (repository?.url !== url || repository?.directory !== directory) {
    return (
      `declares ${repository === undefined ? '(none)' : JSON.stringify(repository)}, ` +
      `needs { "url": "${url}", "directory": "${directory}" }`
    );
  }
  return null;
}

/**
 * Every publish target that does not declare the repository it is published from, or declares
 * another one. Returns EVERY offender, so one run names the whole gap.
 */
function repositoryMismatches(url, names, pkgs) {
  const offenders = [];
  for (const name of names) {
    const entry = pkgs.get(name);
    const problem = entry ? repositoryProblem(entry.json.repository, url, entry.path) : 'not found';
    if (problem !== null) {
      offenders.push({ name, path: entry ? relative(REPO_ROOT, entry.path) : name, problem });
    }
  }
  return offenders.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every manifest that must already carry the release version: the `@rayspec/*` members plus the
 * unscoped launcher — including the ones that are never published (the workspace releases in
 * lockstep, so a member left behind is drift whether or not it ships). The root manifest is the
 * source of the version, so it agrees by construction. The `@spike/*` example fixtures fall outside
 * this set BY NAME (loadRayspecPackages never returns them): they are not RaySpec packages, are never
 * published, and are versioned independently of the release.
 * Returns EVERY offender, so one run names the whole drift instead of the first manifest of it.
 */
function versionMismatches(version, pkgs) {
  const offenders = [];
  for (const [name, { path, json }] of pkgs) {
    if (json.version !== version) {
      offenders.push({ name, path: relative(REPO_ROOT, path), value: json.version ?? '(none)' });
    }
  }
  return offenders.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The release tag as git sees it: `absent` | `lightweight` | `other-commit` | `at-head`, plus any
 * ANNOTATED release tag on HEAD that names a DIFFERENT version. `--points-at` peels tag objects, so
 * it reports exactly the tags whose target commit is HEAD; `v<digit>` is the release-tag shape.
 */
function tagIdentity(version) {
  const name = `v${version}`;
  const head = git('rev-parse', 'HEAD');
  const ref = git('rev-parse', '--verify', '--quiet', `refs/tags/${name}`);
  let state = 'absent';
  let commit = null;
  if (ref) {
    commit = git('rev-list', '-n', '1', `refs/tags/${name}`);
    if (git('cat-file', '-t', ref) !== 'tag') state = 'lightweight';
    else state = commit === head ? 'at-head' : 'other-commit';
  }
  const otherOnHead = (git('tag', '--points-at', 'HEAD') ?? '')
    .split('\n')
    .filter((t) => /^v\d/.test(t) && t !== name)
    .filter((t) => git('cat-file', '-t', git('rev-parse', t)) === 'tag');
  return { name, state, commit, head, otherOnHead };
}

/**
 * PREFLIGHT — everything that can make a run publish the wrong bytes, checked BEFORE the first
 * manifest is stamped and BEFORE the first `pnpm` child process, so a refusal leaves the working tree
 * and the registry untouched. Returns the tag identity for the summary.
 */
function preflight(flags, version, engine, repositoryUrl, pkgs, publishSet) {
  if (flags.version !== null && flags.version !== version) {
    console.error(
      `--version ${flags.version} does not match the release version ${version} (from ` +
        `${VERSION_SOURCE}). --version asserts the version the tree carries; it cannot override it.`,
    );
    process.exit(2);
  }

  const offenders = versionMismatches(version, pkgs);
  if (offenders.length) {
    console.error(
      `version mismatch: the release version is ${version} (from ${VERSION_SOURCE}), but ` +
        `${offenders.length} RaySpec manifest(s) disagree:`,
    );
    for (const o of offenders) console.error(`  ${o.path} — ${o.name} is at ${o.value}`);
    console.error('nothing was packed. Bring the whole workspace to one version first.');
    process.exit(2);
  }

  const engineOffenders = engineMismatches(engine, publishSet, pkgs);
  if (engineOffenders.length) {
    console.error(
      `engines mismatch: every publish target must declare "engines": { "node": "${engine}" } ` +
        `(from ${VERSION_SOURCE}), but ${engineOffenders.length} target(s) do not:`,
    );
    for (const o of engineOffenders) console.error(`  ${o.path} — ${o.name} declares ${o.value}`);
    console.error(
      'nothing was packed. A target that does not declare the requirement ships without an engine ' +
        'check for its consumers.',
    );
    process.exit(2);
  }

  const repositoryOffenders = repositoryMismatches(repositoryUrl, publishSet, pkgs);
  if (repositoryOffenders.length) {
    console.error(
      `repository mismatch: every publish target must declare the repository it is published from ` +
        `(npm provenance refuses a package without it), but ${repositoryOffenders.length} target(s) do not:`,
    );
    for (const o of repositoryOffenders) console.error(`  ${o.path} — ${o.name} ${o.problem}`);
    console.error('nothing was packed.');
    process.exit(2);
  }

  const tag = tagIdentity(version);
  if (tag.otherOnHead.length) {
    console.error(
      `release-tag mismatch: HEAD carries the annotated tag ${tag.otherOnHead.join(', ')}, but the ` +
        `release version is ${version} (from ${VERSION_SOURCE}). Nothing was packed.`,
    );
    process.exit(2);
  }
  if (flags.mode === 'publish' && tag.state !== 'at-head') {
    const detail = {
      absent: `tag ${tag.name} does not exist`,
      lightweight: `tag ${tag.name} is a lightweight tag, not an annotated release tag`,
      'other-commit': `annotated tag ${tag.name} points at ${tag.commit || '(unreadable)'}`,
    }[tag.state];
    console.error(
      `refusing to publish ${version}: ${detail}, and HEAD is ${tag.head}. An irreversible registry ` +
        'write must stand on the annotated tag of the version it writes.',
    );
    process.exit(2);
  }
  // Every target must be BUILT before anything is packed. This ran per target inside the publish
  // loop, which is a check after an irreversible step: a --publish whose Nth target was unbuilt had
  // already put targets 1..N-1 on the registry when it threw. Nothing about it needs the loop.
  const unbuilt = [...publishSet]
    .filter((name) => !existsSync(join(dirname(pkgs.get(name).path), 'dist')))
    .sort();
  if (unbuilt.length) {
    console.error(
      `unbuilt target(s): ${unbuilt.join(', ')} — run \`pnpm build\` before packing or publishing.`,
    );
    console.error('nothing was packed.');
    process.exit(2);
  }

  // In --pack and --dry-run the tag state is REPORTED and never fatal: both write nothing to the registry and nothing to the tracked tree,
  // and a pack rehearsal legitimately happens before the tag for the version being prepared exists.
  return tag;
}

/**
 * The packed tarball of every publish target in `dir`, keyed by name, read before anything is
 * published: exactly one per target, each declaring its target's name and the release version.
 */
function tarballsFrom(dir, version, publishSet, repositoryUrl, pkgs) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  } catch {
    console.error(`--from ${dir} cannot be read. Nothing was published.`);
    process.exit(2);
  }
  const byName = new Map();
  const problems = [];
  for (const file of files.sort()) {
    let manifest;
    try {
      manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', join(dir, file), 'package/package.json'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      problems.push(`${file} carries no readable package/package.json`);
      continue;
    }
    if (byName.has(manifest.name)) problems.push(`${manifest.name} is packed twice (${file})`);
    else if (!publishSet.includes(manifest.name)) problems.push(`${file} is not a publish target`);
    else if (manifest.version !== version) {
      problems.push(`${file} is ${manifest.name}@${manifest.version}, the release is ${version}`);
    } else {
      const problem = repositoryProblem(
        manifest.repository,
        repositoryUrl,
        pkgs.get(manifest.name).path,
      );
      if (problem !== null) problems.push(`${file} ${problem}`);
    }
    byName.set(manifest.name, join(dir, file));
  }
  for (const name of publishSet) if (!byName.has(name)) problems.push(`no tarball of ${name}`);
  if (problems.length) {
    console.error(`--from ${dir} is not the packed release ${version}:`);
    for (const p of problems.sort()) console.error(`  ${p}`);
    console.error('nothing was published.');
    process.exit(2);
  }
  return byName;
}

/** The npm integrity (`sha512-<base64>`) of a tarball's exact bytes, as `dist.integrity` records it. */
function integrityOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

/**
 * What the registry already serves of this release, read before anything is published: the set of
 * targets it serves with exactly their tarball's integrity (skipped by the publish). Refuses, before
 * the first call, when it serves a target with other bytes or a lookup fails other than "not found".
 */
function alreadyPublished(order, packed, version) {
  const skip = new Set();
  const problems = [];
  for (const name of order) {
    const spec = `${name}@${version}`;
    let served;
    try {
      served = execFileSync('npm', ['view', spec, 'dist.integrity', '--prefer-online'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const said = `${err.stderr ?? ''}${err.stdout ?? ''}`;
      if (/\bE404\b/.test(said)) continue; // no such package yet
      problems.push(
        `${spec}: the registry cannot be asked (${said.trim().split('\n')[0] || err.message})`,
      );
      continue;
    }
    if (served === '') continue; // the package exists, this version does not
    const local = integrityOf(packed.get(name));
    if (served === local) skip.add(name);
    else problems.push(`${spec} is already on npm as ${served}, and its tarball here is ${local}`);
  }
  if (problems.length) {
    console.error('refusing to publish: the registry does not allow continuing this release:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('nothing was published by this run.');
    process.exit(2);
  }
  return skip;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.from === '' || (flags.from !== undefined && flags.mode === 'pack')) {
    console.error(
      '--from <dir> names packed tarballs to --publish or --dry-run, and needs a value',
    );
    process.exit(2);
  }
  if (flags.version === undefined || flags.version === '') {
    console.error('--version requires a value (e.g. --version <x.y.z>)');
    process.exit(2);
  }
  if (flags.otp !== undefined && !(flags.mode === 'publish' && /^\d+$/.test(flags.otp))) {
    console.error('--otp <code> hands a one-time code (digits) to a --publish, and needs a value');
    process.exit(2);
  }
  if (flags.mode === 'publish' && !(flags.really && process.env[ALLOW_PUBLISH_ENV] === '1')) {
    console.error(
      'refusing to publish: a REAL registry write requires both --yes-really-publish and ' +
        'RAYSPEC_ALLOW_PUBLISH=1 in the environment. Use --dry-run or --pack for a no-write proof.',
    );
    process.exit(2);
  }

  const pkgs = loadRayspecPackages();
  const version = deriveVersion();
  const nodeEngine = deriveNodeEngine();
  const repositoryUrl = deriveRepositoryUrl();
  const publishSet = computePublishSet(pkgs);
  const tag = preflight(flags, version, nodeEngine, repositoryUrl, pkgs, publishSet);
  const order = topoOrder(publishSet, pkgs);
  const packed =
    flags.from === undefined
      ? null
      : tarballsFrom(resolve(flags.from), version, publishSet, repositoryUrl, pkgs);
  const published =
    flags.mode === 'publish' && packed !== null
      ? alreadyPublished(order, packed, version)
      : new Set();
  // Resolved ONCE, here, so every target is handed the same absolute destination: each `pnpm pack`
  // child runs with its cwd set to the package directory, so a relative destination passed on
  // unresolved would resolve once PER TARGET and scatter the closure one tarball per package while
  // this run reported a single directory holding none of them. Resolution is against the process
  // cwd, the ordinary meaning of a path typed on a command line. The no-`--out` default is a temp
  // directory, already absolute.
  const outDir =
    flags.mode === 'pack'
      ? flags.out === undefined
        ? mkdtempSync(join(tmpdir(), 'rayspec-pack-'))
        : resolve(flags.out)
      : undefined;

  const backups = new Map();
  const results = [];
  // The publish or dry-run call that failed, if one did. Reported after the manifests are restored: an exit
  // inside the `try` would skip the `finally` and leave every target stamped and private:false.
  let failed = null;
  try {
    // Phase 1 — stamp EVERY target first, so cross-package workspace:* refs all resolve to `version`.
    // Packed tarballs already carry the version, so nothing is stamped for them.
    if (packed === null) {
      for (const name of order) backups.set(name, stampManifest(pkgs.get(name).path, version));
    }

    // Phase 2 — run the requested command per target, in dependency order.
    for (const name of order) {
      if (published.has(name)) {
        results.push({ name, version, ok: true, skipped: true, stdout: '' });
        if (!flags.json) console.log(`[${flags.mode}] ${name}@${version} already on npm, skipped`);
        continue;
      }
      const pkgDir = dirname(pkgs.get(name).path);
      // Without it npm creates a scoped package that is new in the release as a restricted one,
      // which a free scope refuses and a paid one hides.
      const access = ['--access', 'public'];
      let stdout = '';
      if (flags.mode === 'pack') {
        stdout = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      } else {
        // A real publish is attached to the terminal, so npm can print its authentication URL and
        // wait for the approval there; a dry run is captured like a pack. A packed tarball goes to
        // npm as it is; a target packed by this run goes through pnpm, which rewrites its
        // `workspace:*` dependencies while packing.
        const real = flags.mode === 'publish';
        const args = [
          ...(real ? [] : ['--dry-run']),
          ...access,
          ...(flags.otp === undefined ? [] : [`--otp=${flags.otp}`]),
        ];
        const io = real
          ? { stdio: ['inherit', flags.json ? 2 : 'inherit', 'inherit'] }
          : { encoding: 'utf8' };
        try {
          stdout =
            packed === null
              ? execFileSync('pnpm', ['publish', '--no-git-checks', ...args], {
                  cwd: pkgDir,
                  ...io,
                })
              : execFileSync('npm', ['publish', packed.get(name), ...args], io);
        } catch (err) {
          // Never `err.message`: for a child that ended without an exit status it is the whole
          // command line, one-time code included.
          const tool = packed === null ? 'pnpm' : 'npm';
          const reason =
            err.status != null
              ? `exit ${err.status}`
              : err.signal
                ? `${tool} was killed by ${err.signal}`
                : `${tool} did not run: ${err.code ?? 'unknown error'}`;
          failed = { name, reason };
          results.push({ name, version, ok: false, stdout: '' });
          break;
        }
      }
      results.push({ name, version, ok: true, stdout: (stdout ?? '').trim() });
      if (!flags.json) console.log(`[${flags.mode}] ${name}@${version} ✓`);
    }
  } finally {
    // Phase 3 — ALWAYS restore original bytes. The committed tree is byte-identical after this script.
    for (const [name, bytes] of backups) writeFileSync(pkgs.get(name).path, bytes);
  }

  const summary = {
    mode: flags.mode,
    version,
    versionSource: VERSION_SOURCE,
    tag: { name: tag.name, state: tag.state, commit: tag.commit, head: tag.head },
    count: order.length,
    order,
    outDir: outDir ?? null,
    from: packed === null ? null : resolve(flags.from),
    failed: failed?.name ?? null,
    results: results.map(({ name, version: v, ok, skipped }) => ({
      name,
      version: v,
      ok,
      ...(skipped ? { skipped: true } : {}),
    })),
  };
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  if (failed !== null) {
    console.error(`\n${flags.mode} of ${failed.name}@${version} failed (${failed.reason}).`);
    if (flags.mode === 'publish') {
      const done = results.filter((r) => r.ok && !r.skipped).map((r) => r.name);
      console.error(
        done.length
          ? `published by this run before it (${done.length}): ${done.join(', ')}.`
          : 'nothing was published by this run.',
      );
      // npm waits for a browser approval only when its stdin AND its stdout are a terminal. Its
      // stdout is this script's stdout, or this script's stderr under --json.
      const npmOut = flags.json ? process.stderr : process.stdout;
      if ((!process.stdin.isTTY || !npmOut.isTTY) && flags.otp === undefined) {
        console.error(
          'this run was not attached to a terminal: npm cannot wait there for a browser approval ' +
            'of the second factor. Run it from a terminal and do not pipe its output, or pass ' +
            '--otp <code>.',
        );
      }
      console.error(
        packed === null
          ? 'this run packed the targets itself, so it cannot be continued: what it published ' +
              'stays public, and another pack has other bytes. Pack once (--pack) and publish ' +
              'with --from <dir>.'
          : 'fix the cause and run the same command again: it continues, skipping every package ' +
              'npm already serves with the integrity of its tarball.',
      );
    } else console.error('a dry run writes nothing to the registry.');
    console.error('working tree restored to committed bytes (private:true).');
    process.exit(1);
  }
  if (!flags.json) {
    console.log(
      `\n${flags.mode}: ${order.length} package(s) at ${version} (from ${VERSION_SOURCE}).`,
    );
    console.log(`release tag ${tag.name}: ${tag.state}.`);
    if (outDir) console.log(`tarballs → ${outDir}`);
    console.log('working tree restored to committed bytes (private:true).');
  }
}

main();
