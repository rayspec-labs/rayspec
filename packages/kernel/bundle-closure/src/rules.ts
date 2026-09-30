/**
 * The fixed rules of the closure: which names a bundle path may hold, which files and directories
 * never enter a bundle, and which files are dependency locks.
 *
 * A bundle holds regular files under `payload/`, whose path segments use `A-Z a-z 0-9 _ . - @ +`
 * only (the manifest schema's `payloadPath`). The resolver never zips a directory wholesale: it
 * walks only the directories the spec names or `--include` adds, and inside them it leaves out
 * version-control metadata, caches, logs, environment files, credentials, database dumps, local
 * dependency directories and, unless asked for, source maps. A file of those classes that is named
 * explicitly is refused rather than dropped.
 */

/** One segment of a bundle path. */
const SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/** The longest bundle path the reader accepts. */
export const MAX_PAYLOAD_PATH_LENGTH = 4096;

/**
 * The bundle path of a file at `relative` (a root-relative path with `/` separators), or `undefined`
 * when a segment holds a character a bundle path cannot carry, or is `.` or `..`.
 */
export function payloadPathFor(relative: string): string | undefined {
  const segments = relative.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') return undefined;
  }
  return `payload/${relative}`;
}

/** Why a file or directory is left out of a bundle. */
export type ExclusionClass =
  | 'version control metadata'
  | 'a cache'
  | 'a log'
  | 'an environment file'
  | 'a credential'
  | 'a database dump'
  | 'a source map'
  | 'a local dependency directory'
  | 'operating system metadata';

const EXCLUDED_DIRECTORIES: ReadonlyMap<string, ExclusionClass> = new Map([
  ['.git', 'version control metadata'],
  ['.hg', 'version control metadata'],
  ['.svn', 'version control metadata'],
  ['.cache', 'a cache'],
  ['.turbo', 'a cache'],
  ['.parcel-cache', 'a cache'],
  ['.npm', 'a cache'],
  ['.pnpm-store', 'a cache'],
  ['.yarn', 'a cache'],
  ['logs', 'a log'],
  ['node_modules', 'a local dependency directory'],
]);

const EXCLUDED_FILES: ReadonlyMap<string, ExclusionClass> = new Map([
  ['.eslintcache', 'a cache'],
  ['.env', 'an environment file'],
  ['id_rsa', 'a credential'],
  ['id_dsa', 'a credential'],
  ['id_ecdsa', 'a credential'],
  ['id_ed25519', 'a credential'],
  ['.pgpass', 'a credential'],
  ['.netrc', 'a credential'],
  ['.npmrc', 'a credential'],
  ['.git-credentials', 'a credential'],
  ['.DS_Store', 'operating system metadata'],
  ['Thumbs.db', 'operating system metadata'],
]);

const EXCLUDED_SUFFIXES: readonly (readonly [string, ExclusionClass])[] = [
  ['.log', 'a log'],
  ['.pem', 'a credential'],
  ['.key', 'a credential'],
  ['.p12', 'a credential'],
  ['.pfx', 'a credential'],
  ['.jks', 'a credential'],
  ['.keystore', 'a credential'],
  ['.dump', 'a database dump'],
  ['.pgdump', 'a database dump'],
  ['.sqlite', 'a database dump'],
  ['.sqlite3', 'a database dump'],
  ['.db', 'a database dump'],
  ['.sql.gz', 'a database dump'],
  ['.bak', 'a database dump'],
];

/** The class of a directory the resolver never walks into, by its name. */
export function excludedDirectory(name: string): ExclusionClass | undefined {
  return EXCLUDED_DIRECTORIES.get(name);
}

/**
 * The class of a file that never enters a bundle, by its name. Source maps are left out unless
 * `sourceMaps` is set.
 */
export function excludedFile(name: string, sourceMaps: boolean): ExclusionClass | undefined {
  const exact = EXCLUDED_FILES.get(name);
  if (exact !== undefined) return exact;
  if (name.startsWith('.env.')) return 'an environment file';
  const lower = name.toLowerCase();
  if (!sourceMaps && lower.endsWith('.map')) return 'a source map';
  for (const [suffix, exclusion] of EXCLUDED_SUFFIXES) {
    if (lower.endsWith(suffix)) return exclusion;
  }
  return undefined;
}

/** The dependency lock files the resolver carries when it finds them. */
export const LOCKFILE_NAMES: readonly string[] = [
  'bun.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

/**
 * Packages that exist to load a compiled addon. An application module importing one, or a package
 * depending on one, carries native code.
 */
export const NATIVE_LOADERS: ReadonlySet<string> = new Set([
  '@mapbox/node-pre-gyp',
  'bindings',
  'cmake-js',
  'nan',
  'node-addon-api',
  'node-gyp-build',
  'node-gyp-build-optional-packages',
  'node-pre-gyp',
  'prebuild-install',
]);
