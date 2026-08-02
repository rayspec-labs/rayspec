#!/usr/bin/env node
/**
 * RaySpec release identity manifest — the mapping from a published npm closure back to the commit
 * it was built from, and the tool that refutes it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A development checkout legitimately carries the PREVIOUS release version until the release cut,
 * so a commit hash plus a `version` field does not identify a published artifact: the tree can say
 * `1.6.2` while the annotated `v1.6.2` points at an ancestor and the working tree already holds the
 * next release's work. Nothing in this repository closed that gap — there was no artifact that said
 * "these exact tarballs came from this exact commit". This script emits one, and verifies one.
 *
 * WHAT THE MANIFEST RECORDS
 * -------------------------
 *   - the release version and the source commit, plus whether the working tree was CLEAN at that
 *     commit (`git diff --name-only HEAD`: build output, packed tarballs and this manifest itself
 *     are UNTRACKED by design, so only a tracked file that differs from HEAD counts as dirty);
 *   - for every member of the launcher's runtime closure: name, version, tarball integrity and the
 *     unpacked file-list digest;
 *   - the three checked-in JSON Schema artifacts (unified / backend / product), the lockfile digest
 *     and the dependency-SBOM digest;
 *   - the Node and pnpm requirements, read from the repo-root manifest;
 *   - the Git tag and the build workflow run — see HONESTY below.
 * Every digest form is named IN the manifest (`algorithms`), so a third party can reproduce one
 * without reading this script.
 *
 * THE TWO DIGESTS, AND WHAT EACH ONE IDENTIFIES (measured, not assumed)
 * --------------------------------------------------------------------
 * `pnpm pack` rewrites each `workspace:*` dependency to the stamped version in the PACKED manifest,
 * and it does not emit that map in a stable key order: two consecutive `--pack` runs of one commit
 * move a varying subset of the tarballs, bounded by the 15 of 29 packed manifests that declare more
 * than one internal dependency (measured pairs moved 9, 11, 12 and 12 of the 29), and in every
 * single case the difference was confined to `package/package.json` and vanished once its keys were
 * sorted. So:
 *   - `tarball.integrity` (sha512 SRI) identifies ONE ARTIFACT — the exact tarball this manifest was
 *     generated from, i.e. the file an operator attaches to the release. It is not a reproducible
 *     build claim, and re-packing the same commit will legitimately move it.
 *   - `files.list_digest` identifies THE PACKAGE — it digests the unpacked entries, canonicalising
 *     `package.json` (see `algorithms`) so the one measured source of pack noise cannot move it. It
 *     is the digest that still matches after a re-pack of the same commit, and therefore the one
 *     that matches a tarball fetched from the registry: `--publish` packs again at publish time, so
 *     the registry never serves the byte-for-byte file this manifest hashed.
 * Both are recorded because they fail differently: an altered archive that unpacks to identical
 * content is caught only by the first, and altered content is caught by the second.
 *
 * THE SELF-REFERENCE
 * ------------------
 * This manifest SHIPS INSIDE the launcher package (`packages/app/rayspec`, the unscoped `rayspec`
 * tarball), so the launcher cannot record its own tarball integrity: a tarball containing the digest
 * of itself is not a fixed point that exists. Nothing is invented to paper over that. The launcher's
 * `tarball.integrity` is an explicit `null` with a reason, and the invariant recorded in its place
 * IS verifiable on the shipped tarball: its file-list digest over every entry EXCEPT the manifest
 * (`files.excluded`). Verification computes the same exclusion, and — when the tarball carries the
 * manifest — additionally requires those bytes to be byte-identical to the manifest being verified.
 * So the exclusion is not a hole: a launcher carrying some OTHER manifest fails. That holds because
 * `unpack` refuses an archive that carries one path twice or that hides content behind a lone null
 * block: without those two refusals the excluded path is a place to post a second, forged copy that
 * the file list never sees and extraction is what actually installs.
 * The launcher is also packed FROM a directory a previous release run may have left a manifest in,
 * so generation refuses when the packed launcher already carries a manifest that is not the one it
 * would write — see the `//release-identity` operator sequence, whose first step removes it.
 *
 * HONESTY ABOUT WHAT DOES NOT EXIST
 * ---------------------------------
 * There is no release workflow in `.github/workflows`, by design: a release happens when a human
 * invokes `scripts/publish.mjs` (see its docblock). So the build workflow run is recorded only from
 * a GitHub Actions environment and is otherwise an explicit `null` with a machine-readable reason —
 * never a fabricated value. The tag is recorded the same way: generating a manifest BEFORE the
 * release tag exists is normal, and it is written down as `state: "absent"` rather than guessed.
 * The manifest is also UNSIGNED, and says so in `signature`, with the reason.
 *
 * DETERMINISM
 * -----------
 * The output carries no timestamp, no host and no random ordering: given the same checkout and the
 * same tarballs it is byte-identical, which is what makes "re-derive it yourself" a real offer.
 *
 *   node scripts/release-identity.mjs --tarballs <dir> [--out <file>] [--json]
 *   node scripts/release-identity.mjs --verify --tarballs <dir> [--manifest <file>] [--json]
 *
 * Exit codes: 0 verified / written · 1 verification failed · 2 refused (bad usage or bad inputs).
 * No network, no package manager, no git WRITES: the script reads the workspace, reads tarballs and
 * writes one file. See the repo-root `package.json` `//release-identity` note for the operator
 * sequence, including where the manifest is attached to the GitHub release.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The ONE authoritative manifest — the same source `publish.mjs` derives the release version from. */
const VERSION_SOURCE = 'package.json';
/** The launcher package: the tarball this manifest ships inside, and the root of the closure. */
const LAUNCHER_DIR = 'packages/app/rayspec';
/** The manifest's file name — identical as a release asset and inside the launcher tarball. */
const MANIFEST_NAME = 'rayspec-release-identity.json';
const SCHEMA_ID = 'rayspec-release-identity/1';
/** The checked-in schema artifacts, each named by the profile it describes. */
const SCHEMAS = [
  { path: 'packages/kernel/spec/version-1.0.schema.json', profile: 'unified' },
  { path: 'packages/kernel/spec/spec.schema.json', profile: 'backend' },
  { path: 'packages/kernel/spec/product.schema.json', profile: 'product' },
];
const LOCKFILE = 'pnpm-lock.yaml';
const DEPENDENCY_SBOM = 'docs/dependency-sbom.json';

/** The digest forms, stated in the manifest so a third party never has to read this file. */
const ALGORITHMS = {
  tarball_integrity:
    'sha512 over the exact tarball bytes, base64, in Subresource-Integrity form ' +
    '(`sha512-<base64>`) — the same value npm records as `dist.integrity`. Reproduce: ' +
    '`openssl dgst -sha512 -binary <file>.tgz | openssl base64 -A`.',
  file_digest:
    'sha256, hex, over one unpacked entry. `package.json` is CANONICALISED first — parsed and ' +
    "re-serialised as `JSON.stringify(value, null, 2)` with every object's keys sorted ascending " +
    'and one trailing newline — because pnpm rewrites `workspace:*` into that file and does not ' +
    'emit the resulting map in a stable key order. Every other entry is digested verbatim.',
  file_list_digest:
    'sha256, hex, over the UTF-8 concatenation of `<path> <file_digest>\\n` for every unpacked ' +
    'entry not listed in `files.excluded`, paths relative to the package root (the leading ' +
    '`package/` of the tarball removed), lines sorted byte-wise ascending.',
  source_file_digest:
    'sha256, hex, over the file bytes in the checkout the manifest was generated from — identical ' +
    'to the bytes committed at `source.commit` when `source.worktree_clean` is true, and otherwise ' +
    'the working-tree bytes of a file `source.dirty_paths` names. Reproduce: `shasum -a 256 <path>`.',
};

/** What the digests do and do not claim — the same idiom the dependency SBOM uses. */
const SCOPE_NOTE =
  'This manifest identifies the release artifacts produced by `scripts/publish.mjs --pack` at ' +
  '`source.commit` — the tarballs attached to the GitHub release, which are what `--verify` checks. ' +
  '`tarball.integrity` pins those exact files. `files.list_digest` pins their unpacked content and ' +
  'is the digest that survives a re-pack of the same commit, so it is also the digest that matches ' +
  'a tarball fetched from the registry (a real publish packs again at publish time). Measured: two ' +
  'consecutive packs of one commit moved 9, 11, 12 and 12 of the 29 tarballs across four pairs — ' +
  'bounded by the 15 packed manifests that declare more than one internal dependency — and in every ' +
  'case the difference was confined to `package/package.json` and vanished once its keys were ' +
  'sorted, which is exactly what the file digest canonicalises away. Neither digest is a ' +
  'reproducible-build claim about the toolchain.';

/** Parse the flag grammar (no positionals). */
function parseFlags(argv) {
  const flags = { verify: false, tarballs: null, out: null, manifest: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') flags.verify = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--tarballs') flags.tarballs = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--manifest') flags.manifest = argv[++i];
    else refuse(`unknown flag: ${a}`);
  }
  if (!flags.tarballs)
    refuse('--tarballs <dir> is required: the directory holding the release tarballs.');
  return flags;
}

/** A refusal: nothing was written, and the message says what is wrong. */
function refuse(...lines) {
  for (const l of lines) console.error(l);
  process.exit(2);
}

/**
 * Read-only git in the repo root, as `{ ok, value }`. The pair exists so that a COMMAND THAT FAILED
 * is never read as an answer: `git diff` exiting 128 (a corrupt index, a `required` clean filter
 * whose binary is missing) produces no output, and empty output is what a clean tree also looks like.
 */
function gitTry(...args) {
  try {
    return {
      ok: true,
      value: execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    };
  } catch {
    return { ok: false, value: null };
  }
}

/** The output, or null when git refuses (e.g. no such ref) — for the queries where both mean absent. */
const git = (...args) => gitTry(...args).value;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const integrity = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** Every object's keys sorted ascending, arrays left in order — the `package.json` canonical form. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * The unpacked entries of a gzipped npm tarball, as `{ path, body }` with the leading `package/`
 * removed. Deliberately FAILS CLOSED: an entry type this reader does not model (a symlink, a hard
 * link, a device node), a header whose checksum does not add up, or a path outside `package/` throws
 * rather than being skipped — a verifier that silently ignores part of an archive verifies nothing.
 * The types npm actually emits are regular files; directories, GNU long names and pax `path=`
 * overrides are handled because the format permits them.
 *
 * Two refusals exist because tar is more permissive than a verifier may be, and the gap between the
 * two is exactly where a tampered artifact hides:
 *   - A PATH THAT OCCURS TWICE. Extraction keeps the LAST entry at a path, so a reader that returns
 *     both — or that stops at the first — hashes something no consumer receives. No packer emits a
 *     duplicate path, so refusing costs nothing and closes the general form of that substitution.
 *   - CONTENT PAST THE END-OF-ARCHIVE MARKER. The marker is two zero blocks, but `tar` and node-tar
 *     (what `npm i` runs) treat a LONE zero block as a warning and keep reading, so bytes appended
 *     after one are installed. Everything from the marker to the end of the archive must be zero,
 *     and an archive that simply runs out before a marker is refused too.
 * The messages carry no file name: the single caller knows which tarball it handed over and says so.
 */
function unpack(gzipped) {
  const buf = gunzipSync(gzipped);
  const entries = [];
  const seen = new Set();
  let override = null;
  let off = 0;
  let ended = false;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) {
      const tail = buf.subarray(off);
      if (tail.length < 1024) {
        throw new Error(
          `the end-of-archive marker is ${tail.length} byte(s), not the two 512-byte zero blocks the format requires`,
        );
      }
      if (!tail.every((b) => b === 0)) {
        throw new Error(
          `content after the end-of-archive marker — tar and npm would read past it, so this reader refuses the archive`,
        );
      }
      ended = true;
      break;
    }
    const text = (from, to) => head.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const octal = (from, to) => {
      const raw = text(from, to).trim();
      if (!/^[0-7]*$/.test(raw)) throw new Error(`unsupported numeric header field`);
      return raw === '' ? 0 : Number.parseInt(raw, 8);
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : head[i];
    if (sum !== octal(148, 156)) throw new Error(`tar header checksum mismatch`);
    const size = octal(124, 136);
    const type = String.fromCharCode(head[156]) || '0';
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x' || type === 'g' || type === 'L') {
      const raw = body.toString('utf8');
      const found = type === 'L' ? raw.replace(/\0.*$/s, '') : raw.match(/^\d+ path=(.*)$/m)?.[1];
      override = found ?? null;
      continue;
    }
    const prefix = text(345, 500);
    const name = override ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    override = null;
    if (type === '5') continue; // a directory carries no content of its own
    if (type !== '0' && type !== '\0') {
      throw new Error(`unsupported tar entry type '${type}' at ${name}`);
    }
    if (!name.startsWith('package/')) throw new Error(`entry outside package/: ${name}`);
    const path = name.slice('package/'.length);
    if (seen.has(path)) throw new Error(`duplicate entry path: ${name}`);
    seen.add(path);
    entries.push({ path, body: Buffer.from(body) });
  }
  if (!ended) throw new Error(`the archive ends without an end-of-archive marker`);
  return entries;
}

/** `{ count, digest }` over the entries, minus `excluded`, per `algorithms.file_list_digest`. */
function fileListDigest(entries, excluded) {
  const skip = new Set(excluded);
  const lines = [];
  for (const entry of entries) {
    if (skip.has(entry.path)) continue;
    let bytes = entry.body;
    if (entry.path === 'package.json') {
      bytes = Buffer.from(
        `${JSON.stringify(sortKeysDeep(JSON.parse(entry.body.toString('utf8'))), null, 2)}\n`,
      );
    }
    lines.push(Buffer.from(`${entry.path} ${sha256(bytes)}\n`));
  }
  lines.sort(Buffer.compare);
  return { count: lines.length, digest: sha256(Buffer.concat(lines)) };
}

/** Every `*.tgz` in `dir`, read and unpacked, keyed by the name its own packed manifest declares. */
function loadTarballs(dir) {
  if (!existsSync(dir)) refuse(`--tarballs ${dir} does not exist.`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort();
  if (files.length === 0) refuse(`--tarballs ${dir} holds no .tgz file. Pack the release first.`);
  const members = [];
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    let entries;
    try {
      entries = unpack(bytes);
    } catch (err) {
      refuse(`${file}: ${err?.message ?? err}`);
    }
    const manifestEntry = entries.find((e) => e.path === 'package.json');
    if (!manifestEntry) refuse(`${file}: the tarball carries no package/package.json.`);
    const json = JSON.parse(manifestEntry.body.toString('utf8'));
    members.push({
      file,
      bytes,
      entries,
      name: json.name,
      version: json.version,
      deps: Object.keys(json.dependencies ?? {}).filter((d) => d.startsWith('@rayspec/')),
    });
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The directory must BE the launcher's runtime closure: the launcher present, every member at the
 * release version, every internal production dependency of a member also a member, and no member
 * the launcher cannot reach. A manifest over a set that is not closed describes most of a release,
 * which is worse than describing none of it.
 */
function assertClosure(members, launcherName, version) {
  const byName = new Map(members.map((m) => [m.name, m]));
  if (!byName.has(launcherName)) {
    refuse(
      `the launcher package '${launcherName}' has no tarball in this directory, so the closure it ` +
        'roots cannot be identified. Pack the release with `node scripts/publish.mjs --pack`.',
    );
  }
  const drift = members.filter((m) => m.version !== version);
  if (drift.length) {
    refuse(
      `the release version is ${version} (from ${VERSION_SOURCE}), but ${drift.length} tarball(s) ` +
        'carry another version:',
      ...drift.map((m) => `  ${m.file} — ${m.name} at ${m.version}`),
    );
  }
  const reached = new Set();
  const missing = new Map();
  const stack = [launcherName];
  while (stack.length) {
    const name = stack.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const dep of byName.get(name)?.deps ?? []) {
      if (byName.has(dep)) stack.push(dep);
      else missing.set(dep, [...(missing.get(dep) ?? []), name]);
    }
  }
  if (missing.size) {
    refuse(
      `the tarball directory is not a closure — ${missing.size} package(s) are depended on but not ` +
        'packed:',
      ...[...missing]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dep, by]) => `  ${dep} — required by ${by.sort().join(', ')}`),
    );
  }
  const unreachable = members.filter((m) => !reached.has(m.name));
  if (unreachable.length) {
    refuse(
      `${unreachable.length} tarball(s) are not part of the runtime closure of '${launcherName}', ` +
        'so this manifest cannot claim them:',
      ...unreachable.map((m) => `  ${m.file} — ${m.name}`),
    );
  }
}

/** The release tag as git sees it — `absent` | `lightweight` | `other-commit` | `at-head`. */
function tagIdentity(version, head) {
  const name = `v${version}`;
  const ref = git('rev-parse', '--verify', '--quiet', `refs/tags/${name}`);
  if (!ref) {
    return {
      name,
      state: 'absent',
      commit: null,
      note: `no ref refs/tags/${name} in this checkout — the manifest was generated before the release tag was created.`,
    };
  }
  const commit = git('rev-list', '-n', '1', `refs/tags/${name}`);
  if (git('cat-file', '-t', ref) !== 'tag') {
    return {
      name,
      state: 'lightweight',
      commit,
      note: `${name} is a lightweight tag, not an annotated release tag.`,
    };
  }
  if (commit !== head) {
    return {
      name,
      state: 'other-commit',
      commit,
      note: `annotated ${name} points at ${commit}, not at source.commit.`,
    };
  }
  return { name, state: 'at-head', commit, note: null };
}

/**
 * The build workflow run, from the GitHub Actions environment. There is no release workflow in this
 * repository — a release is human-invoked — so outside Actions this is an explicit null naming the
 * reason, never a value that looks like a run and is not one.
 */
function workflowRun(env) {
  if (env.GITHUB_ACTIONS !== 'true') {
    return {
      value: null,
      reason: 'no-github-actions-environment',
      note:
        'generated outside GitHub Actions. This repository has no release workflow by design: the ' +
        'release path is the human-invoked scripts/publish.mjs.',
    };
  }
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = env.GITHUB_REPOSITORY ?? null;
  const runId = env.GITHUB_RUN_ID ?? null;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  return {
    value: {
      repository,
      workflow: env.GITHUB_WORKFLOW ?? null,
      run_id: runId,
      run_attempt: attempt,
      url:
        repository && runId && attempt
          ? `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`
          : null,
    },
    reason: null,
  };
}

/** Digest a checked-in file, refusing if it is absent — a missing digest is not a manifest. */
function sourceDigest(rel) {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) refuse(`${rel} is missing — the manifest cannot record a digest for it.`);
  return sha256(readFileSync(path));
}

/** The repo-root facts the manifest carries, refusing when the one authoritative manifest is short. */
function readRoot() {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, VERSION_SOURCE), 'utf8'));
  for (const key of ['version', 'packageManager']) {
    if (typeof json[key] !== 'string' || json[key] === '') {
      refuse(`${VERSION_SOURCE} carries no "${key}" — the manifest records it.`);
    }
  }
  if (typeof json.engines?.node !== 'string' || json.engines.node === '') {
    refuse(`${VERSION_SOURCE} carries no "engines.node" — the manifest records it.`);
  }
  return { version: json.version, node: json.engines.node, packageManager: json.packageManager };
}

/**
 * The working tree as the release sees it: TRACKED files that differ from HEAD (see the docblock).
 * `clean` is null when git could not answer — the one value this must never guess, because the
 * favourable guess (`true`) is indistinguishable from a clean tree and is the claim a reader trusts.
 */
function worktreeState() {
  const res = gitTry('diff', '--name-only', 'HEAD');
  if (!res.ok) return { clean: null, paths: [], error: '`git diff --name-only HEAD` failed' };
  const paths = res.value.split('\n').filter(Boolean).sort();
  return { clean: paths.length === 0, paths, error: null };
}

/** Deterministic serialisation: insertion order, 2-space indent, one trailing newline. */
const serialise = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function buildManifest(members, launcherName, root, env) {
  const head = git('rev-parse', 'HEAD');
  if (!head) refuse('cannot read HEAD — the manifest records the source commit.');
  const tree = worktreeState();
  if (tree.clean === null) {
    refuse(
      `cannot read the working tree state — ${tree.error}. The manifest records whether the tree ` +
        'was clean at source.commit, and a failed command is not a clean tree.',
    );
  }
  return {
    schema: SCHEMA_ID,
    generated_by: 'scripts/release-identity.mjs',
    reproduce: `node scripts/release-identity.mjs --verify --tarballs <dir> --manifest ${MANIFEST_NAME}`,
    scope_note: SCOPE_NOTE,
    algorithms: ALGORITHMS,
    version: root.version,
    source: {
      commit: head,
      worktree_clean: tree.clean,
      dirty_paths: tree.paths,
      tag: tagIdentity(root.version, head),
    },
    workflow_run: workflowRun(env),
    runtime: { node: root.node, package_manager: root.packageManager },
    signature: {
      value: null,
      reason: 'unsigned',
      note:
        'this manifest is not signed. Its authenticity rests on the GitHub release it is attached ' +
        'to and on the commit it names; verify the closure with `--verify` against the tarballs.',
    },
    closure: members.map((m) => {
      const isLauncher = m.name === launcherName;
      const excluded = isLauncher ? [MANIFEST_NAME] : [];
      const files = fileListDigest(m.entries, excluded);
      return {
        name: m.name,
        version: m.version,
        tarball: isLauncher
          ? {
              file: m.file,
              bytes: null,
              integrity: null,
              reason: 'ships-this-manifest',
              note:
                `${MANIFEST_NAME} is published inside this tarball, so a tarball integrity recorded ` +
                'here could never match the tarball that ships. The invariant recorded instead is ' +
                'files.list_digest over every entry except files.excluded.',
            }
          : { file: m.file, bytes: m.bytes.length, integrity: integrity(m.bytes) },
        files: { count: files.count, list_digest: files.digest, excluded },
      };
    }),
    schemas: SCHEMAS.map((s) => ({
      path: s.path,
      profile: s.profile,
      sha256: sourceDigest(s.path),
    })),
    lockfile: { path: LOCKFILE, sha256: sourceDigest(LOCKFILE) },
    dependency_sbom: { path: DEPENDENCY_SBOM, sha256: sourceDigest(DEPENDENCY_SBOM) },
  };
}

function launcherName() {
  const path = join(REPO_ROOT, LAUNCHER_DIR, 'package.json');
  if (!existsSync(path)) refuse(`${LAUNCHER_DIR}/package.json is missing — it roots the closure.`);
  const name = JSON.parse(readFileSync(path, 'utf8')).name;
  if (typeof name !== 'string' || name === '')
    refuse(`${LAUNCHER_DIR}/package.json declares no name.`);
  return name;
}

function generate(flags) {
  const root = readRoot();
  const launcher = launcherName();
  const members = loadTarballs(resolve(flags.tarballs));
  assertClosure(members, launcher, root.version);
  const manifest = buildManifest(members, launcher, root, process.env);
  const out = resolve(flags.out ?? join(REPO_ROOT, LAUNCHER_DIR, MANIFEST_NAME));
  const bytes = serialise(manifest);
  // The launcher is packed from a directory that a PREVIOUS release run may have left a manifest in
  // (it is gitignored, and the launcher's `files` ships it). Packing is not byte-reproducible, so a
  // manifest generated now can never equal that one: the release would be unverifiable from the
  // moment it was packed. Refuse before writing anything, and name the step that was skipped.
  const carried = members
    .find((m) => m.name === launcher)
    ?.entries.find((e) => e.path === MANIFEST_NAME);
  if (carried && !carried.body.equals(Buffer.from(bytes))) {
    refuse(
      `the launcher tarball carries a ${MANIFEST_NAME} that is not the one this run would write, so ` +
        'the tarballs could never verify against it. The pack picked up the manifest a previous ' +
        `release run left in ${LAUNCHER_DIR}/. Nothing was written — remove ` +
        `${LAUNCHER_DIR}/${MANIFEST_NAME}, re-pack the release, then generate again.`,
    );
  }
  writeFileSync(out, bytes);
  if (flags.json) {
    process.stdout.write(bytes);
    return;
  }
  console.log(`release identity ${manifest.version} @ ${manifest.source.commit}`);
  console.log(
    `  ${manifest.closure.length} package(s), tag ${manifest.source.tag.name}: ${manifest.source.tag.state}` +
      `, workflow run: ${manifest.workflow_run.value ? manifest.workflow_run.value.url : `none (${manifest.workflow_run.reason})`}`,
  );
  if (!manifest.source.worktree_clean) {
    console.log(`  working tree DIRTY: ${manifest.source.dirty_paths.join(', ')}`);
  }
  console.log(`written → ${relative(REPO_ROOT, out) || out}`);
}

/**
 * Check a manifest against a directory of tarballs, and against this checkout when it is the one
 * the manifest names. Every member is checked and every failure is reported, so one run names the
 * whole divergence instead of the first symptom of it.
 */
function verify(flags) {
  const manifestPath = resolve(flags.manifest ?? join(REPO_ROOT, LAUNCHER_DIR, MANIFEST_NAME));
  if (!existsSync(manifestPath)) refuse(`--manifest ${manifestPath} does not exist.`);
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (err) {
    refuse(`${manifestPath} is not JSON (${err?.message ?? err}).`);
  }
  if (manifest.schema !== SCHEMA_ID) {
    refuse(`${manifestPath} declares schema '${manifest.schema}', not '${SCHEMA_ID}'.`);
  }

  const members = new Map(loadTarballs(resolve(flags.tarballs)).map((m) => [m.name, m]));
  const failures = [];
  const checked = [];
  for (const entry of manifest.closure) {
    const fail = (line) => failures.push(`${entry.name}: ${line}`);
    const member = members.get(entry.name);
    if (!member) {
      fail(`no tarball in the directory carries this package (expected ${entry.tarball.file}).`);
      continue;
    }
    if (member.version !== entry.version) {
      fail(`the tarball is at ${member.version}, the manifest records ${entry.version}.`);
    }
    if (entry.tarball.integrity === null) {
      // The launcher — it ships this manifest, so only the content invariant can be checked. See
      // the SELF-REFERENCE section of the docblock. There is at most ONE entry at this path:
      // `unpack` refuses an archive that carries a path twice, which is what makes comparing a
      // single occurrence the same thing as comparing what a consumer extracts.
      const shipped = member.entries.find((e) => e.path === MANIFEST_NAME);
      if (shipped && !shipped.body.equals(manifestBytes)) {
        fail(
          `the tarball carries a DIFFERENT ${MANIFEST_NAME} than the one being verified — the ` +
            'excluded entry is checked, not trusted.',
        );
      }
      checked.push({ name: entry.name, carries: Boolean(shipped) });
    } else {
      const actual = integrity(member.bytes);
      if (actual !== entry.tarball.integrity) {
        fail(
          `tarball integrity mismatch\n    recorded: ${entry.tarball.integrity}\n    actual:   ${actual}`,
        );
      }
      if (entry.tarball.bytes !== null && member.bytes.length !== entry.tarball.bytes) {
        fail(
          `tarball size mismatch: recorded ${entry.tarball.bytes}, actual ${member.bytes.length}.`,
        );
      }
      checked.push({ name: entry.name, carries: null });
    }
    const files = fileListDigest(member.entries, entry.files.excluded ?? []);
    if (files.digest !== entry.files.list_digest) {
      fail(
        `unpacked file-list digest mismatch (${files.count} entries counted, ` +
          `${entry.files.count} recorded)\n    recorded: ${entry.files.list_digest}\n    actual:   ${files.digest}`,
      );
    } else if (files.count !== entry.files.count) {
      fail(`file count mismatch: recorded ${entry.files.count}, actual ${files.count}.`);
    }
  }
  const extra = [...members.keys()].filter((n) => !manifest.closure.some((e) => e.name === n));
  for (const name of extra.sort()) {
    failures.push(`${name}: a tarball in the directory that the manifest does not record.`);
  }

  // The source side is comparable only against the checkout the manifest names — a verifier run
  // from another commit reports that instead of failing on a difference it cannot interpret.
  const head = git('rev-parse', 'HEAD');
  const tree = worktreeState();
  const comparable = head === manifest.source.commit && tree.clean === true;
  const sourceEntries = [...(manifest.schemas ?? []), manifest.lockfile, manifest.dependency_sbom];
  let sourceNote =
    tree.clean === null
      ? `not compared: the working tree state is unknown (${tree.error})`
      : `not compared: this checkout is ${head ?? 'unknown'}${tree.clean ? '' : ' (dirty)'}, the manifest records ${manifest.source.commit}`;
  if (comparable) {
    for (const artifact of sourceEntries) {
      if (!artifact) continue;
      const path = join(REPO_ROOT, artifact.path);
      if (!existsSync(path)) {
        failures.push(`${artifact.path}: recorded in the manifest but absent from this checkout.`);
        continue;
      }
      const actual = sha256(readFileSync(path));
      if (actual !== artifact.sha256) {
        failures.push(
          `${artifact.path}: digest mismatch\n    recorded: ${artifact.sha256}\n    actual:   ${actual}`,
        );
      }
    }
    const root = readRoot();
    if (root.version !== manifest.version) {
      failures.push(
        `${VERSION_SOURCE}: version ${root.version}, the manifest records ${manifest.version}.`,
      );
    }
    if (
      root.node !== manifest.runtime?.node ||
      root.packageManager !== manifest.runtime?.package_manager
    ) {
      failures.push(
        `${VERSION_SOURCE}: runtime requirements ${root.node} / ${root.packageManager} do not match ` +
          `the recorded ${manifest.runtime?.node} / ${manifest.runtime?.package_manager}.`,
      );
    }
    sourceNote = `compared against this checkout at ${head}: ${sourceEntries.filter(Boolean).length} artifact(s)`;
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          manifest: relative(REPO_ROOT, manifestPath) || manifestPath,
          version: manifest.version,
          commit: manifest.source.commit,
          packages: manifest.closure.length,
          source_compared: comparable,
          ok: failures.length === 0,
          failures,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`release identity ${manifest.version} @ ${manifest.source.commit}`);
    for (const c of checked) {
      const suffix =
        c.carries === null
          ? ''
          : c.carries
            ? ` — the tarball carries this ${MANIFEST_NAME}`
            : ` — this tarball does not carry ${MANIFEST_NAME} yet (packed before the manifest)`;
      console.log(`  checked ${c.name}${suffix}`);
    }
    console.log(`  source: ${sourceNote}`);
  }
  if (failures.length) {
    console.error(
      `release identity VERIFICATION FAILED — ${failures.length} problem(s):\n` +
        failures.map((f) => `  ${f}`).join('\n'),
    );
    process.exit(1);
  }
  if (!flags.json) {
    console.log(`verified: ${manifest.closure.length} package(s), 0 failure(s).`);
  }
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.verify) verify(flags);
  else generate(flags);
}

main();
