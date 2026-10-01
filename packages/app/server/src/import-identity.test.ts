/**
 * The target's new boot secrets: three fresh values in a new private directory, each usable by the
 * boot that reads it, none of them printed; and the refusal of a directory that is not new.
 */
import { createPrivateKey } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import {
  BOOT_SECRET_FILES,
  bootSecretsDirectoryRefusal,
  mintBootSecrets,
} from './import-identity.js';

afterAll(() => removeTemporaryDirectories());

function readPrivate(path: string): { mode: number; text: string } {
  const fd = openSync(path, 'r');
  try {
    return { mode: fstatSync(fd).mode & 0o777, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

describe('mintBootSecrets', () => {
  it('mints a signing key, a pepper and a media key into a new 0700 directory, files 0600', async () => {
    const dir = join(temporaryDirectory('boot-secrets-'), 'target-secrets');
    const files = await mintBootSecrets(dir);
    const fd = openSync(dir, 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o700);
    } finally {
      closeSync(fd);
    }
    expect(Object.keys(files).sort()).toEqual(Object.keys(BOOT_SECRET_FILES).sort());
    const key = readPrivate(files.RAYSPEC_JWT_SIGNING_KEY);
    expect(key.mode).toBe(0o600);
    const parsed = createPrivateKey(key.text);
    expect(parsed.asymmetricKeyType).toBe('rsa');
    expect(parsed.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const pepper = readPrivate(files.RAYSPEC_API_KEY_PEPPER);
    const media = readPrivate(files.RAYSPEC_MEDIA_SIGNING_KEY);
    for (const secret of [pepper, media]) {
      expect(secret.mode).toBe(0o600);
      expect(Buffer.from(secret.text, 'base64')).toHaveLength(48);
    }
    expect(pepper.text).not.toBe(media.text);
    // Two imports never share a secret.
    const again = await mintBootSecrets(join(temporaryDirectory('boot-secrets-'), 'other'));
    expect(readPrivate(again.RAYSPEC_API_KEY_PEPPER).text).not.toBe(pepper.text);
  });

  it('never writes into a directory that exists', async () => {
    const dir = temporaryDirectory('boot-secrets-');
    await expect(mintBootSecrets(dir)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('bootSecretsDirectoryRefusal', () => {
  it('accepts a new path under an existing directory, and refuses anything else', async () => {
    const parent = temporaryDirectory('boot-secrets-');
    expect(await bootSecretsDirectoryRefusal(join(parent, 'new'))).toBeNull();
    expect(await bootSecretsDirectoryRefusal(parent)).toMatchObject({ code: 'RAY_USAGE' });
    expect(await bootSecretsDirectoryRefusal(join(parent, 'a', 'b'))).toMatchObject({
      code: 'RAY_USAGE',
    });
    mkdirSync(join(parent, 'real'));
    symlinkSync(join(parent, 'real'), join(parent, 'link'));
    expect(await bootSecretsDirectoryRefusal(join(parent, 'link'))).toMatchObject({
      code: 'RAY_USAGE',
    });
    expect(await bootSecretsDirectoryRefusal(join(parent, 'link', 'secrets'))).toMatchObject({
      code: 'RAY_USAGE',
    });
  });
});
