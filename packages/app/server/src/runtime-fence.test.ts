/**
 * The object-write gate a drained runtime holds (`fencedBlobStore`), over the real fs blob backend:
 * while the gate refuses, put, delete and deleteTenant fail with 503 SERVICE_UNAVAILABLE and change
 * nothing on disk, and reads keep working; once it admits again, writes land. Also the two producer
 * adapters the fence drains through, and the phases one process moves through (`RuntimeFence`) over
 * an in-memory stand-in for its two tables: what it admits in each phase, what its heartbeat reports,
 * and that it is visible from the moment it loads, before any producer starts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@rayspec/db';
import { makeFsBlobStoreFactory } from '@rayspec/platform';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  type FencedProducer,
  fencedBlobStore,
  gatedProducer,
  queueProducer,
  RuntimeFence,
} from './runtime-fence.js';

const TENANT = '00000000-0000-4000-8000-0000000000b1';
const root = mkdtempSync(join(tmpdir(), 'rayspec-fenced-blob-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('fencedBlobStore', () => {
  it('refuses every write while fenced, keeps reads, and writes again once admitted', async () => {
    let admits = true;
    const store = fencedBlobStore(makeFsBlobStoreFactory(root)(TENANT), () => admits);
    await store.put('a', new Uint8Array([1, 2]));

    admits = false;
    for (const write of [
      () => store.put('b', new Uint8Array([3])),
      () => store.delete('a'),
      () => store.deleteTenant(TENANT),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    const read = await store.get('a');
    if ('notFound' in read) throw new Error('the object written before the fence is gone');
    expect(Array.from(new Uint8Array(await new Response(read.body).arrayBuffer()))).toEqual([1, 2]);
    expect(await store.stat('b')).toMatchObject({ notFound: true });

    admits = true;
    await store.put('b', new Uint8Array([3]));
    expect(await store.stat('b')).toMatchObject({ len: 1 });
  });
});

describe('the producer adapters', () => {
  it('a queue counts as running while a job runs or its pause has not settled', async () => {
    const queue = {
      inFlight: 0,
      dispatchSettled: false,
      calls: [] as string[],
      async pauseDispatch() {
        this.calls.push('pause');
      },
      async resumeDispatch() {
        this.calls.push('resume');
      },
    };
    const producer = queueProducer('run-queue', queue);
    expect(producer.running()).toBe(0);
    await producer.pause();
    expect(producer.running()).toBe(1);
    queue.dispatchSettled = true;
    expect(producer.running()).toBe(0);
    queue.inFlight = 2;
    expect(producer.running()).toBe(2);
    await producer.resume();
    queue.inFlight = 0;
    queue.dispatchSettled = false;
    expect(producer.running()).toBe(0);
    expect(queue.calls).toEqual(['pause', 'resume']);
  });

  it('a gated producer drains its in-flight work only', async () => {
    let inFlight = 1;
    const producer = gatedProducer('cron-triggers', () => inFlight);
    await producer.pause();
    expect(producer.running()).toBe(1);
    inFlight = 0;
    expect(producer.running()).toBe(0);
  });
});

interface Beat {
  epoch: number;
  phase: string;
  producers: { producer: string; state: string }[];
}

/** The fence row and the heartbeat table, in memory: only the statements `RuntimeFence` sends. */
function fakeDatabase() {
  const state = { fence: 'open' as 'open' | 'fenced', epoch: 0, beats: [] as Beat[] };
  const db = {
    $client: {
      unsafe: async (text: string, params: unknown[] = []) => {
        if (text.includes('FROM runtime_control_state')) {
          return [{ fence_state: state.fence, fence_epoch: String(state.epoch) }];
        }
        if (text.includes('INSERT INTO runtime_control_processes')) {
          state.beats.push({
            epoch: Number(params[1]),
            phase: String(params[2]),
            producers: JSON.parse(String(params[3])),
          });
        }
        return [];
      },
    },
  } as unknown as Db;
  return { db, state, last: () => state.beats.at(-1) };
}

function stateOf(beat: Beat | undefined, producer: string): string | undefined {
  return beat?.producers.find((p) => p.producer === producer)?.state;
}

describe('RuntimeFence', () => {
  it('is visible as a live, undrained process from load(), before any producer is attached', async () => {
    const { db, state } = fakeDatabase();
    const fence = new RuntimeFence({ db, pollIntervalMs: 60_000 });
    await fence.load();
    // The first heartbeat precedes the read of the fence: a quiesce committing in between still sees
    // this process, open, at no fence's epoch.
    expect(state.beats[0]).toMatchObject({ epoch: 0, phase: 'open' });
    expect(state.beats.length).toBeGreaterThanOrEqual(1);
    await fence.stop();
  });

  it('keeps its heartbeat and observes a fence taken while it is still booting', async () => {
    const { db, state, last } = fakeDatabase();
    const fence = new RuntimeFence({ db, pollIntervalMs: 20 });
    await fence.load();
    let paused = 0;
    const producer: FencedProducer = {
      name: 'run-queue',
      pause: async () => {
        paused += 1;
      },
      resume: async () => {},
      running: () => 0,
    };
    await fence.attach(producer);
    state.fence = 'fenced';
    state.epoch = 1;
    // No start(): the poll that load() began observes the fence on its own.
    await vi.waitFor(() => expect(last()).toMatchObject({ epoch: 1, phase: 'fenced' }), {
      timeout: 2_000,
    });
    expect(paused).toBe(1);
    await fence.stop();
  });

  it('moves open, draining, fenced and open again, and reports an in-flight mutation', async () => {
    const { db, state, last } = fakeDatabase();
    const fence = new RuntimeFence({ db, pollIntervalMs: 60_000 });
    await fence.load();
    await fence.start();
    expect(fence.phase).toBe('open');
    expect(fence.admitsWrites()).toBe(true);
    expect(fence.admitsDataWrites()).toBe(true);
    const firstDrain = fence.drainSignal();

    const end = fence.begin();
    state.fence = 'fenced';
    state.epoch = 1;
    await fence.sync();
    // Draining: new mutations refused, running ones may still write, the drain signal fired.
    expect(fence.phase).toBe('draining');
    expect(fence.admitsWrites()).toBe(false);
    expect(fence.admitsDataWrites()).toBe(true);
    expect(firstDrain.aborted).toBe(true);
    expect(last()).toMatchObject({ epoch: 1, phase: 'draining' });
    expect(stateOf(last(), 'http-mutations')).toBe('still-running');

    await fence.sync();
    expect(fence.phase).toBe('draining');

    end();
    await fence.sync();
    // Drained: data writes are refused too.
    expect(fence.phase).toBe('fenced');
    expect(fence.admitsDataWrites()).toBe(false);
    expect(stateOf(last(), 'http-mutations')).toBe('drained');
    const blobs = fence.blobFactory(makeFsBlobStoreFactory(root))(TENANT);
    await expect(blobs.put('fenced', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });

    // A new epoch while fenced is observed again.
    state.epoch = 2;
    await fence.sync();
    expect(fence.epoch).toBe(2);
    expect(last()).toMatchObject({ epoch: 2, phase: 'fenced' });

    // Resume: a fresh drain signal, and everything admitted again.
    state.fence = 'open';
    await fence.sync();
    expect(fence.phase).toBe('open');
    expect(fence.admitsWrites()).toBe(true);
    expect(fence.admitsDataWrites()).toBe(true);
    expect(fence.drainSignal().aborted).toBe(false);
    await fence.stop();
  });
});
