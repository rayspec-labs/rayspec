/**
 * Build the asset-catalog application into a deployable tree that `rayspec pack` packs:
 *
 *   <out>/rayspec.yaml                          the deployment spec, unchanged
 *   <out>/public/                               the static assets
 *   <out>/packs/catalog-pack/index.js           the compiled extension entry
 *   <out>/packs/catalog-pack/handlers/*.js      the compiled handlers
 *   <out>/packs/catalog-pack/package.json       package.out-of-repo.json (ESM, its dependencies)
 *   <out>/packs/catalog-pack/node_modules/      the extension's third-party dependencies
 *
 * The third-party dependencies are copied from wherever the source extension resolves them (its
 * own `node_modules`, a pnpm link in this repository or an npm install outside it), each with the
 * dependencies it declares, into a plain `node_modules` tree: Node resolves the same versions from
 * the built extension, and pack carries exactly that tree. `@rayspec/*` is not copied — the runtime
 * that deploys the bundle provides it. Nothing is downloaded.
 *
 * Run: `node examples/asset-catalog/build.mjs` (default output `dist/` next to this script;
 * `--out=<dir>` writes elsewhere). Compiling needs `typescript` resolvable from this directory.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packSource = join(here, 'packs', 'catalog-pack');

/** The package directory `name` resolves to from `fromDir`, through its package.json. */
function packageDir(fromDir, name) {
  const requireFrom = createRequire(join(fromDir, 'package.json'));
  // Resolve the package.json itself where the package exports it; otherwise walk up from its entry.
  try {
    return dirname(realpathSync(requireFrom.resolve(`${name}/package.json`)));
  } catch {
    let dir = dirname(realpathSync(requireFrom.resolve(name)));
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (manifest.name === name) return dir;
      } catch {
        // no package.json here; keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`cannot find the package directory of '${name}'`);
      dir = parent;
    }
  }
}

/**
 * Copy `name` (resolved from `fromDir`) and, recursively, the dependencies it declares into
 * `nodeModules`, flat. Two versions of one package would need nesting; this application has none,
 * so a second version is refused rather than silently replaced.
 */
function vendor(fromDir, name, nodeModules, seen) {
  const dir = packageDir(fromDir, name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const already = seen.get(name);
  if (already !== undefined) {
    if (already !== manifest.version) {
      throw new Error(
        `two versions of '${name}' (${already}, ${manifest.version}) would be needed`,
      );
    }
    return;
  }
  seen.set(name, manifest.version);
  cpSync(dir, join(nodeModules, name), {
    recursive: true,
    dereference: true,
    filter: (src) => !src.slice(dir.length).split(/[/\\]/).includes('node_modules'),
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    vendor(dir, dependency, nodeModules, seen);
  }
}

/** Build the application into `outDir` and return the directory. */
export function buildAssetCatalog(outDir = join(here, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  const packOut = join(outDir, 'packs', 'catalog-pack');
  mkdirSync(packOut, { recursive: true });

  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [tsc, '-p', join(packSource, 'tsconfig.build.json'), '--outDir', packOut],
    { stdio: 'inherit' },
  );

  const { '//': _note, ...manifest } = JSON.parse(
    readFileSync(join(packSource, 'package.out-of-repo.json'), 'utf8'),
  );
  writeFileSync(join(packOut, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const seen = new Map();
  for (const dependency of Object.keys(manifest.dependencies)) {
    if (dependency.startsWith('@rayspec/')) continue;
    vendor(packSource, dependency, join(packOut, 'node_modules'), seen);
  }

  cpSync(join(here, 'rayspec.yaml'), join(outDir, 'rayspec.yaml'));
  cpSync(join(here, 'public'), join(outDir, 'public'), { recursive: true });
  return outDir;
}

// Run as a script, also through a symlinked path (macOS /tmp, /var/folders): the module's own path is
// the real one, so the argument is compared as its real path too.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const out = process.argv
    .slice(2)
    .find((a) => a.startsWith('--out='))
    ?.slice('--out='.length);
  const dir = buildAssetCatalog(
    out === undefined ? undefined : isAbsolute(out) ? out : resolve(process.cwd(), out),
  );
  console.log(`asset-catalog built -> ${dir} (pack ${join(dir, 'rayspec.yaml')})`);
}
