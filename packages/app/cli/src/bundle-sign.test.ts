/**
 * `rayspec bundle sign` in process: the two outcomes a real process cannot reach on demand. A signal
 * that arrives before the signature file is placed leaves nothing behind and reports
 * `RAY_INTERRUPTED`; a written signature that does not verify against the key's public half is a
 * defect, reported as `RAY_INTERNAL` and never placed. The rest of the verb is shown through the
 * built CLI in bundle-sign-binary.test.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bundleLibrary from '@rayspec/bundle';
import { exitCodeFor, schemaValidator } from '@rayspec/bundle-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSign } from './bundle-sign.js';
import { corpusFile, loadExpectations } from './test-support/bundles.js';

vi.mock('@rayspec/bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/bundle')>();
  return { ...actual, verifySignatureFile: vi.fn(actual.verifySignatureFile) };
});

const expectations = loadExpectations();
const valid = schemaValidator('resultEnvelope');
const OPERATION_ID = '00000000-0000-4000-8000-000000000000';

let work: string;
let app: string;
let key: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'rayspec-cli-sign-'));
  app = join(work, 'app.ray');
  copyFileSync(corpusFile(expectations.cases.find((c) => c.id === 'app-good-minimal')!), app);
  key = join(work, 'k.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(key, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  chmodSync(key, 0o600);
});

afterEach(() => {
  vi.mocked(bundleLibrary.verifySignatureFile).mockClear();
  rmSync(work, { recursive: true, force: true });
});

describe('bundle sign', () => {
  it('signs when nothing interferes (the control for the cases below)', async () => {
    const outcome = await runSign([app, '--key-file', key], { operationId: OPERATION_ID });
    expect(outcome.envelope.ok).toBe(true);
    expect(valid(outcome.envelope)).toBe(true);
    expect(readdirSync(work).sort()).toEqual(['app.ray', 'app.ray.sig', 'k.pem']);
    expect(vi.mocked(bundleLibrary.verifySignatureFile)).toHaveBeenCalledTimes(1);
  });

  it('a signal before placement removes the temporary file and reports RAY_INTERRUPTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSign([app, '--key-file', key], {
      operationId: OPERATION_ID,
      signal: controller.signal,
    });
    expect(valid(outcome.envelope)).toBe(true);
    expect(outcome.envelope.errors[0]?.code).toBe('RAY_INTERRUPTED');
    expect(outcome.envelope.errors[0]?.message).toContain('nothing was written');
    expect(outcome.envelope.errors[0]?.message).not.toContain('rayspec resume');
    expect(exitCodeFor(outcome.envelope.errors)).toBe(6);
    expect(readdirSync(work).sort()).toEqual(['app.ray', 'k.pem']);
  });

  it('a written signature that does not verify is RAY_INTERNAL and is never placed', async () => {
    vi.mocked(bundleLibrary.verifySignatureFile).mockReturnValueOnce({
      ok: false,
      errors: [
        { code: 'RAY_SIGNATURE_INVALID', message: 'x', retryable: false, reason: 'mismatch' },
      ],
    });
    const outcome = await runSign([app, '--key-file', key], { operationId: OPERATION_ID });
    expect(vi.mocked(bundleLibrary.verifySignatureFile)).toHaveBeenCalledTimes(1);
    expect(valid(outcome.envelope)).toBe(true);
    expect(outcome.envelope.data).toBeNull();
    expect(outcome.envelope.errors[0]?.code).toBe('RAY_INTERNAL');
    expect(exitCodeFor(outcome.envelope.errors)).toBe(7);
    expect(readdirSync(work).sort()).toEqual(['app.ray', 'k.pem']);
  });

  it('a limit the reader reaches is refused before anything is written', async () => {
    const outcome = await runSign([app, '--key-file', key], {
      operationId: OPERATION_ID,
      readerLimits: { entryCount: 1 },
    });
    expect(outcome.envelope.errors[0]?.code).toBe('RAY_LIMIT_EXCEEDED');
    expect(readdirSync(work).sort()).toEqual(['app.ray', 'k.pem']);
  });
});
