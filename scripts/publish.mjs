#!/usr/bin/env node
/**
 * RaySpec release packer/publisher — the single sanctioned path to put the CLI + its runtime closure
 * on npm.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Every RaySpec package is committed as `private: true` at the current release version — the
 * `private: true` flag (not the version) is the deliberate accidental-publish guard: a bare
 * `pnpm publish` / `npm publish` at the repo root or in any package refuses, and nothing in CI
 * publishes. This script is the ONLY place that lifts that guard, and it
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
 *                  (if your registry demands auth even for a dry-run, use --pack instead).
 *   --publish      REAL `pnpm publish`. Double-gated: also requires `--yes-really-publish` AND
 *                  `RAYSPEC_ALLOW_PUBLISH=1`. Publishes in dependency order (deps before dependents).
 *                  Intended for the founder-run release window only.
 *
 * Other flags: --version <v> (asserts the derived version) · --out <dir> (pack destination; a
 * relative path is resolved against the current working directory once, before anything is packed,
 * so every target lands in that ONE directory and the run prints the absolute path) ·
 * --json (machine output).
 *
 * This script performs no git WRITES — it only READS the workspace state (`git ls-files`, tag identity)
 * and never creates a commit, a tag or a release. No package lifecycle hook and no CI job runs it
 * against THIS repository — a release run happens only when a human invokes it. CI does execute a copy
 * of it against a throwaway fixture repo with the package manager stubbed (`scripts/publish.test.mjs`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    json: false,
    really: false,
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
function preflight(flags, version, engine, pkgs, publishSet) {
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

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.version === undefined || flags.version === '') {
    console.error('--version requires a value (e.g. --version <x.y.z>)');
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
  const publishSet = computePublishSet(pkgs);
  const tag = preflight(flags, version, nodeEngine, pkgs, publishSet);
  const order = topoOrder(publishSet, pkgs);
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
  try {
    // Phase 1 — stamp EVERY target first, so cross-package workspace:* refs all resolve to `version`.
    for (const name of order) backups.set(name, stampManifest(pkgs.get(name).path, version));

    // Phase 2 — run the requested command per target, in dependency order.
    for (const name of order) {
      const pkgDir = dirname(pkgs.get(name).path);
      let stdout = '';
      if (flags.mode === 'pack') {
        stdout = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      } else if (flags.mode === 'dry-run') {
        stdout = execFileSync('pnpm', ['publish', '--dry-run', '--no-git-checks'], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      } else {
        stdout = execFileSync('pnpm', ['publish', '--no-git-checks'], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      }
      results.push({ name, version, ok: true, stdout: stdout.trim() });
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
    results: results.map(({ name, version: v, ok }) => ({ name, version: v, ok })),
  };
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(
      `\n${flags.mode}: ${order.length} package(s) at ${version} (from ${VERSION_SOURCE}).`,
    );
    console.log(`release tag ${tag.name}: ${tag.state}.`);
    if (outDir) console.log(`tarballs → ${outDir}`);
    console.log('working tree restored to committed bytes (private:true).');
  }
}

main();
