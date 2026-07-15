/**
 * Bounded body reader — unit tests for the shared, product-neutral request-body byte bound
 * (generalized from the file-runtime `drainBounded` upload pattern).
 *
 * Two independent fail-closed layers, both pinned here:
 *   1. the Content-Length PRE-CHECK — a declared length above the cap is rejected BEFORE a single
 *      body byte is read (the body stream is never touched);
 *   2. DRAIN-TIME enforcement — the body is read chunk-wise under a running byte count; the moment it
 *      exceeds the cap the read is cancelled and the outcome is `too_large`, so a LYING (or absent)
 *      Content-Length buys at most `cap + one chunk` of memory, never an unbounded buffer.
 */
import { describe, expect, it } from 'vitest';
import { drainBounded, readBoundedBody } from './bounded-body.js';

/** Build a ReadableStream that emits the given byte chunks then closes. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A stream that THROWS the instant it is read — proves the pre-check never touched the body. */
function explodingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('body was read despite the Content-Length pre-check');
    },
  });
}

describe('drainBounded — chunk-wise byte bound', () => {
  it('a null body is an empty read', async () => {
    expect(await drainBounded(null, 10)).toEqual(new Uint8Array(0));
  });

  it('concatenates in-budget chunks in order', async () => {
    const out = await drainBounded(streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])), 10);
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('a body EXACTLY at the cap is accepted (boundary)', async () => {
    const out = await drainBounded(streamOf(new Uint8Array([1, 2, 3])), 3);
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('a body ONE byte over the cap is over_cap (drain-time)', async () => {
    expect(await drainBounded(streamOf(new Uint8Array([1, 2, 3, 4])), 3)).toBe('over_cap');
  });

  it('over_cap fires mid-stream and does not buffer the remaining chunks', async () => {
    // Two 3-byte chunks under a 4-byte cap: the second chunk pushes past 4 → over_cap.
    expect(
      await drainBounded(streamOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])), 4),
    ).toBe('over_cap');
  });
});

describe('readBoundedBody — Content-Length pre-check + drain-time', () => {
  it('a declared length ABOVE the cap is rejected pre-read (body never touched)', async () => {
    const outcome = await readBoundedBody(
      { contentLength: '11', body: explodingStream() },
      { maxBytes: 10 },
    );
    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
  });

  it('a declared in-budget length reads the body and returns the bytes', async () => {
    const outcome = await readBoundedBody(
      { contentLength: '5', body: streamOf(new Uint8Array([1, 2, 3, 4, 5])) },
      { maxBytes: 10 },
    );
    expect(outcome).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  });

  it('a LYING in-budget Content-Length is still caught at drain time', async () => {
    // Declares 2 bytes but streams 20 — the pre-check passes, drain-time enforcement rejects.
    const outcome = await readBoundedBody(
      { contentLength: '2', body: streamOf(new Uint8Array(20)) },
      { maxBytes: 10 },
    );
    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
  });

  it('default posture is LENIENT on an absent Content-Length (drain-time still bounds it)', async () => {
    const ok = await readBoundedBody(
      { contentLength: undefined, body: streamOf(new Uint8Array([9, 9])) },
      { maxBytes: 10 },
    );
    expect(ok).toEqual({ ok: true, bytes: new Uint8Array([9, 9]) });

    const over = await readBoundedBody(
      { contentLength: undefined, body: streamOf(new Uint8Array(50)) },
      { maxBytes: 10 },
    );
    expect(over).toEqual({ ok: false, reason: 'too_large' });
  });

  it('a non-numeric Content-Length is ignored in the default posture (drain-time bounds it)', async () => {
    const outcome = await readBoundedBody(
      { contentLength: 'not-a-number', body: streamOf(new Uint8Array([7])) },
      { maxBytes: 10 },
    );
    expect(outcome).toEqual({ ok: true, bytes: new Uint8Array([7]) });
  });

  it('requireContentLength rejects an ABSENT length before reading (length_required)', async () => {
    const outcome = await readBoundedBody(
      { contentLength: undefined, body: explodingStream() },
      { maxBytes: 10, requireContentLength: true },
    );
    expect(outcome).toEqual({ ok: false, reason: 'length_required' });
  });

  it('requireContentLength rejects a NON-NUMERIC / chunked length (length_required)', async () => {
    for (const bad of ['', '-5', '12abc', '1e3']) {
      const outcome = await readBoundedBody(
        { contentLength: bad, body: explodingStream() },
        { maxBytes: 10, requireContentLength: true },
      );
      expect(outcome).toEqual({ ok: false, reason: 'length_required' });
    }
  });

  it('an empty body reads as zero bytes (ok)', async () => {
    const outcome = await readBoundedBody({ contentLength: '0', body: null }, { maxBytes: 10 });
    expect(outcome).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });
});
