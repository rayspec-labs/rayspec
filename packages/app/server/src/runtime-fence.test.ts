/**
 * The object-write gate a drained runtime holds (`fencedBlobStore`), over the real fs blob backend:
 * while the gate refuses, put, delete and deleteTenant fail with 503 SERVICE_UNAVAILABLE and change
 * nothing on disk, and reads keep working; once it admits again, writes land. Also the two producer
 * adapters the fence drains through.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFsBlobStoreFactory } from '@rayspec/platform';
import { afterAll, describe, expect, it } from 'vitest';
import { fencedBlobStore, gatedProducer, queueProducer } from './runtime-fence.js';

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
