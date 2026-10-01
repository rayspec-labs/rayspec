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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkAbort, onAbortSignal, ProviderCallTimeoutError, startCallWatchdog } from './abort.js';
import { classifyUpstreamError } from './error-class.js';

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

describe('startCallWatchdog — a provider call that goes silent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once when the window passes with no output', () => {
    vi.useFakeTimers();
    let fired = 0;
    const dog = startCallWatchdog(100, () => {
      fired += 1;
    });
    vi.advanceTimersByTime(99);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    expect(dog.fired).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(1);
  });

  it('every touch starts the window again, so a call that keeps answering is never cut off', () => {
    vi.useFakeTimers();
    let fired = 0;
    const dog = startCallWatchdog(100, () => {
      fired += 1;
    });
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(90);
      dog.touch();
    }
    expect(fired).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fired).toBe(1);
  });

  it('does not count while paused (a tool call the platform bounds itself), and counts afresh after', () => {
    vi.useFakeTimers();
    let fired = 0;
    const dog = startCallWatchdog(100, () => {
      fired += 1;
    });
    dog.pause();
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(0);
    dog.resume();
    vi.advanceTimersByTime(99);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  it('is inert without a timeout, and silent once disposed', () => {
    vi.useFakeTimers();
    let fired = 0;
    const inert = startCallWatchdog(undefined, () => {
      fired += 1;
    });
    vi.advanceTimersByTime(10_000);
    expect(inert.fired).toBe(false);
    const dog = startCallWatchdog(100, () => {
      fired += 1;
    });
    dog.dispose();
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(0);
  });

  it('its error classifies as the neutral `timeout`', () => {
    expect(classifyUpstreamError(new ProviderCallTimeoutError('codex', 100)).errorClass).toBe(
      'timeout',
    );
  });
});
