/**
 * Build the acme-notes backend into a deployable artifact.
 *
 * The `rayspec` serve/deploy runtime is JavaScript-only: it loads each `handlers[].module` with a
 * plain dynamic import, which cannot execute TypeScript. A backend profile that references custom
 * `.ts` handlers therefore has to compile them to `.js` before deploy (the zero-code product profile
 * needs no build). This script produces that artifact under `dist/`:
 *
 *   1. transpiles `handlers/*.ts` -> `dist/handlers/*.js` (ESM) via tsconfig.build.json;
 *   2. writes `dist/package.json` with `{"type":"module"}` so the emitted `.js` loads as ESM;
 *   3. copies the spec into `dist/rayspec.yaml`, rewriting each `module: handlers/<name>.ts`
 *      reference to `.js` so the runtime loader resolves the compiled handler;
 *   4. copies the generated schema + migrations so `dist/` is a complete, self-contained deployment
 *      directory.
 *
 * Deploy from the built directory, e.g. `rayspec deploy dist/rayspec.yaml` — its handlers now
 * resolve to compiled `.js`. Run: `node examples/acme-notes-backend/build.mjs` (or pass `--out=<dir>`
 * to build into a different directory).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The output directory (default `dist/` next to this script; overridable with `--out=<dir>`).
const outArg = process.argv
  .slice(2)
  .find((a) => a.startsWith('--out='))
  ?.slice('--out='.length);
const distDir = outArg
  ? isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg)
  : join(here, 'dist');

// (0) Clean the previous artifact so a removed handler never lingers in dist/.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// (1) Transpile handlers/*.ts -> <distDir>/handlers/*.js (ESM). `tsc` is resolved from the workspace.
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(
  process.execPath,
  [tsc, '-p', join(here, 'tsconfig.build.json'), '--outDir', distDir],
  { stdio: 'inherit' },
);

// (2) Mark the emitted JavaScript as ESM (the emit uses `export`/`import`).
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// (3) Copy the spec, rewriting handler module references from `.ts` to the compiled `.js`.
const spec = readFileSync(join(here, 'rayspec.yaml'), 'utf8');
const compiledSpec = spec.replace(/^(\s*module:\s*handlers\/\S+)\.ts(\s*)$/gm, '$1.js$2');
writeFileSync(join(distDir, 'rayspec.yaml'), compiledSpec);

// (4) Copy the generated schema + migrations so dist/ is a complete deployment directory.
for (const dir of ['generated', 'drizzle']) {
  cpSync(join(here, dir), join(distDir, dir), { recursive: true });
}

console.log('acme-notes backend built -> dist/ (deploy with: rayspec deploy dist/rayspec.yaml)');
