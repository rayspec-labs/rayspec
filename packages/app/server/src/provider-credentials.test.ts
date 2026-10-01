/**
 * The provider-credential reader: a value granted from a bundle's bindings file, else the operator's
 * `<NAME>_FILE`, else the plain variable — and a file that is not a private regular file of this user
 * refuses, never falling back to the plain variable. Messages name the variable and the path, never
 * anything read from the file.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CredentialFileError,
  grantProviderCredentials,
  MAX_CREDENTIAL_FILE_BYTES,
  providerCredential,
  providerCredentialSources,
  providerCredentialSupplied,
  providerCredentialWithSource,
  resetGrantedProviderCredentialsForTests,
} from './provider-credentials.js';

const dir = mkdtempSync(join(tmpdir(), 'rayspec-provider-credentials-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => resetGrantedProviderCredentialsForTests());

const CANARY = `sk-canary-${randomUUID()}`;

function file(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function refusal(env: NodeJS.ProcessEnv): CredentialFileError {
  try {
    providerCredential(env, 'OPENAI_API_KEY');
  } catch (err) {
    if (err instanceof CredentialFileError) return err;
    throw err;
  }
  throw new Error('the credential file was not refused');
}

describe('providerCredential', () => {
  it('reads the plain variable, trimmed; blank is unset', () => {
    expect(providerCredential({ OPENAI_API_KEY: ` ${CANARY}\n` }, 'OPENAI_API_KEY')).toBe(CANARY);
    expect(providerCredential({ OPENAI_API_KEY: '   ' }, 'OPENAI_API_KEY')).toBeUndefined();
    expect(providerCredential({}, 'OPENAI_API_KEY')).toBeUndefined();
  });

  it('reads <NAME>_FILE, which wins over the plain variable', () => {
    const path = file('openai-key', `${CANARY}\n`);
    expect(
      providerCredentialWithSource(
        { OPENAI_API_KEY_FILE: path, OPENAI_API_KEY: 'the-plain-one' },
        'OPENAI_API_KEY',
      ),
    ).toEqual({ value: CANARY, source: 'file' });
  });

  it('takes a value granted from the bindings file before either', () => {
    grantProviderCredentials(new Map([['DEEPGRAM_API_KEY', CANARY]]));
    expect(
      providerCredentialWithSource(
        { DEEPGRAM_API_KEY: 'the-plain-one', DEEPGRAM_API_KEY_FILE: '/nowhere' },
        'DEEPGRAM_API_KEY',
      ),
    ).toEqual({ value: CANARY, source: 'bindings-file' });
    // Granting is per name: another credential is not affected.
    expect(providerCredential({ OPENAI_API_KEY: 'plain' }, 'OPENAI_API_KEY')).toBe('plain');
  });

  it('never grants an application binding to the platform', () => {
    expect(() => grantProviderCredentials(new Map([['STRIPE_SECRET_KEY', CANARY]]))).toThrow(
      /not a provider credential/,
    );
  });

  it.each([
    ['open to others', () => file('open', CANARY, 0o644), true, 'readable or writable by group'],
    [
      'open to the group',
      () => file('group', CANARY, 0o640),
      true,
      'readable or writable by group',
    ],
    [
      'a symbolic link',
      () => {
        const target = file('target', CANARY);
        const link = join(dir, `link-${randomUUID()}`);
        symlinkSync(target, link);
        return link;
      },
      true,
      'symbolic link',
    ],
    ['a directory', () => mkdtempSync(join(dir, 'd-')), true, 'not a regular file'],
    ['missing', () => join(dir, 'missing'), false, 'does not exist'],
    ['empty', () => file('empty', '  \n'), false, 'is empty'],
    [
      'too large',
      () => file('large', 'k'.repeat(MAX_CREDENTIAL_FILE_BYTES + 1)),
      false,
      'larger than',
    ],
  ])('refuses a file that is %s, never falling back to the plain variable', (_what, make, insecure, says) => {
    const path = make();
    const err = refusal({ OPENAI_API_KEY_FILE: path, OPENAI_API_KEY: 'the-plain-one' });
    expect(err.insecure).toBe(insecure);
    expect(err.message).toContain('OPENAI_API_KEY_FILE');
    expect(err.message).toContain(says);
    expect(err.message).not.toContain(CANARY);
    expect(err.message).not.toContain('the-plain-one');
  });
});

describe('what is reported without reading', () => {
  it('names where each supplied credential comes from, and never a value', () => {
    grantProviderCredentials(new Map([['CODEX_API_KEY', CANARY]]));
    const env = {
      OPENAI_API_KEY_FILE: '/run/secrets/openai',
      DEEPGRAM_API_KEY: CANARY,
      ANTHROPIC_API_KEY: '  ',
    };
    const sources = providerCredentialSources(env);
    expect(sources).toEqual({
      OPENAI_API_KEY: 'file',
      DEEPGRAM_API_KEY: 'environment',
      CODEX_API_KEY: 'bindings-file',
    });
    expect(JSON.stringify(sources)).not.toContain(CANARY);
    expect(providerCredentialSupplied(env, 'OPENAI_API_KEY')).toBe(true);
    expect(providerCredentialSupplied(env, 'ANTHROPIC_API_KEY')).toBe(false);
  });
});
