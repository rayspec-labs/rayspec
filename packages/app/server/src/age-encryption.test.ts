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
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
import { EncryptionAborted, encryptFile, isAgeX25519Recipient } from './age-encryption.js';

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
