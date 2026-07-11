/**
 * Codegen CLI: materialize a validated RaySpec `stores[]` into the committed product-schema
 * module + its migration SQL.
 *
 * Usage:
 *   tsx scripts/gen-product-schema.ts                       # regenerate the PRODUCT-EMPTY baseline
 *                                                           # (src/generated/product-schema.ts)
 *   tsx scripts/gen-product-schema.ts <spec.yaml> <outDir> # generate a deployment/throwaway:
 *                                                           #   <outDir>/generated/product-schema.ts
 *                                                           #   <outDir>/drizzle/0000_product_stores.sql
 *
 * The platform main line only ever runs the no-arg (empty) form. The throwaway form is run to
 * (re)produce `examples/acme-notes-backend/generated/` + `examples/acme-notes-backend/drizzle/` — the
 * forcing-function artifact a real deployment would commit in its OWN repo. The SQL is the clean,
 * spec-derived artifact (read it, never blind-apply a contaminated drizzle-kit autogen).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '@rayspec/spec';
import { generateProductSchema } from '../src/generated/generate-product-schema.js';
import { generateProductSql } from '../src/generated/generate-product-sql.js';

const here = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const [specPath, outDir] = process.argv.slice(2);

  if (!specPath) {
    // No-arg: regenerate the product-EMPTY baseline in place.
    const out = join(here, '..', 'src', 'generated', 'product-schema.ts');
    writeFileSync(out, generateProductSchema([]), 'utf8');
    console.log(`gen:product-schema: wrote PRODUCT-EMPTY baseline -> ${out}`);
    return;
  }

  if (!outDir) {
    console.error('usage: gen-product-schema.ts <spec.yaml> <outDir>');
    process.exit(1);
  }

  const raw = readFileSync(specPath, 'utf8');
  const result = parseSpec(raw);
  if (!result.ok) {
    console.error(`gen:product-schema: spec ${specPath} is INVALID — refusing to generate:`);
    for (const e of result.errors) {
      console.error(`  [${e.code}] ${e.path ?? '(doc)'}: ${e.message}`);
    }
    process.exit(1);
  }

  const stores = result.value.stores;
  const schemaOut = join(outDir, 'generated', 'product-schema.ts');
  const sqlOut = join(outDir, 'drizzle', '0000_product_stores.sql');
  mkdirSync(dirname(schemaOut), { recursive: true });
  mkdirSync(dirname(sqlOut), { recursive: true });
  writeFileSync(schemaOut, generateProductSchema(stores), 'utf8');
  writeFileSync(sqlOut, `${generateProductSql(stores)}\n`, 'utf8');
  console.log(
    `gen:product-schema: ${stores.length} store(s) -> ${schemaOut} + ${sqlOut} ` +
      `(${stores.map((s) => s.name).join(', ')})`,
  );
}

main();
