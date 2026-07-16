/**
 * `file_input.parse_text` unit proofs (RED-first; self-made fixtures only).
 *
 * The fake BlobStore enforces the REAL port constraints (fail-the-fix): `get` returns the TYPED
 * `BlobNotFound` value (never a throw) for an absent key, and a genuine I/O fault THROWS — so the
 * missing-blob (terminal) vs read-fault (retryable) split is proven against the real contract, not
 * a fake that can't distinguish them — and the jail-violating key (a THROWN `BlobJailError`) vs
 * transient-fault split is proven with the REAL platform error class. PDF arms run the REAL unpdf
 * extractor over committed (`__fixtures__/text-layer.pdf` / `no-text-layer.pdf`) + builder-made
 * bytes; only the timeout / escaped-throw / whitespace-page arms inject an extractor (the seam
 * exists for that determinism — the whitespace-page shape is REAL-PARSER-UNREACHABLE: pdf.js
 * emits NO text items for whitespace-only runs, empirically probed against the pinned build, so
 * the `.trim()` in the scanned detection can only be pinned through the seam).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  CapabilityInvocationResult,
} from '@rayspec/foundation';
import type { BlobStore } from '@rayspec/handler-sdk';
import { BlobJailError } from '@rayspec/platform';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  DEFAULT_MAX_PDF_PAGES,
  DEFAULT_PDF_PARSE_TIMEOUT_MS,
  type FileParseLimits,
  makeFileParseNode,
  type PdfTextExtractor,
  resolveFileParseLimits,
} from './file-parse-node.js';
import { unwrapArtifactValue } from './materialize.js';
import { buildEncryptedPdfShape, buildPdf } from './test-support/pdf-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEXT_LAYER_PDF = new Uint8Array(readFileSync(join(here, '__fixtures__/text-layer.pdf')));
const NO_TEXT_LAYER_PDF = new Uint8Array(
  readFileSync(join(here, '__fixtures__/no-text-layer.pdf')),
);
const TEXT_LAYER_PDF_TEXT = 'Hello RaySpec PDF fixture.';

const OUTPUT_REF = 'fileintake.extracted_text';
const BLOB_KEY = 'files/f-1/deadbeef';

/** Prepend raw bytes (a BOM / whitespace run) to a fixture — the leading-bytes shapes. */
function withPrefix(prefix: readonly number[], bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}

// ── the fake tenant-bound blob reader (typed not-found; throw = genuine I/O fault) ───────────────

class FakeBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  /** When set, `get` THROWS it — the REAL port's genuine-I/O-fault contract (never typed not-found). */
  failReadsWith: Error | undefined;

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<void> {
    if (!(body instanceof Uint8Array)) throw new Error('fake: bytes only');
    this.blobs.set(key, {
      bytes: body,
      ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
    });
  }

  async get(key: string) {
    if (this.failReadsWith) throw this.failReadsWith;
    const found = this.blobs.get(key);
    if (!found) return { notFound: true as const, key };
    return {
      body: new Blob([found.bytes as BlobPart]).stream() as ReadableStream<Uint8Array>,
      contentLength: found.bytes.length,
      ...(found.contentType !== undefined ? { contentType: found.contentType } : {}),
    };
  }

  async createReadStream(key: string) {
    const r = await this.get(key);
    return 'notFound' in r ? r : r.body;
  }

  async stat(key: string) {
    const found = this.blobs.get(key);
    if (!found) return { notFound: true as const, key };
    return { len: found.bytes.length, etagSource: `${found.bytes.length}` };
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async deleteTenant(): Promise<void> {
    this.blobs.clear();
  }
}

// ── the invocation context builder (the compiled `capability` step shape) ────────────────────────

function makeCtx(opts?: {
  payload?: Record<string, unknown>;
  outputRefs?: string[] | undefined;
}): CapabilityInvocationContext {
  const payload = opts?.payload ?? {
    file_id: 'f-1',
    tenant_id: 't-1',
    source_capability: 'file_input',
    sha256: 'deadbeef',
    size_bytes: 3,
    content_type: 'text/plain',
    original_filename: 'a.txt',
    blob_key: BLOB_KEY,
  };
  const step = {
    id: 'parse',
    capability: 'file_input',
    operation: 'parse_text',
    ...(opts && 'outputRefs' in opts && opts.outputRefs === undefined
      ? {}
      : { output_artifact_refs: opts?.outputRefs ?? [OUTPUT_REF] }),
  };
  const input_event = {
    id: 't-1:f-1',
    type: 'file_input.file_submitted',
    occurred_at: '2026-07-04T00:00:00.000Z',
    payload,
  };
  return {
    workflow: {
      id: 'wf',
      tier: 'A',
      status: 'runtime_foundation',
      trigger: { event: 'file_input.file_submitted' },
      idempotency_key: 'file_id',
      steps: [step],
    },
    step,
    input_event,
    input: {},
    journal: {
      workflow_run_id: 'run-1',
      workflow_id: 'wf',
      idempotency_key: 'file_id:f-1',
      input_event,
      status: 'running',
      node_states: [],
      artifact_refs: [],
      attempts: 0,
      created_at: input_event.occurred_at,
      updated_at: input_event.occurred_at,
    },
    artifacts: [],
  };
}

async function runNode(opts: {
  bytes?: Uint8Array | string;
  declaredType?: string;
  limits?: FileParseLimits;
  extractPdfText?: PdfTextExtractor;
  payload?: Record<string, unknown>;
  outputRefs?: string[] | undefined;
  blob?: FakeBlobStore;
}): Promise<CapabilityInvocationResult> {
  const blob = opts.blob ?? new FakeBlobStore();
  if (opts.bytes !== undefined) {
    const bytes =
      typeof opts.bytes === 'string' ? new TextEncoder().encode(opts.bytes) : opts.bytes;
    await blob.put(BLOB_KEY, bytes);
  }
  const node = makeFileParseNode({
    blob,
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.extractPdfText ? { extractPdfText: opts.extractPdfText } : {}),
  });
  const payload = opts.payload ?? {
    file_id: 'f-1',
    tenant_id: 't-1',
    source_capability: 'file_input',
    sha256: 'deadbeef',
    size_bytes: 3,
    content_type: opts.declaredType ?? 'text/plain',
    original_filename: 'a.txt',
    blob_key: BLOB_KEY,
  };
  return node(
    makeCtx({ payload, ...(opts && 'outputRefs' in opts ? { outputRefs: opts.outputRefs } : {}) }),
  );
}

function expectFailure(
  result: CapabilityInvocationResult,
  code: string,
  retryable: boolean,
): asserts result is CapabilityInvocationResult & {
  status: 'terminal_failure' | 'retryable_failure';
} {
  expect(result.status).toBe(retryable ? 'retryable_failure' : 'terminal_failure');
  if (result.status === 'completed' || result.status === 'paused') throw new Error('unreachable');
  expect(result.error?.code).toBe(code);
  expect(result.error?.retryable).toBe(retryable);
  // A failure NEVER carries a text artifact (fail-closed — no partial/truncated content downstream).
  expect(result.artifact_refs ?? []).toHaveLength(0);
}

function artifactOf(result: CapabilityInvocationResult): ArtifactRef {
  expect(result.status).toBe('completed');
  if (result.status !== 'completed') throw new Error('unreachable');
  expect(result.artifact_refs).toHaveLength(1);
  const artifact = result.artifact_refs?.[0];
  if (!artifact) throw new Error('unreachable');
  expect(artifact.kind).toBe(OUTPUT_REF);
  expect(artifact.source_node_id).toBe('parse');
  return artifact;
}

function metadataOf(artifact: ArtifactRef): Record<string, unknown> {
  const value = artifact.value as Record<string, unknown>;
  return value.metadata as Record<string, unknown>;
}

// ── text pass-through (sniff: not %PDF- ⇒ UTF-8-validated text) ──────────────────────────────────

describe('file_input.parse_text — text pass-through', () => {
  it('passes valid UTF-8 text through byte-exact under the declared output ref', async () => {
    const body = 'vendor,total\nacme,42\n';
    const result = await runNode({ bytes: body, declaredType: 'text/csv' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(body);
    expect(metadataOf(artifact)).toMatchObject({
      sniffed_kind: 'text',
      declared_content_type: 'text/csv',
      content_type_mismatch: false,
      char_count: body.length,
    });
    // No page_count on the text path (a PDF-only field).
    expect('page_count' in metadataOf(artifact)).toBe(false);
  });

  it.each([
    ['markdown', '# Heading\n\nBody with **bold**.\n', 'text/markdown'],
    ['JSON', '{"vendor":"acme","total":42}', 'application/json'],
    ['unicode text', 'Zoë · naïve — 日本語テスト ✓\n', 'text/plain'],
  ])('passes %s through unchanged', async (_name, body, declaredType) => {
    const result = await runNode({ bytes: body, declaredType });
    expect(unwrapArtifactValue(artifactOf(result).value)).toBe(body);
  });

  it('rejects invalid UTF-8 with the typed terminal file_text_not_utf8', async () => {
    // 0xFF can never start a UTF-8 sequence; 0xC3 alone is a truncated 2-byte sequence.
    const result = await runNode({ bytes: new Uint8Array([0xff, 0xc3]) });
    expectFailure(result, 'file_text_not_utf8', false);
  });

  it('notes a declared-pdf/sniffed-text mismatch as metadata DATA, never a failure', async () => {
    const body = 'plain text lying about being a pdf';
    const result = await runNode({ bytes: body, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(body);
    expect(metadataOf(artifact)).toMatchObject({
      sniffed_kind: 'text',
      declared_content_type: 'application/pdf',
      content_type_mismatch: true,
    });
  });

  it('FAILS CLOSED (never truncates) when text exceeds the extracted-chars cap', async () => {
    const result = await runNode({
      bytes: 'twelve chars!',
      limits: { maxExtractedTextChars: 8 },
    });
    expectFailure(result, 'file_text_too_large', false);
  });

  it('passes text EXACTLY AT the extracted-chars cap (the bound is >, never >=)', async () => {
    const body = 'exactly8'; // 8 chars — equal to the cap below.
    const result = await runNode({ bytes: body, limits: { maxExtractedTextChars: 8 } });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(body);
    expect(metadataOf(artifact)).toMatchObject({ char_count: 8 });
  });

  it("keeps a text file that merely STARTS with '%PDF-' (no version digit) on the TEXT path", async () => {
    // A real header is '%PDF-<digit>'; bare '%PDF-' prose must not be false-routed to the parser.
    const body = '%PDF-like prose, not a real header\nvendor,total\nacme,42\n';
    const result = await runNode({ bytes: body, declaredType: 'text/csv' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(body);
    expect(metadataOf(artifact)).toMatchObject({ sniffed_kind: 'text' });
  });

  it('fails a 0-byte file closed with the typed no_extractable_text (uniform empty-text contract)', async () => {
    const result = await runNode({ bytes: new Uint8Array(0) });
    expectFailure(result, 'no_extractable_text', false);
  });

  it('fails a whitespace-only file closed with the typed no_extractable_text (never an empty artifact)', async () => {
    const result = await runNode({ bytes: ' \t \r\n \n ' });
    expectFailure(result, 'no_extractable_text', false);
  });
});

// ── PDF text-layer extraction (the REAL pinned parser over self-made bytes) ──────────────────────

describe('file_input.parse_text — PDF text layer (real unpdf)', () => {
  it('extracts the committed text-layer fixture end-to-end', async () => {
    const result = await runNode({ bytes: TEXT_LAYER_PDF, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(TEXT_LAYER_PDF_TEXT);
    expect(metadataOf(artifact)).toMatchObject({
      sniffed_kind: 'pdf',
      declared_content_type: 'application/pdf',
      content_type_mismatch: false,
      page_count: 1,
      char_count: TEXT_LAYER_PDF_TEXT.length,
    });
  });

  it('parses by the SNIFF when the declared type lies (pdf bytes declared text/plain)', async () => {
    const result = await runNode({ bytes: TEXT_LAYER_PDF, declaredType: 'text/plain' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(TEXT_LAYER_PDF_TEXT);
    expect(metadataOf(artifact)).toMatchObject({
      sniffed_kind: 'pdf',
      content_type_mismatch: true,
    });
  });

  it('joins multi-page text with the blank-line page delimiter', async () => {
    const bytes = buildPdf({ pages: [{ text: 'page one' }, { text: 'page two' }] });
    const result = await runNode({ bytes, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe('page one\n\npage two');
    expect(metadataOf(artifact)).toMatchObject({ page_count: 2 });
  });

  it('routes a BOM-prefixed PDF to the PDF path and extracts (never the raw source as "text")', async () => {
    // pdf.js forward-scans its first 1024 bytes for the header, so it parses these bytes fine —
    // an offset-0-only sniff would route them to the TEXT path and emit the raw PDF source.
    const bytes = withPrefix([0xef, 0xbb, 0xbf], TEXT_LAYER_PDF);
    const result = await runNode({ bytes, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(TEXT_LAYER_PDF_TEXT);
    expect(metadataOf(artifact)).toMatchObject({ sniffed_kind: 'pdf', page_count: 1 });
  });

  it('routes a whitespace/newline-prefixed PDF to the PDF path and extracts', async () => {
    const bytes = withPrefix([0x0a, 0x20, 0x0d, 0x0a, 0x09], TEXT_LAYER_PDF);
    const result = await runNode({ bytes, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe(TEXT_LAYER_PDF_TEXT);
    expect(metadataOf(artifact)).toMatchObject({ sniffed_kind: 'pdf', page_count: 1 });
  });

  it('extracts a MIXED PDF (a text page + an empty page) — only ALL-pages-empty is scanned', async () => {
    // Kills an every→some mutant in the scanned detection: ONE empty page must not fail the doc.
    const bytes = buildPdf({ pages: [{ text: 'page one carries text' }, {}] });
    const result = await runNode({ bytes, declaredType: 'application/pdf' });
    const artifact = artifactOf(result);
    expect(unwrapArtifactValue(artifact.value)).toBe('page one carries text\n\n');
    expect(metadataOf(artifact)).toMatchObject({ page_count: 2 });
  });

  it('detects a WHITESPACE-only text layer as scanned (pins the .trim() — via the injected seam)', async () => {
    // REAL-PARSER-UNREACHABLE shape: pdf.js emits NO text items for whitespace-only runs (probed
    // against the pinned build — a `( ) Tj` page extracts as ''), so the builder cannot make a
    // whitespace-only pageText; the seam pins the node's own trim-based detection instead.
    const whitespacePages: PdfTextExtractor = async () => ({
      kind: 'extracted',
      pageCount: 1,
      pageTexts: [' \t '],
    });
    const result = await runNode({
      bytes: TEXT_LAYER_PDF,
      declaredType: 'application/pdf',
      extractPdfText: whitespacePages,
    });
    expectFailure(result, 'scanned_pdf_no_text_layer', false);
  });

  it('fails a no-text-layer PDF with the typed terminal scanned_pdf_no_text_layer (honest v1: no OCR)', async () => {
    const result = await runNode({ bytes: NO_TEXT_LAYER_PDF, declaredType: 'application/pdf' });
    expectFailure(result, 'scanned_pdf_no_text_layer', false);
  });

  it('fails a truncated PDF with the typed terminal pdf_parse_failed (parser exception wrapped)', async () => {
    const truncated = TEXT_LAYER_PDF.subarray(0, Math.floor(TEXT_LAYER_PDF.length * 0.4));
    const result = await runNode({ bytes: truncated, declaredType: 'application/pdf' });
    expectFailure(result, 'pdf_parse_failed', false);
    if (result.status === 'completed' || result.status === 'paused') throw new Error('unreachable');
    expect(result.error?.message).toContain('InvalidPDFException');
  });

  it('fails an encrypted PDF with the typed terminal pdf_parse_failed naming the password refusal', async () => {
    const result = await runNode({
      bytes: buildEncryptedPdfShape(),
      declaredType: 'application/pdf',
    });
    expectFailure(result, 'pdf_parse_failed', false);
    if (result.status === 'completed' || result.status === 'paused') throw new Error('unreachable');
    expect(result.error?.message).toContain('PasswordException');
  });

  it('fails garbage bytes behind a real %PDF-1.x header with pdf_parse_failed (sniff routes, parser refuses)', async () => {
    // '%PDF-1.4' (a REAL versioned header — the sniff requires the version digit) + binary garbage.
    const garbage = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const result = await runNode({ bytes: garbage, declaredType: 'text/plain' });
    expectFailure(result, 'pdf_parse_failed', false);
  });
});

// ── parser-bomb bounds (fail-closed; config constants, rollout-overridable) ──────────────────────

describe('file_input.parse_text — bomb bounds', () => {
  it('fails CLOSED on a page count above the cap BEFORE extracting any text (real extractor)', async () => {
    const bytes = buildPdf({ pages: [{ text: 'p1' }, { text: 'p2' }, { text: 'p3' }] });
    const result = await runNode({
      bytes,
      declaredType: 'application/pdf',
      limits: { maxPdfPages: 2 },
    });
    expectFailure(result, 'pdf_page_limit_exceeded', false);
  });

  it('fails CLOSED (never truncates) when PDF text exceeds the extracted-chars cap', async () => {
    const result = await runNode({
      bytes: TEXT_LAYER_PDF,
      declaredType: 'application/pdf',
      limits: { maxExtractedTextChars: 5 },
    });
    expectFailure(result, 'file_text_too_large', false);
  });

  it('bounds a hung parse with the wall-clock timeout (typed pdf_parse_timeout)', async () => {
    const hanging: PdfTextExtractor = () => new Promise(() => {});
    const result = await runNode({
      bytes: TEXT_LAYER_PDF,
      declaredType: 'application/pdf',
      limits: { pdfParseTimeoutMs: 40 },
      extractPdfText: hanging,
    });
    expectFailure(result, 'pdf_parse_timeout', false);
  });

  it('a late rejection from a timed-out parse never escapes as an unhandled rejection', async () => {
    let rejectLate: ((e: unknown) => void) | undefined;
    const lateRejecting: PdfTextExtractor = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const result = await runNode({
      bytes: TEXT_LAYER_PDF,
      declaredType: 'application/pdf',
      limits: { pdfParseTimeoutMs: 40 },
      extractPdfText: lateRejecting,
    });
    expectFailure(result, 'pdf_parse_timeout', false);
    // Fire the abandoned promise's rejection AFTER the timeout won; a swallow guard must hold it.
    rejectLate?.(new Error('late I/O fault'));
    await new Promise((r) => setTimeout(r, 10));
    // Reaching this line means no unhandled rejection crashed the worker (vitest fails on them).
    expect(result.status).toBe('terminal_failure');
  });

  it('wraps ANY extractor throw (even a non-Error) as typed pdf_parse_failed — no escape', async () => {
    const throwing: PdfTextExtractor = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'weird non-error throw';
    };
    const result = await runNode({
      bytes: TEXT_LAYER_PDF,
      declaredType: 'application/pdf',
      extractPdfText: throwing,
    });
    expectFailure(result, 'pdf_parse_failed', false);
  });
});

// ── contract plumbing (fail-closed inputs; retryable vs terminal split) ──────────────────────────

describe('file_input.parse_text — contract plumbing', () => {
  it('fails closed when the step declares no output artifact ref', async () => {
    const result = await runNode({ bytes: 'x', outputRefs: undefined });
    expectFailure(result, 'file_parse_outputs_undeclared', false);
  });

  it('fails closed when the trigger payload carries no blob_key', async () => {
    const result = await runNode({
      bytes: 'x',
      payload: { file_id: 'f-1', content_type: 'text/plain' },
    });
    expectFailure(result, 'file_blob_key_missing', false);
  });

  it('maps the typed blob NOT-FOUND to the terminal file_blob_missing (a retry cannot mint bytes)', async () => {
    const result = await runNode({}); // nothing put under BLOB_KEY
    expectFailure(result, 'file_blob_missing', false);
  });

  it('maps a genuine blob I/O THROW to the RETRYABLE file_blob_read_failed', async () => {
    const blob = new FakeBlobStore();
    await blob.put(BLOB_KEY, new TextEncoder().encode('x'));
    blob.failReadsWith = new Error('EIO: disk fault');
    const result = await runNode({ blob });
    expectFailure(result, 'file_blob_read_failed', true);
  });

  it('maps a jail-violating key THROW (BlobJailError) to the TERMINAL file_blob_key_invalid', async () => {
    // The REAL platform error class: a retry re-presents the SAME event key — permanently refused.
    const blob = new FakeBlobStore();
    await blob.put(BLOB_KEY, new TextEncoder().encode('x'));
    blob.failReadsWith = new BlobJailError(
      "blob key '../escape' contains a '..' traversal segment",
    );
    const result = await runNode({ blob });
    expectFailure(result, 'file_blob_key_invalid', false);
  });

  it('is deterministic: two invocations over the same blob emit the identical artifact', async () => {
    const blob = new FakeBlobStore();
    await blob.put(BLOB_KEY, TEXT_LAYER_PDF);
    const first = await runNode({ blob, declaredType: 'application/pdf' });
    const second = await runNode({ blob, declaredType: 'application/pdf' });
    expect(first.status).toBe('completed');
    expect(second).toStrictEqual(first);
  });

  it('keeps the journal output small: metadata only, never the extracted text', async () => {
    const body = 'a'.repeat(512);
    const result = await runNode({ bytes: body });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('unreachable');
    const output = JSON.stringify(result.output ?? {});
    expect(output).not.toContain('aaaaaaaa');
    expect(result.output).toMatchObject({ sniffed_kind: 'text', char_count: 512 });
  });
});

// ── limits resolution (fail-closed construction — the resolveFileConfig mirror) ──────────────────

describe('file_input.parse_text — limits resolution', () => {
  it('applies the documented defaults', () => {
    expect(resolveFileParseLimits()).toStrictEqual({
      maxPdfPages: DEFAULT_MAX_PDF_PAGES,
      maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
      pdfParseTimeoutMs: DEFAULT_PDF_PARSE_TIMEOUT_MS,
    });
  });

  it('stays under the compiled step timeout (30s) so the TYPED timeout wins over the engine one', () => {
    expect(DEFAULT_PDF_PARSE_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it.each([
    ['maxPdfPages: 0', { maxPdfPages: 0 }],
    ['maxPdfPages: -1', { maxPdfPages: -1 }],
    ['maxPdfPages: 1.5', { maxPdfPages: 1.5 }],
    ['maxExtractedTextChars: 0', { maxExtractedTextChars: 0 }],
    ['maxExtractedTextChars: NaN', { maxExtractedTextChars: Number.NaN }],
    ['pdfParseTimeoutMs: 0', { pdfParseTimeoutMs: 0 }],
    ['pdfParseTimeoutMs: 1.5', { pdfParseTimeoutMs: 1.5 }],
  ])('rejects a malformed override fail-closed at construction (%s)', (_name, limits) => {
    expect(() => resolveFileParseLimits(limits as FileParseLimits)).toThrow(/positive integer/);
  });
});
