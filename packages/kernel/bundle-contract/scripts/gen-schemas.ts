/**
 * Writes `src/schemas.gen.ts`: the contract's JSON Schemas as module constants, so the validators
 * compile them without reading a file at run time.
 *
 * Usage: tsx scripts/gen-schemas.ts
 *
 * The sources are the committed contract files under `contract/`. `schemas.test.ts` regenerates
 * the module text and compares it with what is committed.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSchemasModule } from '../src/test-support/schemas-module.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(packageRoot, 'src', 'schemas.gen.ts');
writeFileSync(out, renderSchemasModule(join(packageRoot, 'contract')));
console.log(`gen:schemas: wrote ${out}`);
