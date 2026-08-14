/**
 * COMPILE-TIME pin for the two SPEECH FAILURE types this SDK re-exports. Both docstrings in this
 * package (`stt.ts`, `tts.ts`) and the reference documentation tell a handler that a provider-side
 * condition arrives as an `SttAdapterError` / a `TtsAdapterError`; the handler-import gate allows a
 * handler exactly ONE import specifier (`@rayspec/handler-sdk`), so a type it cannot name from HERE
 * it cannot name at all.
 *
 * This module is COMPILED by `tsc -b` (it is NOT a `.test.ts`, which every package `tsconfig`
 * excludes), so dropping either name from the `index.ts` re-export blocks FAILS `pnpm typecheck`
 * rather than passing silently. A `.test.ts` cannot carry this guarantee: vitest strips types, so a
 * runtime test keeps passing after a type-only export disappears.
 *
 * Both pins are TYPE-only. `TtsAdapterError` is a class in `@rayspec/tts-port`, but it travels here
 * as a type: an `instanceof` check needs the class VALUE, and a value export would give this
 * runtime-free SDK a runtime edge to the port. A handler names the shape and branches on `code`.
 */
import type { SttAdapterError, TtsAdapterError } from './index.js';

type Assert<_T extends true> = true;

/** The documented STT failure shape is nameable from the SDK. */
type _SttAdapterErrorIsNameable = Assert<
  SttAdapterError extends { code: string; message: string; retryable: boolean } ? true : false
>;

/** The documented TTS failure shape is nameable from the SDK — the STT twin's counterpart. */
type _TtsAdapterErrorIsNameable = Assert<
  TtsAdapterError extends { code: string; message: string; retryable: boolean } ? true : false
>;

// Touch the type aliases so unused-locals cannot strip the pins (they are the point of the module).
export const SPEECH_ERROR_TYPEPINS: [_SttAdapterErrorIsNameable, _TtsAdapterErrorIsNameable] = [
  true,
  true,
];
