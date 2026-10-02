/**
 * Build one release of the team-notes application into a directory `rayspec pack` can pack:
 *
 *   <out>/rayspec.yaml              the release spec (releases/<release>.yaml)
 *   <out>/web/dist/                 the UI (web/*), served at `/`
 *   <out>/web/dist/app-version.json the application id, version and note fields the UI reads
 *
 * The UI is the same for every release; what differs is written into `app-version.json` from the
 * release table below, and the build refuses a release spec whose `metadata.id` or
 * `metadata.version` disagrees with it, so the version the UI shows is the version the bundle
 * carries.
 *
 * Run: `node examples/team-notes/build.mjs --release=v1` (default output `dist/v1` next to this
 * script; `--out=<dir>` writes elsewhere). Needs Node only.
 */
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const APPLICATION_ID = 'team-notes';

/** Each release: its application version and the note fields its store declares, in order. */
export const RELEASES = {
  v1: { version: '1.0.0', fields: ['title', 'content'] },
  v2: { version: '1.1.0', fields: ['title', 'content', 'label'] },
  v3: { version: '2.0.0', fields: ['title', 'label'] },
};

function arg(name) {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

/** Build `release` into `outDir` and return the directory. */
export function buildRelease(release, outDir = join(here, 'dist', release)) {
  const info = RELEASES[release];
  if (info === undefined) {
    throw new Error(`unknown release '${release}' (known: ${Object.keys(RELEASES).join(', ')})`);
  }
  const spec = readFileSync(join(here, 'releases', `${release}.yaml`), 'utf8');
  const lines = spec.split('\n');
  for (const [key, value] of [
    ['id', APPLICATION_ID],
    ['version', info.version],
  ]) {
    if (!lines.some((l) => l === `  ${key}: ${value}` || l === `  ${key}: '${value}'`)) {
      throw new Error(`releases/${release}.yaml does not declare metadata.${key} '${value}'`);
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'web', 'dist'), { recursive: true });
  writeFileSync(join(outDir, 'rayspec.yaml'), spec);
  for (const file of ['index.html', 'app.js', 'app.css']) {
    cpSync(join(here, 'web', file), join(outDir, 'web', 'dist', file));
  }
  const appVersion = { application: APPLICATION_ID, version: info.version, fields: info.fields };
  writeFileSync(
    join(outDir, 'web', 'dist', 'app-version.json'),
    `${JSON.stringify(appVersion, null, 2)}\n`,
  );
  return outDir;
}

// Run as a script, also through a symlinked path (macOS /tmp, /var/folders): the module's own path is
// the real one, so the argument is compared as its real path too.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const release = arg('release');
  if (release === undefined) {
    console.error('usage: node build.mjs --release=<v1|v2|v3> [--out=<dir>]');
    process.exit(2);
  }
  const out = arg('out');
  const dir = buildRelease(
    release,
    out === undefined ? undefined : isAbsolute(out) ? out : resolve(process.cwd(), out),
  );
  console.log(`team-notes ${RELEASES[release].version} built -> ${dir}`);
}
