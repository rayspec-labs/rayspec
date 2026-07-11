// @rayspec/capability-bridges — the durable-workflow ↔ capability composition seams for the four
// ingress capabilities, merged into one package. Each sub-barrel re-exports its capability's
// event → WorkflowInputEvent adapter + the fail-closed *Sink a deployment injects to enqueue a
// durable workflow run on ingress. The four capabilities' exported symbols are disjoint, so this
// flat barrel re-exports all of them with no collision.
export * from './audio/index.js';
export * from './conversation/index.js';
export * from './file/index.js';
export * from './record/index.js';
