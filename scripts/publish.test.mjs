#!/usr/bin/env node
/**
 * Release-guard test for the packer/publisher (`publish.mjs`).
 *
 * The script stamps a single version across the publish closure and, in `--publish`, writes it to a
 * registry. Neither an npm version nor a release tag can be taken back, so the version it stamps
 * must be the version the checkout actually carries — and a run that cannot prove that must refuse
 * BEFORE the first `pnpm` child process, not halfway through the closure.
 *
 * The script is therefore driven end-to-end here against a THROWAWAY GIT REPO built per case (real
 * commits, real annotated/lightweight tags) with the real `publish.mjs` COPIED into it, so its
 * repo root resolves to the fixture. Its one external boundary — the package manager — is MOCKED:
 * a stub executable named `pnpm` is placed FIRST on the child's PATH and records every invocation.
 * No test-only flag or seam exists in the script itself. Every refusal case asserts the stub was
 * never invoked, which is the "before packing" half of the property; the refusal cases that need
 * `--publish` additionally point the child at an unroutable registry, so a real registry write is
 * impossible by construction even if the stub were somehow bypassed.
 *
 * The properties, each a real failure mode:
 *
 *   (W) A WORKSPACE THAT DISAGREES WITH ITSELF IS NOT PACKABLE — if any RaySpec manifest carries a
 *       version other than the derived one, the run refuses and names EVERY offender with its path
 *       and its value. A run that names only the first offender turns one bump into N release
 *       attempts. The `@spike/*` example fixtures are versioned independently and must not count.
 *   (L) THE LAUNCHER IS NOT EXEMPT — the unscoped `rayspec` launcher is the package `npx rayspec`
 *       resolves; it is a publish target like any other and its version is held to the same rule.
 *   (E) A PUBLISH TARGET THAT DECLARES NO `engines.node` IS NOT PACKABLE — that field is the only
 *       thing that makes a consumer's package manager check the Node requirement at install time,
 *       so a target missing it ships an incompatibility that surfaces later as a runtime failure.
 *       The stamping step never injects it: the guard exists so such a package cannot ship at all.
 *   (D) A TARGET THAT DECLARES A DIFFERENT REQUIREMENT IS NOT PACKABLE — the requirement string has
 *       ONE source, the repo-root `engines.node`. A target that disagrees tells consumers a Node
 *       floor other than the one the workspace is built and tested against.
 *   (S) A TARGET THAT DOES NOT DECLARE ITS SOURCE REPOSITORY IS NOT PACKABLE — npm refuses a
 *       provenance publish whose `repository.url` does not name the repository the workflow ran in,
 *       and it refuses at publish time, after the targets before it are public. Every target declares
 *       the repo-root `repository.url` and its own `directory`; `--from` holds the packed manifests to
 *       the same rule.
 *   (A) `--version` IS AN ASSERTION, NEVER AN OVERRIDE — a value that disagrees with the derived
 *       version refuses instead of stamping. There must be no input that packs a version the tree
 *       does not carry.
 *   (T/K/C) A REAL REGISTRY WRITE STANDS ON ITS ANNOTATED TAG — `--publish` refuses when the tag
 *       for the version is absent (T), is lightweight (K), or points at another commit (C).
 *       Publishing off-tag produces a released version nobody can check out.
 *   (H) A RELEASE COMMIT THAT CLAIMS ANOTHER VERSION IS FATAL IN EVERY MODE — an annotated `v<X>`
 *       on HEAD with a workspace at `<Y>` means the checkout is lying about which release it is.
 *   (R) PACK AND DRY-RUN REPORT THE TAG, THEY DO NOT ENFORCE IT — both write nothing anywhere, and
 *       a pack rehearsal legitimately runs before the tag exists. Blocking it would push operators
 *       to tag first and check later.
 *   (O) A RELATIVE `--out` LANDS IN ONE DIRECTORY — every target is packed by a child whose cwd is
 *       that target's own directory, so a destination passed on unresolved resolves once PER TARGET:
 *       the closure scatters one tarball per package directory while the run reports a single
 *       destination that holds none of them. The documented release sequence passes a
 *       repository-relative destination and then hands the same string to the release-identity
 *       manifest and its verifier, which resolve it against the repository root — so a scattered
 *       pack leaves those two reading whatever that directory happened to already hold.
 *   (F) THE TESTED TARBALLS ARE THE PUBLISHED ONES — `--from <dir>` publishes each packed tarball as
 *       it is, in dependency order, stamping nothing; a directory that is not exactly one tarball per
 *       publish target at the release version refuses before the first call, naming every problem,
 *       and `--from` is refused with `--pack` and without a value.
 *   (N) A PUBLISH THAT STOPPED PART WAY CAN BE CONTINUED — npm never takes the same version twice, so
 *       a `--publish --from` run skips a target the registry already serves with its tarball's exact
 *       integrity and publishes the rest; a target served with other bytes, or a registry that cannot
 *       be asked, refuses before the first call. The launcher is always published last.
 *   (P) THE POSITIVE CONTROL — a coherent checkout packs: the derived version is the reported one,
 *       every target is packed exactly once in dependency order, and the tree is byte-identical
 *       afterwards.
 *
 * Standalone (no test framework is wired for the repo scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'publish.mjs');
const VERSION = '1.6.2';
// The Node requirement. The fixture's root manifest is its ONE source, exactly as the repo-root
// manifest is in the real repo; every publish target has to declare the same string.
const NODE_ENGINE = '>=22';
// The source repository: the root manifest's `repository.url` is its one source.
const REPOSITORY_URL = 'git+https://github.com/fixture/rayspec.git';
const repositoryOf = (m) => ({ type: 'git', url: REPOSITORY_URL, directory: m.dir });

// ── the `pnpm` test double ──────────────────────────────────────────────────────────────────────
// Logs one JSON line per invocation (argv + cwd, i.e. which package was packed) and succeeds. Its
// mere existence in the log is the assertion target: every refusal case requires an EMPTY log.
// For `pack` it also does the one thing real `pnpm pack` does that is observable on disk: it writes
// one `<name>-<version>.tgz` into `--pack-destination`, resolving that destination against ITS OWN
// cwd — the package directory it was spawned in. Without that, WHERE a pack lands is invisible here
// and case (O) could not tell one destination apart from one per target.
const FAKE_PNPM = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const argv = process.argv.slice(2);
const own = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ argv, cwd: process.cwd(), private: own.private }) + '\\n');
const destIdx = argv.indexOf('--pack-destination');
if (argv[0] === 'pack' && destIdx !== -1) {
  const dest = resolve(process.cwd(), argv[destIdx + 1]);
  mkdirSync(dest, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  writeFileSync(join(dest, pkg.name.replace('@', '').replace('/', '-') + '-' + pkg.version + '.tgz'), '');
}
process.stdout.write('fake pnpm: ' + argv.join(' ') + '\\n');
`;

// ── the `npm` test double ───────────────────────────────────────────────────────────────────────
// Answers `npm view <name>@<version> dist.integrity` from FAKE_NPM_REGISTRY (a JSON map of spec to
// integrity, or to "!down" for a registry that cannot be reached), and like the real one exits 1
// with `E404` for a spec it does not hold. Every call is logged, so a case can show which targets
// were looked up.
const FAKE_NPM = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ argv }) + '\\n');
const registry = JSON.parse(process.env.FAKE_NPM_REGISTRY || '{}');
if (argv[0] !== 'view') { process.stderr.write('fake npm: only view\\n'); process.exit(1); }
const served = registry[argv[1]];
if (served === '!down') { process.stderr.write('npm error code ECONNREFUSED\\n'); process.exit(1); }
if (served === undefined) { process.stderr.write('npm error code E404\\nnpm error 404 Not Found\\n'); process.exit(1); }
process.stdout.write(served + '\\n');
`;

/**
 * The fixture workspace: the publish closure in miniature (the launcher → cli → core chain plus
 * server), one RaySpec member that is NOT a publish target, and one `@spike/*` example fixture that
 * is versioned independently — the same shape the real repo has.
 */
const MEMBERS = [
  { dir: 'packages/app/rayspec', name: 'rayspec', deps: ['@rayspec/cli'], target: true },
  { dir: 'packages/app/cli', name: '@rayspec/cli', deps: ['@rayspec/core'], target: true },
  { dir: 'packages/app/server', name: '@rayspec/server', deps: ['@rayspec/core'], target: true },
  { dir: 'packages/kernel/core', name: '@rayspec/core', deps: [], target: true },
  { dir: 'packages/test/parity', name: '@rayspec/parity', deps: [], target: false },
  { dir: 'examples/spike-pack', name: '@spike/pack', deps: [], target: false, pinned: '1.0.0' },
];
const TARGETS = MEMBERS.filter((m) => m.target).map((m) => m.name);

const workspaces = [];

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
 * Build a throwaway repo: manifests at `rootVersion` (per-package overrides in `versions`), every
 * publish target declaring the root's `engines.node` (per-package overrides in `engines`; `null`
 * omits the field), empty `dist/` for every publish target, the REAL script copied in, and the
 * requested tags. A tag with `at: 'previous'` is created on the first commit and a second commit
 * then moves HEAD past it.
 */
function fixture({
  rootVersion = VERSION,
  versions = {},
  engines = {},
  repositories = {},
  tags = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-release-guard-'));
  workspaces.push(root);

  const manifest = (path, json) =>
    writeFileSync(join(root, path), `${JSON.stringify(json, null, 2)}\n`);

  mkdirSync(join(root, 'scripts'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'publish.mjs'));
  manifest('package.json', {
    name: 'rayspec',
    version: rootVersion,
    private: true,
    repository: { type: 'git', url: REPOSITORY_URL },
    engines: { node: NODE_ENGINE },
  });

  for (const m of MEMBERS) {
    mkdirSync(join(root, m.dir), { recursive: true });
    if (m.target) mkdirSync(join(root, m.dir, 'dist'));
    // Publish targets declare the requirement; the members that never ship deliberately do not —
    // the same shape the real repo has, so every case also exercises the guard's scope.
    const engine = m.name in engines ? engines[m.name] : m.target ? NODE_ENGINE : null;
    const repository =
      m.name in repositories ? repositories[m.name] : m.target ? repositoryOf(m) : null;
    manifest(join(m.dir, 'package.json'), {
      name: m.name,
      version: versions[m.name] ?? m.pinned ?? rootVersion,
      private: true,
      ...(repository === null ? {} : { repository }),
      ...(engine === null ? {} : { engines: { node: engine } }),
      dependencies: Object.fromEntries(m.deps.map((d) => [d, 'workspace:*'])),
    });
  }

  mkdirSync(join(root, 'out'));
  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', 'release candidate');

  const tag = (t) =>
    t.annotated
      ? gitIn(root, 'tag', '-a', t.name, '-m', `release ${t.name}`)
      : gitIn(root, 'tag', t.name);
  const early = tags.filter((t) => t.at === 'previous');
  for (const t of early) tag(t);
  if (early.length) gitIn(root, 'commit', '--allow-empty', '-m', 'post-tag commit');
  for (const t of tags.filter((t) => t.at !== 'previous')) tag(t);

  const stubs = join(root, 'stub-bin');
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'pnpm'), FAKE_PNPM);
  chmodSync(join(stubs, 'pnpm'), 0o755);
  writeFileSync(join(stubs, 'npm'), FAKE_NPM);
  chmodSync(join(stubs, 'npm'), 0o755);
  return { root, stubs };
}

/**
 * Drive the REAL script inside the fixture with `pnpm` shadowed on PATH. `allowPublish` supplies the
 * publish gate for the cases that must reach the tag check; the unroutable registry is the second
 * belt behind the stub — nothing here can reach a real one.
 */
function run(fx, args, { allowPublish = false, registry = {} } = {}) {
  const log = join(fx.root, 'pnpm-calls.log');
  writeFileSync(log, '');
  const npmLog = join(fx.root, 'npm-calls.log');
  writeFileSync(npmLog, '');
  const res = spawnSync('node', [join(fx.root, 'scripts', 'publish.mjs'), ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.stubs}:${process.env.PATH}`,
      FAKE_PNPM_LOG: log,
      FAKE_NPM_LOG: npmLog,
      FAKE_NPM_REGISTRY: JSON.stringify(registry),
      npm_config_registry: 'http://127.0.0.1:1/',
      ...(allowPublish ? { RAYSPEC_ALLOW_PUBLISH: '1' } : {}),
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const lookups = readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', calls, lookups };
}

/** A refusal: nonzero exit, an explanation on stderr, and NOT ONE package manager invocation. */
function assertRefused(r, label, fx) {
  // Exit 2 specifically, not merely nonzero: an uncaught throw exits 1, and a refusal that decayed
  // into a stack trace would still satisfy "nonzero" while telling an operator nothing.
  assert.equal(r.code, 2, `${label} a refusal must exit 2; got ${r.code}: ${r.err || r.out}`);
  assert.notEqual(r.err.trim(), '', `${label} a refusal must say why`);
  assert.deepEqual(
    r.calls,
    [],
    `${label} the refusal must land BEFORE the first pnpm invocation, got ${JSON.stringify(r.calls)}`,
  );
  // The other half of "nothing happened": `process.exit` skips the restore `finally`, so a guard
  // that ran after the stamping loop would leave every manifest rewritten and private:false on disk.
  if (fx) {
    assert.equal(
      gitIn(fx.root, 'status', '--porcelain', '--untracked-files=no'),
      '',
      `${label} a refusal must leave every tracked byte alone`,
    );
  }
}

/** Which package each pnpm invocation ran in, in order. */
const packedOrder = (calls, root) =>
  calls.map((c) => {
    const dir = c.cwd.replace(/^\/private/, '').replace(root.replace(/^\/private/, ''), '');
    return MEMBERS.find((m) => dir.endsWith(m.dir))?.name ?? c.cwd;
  });

try {
  // ── (W) a member manifest that disagrees → refusal naming EVERY offender ───────────────────────
  // Two offenders, one of them the parity harness (a RaySpec member that is NEVER published): the
  // stamped version must match the whole workspace, not merely the publish closure. The `@spike/*`
  // fixture sits at 1.0.0 in every case here and must never be reported.
  {
    const fx = fixture({ versions: { '@rayspec/core': '1.6.1', '@rayspec/parity': '1.4.0' } });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(W)', fx);
    assert.match(
      r.err,
      /packages\/kernel\/core\/package\.json/,
      `(W) the offending manifest must be named by path: ${r.err}`,
    );
    assert.match(r.err, /1\.6\.1/, `(W) the offending value must be shown: ${r.err}`);
    assert.match(
      r.err,
      /packages\/test\/parity\/package\.json/,
      `(W) the SECOND offender must be reported too, not just the first: ${r.err}`,
    );
    assert.match(r.err, /1\.4\.0/, `(W) the second offending value must be shown: ${r.err}`);
    assert.match(r.err, /1\.6\.2/, `(W) the derived version must be named: ${r.err}`);
    assert.doesNotMatch(
      r.err,
      /spike/,
      `(W) an independently versioned example fixture is not a RaySpec manifest: ${r.err}`,
    );
    console.log('ok (W) — a workspace version mismatch refuses and names every offender');
  }

  // ── (L) the unscoped launcher is held to the same rule ─────────────────────────────────────────
  {
    const fx = fixture({ versions: { rayspec: '9.9.9' } });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(L)', fx);
    assert.match(
      r.err,
      /packages\/app\/rayspec\/package\.json/,
      `(L) the launcher manifest must be named by path: ${r.err}`,
    );
    assert.match(r.err, /9\.9\.9/, `(L) the launcher's value must be shown: ${r.err}`);
    console.log('ok (L) — the unscoped launcher cannot drift from the release version');
  }

  // ── (E) a publish target that declares NO engines → refusal naming it ──────────────────────────
  // The members that never ship (the parity harness, the `@spike/*` fixture) carry no engines in any
  // case here: the guard is scoped to the publish closure, and (P) shows that packs.
  {
    const fx = fixture({ engines: { '@rayspec/core': null } });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(E)', fx);
    assert.match(
      r.err,
      /packages\/kernel\/core\/package\.json/,
      `(E) the offending target must be named by path: ${r.err}`,
    );
    assert.match(r.err, /@rayspec\/core/, `(E) the offending target must be named: ${r.err}`);
    assert.match(r.err, />=22/, `(E) the required value must be named: ${r.err}`);
    console.log('ok (E) — a publish target that declares no Node engine cannot be packed');
  }

  // ── (D) a publish target that declares ANOTHER requirement → refusal naming it ─────────────────
  {
    const fx = fixture({ engines: { '@rayspec/cli': '>=20' } });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(D)', fx);
    assert.match(
      r.err,
      /packages\/app\/cli\/package\.json/,
      `(D) the offending target must be named by path: ${r.err}`,
    );
    assert.match(r.err, />=20/, `(D) the divergent value must be shown: ${r.err}`);
    assert.match(r.err, />=22/, `(D) the required value must be named: ${r.err}`);
    console.log('ok (D) — a publish target that declares another Node engine cannot be packed');
  }

  // ── (S) a publish target without its source repository, or with another one → refusal ─────────
  {
    const fx = fixture({
      repositories: {
        '@rayspec/core': null,
        '@rayspec/cli': { type: 'git', url: REPOSITORY_URL, directory: 'packages/app' },
        '@rayspec/server': { type: 'git', url: 'https://github.com/elsewhere/rayspec' },
      },
    });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(S)', fx);
    for (const path of ['kernel/core', 'app/cli', 'app/server']) {
      assert.match(
        r.err,
        new RegExp(`packages/${path}/package\\.json`),
        `(S) every offending target must be named by path: ${r.err}`,
      );
    }
    assert.match(r.err, /declares \(none\)/, `(S) a missing field must be named: ${r.err}`);
    assert.match(r.err, /elsewhere/, `(S) the divergent value must be shown: ${r.err}`);
    assert.match(
      r.err,
      /"directory": "packages\/app\/cli"/,
      `(S) the required directory must be named: ${r.err}`,
    );
    console.log('ok (S) — a publish target that does not declare its repository cannot be packed');
  }

  // ── (A) --version disagreeing with the derived version → refusal, never an override ────────────
  {
    const fx = fixture();
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--version', '1.7.0']);
    assertRefused(r, '(A)', fx);
    assert.match(r.err, /1\.7\.0/, `(A) the asserted value must be named: ${r.err}`);
    assert.match(r.err, /1\.6\.2/, `(A) the derived value must be named: ${r.err}`);
    console.log('ok (A) — --version asserts the derived version, it cannot override it');
  }

  // ── (T) publish with no tag for the version ────────────────────────────────────────────────────
  {
    const fx = fixture();
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(T)', fx);
    assert.match(r.err, /v1\.6\.2/, `(T) the missing tag must be named: ${r.err}`);
    console.log('ok (T) — a real registry write refuses without the release tag');
  }

  // ── (K) publish with a LIGHTWEIGHT tag for the version ─────────────────────────────────────────
  // A lightweight tag is a movable ref with no tagger, date or message: it is not a release record.
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: false }] });
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(K)', fx);
    assert.match(r.err, /v1\.6\.2/, `(K) the tag must be named: ${r.err}`);
    assert.match(r.err, /lightweight/i, `(K) the refusal must say what is wrong: ${r.err}`);
    console.log('ok (K) — a lightweight tag is not a release tag');
  }

  // ── (C) publish with an annotated tag that points at another commit ────────────────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true, at: 'previous' }] });
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(C)', fx);
    assert.match(r.err, /v1\.6\.2/, `(C) the tag must be named: ${r.err}`);
    assert.match(r.err, /HEAD/, `(C) the refusal must contrast the tag with HEAD: ${r.err}`);
    console.log('ok (C) — publishing from a commit the release tag does not point at refuses');
  }

  // ── (H) HEAD carries an annotated tag naming ANOTHER version → fatal in every mode ─────────────
  {
    const fx = fixture({ tags: [{ name: 'v9.9.9', annotated: true }] });
    for (const mode of ['--pack', '--dry-run']) {
      const r = run(fx, mode === '--pack' ? [mode, '--out', join(fx.root, 'out')] : [mode]);
      assertRefused(r, `(H/${mode})`);
      assert.match(r.err, /v9\.9\.9/, `(H/${mode}) the tag on HEAD must be named: ${r.err}`);
      assert.match(r.err, /1\.6\.2/, `(H/${mode}) the derived version must be named: ${r.err}`);
    }
    console.log('ok (H) — a release commit claiming another version stops every mode');
  }

  // ── (R) pack/dry-run REPORT an absent tag and proceed ──────────────────────────────────────────
  {
    const fx = fixture();
    const human = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assert.equal(
      human.code,
      0,
      `(R) an absent tag must not fail a pack; got ${human.code}: ${human.err}`,
    );
    assert.match(human.out, /v1\.6\.2/, `(R) the tag state must be reported: ${human.out}`);
    assert.match(human.out, /absent/, `(R) the tag state must be reported: ${human.out}`);
    assert.equal(human.calls.length, TARGETS.length, '(R) the pack must still run');

    const json = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--json']);
    assert.equal(json.code, 0, `(R) --json pack must succeed; got ${json.code}: ${json.err}`);
    const summary = JSON.parse(json.out);
    assert.equal(
      summary.tag.state,
      'absent',
      `(R) the tag state must be machine-readable: ${json.out}`,
    );
    assert.equal(summary.version, VERSION, '(R) the reported version must be the derived one');

    const dry = run(fx, ['--dry-run']);
    assert.equal(
      dry.code,
      0,
      `(R) an absent tag must not fail a dry-run; got ${dry.code}: ${dry.err}`,
    );
    assert.equal(dry.calls.length, TARGETS.length, '(R) the dry-run must still run');
    console.log('ok (R) — pack and dry-run report the tag state instead of enforcing it');
  }

  // ── (V) --version with an EMPTY value keeps its own message ────────────────────────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--version', '']);
    assertRefused(r, '(V)', fx);
    assert.match(
      r.err,
      /--version requires a value/,
      `(V) an empty --version is a usage error, not a version disagreement: ${r.err}`,
    );
    console.log('ok (V) — --version with no value says so, instead of reporting a mismatch');
  }

  // ── (J) a tracked manifest this loader cannot read refuses, instead of vanishing ────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    // A RaySpec manifest that does not parse. Skipping it would drop the package out of the version
    // and engines preflights entirely — the guards that exist to catch exactly this file.
    const broken = MEMBERS.find((m) => m.name === '@rayspec/core');
    writeFileSync(join(fx.root, broken.dir, 'package.json'), '{ "name": "@rayspec/core", oops\n');
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    // No tree assertion here: this case deliberately writes a broken tracked manifest, so the
    // fixture is dirty by construction and the check would flag the setup rather than the run.
    assertRefused(r, '(J)');
    assert.match(
      r.err,
      /cannot read .*package\.json/,
      `(J) the refusal must name the unreadable manifest: ${r.err}`,
    );
    console.log('ok (J) — an unreadable manifest refuses the run instead of dropping out of it');
  }

  // ── (M) a MATCHING --version is accepted — the assertion is not "always refuse" ────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--version', VERSION, '--json']);
    assert.equal(r.code, 0, `(M) --version ${VERSION} must be accepted; got ${r.code}: ${r.err}`);
    assert.equal(
      r.calls.length,
      TARGETS.length,
      `(M) every target must still be packed: ${JSON.stringify(r.calls.map((c) => c.argv))}`,
    );
    // Without this arm, an implementation that refused EVERY --version would pass case (A).
    console.log('ok (M) — --version that agrees with the tree is accepted, not refused');
  }

  // ── (U) an unbuilt target refuses before anything is packed ────────────────────────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    // Remove one target's dist/. It is the LAST in dependency order, so a check that ran per target
    // inside the publish loop would already have packed the others before reaching it.
    const last = MEMBERS.find((m) => m.name === 'rayspec');
    rmSync(join(fx.root, last.dir, 'dist'), { recursive: true, force: true });
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out')]);
    assertRefused(r, '(U)', fx);
    assert.match(
      r.err,
      /unbuilt target\(s\): rayspec/,
      `(U) the refusal must name the unbuilt target: ${r.err}`,
    );
    console.log('ok (U) — an unbuilt target stops the run before the first target is packed');
  }

  // ── (O) a relative --out lands in ONE directory, and the run names it ──────────────────────────
  // This is the shape the documented release sequence uses: a repository-relative destination, run
  // from the repository root.
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    const rel = join('release', `v${VERSION}`);
    const r = run(fx, ['--pack', '--out', rel]);
    assert.equal(r.code, 0, `(O) a relative --out must pack; got ${r.code}: ${r.err}`);
    assert.equal(r.calls.length, TARGETS.length, '(O) every target must still be packed');

    const strays = readdirSync(join(fx.root, 'packages'), { recursive: true })
      .map(String)
      .filter((p) => p.endsWith('.tgz'))
      .sort();
    assert.deepEqual(
      strays,
      [],
      `(O) no tarball may be written under packages/: ${JSON.stringify(strays)}`,
    );

    // The same run's own count, in the one place it says the tarballs are.
    const dest = join(realpathSync(fx.root), rel);
    const landed = readdirSync(dest)
      .filter((f) => f.endsWith('.tgz'))
      .sort();
    assert.equal(
      landed.length,
      TARGETS.length,
      `(O) every target must land in ${dest}: ${JSON.stringify(landed)}`,
    );
    assert.ok(
      r.out.includes(`tarballs → ${dest}`),
      `(O) the destination line must name the resolved absolute path: ${r.out}`,
    );
    console.log('ok (O) — a relative --out resolves once, to the one destination the run reports');
  }

  // ── (P) the positive control: a coherent checkout packs, in dependency order, and restores ─────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    // Tracked bytes only: the stub bin, the pack destination and the call log are test scaffolding.
    const tracked = () => gitIn(fx.root, 'status', '--porcelain', '--untracked-files=no');
    assert.equal(tracked(), '', '(P) the fixture must start with no modified tracked file');

    const r = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--json']);
    assert.equal(r.code, 0, `(P) a coherent checkout must pack; got ${r.code}: ${r.err}`);
    const summary = JSON.parse(r.out);
    assert.equal(summary.version, VERSION, `(P) the reported version must be derived: ${r.out}`);
    assert.equal(summary.tag.state, 'at-head', `(P) the tag must be reported as on HEAD: ${r.out}`);
    assert.deepEqual(
      [...summary.order].sort(),
      [...TARGETS].sort(),
      `(P) exactly the publish closure must be packed: ${summary.order}`,
    );

    const packed = packedOrder(r.calls, fx.root);
    assert.deepEqual(
      packed,
      summary.order,
      '(P) each target must be packed exactly once, in order',
    );
    for (const m of MEMBERS.filter((x) => x.target)) {
      for (const dep of m.deps) {
        assert.ok(
          packed.indexOf(dep) < packed.indexOf(m.name),
          `(P) ${dep} must be packed before its dependent ${m.name}: ${packed}`,
        );
      }
    }
    for (const c of r.calls) assert.equal(c.argv[0], 'pack', `(P) --pack must pack: ${c.argv}`);

    assert.equal(
      tracked(),
      '',
      '(P) the tree must be byte-identical after the run — the private:true guard is never left off',
    );
    console.log(
      'ok (P) — a coherent checkout packs the closure in dependency order and restores it',
    );
  }

  // ── (F) --from publishes the packed tarballs themselves, and refuses anything else ─────────────
  {
    /**
     * One tarball per entry `[name, version]`, packed the way pnpm names them, each declaring its
     * repository unless `bare` names it.
     */
    const packDir = (fx, entries, dirName, bare = []) => {
      const dir = join(fx.root, dirName);
      mkdirSync(dir);
      for (const [name, version] of entries) {
        const src = mkdtempSync(join(tmpdir(), 'rayspec-release-guard-pkg-'));
        workspaces.push(src);
        mkdirSync(join(src, 'package'));
        writeFileSync(
          join(src, 'package', 'package.json'),
          `${JSON.stringify({
            name,
            version,
            ...(bare.includes(name)
              ? {}
              : {
                  repository: repositoryOf(MEMBERS.find((m) => m.name === name) ?? { dir: name }),
                }),
          })}\n`,
        );
        const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
        const tar = spawnSync('tar', ['-czf', join(dir, file), '-C', src, 'package']);
        assert.equal(tar.status, 0, '(F) the fixture tarball must pack');
      }
      return dir;
    };
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true }] });
    const good = packDir(
      fx,
      TARGETS.map((n) => [n, VERSION]),
      'packed',
    );
    const r = run(fx, ['--publish', '--yes-really-publish', '--from', good, '--json'], {
      allowPublish: true,
    });
    assert.equal(r.code, 0, `(F) a packed release must publish; got ${r.code}: ${r.err}`);
    assert.equal(r.calls.length, TARGETS.length, '(F) one publish per target');
    const order = packedOrder(r.calls, fx.root);
    for (const m of MEMBERS.filter((x) => x.target)) {
      for (const dep of m.deps) {
        assert.ok(
          order.indexOf(dep) < order.indexOf(m.name),
          `(F) ${dep} before ${m.name}: ${order}`,
        );
      }
    }
    for (const c of r.calls) {
      assert.equal(c.argv[0], 'publish', `(F) every call publishes: ${c.argv}`);
      assert.match(c.argv[1], /\.tgz$/, `(F) every call names its tarball: ${c.argv}`);
      assert.ok(c.argv[1].startsWith(good), `(F) the tarball comes from --from: ${c.argv}`);
      assert.equal(c.private, true, '(F) nothing is stamped when the tarballs carry the version');
    }
    assert.equal(JSON.parse(r.out).from, good, '(F) the summary names the directory');
    assert.equal(order.at(-1), 'rayspec', `(F) the launcher is published last: ${order}`);
    assert.equal(r.lookups.length, TARGETS.length, '(F) the registry is asked once per target');

    // (N) a publish that stopped after @rayspec/core: the next run skips it and publishes the rest.
    const integrity = (name) =>
      `sha512-${createHash('sha512')
        .update(
          readFileSync(join(good, `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`)),
        )
        .digest('base64')}`;
    const core = `@rayspec/core@${VERSION}`;
    const resumed = run(fx, ['--publish', '--yes-really-publish', '--from', good, '--json'], {
      allowPublish: true,
      registry: { [core]: integrity('@rayspec/core') },
    });
    assert.equal(
      resumed.code,
      0,
      `(N) a stopped publish continues; got ${resumed.code}: ${resumed.err}`,
    );
    const resumedOrder = packedOrder(resumed.calls, fx.root);
    assert.deepEqual(
      [...resumedOrder].sort(),
      TARGETS.filter((n) => n !== '@rayspec/core').sort(),
      `(N) only the missing targets are published: ${resumedOrder}`,
    );
    assert.equal(resumedOrder.at(-1), 'rayspec', '(N) the launcher still goes last');
    assert.deepEqual(
      JSON.parse(resumed.out).results.find((x) => x.name === '@rayspec/core'),
      { name: '@rayspec/core', version: VERSION, ok: true, skipped: true },
      '(N) the summary says the published target was skipped',
    );
    for (const [registry, pattern] of [
      [{ [core]: 'sha512-other' }, /@rayspec\/core@1\.6\.2 is already on npm as sha512-other/],
      [
        { [`@rayspec/server@${VERSION}`]: '!down' },
        /@rayspec\/server@1\.6\.2: the registry cannot be asked/,
      ],
    ]) {
      const refused = run(fx, ['--publish', '--yes-really-publish', '--from', good], {
        allowPublish: true,
        registry,
      });
      assertRefused(refused, '(N)', fx);
      assert.match(refused.err, pattern, `(N) the problem must be named: ${refused.err}`);
    }
    // Only a real publish asks the registry: a dry run over the same tarballs stays offline.
    const dry = run(fx, ['--dry-run', '--from', good], { registry: { [core]: 'sha512-other' } });
    assert.equal(dry.code, 0, `(N) a dry run does not ask the registry: ${dry.err}`);
    assert.equal(dry.lookups.length, 0, '(N) no lookup in a dry run');
    console.log('ok (N) — a stopped publish continues with the missing targets only');

    const missing = packDir(
      fx,
      TARGETS.slice(1).map((n) => [n, VERSION]),
      'missing',
    );
    const drift = packDir(
      fx,
      TARGETS.map((n) => [n, n === '@rayspec/core' ? '1.6.1' : VERSION]),
      'drift',
    );
    const foreign = packDir(
      fx,
      [...TARGETS.map((n) => [n, VERSION]), ['@rayspec/parity', VERSION]],
      'foreign',
    );
    const unsourced = packDir(
      fx,
      TARGETS.map((n) => [n, VERSION]),
      'unsourced',
      ['@rayspec/server'],
    );
    for (const [dir, pattern] of [
      [missing, new RegExp(`no tarball of ${TARGETS[0].replace('/', '\\/')}`)],
      [unsourced, /rayspec-server-1\.6\.2\.tgz declares \(none\)/],
      [drift, /@rayspec\/core@1\.6\.1, the release is 1\.6\.2/],
      [foreign, /is not a publish target/],
    ]) {
      const refused = run(fx, ['--publish', '--yes-really-publish', '--from', dir], {
        allowPublish: true,
      });
      assertRefused(refused, '(F)', fx);
      assert.match(refused.err, pattern, `(F) the problem must be named: ${refused.err}`);
    }
    assertRefused(run(fx, ['--pack', '--from', good]), '(F) --pack with --from', fx);
    assertRefused(run(fx, ['--dry-run', '--from']), '(F) --from without a value', fx);
    console.log('ok (F) — --from publishes the tested tarballs and refuses any other directory');
  }

  console.log('\nrelease guard: ALL CASES PASSED');
} finally {
  for (const d of workspaces) rmSync(d, { recursive: true, force: true });
}
