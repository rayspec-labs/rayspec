/**
 * The result envelope and its exit code, the legacy wrapping of an existing command's result, and
 * the interruption of a passive verb.
 */
import { EventEmitter } from 'node:events';
import { bundleError, schemaValidator } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import {
  envelope,
  envelopeExitCode,
  internalEnvelope,
  interruptedEnvelope,
  interruptible,
  legacyEnvelope,
  newOperationId,
  usageEnvelope,
} from './envelope.js';

const valid = schemaValidator('resultEnvelope');
const id = newOperationId();

describe('envelope', () => {
  it('is ok exactly when there are no errors, and validates against the contract schema', () => {
    const good = envelope('doctor', id, { ok: true });
    const bad = envelope('doctor', id, null, [bundleError('RAY_CHECK_FAILED', 'no')]);
    expect([good.ok, bad.ok]).toEqual([true, false]);
    expect(valid(good)).toBe(true);
    expect(valid(bad)).toBe(true);
  });

  it('takes a fresh UUID v4 per operation', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newOperationId()));
    expect(ids.size).toBe(50);
    for (const x of ids)
      expect(x).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('clips messages, paths and list lengths to what the schema admits', () => {
    const long = bundleError('RAY_CHECK_FAILED', 'x'.repeat(5000), { path: 'p'.repeat(5000) });
    const many = Array.from({ length: 1200 }, () => long);
    const result = envelope('plan', id, null, many, [
      { code: 'RAY_W_UNSIGNED', message: 'y'.repeat(3000) },
    ]);
    expect(result.errors).toHaveLength(1000);
    expect(result.errors[0]!.message).toHaveLength(2048);
    expect(result.errors[0]!.path).toHaveLength(4096);
    expect(result.warnings[0]!.message).toHaveLength(2048);
    expect(valid(result)).toBe(true);
  });
});

describe('envelopeExitCode', () => {
  const env = (...codes: string[]) =>
    envelope(
      'bundle.verify',
      id,
      null,
      codes.map((c) => ({ code: c as never, message: 'm', retryable: false })),
    );

  it('is 0 without errors and the class of a single error otherwise', () => {
    expect(envelopeExitCode(env())).toBe(0);
    expect(envelopeExitCode(env('RAY_SPEC_INVALID'))).toBe(1);
    expect(envelopeExitCode(env('SPEC_UNKNOWN_FIELD'))).toBe(1);
    expect(envelopeExitCode(env('RAY_USAGE'))).toBe(2);
    expect(envelopeExitCode(env('RAY_RUNTIME_UNSUPPORTED'))).toBe(3);
    expect(envelopeExitCode(env('RAY_SIGNATURE_INVALID'))).toBe(4);
    expect(envelopeExitCode(env('RAY_LOCK_TIMEOUT'))).toBe(5);
    expect(envelopeExitCode(env('RAY_INTERRUPTED'))).toBe(6);
    expect(envelopeExitCode(env('RAY_INTERNAL'))).toBe(7);
  });

  it('follows the precedence 7, 6, 4, 3, 2, 1, 5 among several errors', () => {
    expect(envelopeExitCode(env('RAY_LOCK_TIMEOUT', 'RAY_SPEC_INVALID'))).toBe(1);
    expect(envelopeExitCode(env('RAY_SPEC_INVALID', 'RAY_USAGE'))).toBe(2);
    expect(envelopeExitCode(env('RAY_USAGE', 'RAY_TARGET_UNSUPPORTED'))).toBe(3);
    expect(envelopeExitCode(env('RAY_TARGET_UNSUPPORTED', 'RAY_SECRET_DETECTED'))).toBe(4);
    expect(envelopeExitCode(env('RAY_SECRET_DETECTED', 'RAY_INTERRUPTED'))).toBe(6);
    expect(envelopeExitCode(env('RAY_INTERRUPTED', 'RAY_INTERNAL'))).toBe(7);
  });

  it('maps the fixed envelopes to 2, 6 and 7', () => {
    expect(envelopeExitCode(usageEnvelope('doctor', id, 'bad flag'))).toBe(2);
    expect(envelopeExitCode(interruptedEnvelope('bundle.inspect', id, 'run it again'))).toBe(6);
    expect(envelopeExitCode(internalEnvelope('doctor', id))).toBe(7);
  });
});

describe('legacyEnvelope', () => {
  it('carries the result unchanged in data and adds RAY_W_LEGACY_OUTPUT', () => {
    const result = { ok: true, errors: [], nested: { a: [1, 2] } };
    const env = legacyEnvelope('doctor', id, result, true);
    expect(env.data).toBe(result);
    expect(env.ok).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.warnings.map((w) => w.code)).toEqual(['RAY_W_LEGACY_OUTPUT']);
    expect(valid(env)).toBe(true);
  });

  it('maps spec errors to SPEC_ codes with their path, and anything else to RAY_CHECK_FAILED', () => {
    const result = {
      ok: false,
      errors: [
        { code: 'unknown_field', message: 'unknown field', path: 'bogus' },
        { code: 'invalid_holes', message: 'the holes are malformed' },
        'spec did not validate',
      ],
    };
    const env = legacyEnvelope('plan', id, result, false);
    expect(env.errors).toEqual([
      { code: 'SPEC_UNKNOWN_FIELD', message: 'unknown field', path: 'bogus', retryable: false },
      { code: 'RAY_CHECK_FAILED', message: 'the holes are malformed', retryable: false },
      { code: 'RAY_CHECK_FAILED', message: 'spec did not validate', retryable: false },
    ]);
    expect(envelopeExitCode(env)).toBe(1);
    expect(valid(env)).toBe(true);
  });

  it('gives a negative verdict without listed errors one RAY_CHECK_FAILED', () => {
    const env = legacyEnvelope('dev.db', id, { ok: false }, false);
    expect(env.errors.map((e) => e.code)).toEqual(['RAY_CHECK_FAILED']);
    expect(valid(env)).toBe(true);
  });
});

describe('interruptible', () => {
  const never = () => new Promise<number>(() => {});

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal} ends the wait with interrupted, and the listeners are removed`, async () => {
      const signals = new EventEmitter();
      const waiting = interruptible(never(), signals as never);
      expect(signals.listenerCount(signal)).toBe(1);
      signals.emit(signal);
      expect(await waiting).toEqual({ interrupted: true });
      expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
    });
  }

  it('returns the value when the work settles first, and removes the listeners', async () => {
    const signals = new EventEmitter();
    expect(await interruptible(Promise.resolve(42), signals as never)).toEqual({
      interrupted: false,
      value: 42,
    });
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('passes a rejection of the work through, and removes the listeners', async () => {
    const signals = new EventEmitter();
    await expect(
      interruptible(Promise.reject(new Error('boom')), signals as never),
    ).rejects.toThrow('boom');
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  });
});
