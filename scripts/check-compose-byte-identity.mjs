#!/usr/bin/env node
/**
 * Compose byte-identity gate — the version-merge forcing-function.
 *
 * THE SAFETY STORY, made a STANDING CI check: the unified `version:'1.0'` FRONT-END merge did
 * NOT touch the ENGINE. It parses the neutral `examples/acme-notes/acme-notes.product.yaml` (now
 * `version:'1.0'`) through the REAL parser, composes it through the REAL `composeProductDeploy`, and
 * byte-compares the lowered `engineSpec` against the committed
 * `packages/compose/product-yaml/src/__fixtures__/acme-notes-compose-golden.json`. The compose golden is
 * FROZEN (`buildProductEngineSpec` keeps the engine-internal `version:'0.1'` literal — see compose.ts):
 * a `version:'1.0'` product doc must STILL lower to the byte-identical 0.1 engine spec, or this gate is
 * RED. The `compose-conditional-mount.test.ts` proves it at unit level; this gate proves it at the
 * aggregate `pnpm gate` level the PM/CI runs.
 *
 * DB-free + secret-free (pure parse + compose; compose never executes the enqueuer/stt/agent fakes, it
 * only WIRES them). Imports the BUILT dist, so it runs AFTER `pnpm build` in the CI chain.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');
const distUrl = (pkg) => pathToFileURL(join(repoRoot, 'packages', pkg, 'dist', 'index.js')).href;

function die(msg) {
  console.error(`compose-byte-identity gate FAILED: ${msg}`);
  process.exit(1);
}

let spec;
let productRuntime;
let agentRuntime;
let sttRuntime;
try {
  spec = await import(distUrl('kernel/spec'));
  productRuntime = await import(distUrl('compose/product-yaml'));
  agentRuntime = await import(distUrl('workflow/nodes/agent-runtime'));
  sttRuntime = await import(distUrl('kernel/stt-port'));
} catch (err) {
  die(
    `could not import a built dist (run \`pnpm build\` first — this gate runs AFTER build).\n` +
      `  underlying error: ${String(err?.message ? err.message : err)}`,
  );
}

const { parseProductSpec } = spec;
const { composeProductDeploy, composeCapabilityStores, deriveProductStores } = productRuntime;
const { InMemoryAgentHandlerRegistry } = agentRuntime;
const { FakeSttAdapter } = sttRuntime;

const TENANT = '00000000-0000-0000-0000-0000000000d5';

/** A no-op WorkflowEnqueuer — compose only WIRES it (never executes a run), so a stub suffices. */
const enqueuer = {
  async enqueueWorkflowRun(input) {
    return { workflowRunId: `run:${input.idempotencyKey}`, deduped: false };
  },
};

const acmePath = join(repoRoot, 'examples', 'acme-notes', 'acme-notes.product.yaml');
const parsed = parseProductSpec(readFileSync(acmePath, 'utf8'));
if (!parsed.ok) {
  die(
    `acme-notes.product.yaml must parse at version:'1.0' — got:\n` +
      JSON.stringify(parsed.errors, null, 2),
  );
}
const productSpec = parsed.value;

const caps = composeCapabilityStores(productSpec);
const derived = deriveProductStores(productSpec, caps.names);
const registry = new InMemoryAgentHandlerRegistry();
registry.register('agent.note_extractor', () => []);

let composed;
try {
  composed = composeProductDeploy(productSpec, {
    tenantId: TENANT,
    enqueuer,
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    ...(derived.transcripts ? { transcripts: derived.transcripts } : {}),
    stt: { adapter: new FakeSttAdapter({ fixtures: [] }) },
    agents: registry,
  });
} catch (err) {
  die(`composeProductDeploy threw: ${String(err?.message ? err.message : err)}`);
}

const goldenPath = join(
  repoRoot,
  'packages',
  'compose',
  'product-yaml',
  'src',
  '__fixtures__',
  'acme-notes-compose-golden.json',
);
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

// Byte-compare EVERY committed golden key against the composed deploy's corresponding field. The golden
// pins FOUR facets (the same four `compose-conditional-mount.test.ts` asserts): the lowered `engineSpec`
// (version · metadata · stores set+order+column shapes · api set+order), the composed `handlerIds`
// (the SORTED handler-map keys, matching the unit test's `[...handlers.keys()].sort()`), the
// `triggerEvents`, and the `viewRoutes`. Comparing only `engineSpec` (the pre-fix behavior) left the
// handler/trigger/view surface UNPINNED at the aggregate-gate level — this pins the WHOLE golden.
const composedFacets = {
  engineSpec: composed.engineSpec,
  handlerIds: [...composed.handlers.keys()].sort(),
  triggerEvents: composed.triggerEvents,
  viewRoutes: composed.viewRoutes,
};

for (const key of ['engineSpec', 'handlerIds', 'triggerEvents', 'viewRoutes']) {
  // Same 2-space serialization for all four; buildProductEngineSpec fixes the engineSpec key ORDER, and
  // the array facets are pinned in their emitted/sorted order, so a stable JSON.stringify is faithful.
  const composedStr = JSON.stringify(composedFacets[key], null, 2);
  const goldenStr = JSON.stringify(golden[key], null, 2);
  if (composedStr !== goldenStr) {
    die(
      `the composed \`${key}\` DRIFTED from the frozen compose golden (the front-end version merge ` +
        'perturbed the engine lowering — the byte-identity law violated).\n' +
        '  Inspect the diff; the golden MUST stay byte-unchanged. If a genuine engine change is ' +
        `intended, it is a SEPARATE reviewed decision, not a side effect of the grammar merge.\n` +
        `  composed ${key} (${composedStr.length} bytes):\n${composedStr.slice(0, 400)}\n` +
        `  golden   ${key} (${goldenStr.length} bytes):\n${goldenStr.slice(0, 400)}`,
    );
  }
}

// Sanity: the parsed doc is genuinely at the unified version (so the gate cannot silently pass on a
// stale 0.2 parse) AND the frozen engine literal is the 0.1 lowering.
if (productSpec.version !== '1.0') {
  die(`acme-notes parsed with version '${productSpec.version}', expected the unified '1.0'.`);
}
if (composed.engineSpec.version !== '0.1') {
  die(
    `the lowered engineSpec.version is '${composed.engineSpec.version}', expected the FROZEN ` +
      `engine-internal '0.1' (the golden freeze).`,
  );
}

console.log(
  `compose-byte-identity gate PASSED: acme-notes @ version:'1.0' lowers to the byte-identical golden ` +
    `across ALL FOUR keys (engineSpec + handlerIds + triggerEvents + viewRoutes; frozen ` +
    `engineSpec.version '0.1').`,
);
