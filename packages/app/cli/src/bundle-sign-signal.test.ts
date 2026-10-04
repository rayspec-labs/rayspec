/**
 * `rayspec bundle sign` hears SIGINT and SIGTERM: the CLI hands the verb an abort signal that its
 * own handlers raise, so a signal that arrives while the verb runs reaches it and the command ends
 * with `RAY_INTERRUPTED` (exit 6) instead of being swallowed. The verb is replaced here by one that
 * raises the signal through the handlers the CLI registered for it, and answers as the real verb
 * answers a raised signal before placement; what the real verb does then is shown in
 * bundle-sign.test.ts.
 */
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignRunOptions } from './bundle-sign.js';
import { envelope, interruptedEnvelope } from './envelope.js';
import { run } from './index.js';
import { captureOutput } from './test-support/bundles.js';

const raised: { signal: 'SIGINT' | 'SIGTERM'; before: Set<unknown> } = {
  signal: 'SIGINT',
  before: new Set(),
};

vi.mock('./bundle-sign.js', () => ({
  runSign: async (_args: readonly string[], options: SignRunOptions) => {
    // The handlers the CLI added for this verb, called as the process would call them.
    for (const listener of process.listeners(raised.signal)) {
      if (!raised.before.has(listener)) (listener as (s: string) => void)(raised.signal);
    }
    const result = options.signal?.aborted
      ? interruptedEnvelope('bundle.sign', options.operationId, 'nothing was written')
      : envelope('bundle.sign', options.operationId, {
          bundleSha256: '0'.repeat(64),
          signaturePath: 'app.ray.sig',
          publicKeySha256: '0'.repeat(64),
        });
    return { envelope: result, summary: [], json: true };
  },
}));

const valid = schemaValidator('resultEnvelope');
let io: ReturnType<typeof captureOutput>;
let prevExit: typeof process.exitCode;
beforeEach(() => {
  io = captureOutput();
  prevExit = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = prevExit;
  vi.restoreAllMocks();
});

describe('bundle sign and the process signals', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal} while the verb runs reaches it, and the command exits 6`, async () => {
      raised.signal = signal;
      raised.before = new Set(process.listeners(signal));
      const listenersBefore = process.listenerCount(signal);
      await run(['bundle', 'sign', 'app.ray', '--key-file', 'k.pem', '--json']);
      const env = JSON.parse(io.out());
      expect(valid(env)).toBe(true);
      expect(env.errors[0]?.code).toBe('RAY_INTERRUPTED');
      expect(process.exitCode).toBe(6);
      // The handlers are removed when the verb ends.
      expect(process.listenerCount(signal)).toBe(listenersBefore);
    });
  }
});
