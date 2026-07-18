/**
 * Build the stream-backend example pack into a deployable artifact.
 *
 * The stream surface is delivered as a `defineExtension` PACK (packs/stream-pack) authored in
 * TypeScript. The `rayspec` serve/deploy runtime is compiled-JavaScript-only: it loads each pack module
 * with a plain dynamic import that fail-closed-rejects a `.ts` path. So the pack has to be compiled to
 * `.js` before deploy. This script compiles the pack into `packs/stream-pack/dist/`:
 *
 *   1. transpiles the pack's `index.ts` + `handlers/*.ts` -> `packs/stream-pack/dist/*.js` (ESM) via
 *      tsconfig.build.json;
 *   2. writes `dist/package.json` with `{"type":"module"}` so the emitted `.js` loads as ESM;
 *   3. copies the pack's generated schema + migrations so the built pack is self-contained.
 *
 * The built pack lives UNDER `packs/stream-pack/`, so its entry resolves `@rayspec/platform` (the pack
 * entry imports `defineExtension` from it) through the pack's own `node_modules` — mirroring how a real
 * pack ships in its own repo with the platform as a dependency. Deploy a spec that references the built
 * pack directory `packs/stream-pack/dist` (the loader resolves the compiled `.js` — the manifest keeps its
 * authored `.ts` module paths, and `.js`-preferred resolution loads the compiled siblings, so no manifest
 * rewrite is needed). Run: `node examples/stream-backend/build.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packDir = join(here, 'packs', 'stream-pack');
// The built pack lives under the pack dir so it resolves `@rayspec/platform` via the pack's node_modules.
const distDir = join(packDir, 'dist');

// (0) Clean the previous artifact so a removed handler never lingers in dist/.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// (1) Transpile the pack (index.ts + handlers/*.ts) -> dist/*.js (ESM). tsconfig.build.json emits to ./dist.
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(packDir, 'tsconfig.build.json')], {
  stdio: 'inherit',
});

// (2) Mark the emitted pack JavaScript as ESM (the emit uses `export`/`import`).
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// (3) Copy the pack's generated schema + migrations so the built pack is self-contained.
for (const dir of ['generated', 'drizzle']) {
  cpSync(join(packDir, dir), join(distDir, dir), { recursive: true });
}

console.log(
  'stream-backend pack built -> packs/stream-pack/dist/ ' +
    '(deploy a spec referencing packs/stream-pack/dist)',
);
