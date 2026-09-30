/**
 * The fixed rules of the closure: which names a bundle path may hold, which files and directories
 * never enter a bundle, and which files are dependency locks.
 *
 * A bundle holds regular files under `payload/`, whose path segments use `A-Z a-z 0-9 _ . - @ +`
 * only (the manifest schema's `payloadPath`). The resolver never zips a directory wholesale: it
 * walks only the directories the spec names or `--include` adds, and inside them it leaves out
 * version-control metadata, caches, logs, environment files, credentials, database dumps, local
 * dependency directories and, unless asked for, source maps, matching names in any letter case. A
 * file of those classes that is named explicitly is refused rather than dropped. A walked directory
 * also leaves out `*.sql` files, since a plain-text dump carries that name; a SQL file the spec or
 * `--include` names goes in. A file whose first bytes are those of a database dump (pg_dump,
 * pg_dumpall, mysqldump or MariaDB output, a pg_dump archive or an SQLite database) is a dump
 * whatever its name: left out of a walked directory, refused when named. Inside a vendored
 * package only environment and credential files by name, version control and, unless asked for,
 * source maps are left out, since the package may read any other file at run time.
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
  ['.aws', 'a credential'],
  ['.azure', 'a credential'],
  ['.docker', 'a credential'],
  ['.gnupg', 'a credential'],
  ['.kube', 'a credential'],
  ['.ssh', 'a credential'],
  ['.cache', 'a cache'],
  ['.turbo', 'a cache'],
  ['.parcel-cache', 'a cache'],
  ['.npm', 'a cache'],
  ['.pnpm-store', 'a cache'],
  ['.yarn', 'a cache'],
  ['logs', 'a log'],
  ['node_modules', 'a local dependency directory'],
]);

/** The directories left out of a vendored package: its own copy of version control or credentials. */
const EXCLUDED_PACKAGE_DIRECTORY_CLASSES: ReadonlySet<ExclusionClass> = new Set([
  'version control metadata',
  'a credential',
  'a local dependency directory',
]);

/**
 * Files that hold credentials or environment values by their name alone. They are left out of a
 * vendored package as well as of the application's own directories.
 */
const SECRET_FILES: ReadonlyMap<string, ExclusionClass> = new Map([
  ['.env', 'an environment file'],
  ['.envrc', 'an environment file'],
  ['id_rsa', 'a credential'],
  ['id_dsa', 'a credential'],
  ['id_ecdsa', 'a credential'],
  ['id_ed25519', 'a credential'],
  ['.pgpass', 'a credential'],
  ['.netrc', 'a credential'],
  ['.npmrc', 'a credential'],
  ['.yarnrc', 'a credential'],
  ['.pypirc', 'a credential'],
  ['.dockercfg', 'a credential'],
  ['.git-credentials', 'a credential'],
]);

const OTHER_FILES: ReadonlyMap<string, ExclusionClass> = new Map([
  ['.eslintcache', 'a cache'],
  ['credentials', 'a credential'],
  ['credentials.json', 'a credential'],
  ['.ds_store', 'operating system metadata'],
  ['thumbs.db', 'operating system metadata'],
]);

const EXCLUDED_SUFFIXES: readonly (readonly [string, ExclusionClass])[] = [
  ['.log', 'a log'],
  ['.pem', 'a credential'],
  ['.key', 'a credential'],
  ['.p8', 'a credential'],
  ['.p12', 'a credential'],
  ['.pfx', 'a credential'],
  ['.ppk', 'a credential'],
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

/**
 * The class of a directory the resolver never walks into, by its name in any letter case: a file
 * system that ignores case opens `.GIT` as `.git`.
 */
export function excludedDirectory(name: string): ExclusionClass | undefined {
  return EXCLUDED_DIRECTORIES.get(name.toLowerCase());
}

/**
 * The class of a directory left out of a vendored package. Only version control, credential and
 * nested dependency directories are: a package's `logs/` or `.cache/` may be code it loads.
 */
export function excludedPackageDirectory(name: string): ExclusionClass | undefined {
  const exclusion = excludedDirectory(name);
  return exclusion !== undefined && EXCLUDED_PACKAGE_DIRECTORY_CLASSES.has(exclusion)
    ? exclusion
    : undefined;
}

/** An environment or credential file by its name alone, in any letter case. */
function secretFile(lower: string): ExclusionClass | undefined {
  const exact = SECRET_FILES.get(lower);
  if (exact !== undefined) return exact;
  if (lower.startsWith('.env.') || lower.endsWith('.env')) return 'an environment file';
  return undefined;
}

/**
 * The class of a file that never enters a bundle, by its name in any letter case. Source maps are
 * left out unless `sourceMaps` is set.
 */
export function excludedFile(name: string, sourceMaps: boolean): ExclusionClass | undefined {
  const lower = name.toLowerCase();
  const exclusion = secretFile(lower) ?? OTHER_FILES.get(lower);
  if (exclusion !== undefined) return exclusion;
  if (
    lower.endsWith('.json') &&
    (isServiceAccountKey(lower) || lower.startsWith('client_secret'))
  ) {
    return 'a credential';
  }
  if (!sourceMaps && lower.endsWith('.map')) return 'a source map';
  for (const [suffix, suffixClass] of EXCLUDED_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffixClass;
  }
  return undefined;
}

/**
 * The class of a file left out of a directory the resolver walks: every class of `excludedFile`, and
 * `*.sql` files, which a plain-text database dump is named. A SQL file named explicitly is not
 * excluded by its name, so a migration the spec or `--include` names still goes in.
 */
export function excludedWalkedFile(name: string, sourceMaps: boolean): ExclusionClass | undefined {
  const exclusion = excludedFile(name, sourceMaps);
  if (exclusion !== undefined) return exclusion;
  return name.toLowerCase().endsWith('.sql') ? 'a database dump' : undefined;
}

/** How many leading bytes of a file `isDatabaseDump` reads. */
export const DATABASE_DUMP_HEADER_BYTES = 4096;

/** The comment line a plain-text dump tool writes near the top of its output. */
const DUMP_BANNER = /^-- (?:PostgreSQL database (?:cluster )?dump|MySQL dump |MariaDB dump )/m;

const BINARY_DUMP_MAGIC: readonly Buffer[] = [
  Buffer.from('PGDMP', 'latin1'),
  Buffer.from('SQLite format 3\0', 'latin1'),
];

/**
 * Whether the first bytes of a file are those of a database dump: the banner pg_dump, pg_dumpall,
 * mysqldump or mariadb-dump write in plain-text output, or the magic of a pg_dump archive or an
 * SQLite database. Only the first `DATABASE_DUMP_HEADER_BYTES` are looked at.
 */
export function isDatabaseDump(head: Uint8Array): boolean {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength).subarray(
    0,
    DATABASE_DUMP_HEADER_BYTES,
  );
  if (BINARY_DUMP_MAGIC.some((magic) => bytes.subarray(0, magic.length).equals(magic))) return true;
  return DUMP_BANNER.test(bytes.toString('latin1'));
}

/**
 * The class of a file left out of a vendored package. Only environment and credential files by
 * their exact name, operating-system metadata and, unless `sourceMaps` is set, source maps are: a
 * package reads its own `*.pem` certificate bundle or `*.db` data file at run time, and a private
 * key among its files is found by the secret scan's content rule instead.
 */
export function excludedPackageFile(name: string, sourceMaps: boolean): ExclusionClass | undefined {
  const lower = name.toLowerCase();
  const exclusion = secretFile(lower);
  if (exclusion !== undefined) return exclusion;
  if (lower === '.ds_store' || lower === 'thumbs.db') return 'operating system metadata';
  if (!sourceMaps && lower.endsWith('.map')) return 'a source map';
  return undefined;
}

function isServiceAccountKey(lower: string): boolean {
  return (
    lower.includes('service-account') ||
    lower.includes('service_account') ||
    lower.includes('serviceaccount')
  );
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
