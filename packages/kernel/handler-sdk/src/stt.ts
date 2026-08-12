/**
 * @rayspec/handler-sdk — the neutral `SttCapability` (speech-to-text) capability contract.
 *
 * An `SttCapability` transcribes AUDIO BYTES a handler already holds (a raw-body upload, a blob it
 * just read, a file it read through `init.fsSource`) into the neutral transcript artifact the STT port
 * defines. It is the open-core CONTRACT only — the impl is built at the composition root from the
 * deployment's configured provider and injected, never constructed by a handler.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * BYTES IN, PLAIN RESULT OUT — the adapter + its media resolution stay ENGINE-SIDE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The neutral `SttAdapter` port is REFERENCE-keyed (a finalized session/track ref, resolved to bytes
 * by a deployment-provided resolver) because the product profile's audio pipeline finalizes tracks
 * into blob storage first. A handler holds BYTES, not a finalized track — so the engine wraps the
 * per-call resolution INTERNALLY: it hands the adapter a call-scoped ref for the bytes it was given.
 * A handler therefore never selects a provider, reads a credential, or constructs an adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERIALIZABLE REQUEST SHAPE, NOT A CLOSURE (preserve the external-exposure isolate seam).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The one method takes plain, serializable arguments (bytes + a small opts record) and returns the
 * plain neutral result — never a captured closure over server internals. So the handle is a typed
 * REQUEST surface the in-process call can later become a cross-isolate call against the isolate seam,
 * with no handler change (mirrors `BlobStore` / `FsSource` / `HandlerDb`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT TENANT-PARTITIONED — it transcribes the bytes it is handed.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Unlike `BlobStore` (per-tenant WRITABLE storage, tenant-prefixed by construction because blobs ARE
 * tenant DATA), this capability holds no tenant-scoped state: the caller supplies the bytes it already
 * read through a tenant-bound handle, so there is no tenant partition to make (mirrors `FsSource`).
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture; see the SDK header). A handler runs IN OUR PROCESS
 * and could reach a provider over `fetch` directly; this capability is the sanctioned path — the one
 * that keeps the credential engine-side and the provider swappable — not a confinement mechanism.
 */
import type { SttTranscriptionResult } from '@rayspec/stt-port';

/**
 * The per-call transcription options. Every field is OPTIONAL and a plain value (the record is passed
 * to the provider adapter as the neutral language/model policy, never as provider-specific wire args).
 */
export interface SttTranscribeOptions {
  /**
   * The audio container/codec of `bytes` (e.g. `audio/ogg`, `audio/wav`). ADVISORY — providers sniff
   * the container; absent ⇒ the deployment's default upload type.
   */
  readonly contentType?: string;
  /**
   * Pin the transcription to a language (a BCP-47-ish provider language code, e.g. `de`). MUTUALLY
   * EXCLUSIVE with `detectLanguage: true` — a call that sets both is refused by the adapter with a
   * structured `unsupported_option` failure, never a silently-dropped option.
   */
  readonly languageHint?: string;
  /** Ask the provider to DETECT the dominant language instead of pinning one (see `languageHint`). */
  readonly detectLanguage?: boolean;
}

/**
 * The neutral transcription capability a route/tool handler may receive as `init.stt`.
 *
 * `transcribe` NEVER throws for a provider-side condition: a missing credential, an upstream error, or
 * malformed provider output comes back as the `failed` variant of `SttTranscriptionResult` carrying a
 * CONTENT-FREE `SttAdapterError` (a code + a message naming the provider/status only — never the audio,
 * the response body, or the credential). A handler branches on `result.status`.
 */
export interface SttCapability {
  /** Transcribe `bytes` (one audio clip) into the neutral transcript artifact. */
  transcribe(bytes: Uint8Array, opts?: SttTranscribeOptions): Promise<SttTranscriptionResult>;
}
