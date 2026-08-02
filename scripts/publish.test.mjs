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
 *   (P) THE POSITIVE CONTROL — a coherent checkout packs: the derived version is the reported one,
 *       every target is packed exactly once in dependency order, and the tree is byte-identical
 *       afterwards.
 *
 * Standalone (no test framework is wired for the repo scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

// ── the `pnpm` test double ──────────────────────────────────────────────────────────────────────
// Logs one JSON line per invocation (argv + cwd, i.e. which package was packed) and succeeds. Its
// mere existence in the log is the assertion target: every refusal case requires an EMPTY log.
const FAKE_PNPM = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
process.stdout.write('fake pnpm: ' + argv.join(' ') + '\\n');
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
function fixture({ rootVersion = VERSION, versions = {}, engines = {}, tags = [] } = {}) {
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
    engines: { node: NODE_ENGINE },
  });

  for (const m of MEMBERS) {
    mkdirSync(join(root, m.dir), { recursive: true });
    if (m.target) mkdirSync(join(root, m.dir, 'dist'));
    // Publish targets declare the requirement; the members that never ship deliberately do not —
    // the same shape the real repo has, so every case also exercises the guard's scope.
    const engine = m.name in engines ? engines[m.name] : m.target ? NODE_ENGINE : null;
    manifest(join(m.dir, 'package.json'), {
      name: m.name,
      version: versions[m.name] ?? m.pinned ?? rootVersion,
      private: true,
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
  return { root, stubs };
}

/**
 * Drive the REAL script inside the fixture with `pnpm` shadowed on PATH. `allowPublish` supplies the
 * publish gate for the cases that must reach the tag check; the unroutable registry is the second
 * belt behind the stub — nothing here can reach a real one.
 */
function run(fx, args, { allowPublish = false } = {}) {
  const log = join(fx.root, 'pnpm-calls.log');
  writeFileSync(log, '');
  const res = spawnSync('node', [join(fx.root, 'scripts', 'publish.mjs'), ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.stubs}:${process.env.PATH}`,
      FAKE_PNPM_LOG: log,
      npm_config_registry: 'http://127.0.0.1:1/',
      ...(allowPublish ? { RAYSPEC_ALLOW_PUBLISH: '1' } : {}),
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', calls };
}

/** A refusal: nonzero exit, an explanation on stderr, and NOT ONE package manager invocation. */
function assertRefused(r, label) {
  assert.notEqual(r.code, 0, `${label} the run must exit nonzero; got ${r.code}: ${r.out}`);
  assert.notEqual(r.err.trim(), '', `${label} a refusal must say why`);
  assert.deepEqual(
    r.calls,
    [],
    `${label} the refusal must land BEFORE the first pnpm invocation, got ${JSON.stringify(r.calls)}`,
  );
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
    assertRefused(r, '(W)');
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
    assertRefused(r, '(L)');
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
    assertRefused(r, '(E)');
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
    assertRefused(r, '(D)');
    assert.match(
      r.err,
      /packages\/app\/cli\/package\.json/,
      `(D) the offending target must be named by path: ${r.err}`,
    );
    assert.match(r.err, />=20/, `(D) the divergent value must be shown: ${r.err}`);
    assert.match(r.err, />=22/, `(D) the required value must be named: ${r.err}`);
    console.log('ok (D) — a publish target that declares another Node engine cannot be packed');
  }

  // ── (A) --version disagreeing with the derived version → refusal, never an override ────────────
  {
    const fx = fixture();
    const r = run(fx, ['--pack', '--out', join(fx.root, 'out'), '--version', '1.7.0']);
    assertRefused(r, '(A)');
    assert.match(r.err, /1\.7\.0/, `(A) the asserted value must be named: ${r.err}`);
    assert.match(r.err, /1\.6\.2/, `(A) the derived value must be named: ${r.err}`);
    console.log('ok (A) — --version asserts the derived version, it cannot override it');
  }

  // ── (T) publish with no tag for the version ────────────────────────────────────────────────────
  {
    const fx = fixture();
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(T)');
    assert.match(r.err, /v1\.6\.2/, `(T) the missing tag must be named: ${r.err}`);
    console.log('ok (T) — a real registry write refuses without the release tag');
  }

  // ── (K) publish with a LIGHTWEIGHT tag for the version ─────────────────────────────────────────
  // A lightweight tag is a movable ref with no tagger, date or message: it is not a release record.
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: false }] });
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(K)');
    assert.match(r.err, /v1\.6\.2/, `(K) the tag must be named: ${r.err}`);
    assert.match(r.err, /lightweight/i, `(K) the refusal must say what is wrong: ${r.err}`);
    console.log('ok (K) — a lightweight tag is not a release tag');
  }

  // ── (C) publish with an annotated tag that points at another commit ────────────────────────────
  {
    const fx = fixture({ tags: [{ name: 'v1.6.2', annotated: true, at: 'previous' }] });
    const r = run(fx, ['--publish', '--yes-really-publish'], { allowPublish: true });
    assertRefused(r, '(C)');
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

  console.log('\nrelease guard: ALL CASES PASSED');
} finally {
  for (const d of workspaces) rmSync(d, { recursive: true, force: true });
}
