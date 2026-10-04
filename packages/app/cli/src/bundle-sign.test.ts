/**
 * `rayspec bundle sign` in process: the outcomes a real process cannot reach on demand. A signal
 * that arrives before the signature file is placed leaves nothing behind and reports
 * `RAY_INTERRUPTED`; a written signature that does not verify against the key's public half is a
 * defect, reported as `RAY_INTERNAL` and never placed; the bytes verified are the ones read back
 * from the file; a key file owned by another user is refused; the signature file's mode does not
 * depend on the umask; and a file system without hard links is a usage error. The rest of the verb
 * is shown through the built CLI in bundle-sign-binary.test.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bundleLibrary from '@rayspec/bundle';
import { exitCodeFor, schemaValidator } from '@rayspec/bundle-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSign } from './bundle-sign.js';
import { corpusFile, loadExpectations } from './test-support/bundles.js';

vi.mock('@rayspec/bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/bundle')>();
  return {
    ...actual,
    createSignatureFile: vi.fn(actual.createSignatureFile),
    verifySignatureFile: vi.fn(actual.verifySignatureFile),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
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
  vi.mocked(bundleLibrary.createSignatureFile).mockClear();
  vi.mocked(bundleLibrary.verifySignatureFile).mockClear();
  vi.mocked(fsPromises.link).mockClear();
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

  it('verifies the bytes read back from the file, not the bytes it meant to write', async () => {
    const outcome = await runSign([app, '--key-file', key], { operationId: OPERATION_ID });
    expect(outcome.envelope.ok).toBe(true);
    const created = vi.mocked(bundleLibrary.createSignatureFile).mock.results[0]!.value as {
      ok: true;
      value: Buffer;
    };
    const checked = vi.mocked(bundleLibrary.verifySignatureFile).mock.calls[0]![1] as Buffer;
    expect(created.ok).toBe(true);
    expect(checked).not.toBe(created.value);
    expect(Buffer.from(checked).equals(created.value)).toBe(true);
  });

  it('a key file owned by another user is RAY_BINDINGS_FILE_INSECURE', async () => {
    const fd = openSync(key, 'r');
    const owner = fstatSync(fd).uid;
    closeSync(fd);
    const outcome = await runSign([app, '--key-file', key], {
      operationId: OPERATION_ID,
      ownerUid: owner + 1,
    });
    expect(valid(outcome.envelope)).toBe(true);
    expect(outcome.envelope.errors[0]?.code).toBe('RAY_BINDINGS_FILE_INSECURE');
    expect(outcome.envelope.errors[0]?.message).toContain('not owned by the user');
    expect(exitCodeFor(outcome.envelope.errors)).toBe(4);
    expect(readdirSync(work).sort()).toEqual(['app.ray', 'k.pem']);
    // The same file passes for its owner, so the refusal above is the owner check's.
    const own = await runSign([app, '--key-file', key], {
      operationId: OPERATION_ID,
      ownerUid: owner,
    });
    expect(own.envelope.ok).toBe(true);
  });

  it('the signature file is mode 0644 under a umask that would narrow it', async () => {
    const previous = process.umask(0o077);
    try {
      expect(process.umask()).toBe(0o077);
      const outcome = await runSign([app, '--key-file', key], { operationId: OPERATION_ID });
      expect(outcome.envelope.ok).toBe(true);
    } finally {
      process.umask(previous);
    }
    const fd = openSync(join(work, 'app.ray.sig'), 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o644);
    } finally {
      closeSync(fd);
    }
  });

  it('a file system without hard links is RAY_USAGE without --force, and nothing is left', async () => {
    const unsupported = Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
    vi.mocked(fsPromises.link).mockRejectedValueOnce(unsupported);
    const outcome = await runSign([app, '--key-file', key], { operationId: OPERATION_ID });
    expect(vi.mocked(fsPromises.link)).toHaveBeenCalledTimes(1);
    expect(valid(outcome.envelope)).toBe(true);
    expect(outcome.envelope.errors[0]?.code).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.message).toContain('no hard links');
    expect(exitCodeFor(outcome.envelope.errors)).toBe(2);
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
