/**
 * An unexpected internal failure exits 7 — distinct from a usage error (2) — on an existing command
 * with and without `--json`, and on a bundle verb, which answers with a `RAY_INTERNAL` envelope.
 *
 * The failure is planted by mocking the command module the CLI imports on the command's path, so the
 * throw is one no handler inside the command anticipated.
 */
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './index.js';
import { captureOutput } from './test-support/bundles.js';

vi.mock('./openapi.js', () => ({
  runOpenapi: () => {
    throw new Error('planted failure');
  },
}));
vi.mock('./bundle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./bundle.js')>();
  return {
    ...original,
    runBundle: () => Promise.reject(new Error('planted failure')),
  };
});

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

describe('an unexpected failure', () => {
  it('exits 7 on an existing command, with the message on stderr and nothing on stdout', async () => {
    await run(['openapi', 'spec.yaml']);
    expect(process.exitCode).toBe(7);
    expect(io.out()).toBe('');
    expect(JSON.parse(io.err().split('\n')[0]!)).toEqual({
      ok: false,
      cliError: 'planted failure',
    });
  });

  it('exits 7 with --json, with a RAY_INTERNAL envelope that does not repeat the message', async () => {
    await run(['openapi', 'spec.yaml', '--json']);
    expect(process.exitCode).toBe(7);
    const env = JSON.parse(io.out());
    expect(valid(env)).toBe(true);
    expect(env.errors).toEqual([
      { code: 'RAY_INTERNAL', message: 'the command failed unexpectedly', retryable: false },
    ]);
    expect(env.operation).toBe('openapi');
  });

  it('exits 7 on a bundle verb, which still writes its one envelope', async () => {
    await run(['bundle', 'inspect', 'app.ray']);
    expect(process.exitCode).toBe(7);
    const env = JSON.parse(io.out());
    expect(valid(env)).toBe(true);
    expect(env.operation).toBe('bundle.inspect');
    expect(env.errors[0].code).toBe('RAY_INTERNAL');
  });
});
