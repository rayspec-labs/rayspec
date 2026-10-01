/**
 * The age encryption of a migration payload.
 *
 *  - The library is run against the official age test vectors (C2SP CCTV, published by the age
 *    authors as `cctv-age`): every vector, through the library's public decrypter, from bytes and as
 *    a stream. A vector that expects success decrypts to the payload its SHA-256 names; every other
 *    vector (header, HMAC, payload and armor failures, no matching identity) is refused.
 *  - Only an X25519 recipient is accepted: a passphrase, a post-quantum or tag recipient, a wrong
 *    checksum, upper case and anything else are refused before a file is opened.
 *  - `encryptFile` writes a ciphertext (mode 0600, never over an existing file) that decrypts with
 *    the matching identity and with no other, whose size is the one the format fixes for the
 *    plaintext, and leaves nothing behind when it is stopped or fails.
 *  - When the reference `age` command is on PATH, it decrypts the ciphertext too.
 *  - `decryptFile` decrypts every X25519 vector that expects success to its payload and refuses every
 *    other one with `RAY_DECRYPTION_FAILED`, leaving no plaintext; it refuses a wrong identity, a
 *    passphrase file, a truncated or flipped ciphertext (keeping none of the chunks it had already
 *    decrypted) and a plaintext over its budget before decrypting a byte.
 *  - `parseAgeX25519Identity` takes the one identity of an `age-keygen` file and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  armor,
  Decrypter,
  generateHybridIdentity,
  generateX25519Identity,
  identityToRecipient,
} from 'age-encryption';
import * as vectors from 'cctv-age';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decryptFile,
  EncryptionAborted,
  encryptFile,
  isAgeX25519Recipient,
  parseAgeX25519Identity,
} from './age-encryption.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-age-'));
  dirs.push(dir);
  return dir;
}

// ─── the official test vectors ─────────────────────────────────────────────────────────────────

interface Vector {
  name: string;
  meta: Record<string, string>;
  body: Uint8Array;
}

/** A vector is a header of `key: value` lines, a blank line, then the age file. */
function parseVector(name: string, contents: Uint8Array): Vector {
  let end = 0;
  while (!(contents[end] === 0x0a && contents[end + 1] === 0x0a)) {
    end += 1;
    if (end >= contents.length) throw new Error(`vector ${name} has no header`);
  }
  const meta: Record<string, string> = {};
  for (const line of new TextDecoder().decode(contents.subarray(0, end)).split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) meta[line.slice(0, at)] = line.slice(at + 2);
  }
  let body: Uint8Array = contents.subarray(end + 2);
  if (meta.compressed === 'zlib') body = inflateSync(body);
  else if (meta.compressed !== undefined) throw new Error(`vector ${name}: unknown compression`);
  return { name, meta, body };
}

const VECTORS: Vector[] = Object.entries(vectors as unknown as Record<string, Uint8Array>)
  .filter(([, value]) => value instanceof Uint8Array)
  .map(([name, value]) => parseVector(name, value));

function decrypter(vector: Vector): Decrypter {
  const d = new Decrypter();
  if (vector.meta.passphrase !== undefined) d.addPassphrase(vector.meta.passphrase);
  if (vector.meta.identity !== undefined) d.addIdentity(vector.meta.identity);
  return d;
}

/** The file bytes of a vector; an armored one is decoded first, which may itself fail. */
function fileOf(vector: Vector): Uint8Array {
  return vector.meta.armored === 'yes'
    ? armor.decode(new TextDecoder().decode(vector.body))
    : vector.body;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      // Uneven chunks, so a reader that assumes aligned chunks is caught.
      for (let at = 0; at < bytes.length; at += 777) {
        controller.enqueue(bytes.subarray(at, at + 777));
      }
      controller.close();
    },
  });
}

describe('the official age test vectors', () => {
  it('are all present: X25519 vectors among them, of every outcome', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(140);
    const x25519 = VECTORS.filter((v) => v.meta.identity?.startsWith('AGE-SECRET-KEY-1') === true);
    expect(x25519.length).toBeGreaterThanOrEqual(90);
    const outcomes = new Set(x25519.map((v) => v.meta.expect));
    for (const outcome of [
      'success',
      'header failure',
      'HMAC failure',
      'payload failure',
      'armor failure',
      'no match',
    ]) {
      expect(outcomes, outcome).toContain(outcome);
    }
  });

  for (const vector of VECTORS) {
    if (vector.meta.expect === 'success') {
      it(`${vector.name}: decrypts to the stated payload, from bytes and as a stream`, async () => {
        const fromBytes = await decrypter(vector).decrypt(fileOf(vector));
        expect(sha(fromBytes)).toBe(vector.meta.payload);
        const fromStream = await readAll(await decrypter(vector).decrypt(streamOf(fileOf(vector))));
        expect(sha(fromStream)).toBe(vector.meta.payload);
      });
    } else {
      it(`${vector.name}: is refused (${vector.meta.expect})`, async () => {
        await expect(
          (async () => await decrypter(vector).decrypt(fileOf(vector)))(),
        ).rejects.toThrow();
        await expect(
          (async () => await readAll(await decrypter(vector).decrypt(streamOf(fileOf(vector)))))(),
        ).rejects.toThrow();
      });
    }
  }
});

// ─── recipients ────────────────────────────────────────────────────────────────────────────────

describe('the recipient', () => {
  it('accepts an X25519 recipient', async () => {
    const recipient = await identityToRecipient(await generateX25519Identity());
    expect(isAgeX25519Recipient(recipient)).toBe(true);
  });

  it('refuses every other kind of recipient and every malformed one', async () => {
    const x25519 = await identityToRecipient(await generateX25519Identity());
    const hybrid = await identityToRecipient(await generateHybridIdentity());
    const flipped = `${x25519.slice(0, -1)}${x25519.endsWith('q') ? 'p' : 'q'}`;
    for (const value of [
      hybrid,
      `age1tag1${x25519.slice(4)}`,
      flipped,
      x25519.toUpperCase(),
      `${x25519} `,
      x25519.slice(0, -1),
      `${x25519}q`,
      // An identity is never a recipient.
      await generateX25519Identity(),
      'correct horse battery staple',
      '',
      undefined,
      42,
    ]) {
      expect(isAgeX25519Recipient(value), String(value).slice(0, 12)).toBe(false);
    }
  });
});

// ─── encryptFile ───────────────────────────────────────────────────────────────────────────────

describe('encryptFile', () => {
  async function keyPair() {
    const identity = await generateX25519Identity();
    return { identity, recipient: await identityToRecipient(identity) };
  }

  it('writes a mode-0600 ciphertext that decrypts with the matching identity and no other', async () => {
    const dir = workDir();
    const plain = join(dir, 'inner.zip');
    // More than one 64 KiB age chunk and more than one read chunk, not a multiple of either.
    const plaintext = randomBytes(2 * 1024 * 1024 + 12_345);
    writeFileSync(plain, plaintext);
    const { identity, recipient } = await keyPair();
    const out = join(dir, 'migration.age');

    const result = await encryptFile(plain, out, recipient);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ciphertext = readFileSync(out);
    expect(result.value).toEqual({
      path: out,
      size: ciphertext.length,
      sha256: sha(ciphertext),
      plaintextSize: plaintext.length,
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // An age v1 file with exactly one X25519 stanza.
    const header = ciphertext.subarray(0, 200).toString('latin1');
    expect(header.startsWith('age-encryption.org/v1\n-> X25519 ')).toBe(true);
    expect(header.split('\n-> ').length).toBe(2);

    const right = new Decrypter();
    right.addIdentity(identity);
    expect(Buffer.from(await right.decrypt(ciphertext)).equals(plaintext)).toBe(true);

    const other = new Decrypter();
    other.addIdentity((await keyPair()).identity);
    await expect(other.decrypt(ciphertext)).rejects.toThrow();
  });

  it('encrypts an empty file', async () => {
    const dir = workDir();
    const plain = join(dir, 'empty');
    writeFileSync(plain, '');
    const { identity, recipient } = await keyPair();
    const result = await encryptFile(plain, join(dir, 'out.age'), recipient);
    expect(result.ok).toBe(true);
    const d = new Decrypter();
    d.addIdentity(identity);
    expect((await d.decrypt(readFileSync(join(dir, 'out.age')))).length).toBe(0);
  });

  it('refuses a recipient that is not X25519, a source that is not a file and an existing destination', async () => {
    const dir = workDir();
    const plain = join(dir, 'inner.zip');
    writeFileSync(plain, 'plaintext');
    const { recipient } = await keyPair();
    const hybrid = await identityToRecipient(await generateHybridIdentity());

    const notX25519 = await encryptFile(plain, join(dir, 'a.age'), hybrid);
    expect(notX25519.ok ? 'ok' : notX25519.errors[0]!.code).toBe('RAY_USAGE');
    const notAFile = await encryptFile(dir, join(dir, 'b.age'), recipient);
    expect(notAFile.ok ? 'ok' : notAFile.errors[0]!.code).toBe('RAY_USAGE');
    writeFileSync(join(dir, 'c.age'), 'already here');
    const exists = await encryptFile(plain, join(dir, 'c.age'), recipient);
    expect(exists.ok ? 'ok' : exists.errors[0]!.code).toBe('RAY_USAGE');
    expect(readFileSync(join(dir, 'c.age'), 'utf8')).toBe('already here');
    expect(readdirSync(dir).sort()).toEqual(['c.age', 'inner.zip']);
  });

  it('stops when its signal aborts and leaves no partial ciphertext', async () => {
    const dir = workDir();
    const plain = join(dir, 'inner.zip');
    writeFileSync(plain, randomBytes(4 * 1024 * 1024));
    const { recipient } = await keyPair();
    const controller = new AbortController();
    controller.abort();
    await expect(
      encryptFile(plain, join(dir, 'out.age'), recipient, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(EncryptionAborted);
    expect(existsSync(join(dir, 'out.age'))).toBe(false);
  });

  it('refuses a plaintext reached through a symbolic link and writes nothing', async () => {
    const dir = workDir();
    const plain = join(dir, 'inner.zip');
    writeFileSync(plain, 'plaintext');
    symlinkSync(plain, join(dir, 'link.zip'));
    const { recipient } = await keyPair();
    const result = await encryptFile(join(dir, 'link.zip'), join(dir, 'out.age'), recipient);
    expect(result.ok ? 'ok' : result.errors[0]!.code).toBe('RAY_USAGE');
    expect(existsSync(join(dir, 'out.age'))).toBe(false);
  });

  /**
   * A signal that is never aborted but changes the plaintext the first time the encryption looks at
   * it, while the file is being read.
   */
  function changingOnFirstLook(change: () => void): AbortSignal {
    let changed = false;
    return {
      get aborted() {
        if (!changed) {
          changed = true;
          change();
        }
        return false;
      },
    } as AbortSignal;
  }

  it('refuses a plaintext that grows or shrinks while it is encrypted, and leaves no ciphertext', async () => {
    const { recipient } = await keyPair();
    for (const [name, change] of [
      ['grows', (path: string) => appendFileSync(path, randomBytes(64 * 1024))],
      ['shrinks', (path: string) => truncateSync(path, 1024)],
    ] as const) {
      const dir = workDir();
      const plain = join(dir, 'inner.zip');
      writeFileSync(plain, randomBytes(4 * 1024 * 1024));
      const result = await encryptFile(plain, join(dir, 'out.age'), recipient, {
        signal: changingOnFirstLook(() => change(plain)),
      });
      expect(result.ok ? 'ok' : result.errors[0]!.code, name).toBe('RAY_INTERNAL');
      expect(existsSync(join(dir, 'out.age')), name).toBe(false);
    }
  });

  const age = spawnSync('age', ['--version'], { encoding: 'utf8' });
  it.skipIf(age.status !== 0)(
    'writes a file the reference age command decrypts (runs when age is on PATH)',
    async () => {
      const dir = workDir();
      const plain = join(dir, 'inner.zip');
      const plaintext = randomBytes(300_000);
      writeFileSync(plain, plaintext);
      const { identity, recipient } = await keyPair();
      writeFileSync(join(dir, 'key.txt'), `${identity}\n`, { mode: 0o600 });
      const result = await encryptFile(plain, join(dir, 'out.age'), recipient);
      expect(result.ok).toBe(true);
      const decrypted = spawnSync(
        'age',
        ['--decrypt', '-i', join(dir, 'key.txt'), join(dir, 'out.age')],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      expect(decrypted.status, decrypted.stderr?.toString()).toBe(0);
      expect(Buffer.from(decrypted.stdout).equals(plaintext)).toBe(true);
    },
  );
});

// ─── decryptFile ───────────────────────────────────────────────────────────────────────────────

describe('decryptFile', () => {
  const LIMIT = 64 * 1024 * 1024;
  const code = (r: { ok: true } | { ok: false; errors: { code: string; reason?: string }[] }) =>
    r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

  async function encrypted(plaintext: Buffer) {
    const dir = workDir();
    const identity = await generateX25519Identity();
    const plain = join(dir, 'inner.zip');
    writeFileSync(plain, plaintext);
    const written = await encryptFile(
      plain,
      join(dir, 'migration.age'),
      await identityToRecipient(identity),
    );
    if (!written.ok) throw new Error('encryption failed');
    return { dir, identity, ciphertext: join(dir, 'migration.age') };
  }

  const x25519Vectors = VECTORS.filter(
    (v) =>
      v.meta.identity?.startsWith('AGE-SECRET-KEY-1') === true &&
      v.meta.passphrase === undefined &&
      v.meta.armored !== 'yes',
  );

  it('decrypts every X25519 vector that succeeds, and refuses every other one leaving nothing', async () => {
    expect(x25519Vectors.filter((v) => v.meta.expect === 'success').length).toBeGreaterThan(5);
    expect(x25519Vectors.filter((v) => v.meta.expect !== 'success').length).toBeGreaterThan(20);
    for (const vector of x25519Vectors) {
      const dir = workDir();
      writeFileSync(join(dir, 'in.age'), vector.body);
      const out = join(dir, 'out.zip');
      const result = await decryptFile(join(dir, 'in.age'), out, vector.meta.identity!, {
        maxPlaintextBytes: LIMIT,
      });
      if (vector.meta.expect === 'success') {
        expect(code(result), vector.name).toBe('ok');
        expect(sha(readFileSync(out)), vector.name).toBe(vector.meta.payload);
        expect(statSync(out).mode & 0o777, vector.name).toBe(0o600);
      } else {
        expect(code(result), vector.name).toBe('RAY_DECRYPTION_FAILED/');
        expect(existsSync(out), vector.name).toBe(false);
      }
    }
  });

  it('decrypts with the matching identity and reports the ciphertext it read', async () => {
    const plaintext = randomBytes(3 * 64 * 1024 + 99);
    const { dir, identity, ciphertext } = await encrypted(plaintext);
    const out = join(dir, 'out.zip');
    const result = await decryptFile(ciphertext, out, identity, { maxPlaintextBytes: LIMIT });
    expect(code(result)).toBe('ok');
    if (!result.ok) return;
    expect(readFileSync(out).equals(plaintext)).toBe(true);
    expect(result.value).toEqual({
      path: out,
      size: plaintext.length,
      ciphertextSha256: sha(readFileSync(ciphertext)),
      ciphertextSize: statSync(ciphertext).size,
    });
  });

  it('refuses another identity, and a passphrase file, leaving no plaintext', async () => {
    const { dir, ciphertext } = await encrypted(randomBytes(1000));
    const other = await decryptFile(
      ciphertext,
      join(dir, 'a.zip'),
      await generateX25519Identity(),
      {
        maxPlaintextBytes: LIMIT,
      },
    );
    expect(code(other)).toBe('RAY_DECRYPTION_FAILED/');
    const passphrase = VECTORS.find(
      (v) =>
        v.meta.passphrase !== undefined && v.meta.expect === 'success' && v.meta.armored !== 'yes',
    );
    expect(passphrase).toBeDefined();
    writeFileSync(join(dir, 'scrypt.age'), passphrase!.body);
    const scrypt = await decryptFile(
      join(dir, 'scrypt.age'),
      join(dir, 'b.zip'),
      await generateX25519Identity(),
      { maxPlaintextBytes: LIMIT },
    );
    expect(code(scrypt)).toBe('RAY_DECRYPTION_FAILED/');
    expect(readdirSync(dir).sort()).toEqual(['inner.zip', 'migration.age', 'scrypt.age']);
  });

  it('refuses a truncated ciphertext and a flipped byte in its last chunk, keeping none of the chunks before it', async () => {
    // Several 64 KiB chunks: the ones before the damage decrypt and are written, then removed.
    const plaintext = randomBytes(5 * 64 * 1024 + 7);
    for (const damage of ['truncate', 'flip'] as const) {
      const { dir, identity, ciphertext } = await encrypted(plaintext);
      const bytes = readFileSync(ciphertext);
      if (damage === 'truncate') truncateSync(ciphertext, bytes.length - 16);
      else {
        const at = bytes.length - 10;
        bytes[at] = bytes[at]! ^ 0x01;
        writeFileSync(ciphertext, bytes);
      }
      const out = join(dir, 'out.zip');
      const result = await decryptFile(ciphertext, out, identity, { maxPlaintextBytes: LIMIT });
      expect(code(result), damage).toBe('RAY_DECRYPTION_FAILED/');
      expect(existsSync(out), damage).toBe(false);
    }
  });

  it('refuses a plaintext over its budget before decrypting, and an existing destination', async () => {
    const plaintext = randomBytes(200_000);
    const { dir, identity, ciphertext } = await encrypted(plaintext);
    const budget = 100_000;
    expect(plaintext.length).toBeGreaterThan(budget);
    const out = join(dir, 'out.zip');
    const over = await decryptFile(ciphertext, out, identity, { maxPlaintextBytes: budget });
    expect(code(over)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(existsSync(out)).toBe(false);
    writeFileSync(out, 'already here');
    const exists = await decryptFile(ciphertext, out, identity, { maxPlaintextBytes: LIMIT });
    expect(code(exists)).toBe('RAY_USAGE/');
    expect(readFileSync(out, 'utf8')).toBe('already here');
  });

  it('stops when its signal aborts and leaves no partial plaintext', async () => {
    const { dir, identity, ciphertext } = await encrypted(randomBytes(4 * 64 * 1024));
    const controller = new AbortController();
    controller.abort();
    await expect(
      decryptFile(ciphertext, join(dir, 'out.zip'), identity, {
        maxPlaintextBytes: LIMIT,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(EncryptionAborted);
    expect(existsSync(join(dir, 'out.zip'))).toBe(false);
  });
});

describe('parseAgeX25519Identity', () => {
  it('takes the one identity of an age-keygen file', async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const file = `# created: 2026-10-01T08:00:00Z\n# public key: ${recipient}\n${identity}\n`;
    expect(parseAgeX25519Identity(file)).toBe(identity);
    expect(parseAgeX25519Identity(`\r\n${identity}\r\n\r\n`)).toBe(identity);
  });

  it('refuses no identity, two, a post-quantum one, a passphrase and a broken checksum', async () => {
    const identity = await generateX25519Identity();
    const flipped = `${identity.slice(0, -1)}${identity.endsWith('Q') ? 'P' : 'Q'}`;
    for (const text of [
      '',
      '# only a comment\n',
      `${identity}\n${await generateX25519Identity()}\n`,
      `${await generateHybridIdentity()}\n`,
      'correct horse battery staple\n',
      `${flipped}\n`,
      `${identity.toLowerCase()}\n`,
      await identityToRecipient(identity),
    ]) {
      expect(parseAgeX25519Identity(text), text.slice(0, 20)).toBeNull();
    }
  });
});
