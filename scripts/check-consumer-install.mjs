#!/usr/bin/env node
/**
 * check-consumer-install.mjs — install the packed release the way a consumer does, and prove it loads.
 *
 * WHY THIS EXISTS. The dependency audit in ci.yml scans pnpm-lock.yaml, the workspace lockfile. A
 * consumer never installs from that file. `npm install rayspec` resolves every dependency afresh, and
 * a dependency that ships its own npm-shrinkwrap.json installs exactly the versions written there,
 * which no `pnpm.overrides` entry of ours can reach. So the workspace lockfile can be clean while the
 * tree a consumer runs carries known advisories: the copies of brace-expansion, protobufjs and undici
 * inside @earendil-works/pi-coding-agent's shrinkwrap never appear in pnpm-lock.yaml, and the
 * lockfile scan cannot see them. The same gap hides version splits: the workspace runs one copy of a
 * package that a consumer install can resolve twice.
 *
 * WHAT IT DOES.
 *   1. Reads the name of every tarball in --tarballs (the output of
 *      `node scripts/publish.mjs --pack --out <dir>`) from the package.json inside it.
 *   2. Writes a consumer package.json at --out that depends on every tarball by `file:` path, so
 *      every internal dependency resolves to the tarball being released, never to the registry.
 *   3. Runs `npm install --ignore-scripts`: the registry resolves everything else, and the resulting
 *      package-lock.json records the whole installed tree, nested shrinkwrap copies included. That
 *      file is what the CI step then scans with osv-scanner.
 *   4. Imports the entry point of every package that declares one, inside the installed tree, so the
 *      tree a consumer gets is loaded at least once before a release.
 *   5. Reports every dependency of a RaySpec package that the tree holds in more than one version.
 *      This is information, not a failure: the workspace pins exact versions and the registry moves.
 *
 *   node scripts/check-consumer-install.mjs --tarballs <dir> [--out <dir>]
 *
 * `--out` defaults to a fresh temporary directory and must be empty or absent. Needs npm and tar on
 * PATH, and the registry for anything the tarballs do not provide (npm's own configuration applies,
 * so `npm_config_offline=true` runs it without a network when the tarballs need nothing else).
 * Exit 0 = installed and every entry point loaded; 1 = a step failed, named on stderr; 2 = usage.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read `--flag value` out of argv. */
function flag(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The package.json of a packed tarball, read without unpacking it to disk. */
export function tarballManifest(tarball) {
  const text = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(text);
}

/** The consumer manifest: one `file:` dependency per tarball, keyed by the name inside it. */
export function consumerManifest(tarballs) {
  const dependencies = {};
  for (const { name, path } of tarballs) {
    if (dependencies[name] !== undefined) throw new Error(`${name} is packed twice`);
    dependencies[name] = `file:${path}`;
  }
  return { name: 'rayspec-consumer-install', private: true, dependencies };
}

/**
 * Every package the installed tree holds in more than one version, among `names`, from the JSON of
 * `npm ls --all --json`. Returns `[name, [versions…]]` pairs sorted by name.
 */
export function duplicatedPackages(tree, names) {
  const versions = new Map();
  const visit = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (names.has(name) && typeof node.version === 'string') {
        if (!versions.has(name)) versions.set(name, new Set());
        versions.get(name).add(node.version);
      }
      visit(node.dependencies);
    }
  };
  visit(tree.dependencies);
  return [...versions]
    .filter(([, set]) => set.size > 1)
    .map(([name, set]) => [name, [...set].sort()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether a manifest declares an importable entry point. A bin-only package does not. */
function hasEntryPoint(manifest) {
  return manifest.exports !== undefined || manifest.main !== undefined;
}

function main(argv) {
  const tarballDir = flag(argv, 'tarballs');
  if (tarballDir === undefined) {
    console.error('usage: check-consumer-install.mjs --tarballs <dir> [--out <dir>]');
    return 2;
  }
  const dir = resolve(tarballDir);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tgz')) : [];
  if (files.length === 0) {
    console.error(`consumer install FAILED: no .tgz in ${dir}`);
    return 1;
  }
  const out = flag(argv, 'out')
    ? resolve(flag(argv, 'out'))
    : mkdtempSync(join(tmpdir(), 'rayspec-consumer-'));
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) {
    console.error(`consumer install FAILED: ${out} is not empty`);
    return 1;
  }

  const packed = files.sort().map((f) => {
    const path = join(dir, f);
    return { path, manifest: tarballManifest(path) };
  });
  const manifest = consumerManifest(packed.map((p) => ({ name: p.manifest.name, path: p.path })));
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: out,
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    console.error(`consumer install FAILED: npm install exited ${install.status}`);
    console.error(install.stderr);
    return 1;
  }

  const failed = [];
  for (const { manifest: m } of packed) {
    if (!hasEntryPoint(m)) continue;
    const load = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(m.name)});`],
      { cwd: out, encoding: 'utf8' },
    );
    if (load.status !== 0) failed.push({ name: m.name, stderr: load.stderr });
  }
  for (const f of failed) {
    console.error(`consumer install FAILED: importing ${f.name} threw`);
    console.error(f.stderr.split('\n').slice(0, 20).join('\n'));
  }

  // The dependencies RaySpec packages declare themselves are the ones a split can reach through our
  // own code; a split deeper in the tree is somebody else's.
  const direct = new Set(
    packed.flatMap(({ manifest: m }) =>
      Object.keys(m.dependencies ?? {}).filter((d) => !d.startsWith('@rayspec/')),
    ),
  );
  const ls = spawnSync('npm', ['ls', '--all', '--json'], { cwd: out, encoding: 'utf8' });
  const tree = JSON.parse(ls.stdout || '{}');
  for (const [name, versions] of duplicatedPackages(tree, direct)) {
    console.log(
      `note: the installed tree holds ${name} in ${versions.length} versions: ${versions.join(', ')}`,
    );
  }

  if (failed.length > 0) return 1;
  console.log(
    `consumer install: ${packed.length} tarballs installed and loaded in ${out}; scan ${join(out, 'package-lock.json')}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
