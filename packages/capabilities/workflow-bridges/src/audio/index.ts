// @rayspec/audio-workflow-bridge — the Tier A ↔ Tier B composition seam. Maps the Audio/Media
// capability's `FinalizedSessionEvent` onto the neutral `WorkflowInputEvent` (the adapter) and provides
// the `SessionFinalizedSink` a deployment injects to enqueue a durable workflow run when a session
// finalizes (the sink). Homed here so neither `@rayspec/workflow-durable` (the neutral Tier A engine)
// nor `@rayspec/audio-runtime` (the Tier B capability) depends on the other.
export * from './adapter.js';
export * from './sink.js';
