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
 * SCOPE (honest): this gate checks FRESHNESS (artifact == exporter) AND the per-node CLOSED-SHAPE
 * invariant — every object node that declares `properties`, at EVERY nesting level of every derived
 * schema, must carry `additionalProperties:false` (a grammar level that lost its `.strict()` turns
 * the gate red at its exact JSON Pointer; deliberate record maps declare no properties and stay
 * legal). The walk itself (`findOpenObjectNodes`) lives in the exporter module and is unit-tested in
 * `packages/kernel/spec/src/export.test.ts`; the gate SELF-TESTS it on two known fixtures before
 * trusting any scan. The exporter's Ajv2020-enforceability / round-trip contract is already proven
 * by the same test file — NOT duplicated here. DB-free + secret-free (pure schema derivation). It
 * imports the BUILT exporter from `packages/kernel/spec/dist`, so it runs AFTER `pnpm build` in the
 * CI chain (a clear error if unbuilt).
 *
 * NOTE: this is the MINIMAL schema-emit + drift-gate. Generated handler TYPES
 * are deliberately OUT OF SCOPE here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the repo root from THIS file via fileURLToPath — a checkout path with a space (or any
// other percent-encodable character) survives, where `new URL(import.meta.url).pathname` would leave
// a literal `%20` in the path and break every join below.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  if (typeof mod.findOpenObjectNodes !== 'function') {
    console.error(
      'spec-schema gate FAILED: @rayspec/spec/dist does not export `findOpenObjectNodes` ' +
        '(the per-node closed-shape walk). Did the export surface change?',
    );
    process.exit(1);
  }
  return mod;
}

/**
 * SELF-TEST the closed-shape walk on two known fixtures BEFORE trusting any scan: an object that
 * lost its `.strict()` must be flagged at its exact pointer, and a closed shape with a deliberate
 * record map must scan clean. A detector that cannot find the planted defect proves nothing about
 * the real artifacts. Exit 2 on a self-test failure (distinct from a real violation's exit 1).
 */
function selfTestClosedShapeWalk(findOpenObjectNodes) {
  const openFixture = {
    type: 'object',
    properties: { outer: { type: 'object', properties: { x: { type: 'string' } } } },
    additionalProperties: false,
  };
  const closedFixture = {
    type: 'object',
    properties: {
      map: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
    },
    additionalProperties: false,
  };
  const flagged = findOpenObjectNodes(openFixture);
  const clean = findOpenObjectNodes(closedFixture);
  if (flagged.length !== 1 || flagged[0] !== '/properties/outer' || clean.length !== 0) {
    console.error(
      'spec-schema gate SELF-TEST FAILED: findOpenObjectNodes did not flag the planted open node ' +
        `(got ${JSON.stringify(flagged)}) or wrongly flagged the closed fixture ` +
        `(got ${JSON.stringify(clean)}). Refusing to scan with a broken detector.`,
    );
    process.exit(2);
  }
}

const write = process.argv.includes('--write');
const mod = await loadExporters();
selfTestClosedShapeWalk(mod.findOpenObjectNodes);

for (const { path, exportName } of ARTIFACTS) {
  const derived = mod[exportName]();
  const fresh = serializeSchema(derived);

  // The CLOSED-SHAPE invariant binds on --write too: an open node must never be committable.
  const openNodes = mod.findOpenObjectNodes(derived);
  if (openNodes.length > 0) {
    console.error(
      `spec-schema gate FAILED: ${exportName} emits ${openNodes.length} OPEN object node(s) — an ` +
        'object level declares properties without `additionalProperties:false` (a grammar object ' +
        'lost its `.strict()`; unknown keys would be silently accepted there). Fail-closed. At:\n' +
        openNodes.map((pointer) => `    ${pointer}`).join('\n'),
    );
    process.exit(1);
  }

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
    `spec-schema gate PASSED: ${path} is fresh (${fresh.length} bytes, byte-identical to ${exportName}) ` +
      'and every object node that declares properties is closed.',
  );
}
