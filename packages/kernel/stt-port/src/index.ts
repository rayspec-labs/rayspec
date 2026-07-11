/**
 * `@rayspec/stt-port` — the provider-NEUTRAL speech-to-text port: the `SttAdapter` contract and its
 * neutral transcript types, the adapter registry, the media-resolution seam, the shared transcript
 * normalizer, and the deterministic fake adapter. A concrete provider adapter depends on this port;
 * nothing in the port names or imports any provider.
 */
export * from './fake-adapter.js';
export * from './media-resolver.js';
export * from './normalizer.js';
export * from './registry.js';
export * from './types.js';
