/**
 * Build the Expense-Claim Auto-Coder into a deployable artifact.
 *
 * The serve/deploy runtime loads each `handlers[].module` with a plain dynamic import and REFUSES
 * TypeScript source (`assertCompiledJavaScriptModule`), so the committed `handlers/*.gen.ts` cannot be
 * deployed as they stand — they are the byte-goldens the renderer is pinned against, not a deployment
 * artifact. This script produces the deployable one under `dist/`:
 *
 *   1. renders each committed hole-set to `dist/handlers/<name>.gen.js` with `gen-handler --emit js`;
 *   2. writes `dist/package.json` with `{"type":"module"}` so the emitted `.js` loads as ESM;
 *   3. copies the spec into `dist/rayspec.yaml`, rewriting each `module: handlers/<name>.gen.ts`
 *      reference to `.gen.js` so the runtime loader resolves the rendered handler.
 *
 * WHY IT RENDERS RATHER THAN TRANSPILES. For a GENERATED handler the JavaScript form is a first-class
 * render target, not a build product of the TypeScript one: `--emit js` emits the same program with the
 * type-only SDK import erased and every safety annotation intact. Transpiling the `.ts` instead would
 * ship a file the renderer never produced — and the transpile config the hand-written examples use sets
 * `removeComments`, which would strip the TRUSTED-AUTHOR / UNTRUSTED notices out of the deployed code.
 *
 * `dist/package.json` is not belt-and-braces: `"type"` is what makes a `.js` file ESM. Node only falls
 * back to detecting module syntax in an ambiguous `.js` from 22.7 on, and this repository supports
 * `>=22`, so on 22.0-22.6 an undeclared `.js` would be read as CommonJS and fail on its first `export`.
 *
 * Run `node examples/expense-claim-coder/build.mjs` (`--out=<dir>` builds elsewhere), then boot
 * `dist/rayspec.yaml`. Needs the CLI built first (`pnpm build`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

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

// The CLI is spawned as a built entrypoint, so this build needs no TypeScript runtime of its own.
const cli = join(repoRoot, 'packages/app/cli/dist/index.js');
if (!existsSync(cli)) {
  console.error(
    `the CLI is not built: ${relative(repoRoot, cli)} is missing — run \`pnpm build\`.`,
  );
  process.exit(1);
}

// gen-handler jails every path it is given to the working directory, so the run below uses the repo
// root as its working directory and repo-relative paths. An `--out=` outside the repository cannot be
// expressed that way; say so rather than emitting a jail error from one directory further down.
const outRel = relative(repoRoot, join(distDir, 'handlers'));
if (outRel.startsWith(`..${sep}`) || isAbsolute(outRel)) {
  console.error(
    `--out must name a directory inside the repository (gen-handler jails paths to its working ` +
      `directory); got ${distDir}`,
  );
  process.exit(1);
}

// (0) Clean the previous artifact so a removed handler never lingers in dist/.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, 'handlers'), { recursive: true });

// (1) Render each committed hole-set as deployable ESM.
for (const name of ['lookup-categories', 'code-claim']) {
  execFileSync(
    process.execPath,
    [
      cli,
      'gen-handler',
      '--holes',
      relative(repoRoot, join(here, 'holes', `${name}.holes.json`)),
      '--out',
      outRel,
      '--emit',
      'js',
      '--file',
      `${name}.gen.js`,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
}

// (2) Mark the emitted JavaScript as ESM (the render uses `export`).
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// (3) Copy the spec, rewriting handler module references from `.gen.ts` to the rendered `.gen.js`.
const spec = readFileSync(join(here, 'rayspec.yaml'), 'utf8');
const rendered = spec.replace(/(module:\s*handlers\/\S+)\.gen\.ts/g, '$1.gen.js');
if (rendered === spec) {
  console.error(
    'the spec declares no `module: handlers/<name>.gen.ts` reference to rewrite — refusing to write a ' +
      'dist/ whose spec would point at modules this build did not produce.',
  );
  process.exit(1);
}
writeFileSync(join(distDir, 'rayspec.yaml'), rendered);

console.log(
  `expense-claim-coder built -> ${relative(repoRoot, distDir)}/ ` +
    `(boot it with RAYSPEC_SPEC_PATH=<abs>/${relative(repoRoot, distDir)}/rayspec.yaml)`,
);
