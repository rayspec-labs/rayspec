/**
 * Pins for the `httpResponse` envelope + the ADDITIVE `sseResponse` streaming variant.
 *
 * The heaviest item here is the UNFLAGGED-DEFAULT BYTE-IDENTITY pin: a plain
 * `httpResponse({...})` (no `sse`) must be structurally identical to the body-only envelope — it carries
 * NO `sse` own-key — so every existing consumer (the views runtime, product route handlers,
 * product views) is provably unperturbed. The `sse` member is the ONE non-serializable (closure)
 * member; it appears ONLY on an `sseResponse(...)` return.
 */
import { describe, expect, it } from 'vitest';
import {
  HTTP_RESPONSE_BRAND,
  httpResponse,
  isHttpResponse,
  type SseFrame,
  type SseProducer,
  sseResponse,
} from './index.js';

describe('httpResponse — the plain-value envelope (unflagged default, byte-identity)', () => {
  it('a body-only envelope carries NO sse own-key (byte-identity with the pre-S4 shape)', () => {
    const r = httpResponse({ body: { ok: true } });
    expect(isHttpResponse(r)).toBe(true);
    expect(Object.hasOwn(r, 'sse')).toBe(false);
    // Exact key set — brand + body only, nothing S4 leaked in.
    expect(Object.keys(r).sort()).toEqual([HTTP_RESPONSE_BRAND, 'body'].sort());
  });

  it('a status+headers+body envelope is unchanged (no sse key)', () => {
    const r = httpResponse({ status: 201, headers: { Location: '/x/1' }, body: { id: 1 } });
    expect(Object.hasOwn(r, 'sse')).toBe(false);
    expect(Object.keys(r).sort()).toEqual(
      [HTTP_RESPONSE_BRAND, 'status', 'headers', 'body'].sort(),
    );
  });

  it('an empty envelope is just the brand (no sse)', () => {
    const r = httpResponse({});
    expect(Object.keys(r)).toEqual([HTTP_RESPONSE_BRAND]);
    expect(Object.hasOwn(r, 'sse')).toBe(false);
  });
});

describe('sseResponse — the ADDITIVE streaming variant', () => {
  it('carries the SAME brand (so isHttpResponse + the request-body brand-strip cover it)', () => {
    const producer: SseProducer = async () => {};
    const r = sseResponse(producer);
    expect(isHttpResponse(r)).toBe(true);
    expect((r as Record<string, unknown>)[HTTP_RESPONSE_BRAND]).toBe(true);
  });

  it('exposes the producer under `sse` and NOTHING else beyond the brand', () => {
    const producer: SseProducer = async () => {};
    const r = sseResponse(producer);
    expect(r.sse).toBe(producer);
    expect(Object.keys(r).sort()).toEqual([HTTP_RESPONSE_BRAND, 'sse'].sort());
  });

  it('the producer receives an emit + an abort signal and can emit frames', async () => {
    const frames: SseFrame[] = [];
    const producer: SseProducer = async (emit, signal) => {
      expect(signal.aborted).toBe(false);
      await emit({ event: 'text_delta', data: '{"text":"hi"}' });
      await emit({ id: '9', event: 'conversation_reply', data: '{"run_id":"r","text":"hi"}' });
    };
    const r = sseResponse(producer);
    await r.sse?.(async (f) => void frames.push(f), { aborted: false });
    expect(frames).toEqual([
      { event: 'text_delta', data: '{"text":"hi"}' },
      { id: '9', event: 'conversation_reply', data: '{"run_id":"r","text":"hi"}' },
    ]);
  });
});
