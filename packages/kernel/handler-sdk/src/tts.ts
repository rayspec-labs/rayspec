/**
 * @rayspec/handler-sdk — the neutral `TtsCapability` (text-to-speech) capability contract.
 *
 * A `TtsCapability` turns TEXT a handler already holds into AUDIO BYTES the handler can then do
 * anything with (return as a response body, write through `init.blob`, hand to another service). It is
 * the open-core CONTRACT only — the impl is built at the composition root from the deployment's
 * configured provider and injected, never constructed by a handler.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE EGRESS HALF OF THE SAME SEAM `init.stt` OPENS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `init.stt` takes bytes and returns text; this takes text and returns bytes. The two are deliberately
 * symmetric: a voice product needs both directions, and the half that already existed set the design
 * language (lazy credential, content-free errors, a deterministic offline stand-in for CI) that this
 * half follows exactly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERIALIZABLE REQUEST SHAPE, NOT A CLOSURE (preserve the external-exposure isolate seam).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The one method takes plain, serializable arguments (a string + a small opts record) and returns the
 * plain neutral result — never a captured closure over server internals. So the handle is a typed
 * REQUEST surface the in-process call can later become a cross-isolate call against the isolate seam,
 * with no handler change (mirrors `BlobStore` / `FsSource` / `HandlerDb` / `SttCapability`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT TENANT-PARTITIONED — it speaks the text it is handed.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Unlike `BlobStore` (per-tenant WRITABLE storage, tenant-prefixed by construction because blobs ARE
 * tenant DATA), this capability holds no tenant-scoped state: the caller supplies the text it already
 * assembled through a tenant-bound handle, so there is no tenant partition to make (mirrors `FsSource`).
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture; see the SDK header). A handler runs IN OUR PROCESS
 * and could reach a provider over `fetch` directly; this capability is the sanctioned path — the one
 * that keeps the credential engine-side and the provider swappable — not a confinement mechanism.
 */
import type { TtsSynthesisResult } from '@rayspec/tts-port';

/**
 * The per-call synthesis options. Every field is OPTIONAL and a plain value (the record is passed to
 * the provider adapter as the neutral request, never as provider-specific wire args). An option the
 * caller leaves out is resolved from the wired adapter's own policy.
 */
export interface TtsSynthesizeOptions {
  /**
   * The provider voice id (e.g. `onyx`). The adapter validates MEMBERSHIP against its own closed list
   * — an unknown voice comes back as a rejected promise carrying `unsupported_option`, never a silent
   * fallback to a default voice the caller did not ask for. A blank string is an unknown voice, not an
   * absent one, and is rejected the same way. Absent ⇒ the adapter's default voice.
   */
  readonly voice?: string;
  /**
   * Speaking rate. CLAMPED into the wired provider's supported range rather than refused, so a caller
   * cannot fail a request on a value that has an obvious nearest-legal meaning. Absent ⇒ `1`.
   */
  readonly speed?: number;
  /** The audio container to return. Absent ⇒ the adapter's default (`contentType` always describes
   *  what actually came back, so a handler reads that rather than assuming). */
  readonly format?: 'mp3' | 'opus' | 'wav';
}

/**
 * The neutral speech-synthesis capability a route, tool or trigger handler may receive as `init.tts`.
 *
 * `synthesize` returns the AUDIO on success. A provider-side condition — a missing credential, an
 * upstream error, malformed provider output — comes back as a REJECTED promise carrying a
 * `TtsAdapterError`: a structured, CONTENT-FREE error (a `code` plus a message naming the provider,
 * the HTTP status, or an error class only — never the text being spoken, the response body, or the
 * credential). A request that violates a stated limit (an over-long text, an unknown voice) is
 * rejected the same way BEFORE any provider call, so it is never billed.
 *
 * The text cap is FAIL-CLOSED: an over-long text is refused, never truncated into a recording that
 * stops mid-sentence and looks successful.
 */
export interface TtsCapability {
  /** Synthesize `text` into audio bytes through the deployment's configured provider. */
  synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<TtsSynthesisResult>;
}
