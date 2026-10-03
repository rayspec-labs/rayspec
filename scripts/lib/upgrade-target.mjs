/**
 * The runtime `scripts/upgrade-with-data.mjs` upgrades a deployment to, and the proof that the run
 * used it.
 *
 * Without a candidate it is this working tree: its built CLI, its database roles setup and its
 * `@rayspec` packages. With `--candidate <dir>` it is the release a consumer installed from the
 * candidate tarballs into `<dir>` (`scripts/check-consumer-install.mjs`), and nothing of the
 * working tree may stand in for it: every path the run uses must lie inside that install, and the
 * CLI must report the version the install carries. The harness records both in its summary, and
 * `scripts/release-manifest.mjs evidence` accepts only an upgrade onto a candidate install.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The packages an extension imports, by name and their directory in the working tree. */
export const EXTENSION_PACKAGES = [
  ['platform', join('kernel', 'platform')],
  ['handler-sdk', join('kernel', 'handler-sdk')],
];

/**
 * Where the runtime upgraded to lives. Throws when a candidate directory holds no installed
 * launcher. `version` is the version its package manifest carries.
 */
export function upgradeTarget({ repo, candidate }) {
  if (candidate === null) {
    return {
      install: 'working tree',
      root: repo,
      cli: join(repo, 'packages', 'app', 'cli', 'dist', 'index.js'),
      rolesSql: join(repo, 'packages', 'kernel', 'db', 'sql', 'database-roles.sql'),
      packages: EXTENSION_PACKAGES.map(([name, dir]) => [name, join(repo, 'packages', dir)]),
      version: JSON.parse(
        readFileSync(join(repo, 'packages', 'app', 'cli', 'package.json'), 'utf8'),
      ).version,
    };
  }
  const launcherDir = join(candidate, 'node_modules', 'rayspec');
  let launcher;
  try {
    launcher = JSON.parse(readFileSync(join(launcherDir, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`--candidate ${candidate} holds no installed rayspec`);
  }
  const bin = typeof launcher.bin === 'string' ? launcher.bin : launcher.bin?.rayspec;
  if (typeof bin !== 'string') throw new Error(`the rayspec in ${candidate} names no rayspec bin`);
  return {
    install: 'candidate',
    root: candidate,
    cli: join(launcherDir, bin),
    rolesSql: join(candidate, 'node_modules', '@rayspec', 'db', 'sql', 'database-roles.sql'),
    packages: EXTENSION_PACKAGES.map(([name]) => [
      name,
      join(candidate, 'node_modules', '@rayspec', name),
    ]),
    version: launcher.version,
  };
}

/**
 * What is wrong with a target: a path that does not exist, and, for a candidate, a path whose real
 * location is outside the candidate install (a link back into the working tree counts).
 */
export function targetProblems(target) {
  const problems = [];
  let root;
  try {
    root = realpathSync(target.root);
  } catch {
    return [`${target.root} does not exist`];
  }
  for (const [what, path] of [
    ['the CLI', target.cli],
    ['the database roles setup', target.rolesSql],
    ...target.packages.map(([name, path]) => [`@rayspec/${name}`, path]),
  ]) {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      problems.push(`${what} is missing: ${path}`);
      continue;
    }
    const rel = relative(root, real);
    if (
      target.install === 'candidate' &&
      (rel === '' || rel.startsWith(`..${sep}`) || rel === '..')
    ) {
      problems.push(`${what} resolves to ${real}, outside the candidate install ${root}`);
    }
  }
  return problems;
}

/** The version a CLI reports with `--version` (its JSON line), or null. */
export function reportedVersion(cli, run = spawnSync) {
  const res = run(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  try {
    const version = JSON.parse(String(res.stdout).trim()).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
