/**
 * Application trees for the resolver's tests: throwaway directories with a spec, modules,
 * node_modules layouts and addon binaries, and the real examples built into a temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
export const EXAMPLES = join(REPO_ROOT, 'examples');

/** The runtime version the tests pin, which is the repository's own version. */
export const RUNTIME = '1.9.0';

const created: string[] = [];

/** A fresh temporary directory, removed by `removeTemporaryDirectories`. */
export function temporaryDirectory(prefix = 'closure-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function removeTemporaryDirectories(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Write files under `root`, creating directories on the way. */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** A symbolic link at `root/path` pointing at `target`. */
export function link(root: string, path: string, target: string): void {
  const at = join(root, ...path.split('/'));
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at);
}

/** A backend spec with an identity, and the given extra YAML. */
export function backendSpec(extra = ''): string {
  return `version: '1.0'\nmetadata:\n  name: probe\n  id: probe-app\n  version: '1.0.0'\n${extra}`;
}

/** A backend spec declaring one route handler at `module`. */
export function handlerSpec(module: string): string {
  return backendSpec(
    `api:\n  - { method: GET, path: /x, action: { kind: handler, handler: h } }\n` +
      `handlers:\n  - { id: h, module: ${module}, export: handle, kind: route }\n`,
  );
}

/** An application with one ES module handler at `handlers/h.js` whose body is `source`. */
export function handlerApp(
  source: string,
  extra: Record<string, string | Uint8Array> = {},
): string {
  const root = temporaryDirectory();
  writeTree(root, {
    'rayspec.yaml': handlerSpec('handlers/h.js'),
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
    'handlers/h.js': source,
    ...extra,
  });
  return root;
}

/** A package directory's files: its package.json and an entry module. */
export function packageFiles(
  dir: string,
  manifest: Record<string, unknown>,
  extra: Record<string, string | Uint8Array> = {},
): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {
    [`${dir}/package.json`]: JSON.stringify({ main: 'index.js', ...manifest }),
    [`${dir}/index.js`]: 'module.exports = {};\n',
  };
  for (const [path, content] of Object.entries(extra)) files[`${dir}/${path}`] = content;
  return files;
}

/**
 * A PEM private-key header, built at run time so no source file of this repository carries one
 * and the repository's own secret scanners stay quiet.
 */
export function privateKeyHeader(): string {
  return ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
}

/**
 * The output of pg_dump 16 in its default plain-text format for a one-table database, as the tool
 * wrote it. The row is the canary `canary-dump@example.test`.
 */
export const PG_DUMP_OUTPUT = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict XMTvFKAMa3nUQjyhEotS5SA396Fhwpuxg3IHAvDAaN589ZX7tvajLt81gq6yvxY',
  '',
  '-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)',
  '-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)',
  '',
  'SET statement_timeout = 0;',
  'SET lock_timeout = 0;',
  'SET idle_in_transaction_session_timeout = 0;',
  "SET client_encoding = 'UTF8';",
  'SET standard_conforming_strings = on;',
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'SET check_function_bodies = false;',
  'SET xmloption = content;',
  'SET client_min_messages = warning;',
  'SET row_security = off;',
  '',
  "SET default_tablespace = '';",
  '',
  'SET default_table_access_method = heap;',
  '',
  '--',
  '-- Name: users; Type: TABLE; Schema: public; Owner: -',
  '--',
  '',
  'CREATE TABLE public.users (',
  '    email text',
  ');',
  '',
  '',
  '--',
  '-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -',
  '--',
  '',
  'COPY public.users (email) FROM stdin;',
  'canary-dump@example.test',
  '\\.',
  '',
  '',
  '--',
  '-- PostgreSQL database dump complete',
  '--',
  '',
  '\\unrestrict XMTvFKAMa3nUQjyhEotS5SA396Fhwpuxg3IHAvDAaN589ZX7tvajLt81gq6yvxY',
  '',
  '',
].join('\n');

/** The row `PG_DUMP_OUTPUT` carries, which must never reach a bundle. */
export const PG_DUMP_CANARY = 'canary-dump@example.test';

/**
 * The first bytes of a compiled addon: an ELF shared object with the given machine and OS ABI
 * (x64 and System V by default), followed by a registration symbol.
 */
export function elfAddon(
  options: { machine?: number; osAbi?: number; symbol?: string } = {},
): Uint8Array {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46], 0);
  header[4] = 2; // 64-bit
  header[5] = 1; // little-endian
  header[6] = 1; // ELF version
  header[7] = options.osAbi ?? 0;
  header.writeUInt16LE(3, 16); // shared object
  header.writeUInt16LE(options.machine ?? 62, 18);
  const symbol = Buffer.from(`\0${options.symbol ?? 'napi_register_module_v1'}\0`, 'ascii');
  return Buffer.concat([header, Buffer.alloc(32), symbol]);
}

/** The first bytes of a 64-bit Mach-O file, as a macOS build of an addon starts. */
export function machOAddon(): Uint8Array {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  return bytes;
}

const require = createRequire(import.meta.url);

/** Compile TypeScript with the repository's compiler and a project file. */
function tsc(project: string, outDir?: string): void {
  const compiler = require.resolve('typescript/bin/tsc');
  const args = [compiler, '-p', project, ...(outDir === undefined ? [] : ['--outDir', outDir])];
  execFileSync(process.execPath, args, { stdio: 'pipe' });
}

/** Build the acme-notes backend example with its own build script into a temporary directory. */
export function buildAcmeNotesBackend(): string {
  const out = join(temporaryDirectory('acme-'), 'dist');
  execFileSync(
    process.execPath,
    [join(EXAMPLES, 'acme-notes-backend', 'build.mjs'), `--out=${out}`],
    {
      stdio: 'pipe',
    },
  );
  return out;
}

/**
 * The stream-backend example as a deployer ships it from its own repository: the extension compiled
 * to `packs/stream-pack/dist`, its out-of-repository manifest (which pins the released platform
 * version) as `packs/stream-pack/package.json`, the platform installed in the extension's own
 * `node_modules`, and a spec that references the built directory.
 */
export function buildStreamBackend(): string {
  const root = temporaryDirectory('stream-');
  const source = join(EXAMPLES, 'stream-backend', 'packs', 'stream-pack');
  const pack = join(root, 'packs', 'stream-pack');
  mkdirSync(pack, { recursive: true });
  cpSync(join(source, 'index.ts'), join(pack, 'index.ts'));
  cpSync(join(source, 'handlers'), join(pack, 'handlers'), { recursive: true });
  cpSync(join(source, 'tsconfig.build.json'), join(pack, 'tsconfig.build.json'));
  cpSync(join(source, 'package.out-of-repo.json'), join(pack, 'package.json'));
  tsc(join(pack, 'tsconfig.build.json'));
  writeTree(root, {
    'packs/stream-pack/dist/package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'packs/stream-pack/node_modules/@rayspec/platform/package.json': JSON.stringify({
      name: '@rayspec/platform',
      version: RUNTIME,
      type: 'module',
      main: 'index.js',
    }),
    'packs/stream-pack/node_modules/@rayspec/platform/index.js': 'export const x = 1;\n',
    'rayspec.yaml':
      "version: '1.0'\nmetadata:\n  name: stream-backend\n  id: stream-backend\n  version: '1.0.0'\n" +
      'extensions:\n  - id: stream_pack\n    module: ./packs/stream-pack/dist\n    version: 1.0.0\n',
  });
  return root;
}
