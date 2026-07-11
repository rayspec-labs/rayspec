#!/usr/bin/env node
/**
 * Tool-callback latency micro-benchmark for the tool-callback round-trip.
 *
 * Measures the round-trip of the platform's CENTRAL tool path — ctx.dispatchTool — end to end:
 *   validate-in (ajv) -> acquire concurrency slot -> run handler -> validate-out (ajv) ->
 *   opaque-wrap -> record ONE journal step.
 * This is the per-tool-call overhead a run pays on TOP of the model call + the handler's own work.
 * The handler here is a trivial sync function so the number is the PLATFORM overhead, not the
 * tool's business logic (documented honestly — this is NOT an end-to-end SDK round-trip, which is
 * dominated by network/model latency; it isolates the dispatcher cost the platform owns).
 *
 * LOCAL/CI-safe: needs NO credentials and NO database (an in-memory JournalSink). Run with:
 *   pnpm --filter @rayspec/platform build && node scripts/bench-tool-latency.mjs
 * It always runs (self-contained); it prints a number and exits 0.
 */
import { performance } from 'node:perf_hooks';
import { makeDispatchTool } from '../packages/kernel/platform/dist/dispatch.js';

/** In-memory JournalSink (no DB): records steps, supports the tool-cache lookup, enforces nothing. */
function makeMemJournal() {
  const records = [];
  return {
    records,
    async lookup() {
      return null;
    },
    async lookupToolCache() {
      return null;
    },
    async record(step) {
      records.push(step);
      return `step-${records.length}`;
    },
  };
}

const tool = {
  spec: {
    name: 'echo',
    description: 'echo the input back',
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  },
  // Trivial handler -> the measured time is the DISPATCHER overhead, not business logic.
  handler: (args) => ({ doubled: args.n * 2 }),
  inputSchema: {
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { doubled: { type: 'number' } },
    required: ['doubled'],
    additionalProperties: false,
  },
  timeoutMs: 1000,
  idempotent: false, // side-effecting flag => always fires (no replay short-circuit)
};

const journal = makeMemJournal();
const dispatch = makeDispatchTool({
  runId: 'bench-run',
  tenantId: 'bench-tenant',
  journal,
  tools: [tool],
  replay: false,
  authMode: 'api-key',
});

const WARMUP = 500;
const ITERS = 5000;

// Warm up (JIT + ajv compile cache).
for (let i = 0; i < WARMUP; i++) {
  await dispatch('echo', { n: i }, `warm_${i}`);
}

const samples = new Float64Array(ITERS);
for (let i = 0; i < ITERS; i++) {
  const t0 = performance.now();
  await dispatch('echo', { n: i }, `call_${i}`);
  samples[i] = performance.now() - t0;
}

const sorted = Array.from(samples).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

const fmt = (ms) => `${(ms * 1000).toFixed(1)}µs`;
console.log('tool-callback latency micro-benchmark (ctx.dispatchTool round-trip)');
console.log(
  `  iterations: ${ITERS} (after ${WARMUP} warmup), trivial sync handler, in-memory journal`,
);
console.log(`  mean:   ${fmt(mean)}`);
console.log(`  p50:    ${fmt(pct(50))}`);
console.log(`  p95:    ${fmt(pct(95))}`);
console.log(`  p99:    ${fmt(pct(99))}`);
console.log(`  max:    ${fmt(sorted[sorted.length - 1])}`);
console.log(
  '  (measures the PLATFORM dispatcher overhead per tool call: validate-in/out + concurrency-slot ' +
    '+ opaque-wrap + one journal record. NOT an end-to-end model+SDK round-trip.)',
);
