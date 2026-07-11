#!/usr/bin/env node
/**
 * Spec-schema DRIFT gate.
 *
 * `@rayspec/spec` ships a RUNTIME JSON-Schema exporter (`exportJsonSchema()` — `z.toJSONSchema` at
 * draft-2020-12, `io:'input'`). This gate keeps a CHECKED-IN `packages/kernel/spec/spec.schema.json` artifact
 * FRESH against that exporter: it re-derives the schema, serializes it DETERMINISTICALLY through the ONE
 * shared `serializeSchema()` helper (used by BOTH `--write` and the check), and byte-compares to the
 * committed file. Any drift (a grammar change, OR a zod-version bump that moves the emitted shape) turns
 * the gate RED — the intended SDK-churn tripwire: the bumper REGENERATES via `--write` and re-commits.
 *
 *   node scripts/check-spec-schema.mjs            # CHECK (exit 1 on drift)
 *   node scripts/check-spec-schema.mjs --write    # REGENERATE the committed artifact
 *
 * SCOPE (honest): this gate ONLY checks FRESHNESS (artifact == exporter). The exporter's
 * Ajv2020-enforceability / round-trip contract is already proven by `packages/kernel/spec/src/export.test.ts`
 * — NOT duplicated here. DB-free + secret-free (pure schema derivation). It imports the BUILT exporter
 * from `packages/kernel/spec/dist`, so it runs AFTER `pnpm build` in the CI chain (a clear error if unbuilt).
 *
 * NOTE: this is the MINIMAL schema-emit + drift-gate. Generated handler TYPES
 * are deliberately OUT OF SCOPE here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');
/** The BUILT exporter (dist) — the gate runs after `pnpm build` in the CI/local chain. */
const SPEC_DIST = join(repoRoot, 'packages', 'kernel', 'spec', 'dist', 'index.js');

/**
 * The checked-in artifacts this gate keeps fresh, each keyed to the exporter that derives it:
 *  - `version-1.0.schema.json` ← `exportUnifiedJsonSchema` (the ONE canonical schema for the unified
 *                                 `version:'1.0'` document — a `oneOf` over the two profiles).
 *  - `spec.schema.json`        ← `exportJsonSchema`        (the backend-profile VIEW — RaySpec / grammar.ts).
 *  - `product.schema.json`     ← `exportProductJsonSchema` (the product-profile VIEW — ProductSpec / product-grammar.ts).
 */
const ARTIFACTS = [
  {
    path: join(repoRoot, 'packages', 'kernel', 'spec', 'version-1.0.schema.json'),
    exportName: 'exportUnifiedJsonSchema',
  },
  {
    path: join(repoRoot, 'packages', 'kernel', 'spec', 'spec.schema.json'),
    exportName: 'exportJsonSchema',
  },
  {
    path: join(repoRoot, 'packages', 'kernel', 'spec', 'product.schema.json'),
    exportName: 'exportProductJsonSchema',
  },
];

/**
 * THE ONE canonical serialization — used by BOTH `--write` and the check, so the committed artifact and
 * the freshness comparison can NEVER use different formats. 2-space indent + a trailing newline (POSIX
 * text-file convention, so editors/git don't churn it). We do NOT sort keys: `JSON.stringify` preserves
 * the exporter's INSERTION order, so a zod-version bump that REORDERS the emitted shape ALSO trips the
 * gate (sorting would mask that churn) — the whole point of the tripwire.
 */
export function serializeSchema(schema) {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

async function loadExporters() {
  let mod;
  try {
    mod = await import(pathToFileURL(SPEC_DIST).href);
  } catch (err) {
    console.error(
      `spec-schema gate FAILED: could not import the built exporter at ${SPEC_DIST}\n` +
        '  (run `pnpm build` first — this gate runs AFTER build in the CI chain).\n' +
        `  underlying error: ${String(err?.message ? err.message : err)}`,
    );
    process.exit(1);
  }
  for (const { exportName } of ARTIFACTS) {
    if (typeof mod[exportName] !== 'function') {
      console.error(
        `spec-schema gate FAILED: @rayspec/spec/dist does not export \`${exportName}\` ` +
          '(a runtime JSON-Schema exporter). Did the export surface change?',
      );
      process.exit(1);
    }
  }
  return mod;
}

const write = process.argv.includes('--write');
const mod = await loadExporters();

for (const { path, exportName } of ARTIFACTS) {
  const fresh = serializeSchema(mod[exportName]());

  if (write) {
    writeFileSync(path, fresh);
    console.log(`spec-schema gate: REGENERATED ${path} (${fresh.length} bytes).`);
    continue;
  }

  let committed;
  try {
    committed = readFileSync(path, 'utf8');
  } catch {
    console.error(
      `spec-schema gate FAILED: the checked-in artifact is MISSING at ${path}.\n` +
        '  Regenerate + commit it: `node scripts/check-spec-schema.mjs --write`.',
    );
    process.exit(1);
  }

  if (committed !== fresh) {
    console.error(
      `spec-schema gate FAILED: ${path} is STALE (drift from ${exportName}).\n` +
        '  The grammar (or zod) changed without regenerating the artifact. Regenerate + commit it:\n' +
        '    node scripts/check-spec-schema.mjs --write\n' +
        `  (committed ${committed.length} bytes vs fresh ${fresh.length} bytes).`,
    );
    process.exit(1);
  }

  console.log(
    `spec-schema gate PASSED: ${path} is fresh (${fresh.length} bytes, byte-identical to ${exportName}).`,
  );
}
