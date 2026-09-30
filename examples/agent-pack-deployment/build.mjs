/**
 * Build the agent-pack-deployment example extension into a deployable artifact.
 *
 * The whole product surface (the `notes` store, the `lookup_note` tool + its handler, and the
 * extension-contributed `note_summarizer` agent) is delivered as an EXTENSION (a `defineExtension` manifest)
 * (packs/agent-pack) authored in TypeScript. The `rayspec` serve/deploy runtime is
 * compiled-JavaScript-only: it loads each extension module through the guarded `defaultImporter`, which
 * fail-closed-rejects a `.ts` path. So the extension has to be compiled to `.js` before deploy. This script
 * compiles the extension into `packs/agent-pack/dist/`:
 *
 *   1. transpiles the extension's `index.ts` + `handlers/*.ts` -> `packs/agent-pack/dist/*.js` (ESM) via
 *      tsconfig.build.json;
 *   2. writes `dist/package.json` with `{"type":"module"}` so the emitted `.js` loads as ESM.
 *
 * The built extension lives UNDER `packs/agent-pack/`, so its entry resolves `@rayspec/platform` (the extension
 * entry imports `defineExtension` from it) through the extension's own `node_modules`: the loader imports the
 * entry by the ENTRY's own absolute file URL, so Node resolves that bare specifier from the BUILT file's
 * location upward, hitting the extension's own `node_modules` before anything the deploy tree carries above
 * it — ship `dist/` alone and the extension gets whatever is up there, or nothing. IN THIS REPO that
 * `node_modules` is the pnpm workspace link; out of the repo it is a real install of the RELEASED
 * `@rayspec/platform`, and the extension DIRECTORY (`dist/` + `node_modules/`) is what has to reach the
 * deploy target — see examples/stream-backend/README.md, 'Shipping this extension from its own repo'. Deploy
 * a spec that references the built extension directory `packs/agent-pack/dist` (the loader resolves the
 * compiled `.js` — the manifest keeps its authored `.ts` module paths, and `.js`-preferred resolution
 * loads the compiled siblings, so no manifest rewrite is needed). Run:
 * `node examples/agent-pack-deployment/build.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packDir = join(here, 'packs', 'agent-pack');
// The built extension lives under the extension dir so it resolves `@rayspec/platform` via the extension's node_modules.
const distDir = join(packDir, 'dist');

// (0) Clean the previous artifact so a removed handler never lingers in dist/.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// (1) Transpile the extension (index.ts + handlers/*.ts) -> dist/*.js (ESM). tsconfig.build.json emits to ./dist.
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(packDir, 'tsconfig.build.json')], {
  stdio: 'inherit',
});

// (2) Mark the emitted extension JavaScript as ESM (the emit uses `export`/`import`).
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

console.log(
  'agent-pack-deployment extension built -> packs/agent-pack/dist/ ' +
    '(deploy a spec referencing packs/agent-pack/dist)',
);
