/**
 * The `file_input.parse_text` node (S3) — the durable blob→text parse step between the S1/S2
 * bounded byte-ingest and the S4 extraction: it resolves the sealed file's raw bytes through an
 * INJECTED tenant-bound `BlobStore` (the STT `BlobRemuxSttMediaResolver` composition pattern —
 * never a raw fs/db handle), parses them to text, and emits ONE bounded text artifact under the
 * step's declared output ref. It calls NO LLM (extraction is S4) and runs INSIDE the workflow
 * (journaled, re-run safe): a pure read → deterministic parse → artifact.
 *
 * ── PARSER SELECTION BY MAGIC-BYTE SNIFF (never the declared type) ──────────────────────
 * The stored `content_type` is advisory attacker-influenced DATA (the S1 config docstring), so the
 * parser is selected by SNIFFING the bytes. The sniff must be AS TOLERANT as the parser it routes
 * to, or a parseable PDF leaks down the text path and its raw source is emitted as "extracted
 * text": pdf.js forward-scans its first `peekBytes(1024)` for the `%PDF-` header, so the sniff
 * scans the same bounded window, tolerating ONE leading UTF-8 BOM and an ASCII-whitespace run
 * before the header, and requires the VERSION DIGIT (`%PDF-<digit>`) — bare `%PDF-` prose in a
 * text file is not a header and stays on the text path. Deliberately NARROWER than pdf.js's
 * arbitrary-junk forward scan (only BOM/whitespace prefixes are honored): routing every text file
 * that merely CONTAINS `%PDF-<digit>` in its first KB to the parser would false-reject legit
 * text; a junk-prefixed PDF instead stays on the text path where non-UTF-8 bytes fail closed
 * (`file_text_not_utf8`) — the residual (a pure-ASCII PDF behind non-whitespace junk passes
 * through as text) is accepted and documented. Anything not sniffed as PDF must be VALID UTF-8
 * (fail-closed `file_text_not_utf8`) and passes through as text (covers text/markdown/CSV/JSON —
 * no per-format parsing in v1). A sniff-vs-declared mismatch is noted in the artifact metadata
 * (`content_type_mismatch` — DATA, not a failure): a lying declared type changes NOTHING about
 * how the bytes are parsed.
 *
 * ── THE PDF PATH (unpdf 1.6.2, exact-pinned; doc-first verified 2026-07-04) ─────────────────────
 * unpdf ships a SERVERLESS pdf.js build (v5.6.205) with the worker INLINED — plain-Node safe, no
 * worker files, no native deps (`@napi-rs/canvas` is an optional peer used only by the image/render
 * helpers this node never imports). `getDocumentProxy` applies `isEvalSupported: false` by default
 * (no eval anywhere near attacker bytes); we additionally pass `verbosity: 0` so hostile
 * bytes cannot spam operator logs with pdf.js warnings. Error shapes (empirically probed): a
 * corrupt/truncated file rejects with `InvalidPDFException`, an encrypted file with
 * `PasswordException` — BOTH are wrapped into the typed terminal `pdf_parse_failed` (the parser can
 * NEVER throw past this node; the engine's own catch is defense-in-depth behind it). A structurally
 * valid PDF whose pages carry NO text (a scan) is NOT an exception — it extracts empty page texts
 * and fails typed `scanned_pdf_no_text_layer` (the honest v1 cut: no OCR).
 *
 * ── PARSER-BOMB BOUNDS (fail-closed; deployment-overridable via `rollout.file.parse`) ───────────
 *  - `maxPdfPages` (default 500): checked against `pdf.numPages` AFTER load but BEFORE any page
 *    text is extracted — a page-tree bomb is refused without paying per-page extraction. 500
 *    comfortably covers the v1 document scope (invoices/reports; the 25 MiB upload cap already
 *    bounds the bytes) while capping the per-page work an attacker can declare.
 *  - `maxExtractedTextChars` (default 2,000,000): the artifact stays journal-friendly (~2 M chars
 *    ≈ 4 MB of UTF-16 — beyond any realistic v1 document, far below jsonb/journal pain). Applies to
 *    BOTH paths (decoded text length / joined page-text length). Over-cap FAILS CLOSED
 *    (`file_text_too_large`) — NEVER silent truncation: extraction correctness depends on
 *    completeness, and a silently-truncated invoice is worse than a named refusal (the documented
 *    S3 truncate-vs-fail decision).
 *  - `pdfParseTimeoutMs` (default 20,000 — deliberately UNDER the compiled step's 30 s
 *    `timeout_policy`, and compose CROSS-CHECKS any override against the compiled step value, so
 *    the TYPED `pdf_parse_timeout` always wins over a generic engine timeout): a wall-clock race
 *    around the whole load+extract. The timed-out work is abandoned with a rejection swallow
 *    (never an unhandled rejection crash later).
 *
 *    HONESTY — what these bounds do and do NOT cover: the caps bound OUTPUT text + page COUNT.
 *    `maxExtractedTextChars` is checked AFTER unpdf's concurrent per-page extraction has fully
 *    returned, so it does NOT bound peak decompressed/intermediate memory; and the wall-clock
 *    race bounds only the AWAIT — the inlined pdf.js parses on THIS thread, so a purely
 *    CPU-pinned parse is not preempted. A single-page decompression bomb (OOM) and a
 *    CPU-pathological PDF (an on-thread stall for the DBOS lease) are KNOWN availability-only
 *    residuals, accepted under the trusted single-node beta posture and tracked as BACKLOG
 * `-PARSE-HARDENING-1` (structural close = off-thread parse + bounded sequential
 * extraction + a CPU watchdog — due before external-exposure hardening / any untrusted self-serve exposure).
 *
 * ── FAILURE SEMANTICS (typed, split by recoverability) ──────────────────────────────────────────
 * TERMINAL (a retry cannot change the bytes): missing output ref / missing payload `blob_key` /
 * blob NOT-FOUND (`file_blob_missing` — the seal wrote the blob before the event, so absence is a
 * genuine inconsistency, e.g. an erased tenant) / a jail-violating blob key (`file_blob_key_invalid`
 * — the blob layer THROWS the typed `BlobJailError` on a malformed/hostile key, and a retry
 * re-presents the SAME event key) / invalid UTF-8 / empty-or-whitespace-only decoded text
 * (`no_extractable_text` — the text-path twin of `scanned_pdf_no_text_layer`: BOTH paths fail
 * closed on nothing-to-extract, never a completed empty artifact) / over-cap / page bomb / parse
 * timeout / parser refusal. RETRYABLE: a genuine blob-read THROW (`file_blob_read_failed` — the
 * port's typed-not-found-vs-thrown-fault contract makes the split structural).
 *
 * ── THE ARTIFACT (bounded) ───────────────────────────────────────────────────────────────
 * `{ ref, kind, content, metadata }` — the envelope shape `unwrapArtifactValue` unwraps to the
 * plain text string, so a `store_write` `{artifact}` value or the S4 extraction consumes the TEXT
 * (a text-column write stays type-clean). `metadata` (sniffed kind, declared type, mismatch flag,
 * char count, page count) rides alongside as DATA. The extracted text is UNTRUSTED CONTENT — it is
 * emitted as an artifact VALUE only, never anything instruction-shaped. Raw bytes NEVER become an
 * artifact (they stay behind the tenant-jailed blob key — the journal-friendliness law); the
 * journal `output` carries the metadata only, never the text.
 */

import type { CapabilityInvocationResult, CapabilityNodeHandler } from '@rayspec/foundation';
import type { BlobStore } from '@rayspec/handler-sdk';
import { BlobJailError } from '@rayspec/platform';
import { extractText, getDocumentProxy } from 'unpdf';

// ── bounds (documented above; overridable per deployment via rollout.file.parse) ─────────────────

/** Max pdf.js page count a PDF may declare before extraction is refused (bomb bound). */
export const DEFAULT_MAX_PDF_PAGES = 500;
/** Max extracted characters (both paths) — the artifact's journal-friendliness bound. */
export const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
/** Wall-clock cap on one PDF load+extract (typed; under the 30 s compiled step timeout). */
export const DEFAULT_PDF_PARSE_TIMEOUT_MS = 20_000;

/** The `%PDF-` magic — the ONE sniff that routes to the PDF path (see {@link sniffIsPdf}). */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
/** The UTF-8 BOM — tolerated ONCE, leading, before the PDF header (pdf.js parses through it). */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
/** pdf.js searches its first `peekBytes(1024)` for the header — the sniff mirrors that bound. */
const PDF_SNIFF_WINDOW_BYTES = 1024;

/** The page delimiter joining per-page texts (a blank line — paragraph-shaped for extraction). */
const PAGE_DELIMITER = '\n\n';

export interface FileParseLimits {
  /** Override {@link DEFAULT_MAX_PDF_PAGES} (positive integer). */
  readonly maxPdfPages?: number;
  /** Override {@link DEFAULT_MAX_EXTRACTED_TEXT_CHARS} (positive integer). */
  readonly maxExtractedTextChars?: number;
  /** Override {@link DEFAULT_PDF_PARSE_TIMEOUT_MS} (positive integer). */
  readonly pdfParseTimeoutMs?: number;
}

export interface ResolvedFileParseLimits {
  readonly maxPdfPages: number;
  readonly maxExtractedTextChars: number;
  readonly pdfParseTimeoutMs: number;
}

/**
 * Resolve + fail-closed-validate the parse bounds (the `resolveFileConfig` construction-belt
 * mirror): a malformed override would break a bomb bound OPEN (`chars > NaN` is never true), so it
 * throws at construction/compose time — deploy-time loud, never a silently disabled cap.
 */
export function resolveFileParseLimits(limits?: FileParseLimits): ResolvedFileParseLimits {
  const resolved = {
    maxPdfPages: limits?.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES,
    maxExtractedTextChars: limits?.maxExtractedTextChars ?? DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    pdfParseTimeoutMs: limits?.pdfParseTimeoutMs ?? DEFAULT_PDF_PARSE_TIMEOUT_MS,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `file parse limits: ${name} must be a positive integer (got ${String(value)}) — a ` +
          'malformed cap would disable a parser-bomb bound (fail-closed at construction).',
      );
    }
  }
  return resolved;
}

// ── the PDF text extractor seam (real impl below; injectable for the timeout/throw proofs) ──────

export type PdfExtractOutcome =
  | {
      readonly kind: 'extracted';
      readonly pageCount: number;
      readonly pageTexts: readonly string[];
    }
  | { readonly kind: 'page_limit_exceeded'; readonly pageCount: number };

export type PdfTextExtractor = (
  bytes: Uint8Array,
  opts: { readonly maxPdfPages: number },
) => Promise<PdfExtractOutcome>;

/**
 * The REAL extractor over the pinned unpdf build: load (`isEvalSupported:false` default;
 * `verbosity:0` so hostile bytes cannot log-spam), enforce the page bound BEFORE extracting, then
 * per-page text extraction (`mergePages:false` — the per-page shape feeds the no-text-layer
 * detection and the page metadata). The proxy is destroyed in `finally` so a long-lived worker
 * process never accumulates pdf.js document resources across runs.
 */
export const unpdfTextExtractor: PdfTextExtractor = async (bytes, opts) => {
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  try {
    if (pdf.numPages > opts.maxPdfPages) {
      return { kind: 'page_limit_exceeded', pageCount: pdf.numPages };
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return { kind: 'extracted', pageCount: totalPages, pageTexts: text };
  } finally {
    await pdf.destroy();
  }
};

export interface FileParseNodeConfig {
  /** The run's tenant-bound blob reader (composition-injected — the STT resolver pattern). */
  readonly blob: BlobStore;
  /** Parse bounds (validated fail-closed; defaults documented above). */
  readonly limits?: FileParseLimits;
  /** The PDF extractor (default: the real pinned unpdf path; injectable for timeout/throw proofs). */
  readonly extractPdfText?: PdfTextExtractor;
}

function fail(
  code: string,
  message: string,
  retryable = false,
): CapabilityInvocationResult & { status: 'terminal_failure' | 'retryable_failure' } {
  return {
    status: retryable ? 'retryable_failure' : 'terminal_failure',
    error: { code, message, retryable },
  };
}

/** ASCII whitespace (space, \t, \n, \v, \f, \r) — the tolerated pre-header run. */
function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/**
 * PDF sniff, aligned with the tolerance of the parser it routes to (module header): within the
 * first {@link PDF_SNIFF_WINDOW_BYTES} bytes, skip ONE leading UTF-8 BOM + an ASCII-whitespace
 * run, then require `%PDF-` WITH its version digit. Allocation-bounded: pure index reads over at
 * most the window — never a decode of the blob.
 */
function sniffIsPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, PDF_SNIFF_WINDOW_BYTES);
  let i = 0;
  if (UTF8_BOM.every((b, k) => bytes[k] === b)) i = UTF8_BOM.length;
  while (i < limit && isAsciiWhitespace(bytes[i] ?? -1)) i += 1;
  if (i + PDF_MAGIC.length + 1 > limit) return false; // header + digit must fit the window
  if (!PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return false;
  const version = bytes[i + PDF_MAGIC.length] ?? -1;
  return version >= 0x30 && version <= 0x39; // '%PDF-' without a version digit is prose, not a header
}

/**
 * Race `work` against a wall clock. On timeout the abandoned promise gets a no-op rejection
 * handler — a late fault from the timed-out parse must never become an unhandled rejection.
 */
async function withWallClock<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const TIMED_OUT: unique symbol = Symbol('timed_out');

/** Build the `file_input.parse_text` capability node (see the module header for every law). */
export function makeFileParseNode(cfg: FileParseNodeConfig): CapabilityNodeHandler {
  const limits = resolveFileParseLimits(cfg.limits);
  const extractPdfText = cfg.extractPdfText ?? unpdfTextExtractor;

  return async (ctx): Promise<CapabilityInvocationResult> => {
    const outputRef = ctx.step.output_artifact_refs?.[0];
    if (!outputRef) {
      return fail(
        'file_parse_outputs_undeclared',
        `parse step '${ctx.step.id}' compiled without its text output ref — declare the extracted-` +
          'text contract under outputs (fail-closed).',
      );
    }

    // The blob key rides the METADATA-ONLY trigger payload (bytes never in the event — S1).
    const blobKey = ctx.input_event.payload.blob_key;
    if (typeof blobKey !== 'string' || blobKey.length === 0) {
      return fail(
        'file_blob_key_missing',
        `parse step '${ctx.step.id}': trigger event '${ctx.input_event.type}' carries no ` +
          "'blob_key' payload key — this node runs on the file_input.file_submitted contract " +
          '(fail-closed).',
      );
    }

    // Tenant-bound read. The port's contract splits recoverability structurally: NOT-FOUND is the
    // TYPED value (terminal — the sealed blob should exist; a retry cannot mint bytes), a genuine
    // I/O fault THROWS (retryable).
    let bytes: Uint8Array;
    try {
      const read = await cfg.blob.get(blobKey);
      if ('notFound' in read) {
        return fail(
          'file_blob_missing',
          `parse step '${ctx.step.id}': no blob under the event's blob_key — the sealed bytes are ` +
            'gone (a genuine inconsistency, e.g. an erased tenant); a retry cannot recover them.',
        );
      }
      bytes = new Uint8Array(await new Response(read.body).arrayBuffer());
    } catch (e) {
      // The blob layer's typed PERMANENT fault: a jail-violating key (BlobJailError). A retry
      // re-presents the SAME event blob_key, so retrying can never succeed — terminal, split
      // from the genuinely transient read fault below.
      if (e instanceof BlobJailError) {
        return fail(
          'file_blob_key_invalid',
          `parse step '${ctx.step.id}': the blob layer refused the event's blob_key as ` +
            `jail-violating (permanent — a retry re-presents the same key): ${e.message}`,
        );
      }
      return fail(
        'file_blob_read_failed',
        `parse step '${ctx.step.id}': reading the file blob failed transiently: ` +
          (e instanceof Error ? e.message : String(e)),
        true,
      );
    }

    // Advisory declared type (DATA — metadata only; the SNIFF selects the parser).
    const declaredRaw = ctx.input_event.payload.content_type;
    const declaredContentType = typeof declaredRaw === 'string' ? declaredRaw : null;
    const declaredIsPdf = declaredContentType?.toLowerCase() === 'application/pdf';

    let text: string;
    let pageCount: number | undefined;
    let sniffedKind: 'pdf' | 'text';
    if (sniffIsPdf(bytes)) {
      sniffedKind = 'pdf';
      let outcome: PdfExtractOutcome | typeof TIMED_OUT;
      try {
        const work = extractPdfText(bytes, { maxPdfPages: limits.maxPdfPages });
        outcome = await withWallClock(work, limits.pdfParseTimeoutMs);
        // A late fault from an abandoned (timed-out) parse must never crash the worker.
        if (outcome === TIMED_OUT) work.catch(() => {});
      } catch (e) {
        const name = e instanceof Error && e.name !== 'Error' ? `${e.name}: ` : '';
        return fail(
          'pdf_parse_failed',
          `parse step '${ctx.step.id}': the PDF parser refused the bytes (encrypted/corrupt/` +
            `truncated): ${name}${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (outcome === TIMED_OUT) {
        return fail(
          'pdf_parse_timeout',
          `parse step '${ctx.step.id}': the PDF parse exceeded the ${limits.pdfParseTimeoutMs} ms ` +
            'wall clock (fail-closed; see rollout.file.parse.pdfParseTimeoutMs).',
        );
      }
      if (outcome.kind === 'page_limit_exceeded') {
        return fail(
          'pdf_page_limit_exceeded',
          `parse step '${ctx.step.id}': the PDF declares ${outcome.pageCount} pages, above the ` +
            `${limits.maxPdfPages}-page bound (fail-closed; see rollout.file.parse.maxPdfPages).`,
        );
      }
      pageCount = outcome.pageCount;
      if (outcome.pageTexts.every((p) => p.trim().length === 0)) {
        return fail(
          'scanned_pdf_no_text_layer',
          `parse step '${ctx.step.id}': the PDF has no extractable text layer (a scanned/image-` +
            'only document) — v1 extracts text layers only, no OCR (the documented cut).',
        );
      }
      text = outcome.pageTexts.join(PAGE_DELIMITER);
    } else {
      sniffedKind = 'text';
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return fail(
          'file_text_not_utf8',
          `parse step '${ctx.step.id}': the bytes are neither a PDF nor valid UTF-8 text — v1 ` +
            'parses text/markdown/CSV/JSON (UTF-8) and PDF text layers only (fail-closed).',
        );
      }
      // The uniform empty-text contract: BOTH paths fail closed on nothing-to-extract (the PDF
      // twin is `scanned_pdf_no_text_layer`) — never a completed empty artifact into S4.
      if (text.trim().length === 0) {
        return fail(
          'no_extractable_text',
          `parse step '${ctx.step.id}': the file decodes to empty/whitespace-only text — nothing ` +
            'to extract downstream (fail-closed; the PDF-path twin is scanned_pdf_no_text_layer).',
        );
      }
    }

    if (text.length > limits.maxExtractedTextChars) {
      return fail(
        'file_text_too_large',
        `parse step '${ctx.step.id}': extracted ${text.length} chars, above the ` +
          `${limits.maxExtractedTextChars}-char bound — failing closed instead of silently ` +
          'truncating (extraction correctness depends on completeness); see ' +
          'rollout.file.parse.maxExtractedTextChars.',
      );
    }

    const mismatch = sniffedKind === 'pdf' ? !declaredIsPdf : declaredIsPdf === true;
    const metadata = {
      sniffed_kind: sniffedKind,
      declared_content_type: declaredContentType,
      content_type_mismatch: mismatch,
      char_count: text.length,
      ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    };
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: `${ctx.step.id}:${outputRef}`,
          kind: outputRef,
          source_node_id: ctx.step.id,
          // The envelope shape `unwrapArtifactValue` unwraps to the TEXT (module header) — the
          // extracted text is UNTRUSTED CONTENT riding as a value, never instruction-shaped.
          value: { ref: outputRef, kind: outputRef, content: text, metadata },
        },
      ],
      // Journal output = the small metadata ONLY (the text lives in the artifact, bounded above).
      output: metadata,
    };
  };
}
