/**
 * COMPILE-TIME pin for the `EmitEvent` call surface — the shapes the reference documentation tells a
 * handler author to write. This module is COMPILED by `tsc -b` (it is NOT a `.test.ts`, which every
 * package `tsconfig` excludes), so the assertions below FAIL `pnpm typecheck` on a regression rather
 * than passing silently. A `.test.ts` cannot carry this guarantee: vitest strips types, so a runtime
 * test of a call form keeps passing after the type behind it narrows.
 *
 * It proves:
 *   1. TOPIC-ONLY — `emit('heartbeat')` is a legitimate call, not a mis-call. The reference documents
 *      this form for an event that carries no payload; making `payload` a required parameter would
 *      break this line.
 *   2. TOPIC + PAYLOAD — the ordinary two-argument form stays callable.
 *   3. AWAITABLE — the return type stays a promise, so a handler can await the append.
 *
 * The RUNTIME half (a topic-only emit is stored as a topic-only row, and a mis-shaped payload is
 * refused) is proven by the event-bus suites.
 */
import type { EmitEvent } from './index.js';

type Assert<_T extends true> = true;

/** `[topic]` is assignable to the parameter list ⇒ the topic-only call form type-checks. */
type _TopicOnlyIsCallable = Assert<[topic: string] extends Parameters<EmitEvent> ? true : false>;

/** The ordinary form stays callable. */
type _TopicAndPayloadIsCallable = Assert<
  [topic: string, payload: unknown] extends Parameters<EmitEvent> ? true : false
>;

/** The append is awaitable. */
type _ReturnsPromise = Assert<ReturnType<EmitEvent> extends Promise<void> ? true : false>;

// Touch the type aliases so unused-locals cannot strip the pins (they are the point of the module).
export const EMIT_CONTRACT_TYPEPINS: [
  _TopicOnlyIsCallable,
  _TopicAndPayloadIsCallable,
  _ReturnsPromise,
] = [true, true, true];
