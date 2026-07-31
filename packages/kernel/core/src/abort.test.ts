/**
 * Unit tests for the neutral abort plumbing.
 *
 * These two helpers exist so the three adapters that own a cancellable resource do not each
 * re-implement the linking — and the case that gets forgotten when they do is the one where the
 * source signal has ALREADY aborted by the time the adapter links it. That ordering is real: the run
 * surface signals a cancellation before anything is written, so a run whose backend call starts a
 * moment later links an already-aborted signal.
 *
 * The unlink contract matters just as much. An adapter runs it in the same `finally` that tears the
 * resource down, so it has to be safe to call after the source already fired and safe to call twice.
 */

import { describe, expect, it } from 'vitest';
import { linkAbort, onAbortSignal } from './abort.js';

describe('linkAbort — for a resource whose stop is a controller', () => {
  it('aborts the target when the source aborts', () => {
    const source = new AbortController();
    const target = new AbortController();
    linkAbort(source.signal, target);
    expect(target.signal.aborted).toBe(false);
    source.abort();
    expect(target.signal.aborted).toBe(true);
  });

  it('aborts the target IMMEDIATELY when the source has already aborted', () => {
    const source = new AbortController();
    source.abort();
    const target = new AbortController();
    linkAbort(source.signal, target);
    // The forgettable case: linking after the fact must still stop the resource.
    expect(target.signal.aborted).toBe(true);
  });

  it('is a no-op with no source signal, and returns a callable unlink', () => {
    const target = new AbortController();
    const unlink = linkAbort(undefined, target);
    expect(target.signal.aborted).toBe(false);
    expect(() => unlink()).not.toThrow();
    expect(target.signal.aborted).toBe(false);
  });

  it('unlink stops a later source abort from reaching the target, and is idempotent', () => {
    const source = new AbortController();
    const target = new AbortController();
    const unlink = linkAbort(source.signal, target);
    unlink();
    unlink(); // an adapter teardown may run it more than once
    source.abort();
    // The run ended on its own and released the link, so a later cancellation touches nothing.
    expect(target.signal.aborted).toBe(false);
  });

  it('unlink after the source already fired is safe', () => {
    const source = new AbortController();
    const target = new AbortController();
    const unlink = linkAbort(source.signal, target);
    source.abort();
    expect(() => unlink()).not.toThrow();
    expect(target.signal.aborted).toBe(true);
  });
});

describe('onAbortSignal — for a resource whose stop is a CALL', () => {
  it('runs the callback when the source aborts, exactly once', () => {
    const source = new AbortController();
    let calls = 0;
    onAbortSignal(source.signal, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    source.abort();
    source.abort(); // a second abort on an already-aborted controller emits no second event
    expect(calls).toBe(1);
  });

  it('runs the callback IMMEDIATELY when the source has already aborted', () => {
    const source = new AbortController();
    source.abort();
    let calls = 0;
    onAbortSignal(source.signal, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });

  it('is a no-op with no source signal', () => {
    let calls = 0;
    const unlink = onAbortSignal(undefined, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(() => unlink()).not.toThrow();
  });

  it('unlink prevents a later abort from running the callback, and is idempotent', () => {
    const source = new AbortController();
    let calls = 0;
    const unlink = onAbortSignal(source.signal, () => {
      calls += 1;
    });
    unlink();
    unlink();
    source.abort();
    expect(calls).toBe(0);
  });
});
