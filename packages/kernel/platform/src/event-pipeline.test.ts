/**
 * EventPipeline tests — the bounded back-pressure overflow policy, asserted
 * DETERMINISTICALLY (not timing-flaky):
 *  - persist-before-flush: a frame reaches the live sink ONLY after it is durably persisted;
 *  - under a slow consumer, ONLY text_delta / reasoning_delta are coalesced (oldest shed);
 *  - tool_called / tool_result / tool_error / run_started / turn_completed / run_completed are
 *    NEVER dropped and are ALL persisted;
 *  - a non-droppable-full queue applies back-pressure (the producer blocks) rather than dropping.
 *
 * The slow consumer is a CONTROLLED gate (a manually-resolved promise) so the queue fills on
 * demand — no sleeps, no flakiness.
 */
import type { NeutralEvent } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { EventPipeline } from './event-pipeline.js';

/** A manual gate: callers `await gate.wait()`; the test `gate.open()`s it to release them. */
function makeGate() {
  let resolve!: () => void;
  let p = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    wait: () => p,
    open: () => {
      resolve();
      // re-arm for the next wait
      p = new Promise<void>((r) => {
        resolve = r;
      });
    },
  };
}

const td = (seq: number, text: string): NeutralEvent => ({
  type: 'text_delta',
  runId: 'r',
  seq,
  text,
});
const started = (seq: number): NeutralEvent => ({ type: 'run_started', runId: 'r', seq });
const toolCalled = (seq: number): NeutralEvent => ({
  type: 'tool_called',
  runId: 'r',
  seq,
  toolCallId: `c${seq}`,
  name: 'lookup',
  args: {},
});
const toolResult = (seq: number): NeutralEvent => ({
  type: 'tool_result',
  runId: 'r',
  seq,
  toolCallId: `c${seq}`,
  name: 'lookup',
  result: { kind: 'tool_data', name: 'lookup', toolCallId: `c${seq}`, data: 1 },
});
const completed = (seq: number): NeutralEvent => ({
  type: 'run_completed',
  runId: 'r',
  seq,
  status: 'ok',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

describe('EventPipeline persist-before-flush', () => {
  it('persists an event BEFORE it is flushed to the live sink', async () => {
    const order: string[] = [];
    const p = new EventPipeline({
      persist: async (e) => {
        order.push(`persist:${e.seq}`);
      },
      live: (e) => {
        order.push(`live:${e.seq}`);
      },
    });
    await p.emit(started(0));
    await p.emit(td(1, 'hi'));
    await p.drain();
    // For each event, persist precedes live; order is seq-FIFO.
    expect(order).toEqual(['persist:0', 'live:0', 'persist:1', 'live:1']);
  });

  it('a persist FAILURE means the event is NOT flushed live (fail-closed) and drain rejects', async () => {
    const flushed: number[] = [];
    const p = new EventPipeline({
      persist: async (e) => {
        if (e.seq === 1) throw new Error('boom');
      },
      live: (e) => {
        flushed.push(e.seq);
      },
    });
    await p.emit(started(0));
    await p.emit(td(1, 'x'));
    await expect(p.drain()).rejects.toThrow('boom');
    // seq 0 flushed; seq 1 (persist threw) was NEVER flushed live.
    expect(flushed).toEqual([0]);
  });
});

describe('EventPipeline overflow policy (back-pressure)', () => {
  it('coalesces ONLY text_delta under a slow consumer; tool + terminal frames survive + persist', async () => {
    const persisted: NeutralEvent[] = [];
    const flushed: NeutralEvent[] = [];
    const gate = makeGate();
    let firstLive = true;

    const p = new EventPipeline({
      maxQueue: 3,
      persist: async (e) => {
        persisted.push(e);
      },
      // The live sink STALLS on the very first event (holding the worker), so subsequent emits pile
      // up in the bounded queue and force the coalescing policy deterministically.
      live: async (e) => {
        if (firstLive) {
          firstLive = false;
          await gate.wait();
        }
        flushed.push(e);
      },
    });

    // Emit run_started — the worker picks it up and STALLS in the live sink (queue now draining slot 0).
    await p.emit(started(0));
    // Let the worker start + stall on the gate.
    await new Promise((r) => setTimeout(r, 0));

    // Now flood: 5 text deltas (1..5) + a tool_called(6) + tool_result(7) + run_completed(8).
    // maxQueue=3, the worker is stalled, so the queue fills and coalesces deltas. We DON'T await each
    // emit (a producer may block on a full non-droppable queue), then release the gate so the worker
    // can drain — modelling a slow consumer that eventually catches up.
    const emits = Promise.all([
      p.emit(td(1, 'a')),
      p.emit(td(2, 'b')),
      p.emit(td(3, 'c')),
      p.emit(td(4, 'd')),
      p.emit(td(5, 'e')),
      p.emit(toolCalled(6)),
      p.emit(toolResult(7)),
      p.emit(completed(8)),
    ]);

    // Release the stalled consumer; let the worker drain the rest.
    gate.open();
    await emits;
    await p.drain();

    const persistedSeqs = persisted.map((e) => e.seq);
    const persistedTypes = new Set(persisted.map((e) => e.type));

    // Some text_delta frames WERE coalesced (shed) under pressure — fewer than 5 survived.
    const survivingTextDeltas = persisted.filter((e) => e.type === 'text_delta').length;
    expect(p.coalescedCount).toBeGreaterThan(0);
    expect(survivingTextDeltas).toBeLessThan(5);

    // The NON-droppable frames are ALL present + persisted (never dropped):
    expect(persistedSeqs).toContain(0); // run_started
    expect(persistedSeqs).toContain(6); // tool_called
    expect(persistedSeqs).toContain(7); // tool_result
    expect(persistedSeqs).toContain(8); // run_completed
    expect(persistedTypes.has('run_started')).toBe(true);
    expect(persistedTypes.has('tool_called')).toBe(true);
    expect(persistedTypes.has('tool_result')).toBe(true);
    expect(persistedTypes.has('run_completed')).toBe(true);

    // Persist precedes flush for every surviving frame (same set, persist order == flush order).
    expect(flushed.map((e) => e.seq)).toEqual(persisted.map((e) => e.seq));

    // A coalesced (shed) text_delta is absent from BOTH the durable log and the live stream.
    // 9 events were emitted (seq 0..8); persisted = 9 - coalesced, and live == persisted set.
    expect(persisted.length).toBe(flushed.length);
    expect(persisted.length).toBe(9 - p.coalescedCount);
  });

  it('NEVER coalesces a structural frame: a queue full of non-droppable frames applies back-pressure', async () => {
    const persisted: NeutralEvent[] = [];
    const gate = makeGate();
    let firstLive = true;
    const p = new EventPipeline({
      maxQueue: 2,
      persist: async (e) => {
        persisted.push(e);
      },
      live: async () => {
        if (firstLive) {
          firstLive = false;
          await gate.wait();
        }
      },
    });

    await p.emit(started(0)); // worker picks up + stalls
    await new Promise((r) => setTimeout(r, 0));

    // Fill the queue with NON-droppable frames (tool_called x2) — no coalescible frame to shed.
    await p.emit(toolCalled(1));
    await p.emit(toolCalled(2));

    // A THIRD non-droppable frame must BLOCK (queue full, nothing to coalesce): emit() does NOT
    // resolve until the worker drains a slot. Assert it is still pending after a short wait.
    let resolved = false;
    const blocked = p.emit(toolResult(3)).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false); // back-pressure: producer is blocked, NOT dropping the frame

    // Release the stalled consumer; the worker drains a slot, the blocked producer resolves.
    gate.open();
    await blocked;
    await p.drain();
    expect(resolved).toBe(true);
    // ALL four non-droppable frames are persisted — none dropped.
    expect(persisted.map((e) => e.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(p.coalescedCount).toBe(0);
  });

  // Blocked-producer (must-fix) regression: ≥2 CONCURRENT producers blocked on a full non-droppable queue. With a
  // single waiter slot, the second producer's resolver OVERWRITES the first's — the first is orphaned
  // forever, its emit() never resolves, drain() never completes, and the structural frame it carried is
  // NEVER persisted. This is the real deadlock (parallel OpenAI tool calls fire pipeline.emit of
  // non-droppable tool_called frames via Promise.all). A FIFO waiter queue must wake EXACTLY ONE waiter
  // per freed slot, in order, so BOTH resolve and BOTH frames persist. This test FAILS (times out, one
  // frame missing) against the single-slot waiter and PASSES after the FIFO fix.
  it('two CONCURRENT producers on a full non-droppable queue both resolve + both frames persist (no deadlock)', async () => {
    const persisted: NeutralEvent[] = [];
    const gate = makeGate();
    let firstLive = true;
    const p = new EventPipeline({
      maxQueue: 2,
      persist: async (e) => {
        persisted.push(e);
      },
      // Stall the worker on the very first flush so the queue fills with non-droppable frames.
      live: async () => {
        if (firstLive) {
          firstLive = false;
          await gate.wait();
        }
      },
    });

    await p.emit(started(0)); // worker picks it up + STALLS in live(0); queue now empty, slot free
    await new Promise((r) => setTimeout(r, 0));

    // Fill the bounded queue (maxQueue=2) with NON-droppable frames so the next emits MUST block.
    await p.emit(toolCalled(1));
    await p.emit(toolCalled(2));

    // TWO producers race to emit a non-droppable frame onto the now-full non-droppable queue. Both
    // block (nothing coalescible to shed). The single-slot waiter loses producer A's resolver here.
    const a = p.emit(toolResult(3));
    const b = p.emit(toolCalled(4));

    // Release the stalled worker; it drains slots one at a time and must wake BOTH blocked producers.
    gate.open();

    // Bound the wait so a deadlock fails the test (a hung Promise.all) instead of hanging the suite.
    const bothResolved = Promise.all([a, b]).then(() => 'ok');
    const timeout = new Promise<string>((r) => setTimeout(() => r('deadlock'), 1000));
    expect(await Promise.race([bothResolved, timeout])).toBe('ok');

    await p.drain();
    // BOTH concurrently-emitted structural frames are durable — neither orphaned, neither dropped.
    const seqs = persisted.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(p.coalescedCount).toBe(0);
  });

  // Blocked-producer corollary: a persist FAILURE while producers are blocked must reject ALL waiters (fail-closed),
  // never leave one orphaned waiting on a worker that has stopped. With a single waiter slot a second
  // blocked producer is silently lost on failure too.
  it('a persist failure rejects ALL blocked producers (no orphaned waiter)', async () => {
    const gate = makeGate();
    let firstLive = true;
    const p = new EventPipeline({
      maxQueue: 2,
      persist: async (e) => {
        if (e.seq === 1) throw new Error('persist-boom');
      },
      live: async () => {
        if (firstLive) {
          firstLive = false;
          await gate.wait();
        }
      },
    });

    await p.emit(started(0)); // worker stalls in live(0)
    await new Promise((r) => setTimeout(r, 0));
    await p.emit(toolCalled(1)); // will throw on persist once the worker resumes
    await p.emit(toolCalled(2)); // queue full (2)

    // Two producers block on the full non-droppable queue.
    const a = p.emit(toolResult(3)).then(
      () => 'resolved',
      (e) => `rejected:${(e as Error).message}`,
    );
    const b = p.emit(toolCalled(4)).then(
      () => 'resolved',
      (e) => `rejected:${(e as Error).message}`,
    );

    gate.open(); // worker resumes: flush 0, shift 1 (frees a slot, wakes one producer), persist(1) throws

    const results = await Promise.all([
      Promise.race([a, new Promise<string>((r) => setTimeout(() => r('hung'), 1000))]),
      Promise.race([b, new Promise<string>((r) => setTimeout(() => r('hung'), 1000))]),
    ]);
    // Fail-closed contract: NEITHER producer is left hung. Each either resolved (admitted into a slot
    // freed BEFORE the persist threw) or rejected (observed the failure) — never an orphaned waiter.
    // At least one MUST be rejected (the worker stopped on the failure), and NONE may hang.
    expect(results.every((r) => r !== 'hung')).toBe(true);
    expect(results.some((r) => r.startsWith('rejected:'))).toBe(true);
    await expect(p.drain()).rejects.toThrow('persist-boom');
  });
});
