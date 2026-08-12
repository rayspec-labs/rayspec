/**
 * `@rayspec/tts-port` — the provider-NEUTRAL text-to-speech port: the `TtsAdapter` contract and its
 * request/result types, the shared request-normalization rules (text cap, voice membership, speed
 * clamp) every adapter behind the port applies, and the deterministic fake adapter. A concrete
 * provider adapter depends on this port; nothing in the port names or imports any provider.
 */
export * from './fake-adapter.js';
export * from './request-policy.js';
export * from './types.js';
