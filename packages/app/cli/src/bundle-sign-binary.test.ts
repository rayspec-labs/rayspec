/**
 * `rayspec bundle sign` through the REAL built CLI (`node dist/index.js`), and the signature it
 * writes through `rayspec bundle verify`.
 *
 * The round trip: a bundle signed with a key verifies with `--require-signature` and that key's
 * public half as the trusted key, and the fingerprint sign reports is the one verify reports. Another
 * trusted key, or a bundle changed after signing, is refused by verify. Every refusal of the key
 * file, the output and the bundle is shown with its code and exit, and leaves nothing behind: no
 * signature file and no temporary file.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_DIST, CONTRACT_ROOT, corpusFile, loadExpectations } from './test-support/bundles.js';

const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `bundle-sign-binary.test: SKIPPING — built CLI not found at ${CLI_DIST}; run \`pnpm build\` first.\n`,
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

const expectations = loadExpectations();
const valid = schemaValidator('resultEnvelope');
const caseFile = (id: string) => corpusFile(expectations.cases.find((c) => c.id === id)!);
/** The runtime the good corpus bundles pin. */
const FIXTURE_RUNTIME = expectations.runtimeProfiles.fixture!.version;
/** The codes the contract lists for bundle.sign. */
const SIGN_CODES: string[] = (
  JSON.parse(readFileSync(join(CONTRACT_ROOT, 'contract', 'cli-verbs.json'), 'utf8')) as {
    verbs: { operation: string; errors: string[] }[];
  }
).verbs.find((v) => v.operation === 'bundle.sign')!.errors;

let root: string;
let work: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-sign-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  work = mkdtempSync(join(root, 'case-'));
});

// biome-ignore lint/suspicious/noExplicitAny: the envelope's shape is what the assertions check.
type Json = Record<string, any>;

/** Run the built CLI in `work` with a minimal environment; the envelope is parsed from stdout. */
function cli(args: string[]): { status: number | null; stdout: string; stderr: string; env: Json } {
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RAYSPEC_SKIP_DOTENV: '1' },
  });
  let env: Json = {};
  try {
    env = JSON.parse(r.stdout);
  } catch {
    env = {};
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, env };
}

/** A copy of a corpus bundle in `work`, so a signature can be written next to it. */
function bundle(id = 'app-good-minimal', name = 'app.ray'): string {
  const path = join(work, name);
  copyFileSync(caseFile(id), path);
  return path;
}

/** The mode bits of a file, read through one handle. */
function modeOf(path: string): number {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd).mode & 0o777;
  } finally {
    closeSync(fd);
  }
}

/** Write a private key as PKCS#8 PEM with `mode`, and assert the mode really is that. */
function keyFile(name: string, key: KeyObject, mode = 0o600, passphrase?: string): string {
  const path = join(work, name);
  const pem = key.export(
    passphrase === undefined
      ? { format: 'pem', type: 'pkcs8' }
      : { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase },
  );
  writeFileSync(path, pem, { mode });
  chmodSync(path, mode);
  expect(modeOf(path)).toBe(mode);
  return path;
}

function publicKeyFile(name: string, key: KeyObject): string {
  const path = join(work, name);
  writeFileSync(path, key.export({ format: 'pem', type: 'spki' }), { mode: 0o644 });
  chmodSync(path, 0o644);
  return path;
}

const ed25519 = () => generateKeyPairSync('ed25519');

/** The names in `work` that a refused sign must not have left: a signature or a temporary file. */
function leftovers(): string[] {
  return readdirSync(work).filter((n) => n.endsWith('.sig') || n.endsWith('.tmp'));
}

/** The refusal of a sign: data null, the code first, the exit, the code listed by the contract. */
function expectRefused(r: ReturnType<typeof cli>, code: string, exit: number): void {
  expect(r.status, r.stdout + r.stderr).toBe(exit);
  expect(valid(r.env), JSON.stringify(valid.errors)).toBe(true);
  expect(r.env.operation).toBe('bundle.sign');
  expect(r.env.ok).toBe(false);
  expect(r.env.data).toBeNull();
  expect(r.env.errors[0].code).toBe(code);
  expect(SIGN_CODES).toContain(code);
}

maybeDescribe('bundle sign, then bundle verify', () => {
  it('a signed bundle verifies with --require-signature and the trusted public key', () => {
    const app = bundle();
    const { privateKey, publicKey } = ed25519();
    const key = keyFile('signer.pem', privateKey);
    const pub = publicKeyFile('signer.pub.pem', publicKey);

    const signed = cli(['bundle', 'sign', app, '--key-file', key, '--json']);
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    expect(valid(signed.env), JSON.stringify(valid.errors)).toBe(true);
    expect(signed.env).toMatchObject({ ok: true, operation: 'bundle.sign', errors: [] });
    expect(signed.env.data.signaturePath).toBe(`${app}.sig`);
    expect(signed.stderr).toBe(`operationId: ${signed.env.operationId}\n`);
    expect(modeOf(`${app}.sig`)).toBe(0o644);

    // Without a signature the same verify refuses, so the success below is the signature's.
    const unsignedCopy = bundle('app-good-minimal', 'unsigned.ray');
    const unsigned = cli([
      'bundle',
      'verify',
      unsignedCopy,
      '--runtime',
      FIXTURE_RUNTIME,
      '--trusted-key',
      pub,
      '--require-signature',
    ]);
    expect(unsigned.status).toBe(4);
    expect(unsigned.env.errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'malformed',
    });

    const verified = cli([
      'bundle',
      'verify',
      app,
      '--runtime',
      FIXTURE_RUNTIME,
      '--trusted-key',
      pub,
      '--require-signature',
      '--json',
    ]);
    expect(verified.status, verified.stdout).toBe(0);
    expect(verified.env.data.signature).toEqual({
      present: true,
      verified: true,
      publicKeySha256: signed.env.data.publicKeySha256,
    });
    expect(verified.env.data.sha256).toBe(signed.env.data.bundleSha256);
  });

  it('verify refuses the signature with another trusted key', () => {
    const app = bundle();
    const signer = ed25519();
    const other = ed25519();
    expect(
      cli(['bundle', 'sign', app, '--key-file', keyFile('signer.pem', signer.privateKey)]).status,
    ).toBe(0);
    const r = cli([
      'bundle',
      'verify',
      app,
      '--runtime',
      FIXTURE_RUNTIME,
      '--trusted-key',
      publicKeyFile('other.pub.pem', other.publicKey),
      '--require-signature',
    ]);
    expect(r.status).toBe(4);
    expect(r.env.errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'untrusted-key',
    });
  });

  it('verify refuses a bundle changed after it was signed', () => {
    const { privateKey, publicKey } = ed25519();
    const key = keyFile('signer.pem', privateKey);
    const pub = publicKeyFile('signer.pub.pem', publicKey);
    const verify = (app: string) =>
      cli([
        'bundle',
        'verify',
        app,
        '--runtime',
        FIXTURE_RUNTIME,
        '--trusted-key',
        pub,
        '--require-signature',
      ]);

    // Replaced by another valid bundle: the archive digest no longer matches the signature.
    const swapped = bundle();
    expect(cli(['bundle', 'sign', swapped, '--key-file', key]).status).toBe(0);
    expect(verify(swapped).status).toBe(0);
    copyFileSync(caseFile('app-good-scoped-package-paths'), swapped);
    expect(readFileSync(swapped).equals(readFileSync(caseFile('app-good-minimal')))).toBe(false);
    const r = verify(swapped);
    expect(r.status).toBe(4);
    expect(r.env.errors[0]).toMatchObject({ code: 'RAY_SIGNATURE_INVALID', reason: 'mismatch' });

    // One byte changed: the reader refuses it before the signature is looked at.
    const flipped = bundle('app-good-minimal', 'flipped.ray');
    expect(cli(['bundle', 'sign', flipped, '--key-file', key]).status).toBe(0);
    const bytes = readFileSync(flipped);
    bytes[bytes.length >> 1] ^= 0xff;
    writeFileSync(flipped, bytes);
    const f = verify(flipped);
    expect(f.status).not.toBe(0);
    expect(f.env.ok).toBe(false);
  });
});

maybeDescribe('bundle sign refuses a key file that is not a protected Ed25519 private key', () => {
  it('a key file group or others can read', () => {
    const app = bundle();
    for (const mode of [0o644, 0o640, 0o604, 0o620]) {
      const r = cli([
        'bundle',
        'sign',
        app,
        '--key-file',
        keyFile(`k${mode.toString(8)}.pem`, ed25519().privateKey, mode),
      ]);
      expectRefused(r, 'RAY_BINDINGS_FILE_INSECURE', 4);
      expect(r.env.errors[0].message).toContain('chmod 600');
    }
    expect(leftovers()).toEqual([]);
  });

  it('accepts 0400 as well as 0600', () => {
    const app = bundle();
    const r = cli([
      'bundle',
      'sign',
      app,
      '--key-file',
      keyFile('k400.pem', ed25519().privateKey, 0o400),
    ]);
    expect(r.status, r.stdout).toBe(0);
  });

  it('a symbolic link, even to a protected key file', () => {
    const app = bundle();
    const real = keyFile('real.pem', ed25519().privateKey);
    const link = join(work, 'link.pem');
    symlinkSync(real, link);
    const r = cli(['bundle', 'sign', app, '--key-file', link]);
    expectRefused(r, 'RAY_BINDINGS_FILE_INSECURE', 4);
    expect(r.env.errors[0].message).toContain('symbolic link');
    expect(leftovers()).toEqual([]);
  });

  it('a directory, which is not a regular file', () => {
    const app = bundle();
    const dir = join(work, 'keydir');
    mkdirSync(dir, { mode: 0o700 });
    expectRefused(cli(['bundle', 'sign', app, '--key-file', dir]), 'RAY_BINDINGS_FILE_INSECURE', 4);
  });

  it('a missing key file', () => {
    const app = bundle();
    const r = cli(['bundle', 'sign', app, '--key-file', join(work, 'absent.pem')]);
    expectRefused(r, 'RAY_USAGE', 2);
    expect(r.env.errors[0].message).toContain('no file at that path');
    expect(leftovers()).toEqual([]);
  });

  it('a public key, an RSA key, a P-256 key and an encrypted key, naming none of their bytes', () => {
    const app = bundle();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(rsa.privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = join(work, 'public.pem');
    const publicPem = ed25519().publicKey.export({ format: 'pem', type: 'spki' });
    writeFileSync(pub, publicPem, { mode: 0o600 });
    chmodSync(pub, 0o600);
    const cases: [string, string][] = [
      [pub, 'holds a public key'],
      [keyFile('rsa.pem', rsa.privateKey), 'not an Ed25519 key (it is rsa)'],
      [keyFile('p256.pem', p256.privateKey), 'not an Ed25519 key (it is ec)'],
      [
        keyFile('encrypted.pem', ed25519().privateKey, 0o600, randomBytes(16).toString('hex')),
        'encrypted',
      ],
    ];
    for (const [file, message] of cases) {
      const r = cli(['bundle', 'sign', app, '--key-file', file]);
      expectRefused(r, 'RAY_USAGE', 2);
      expect(r.env.errors[0].message).toContain(message);
      const content = readFileSync(file, 'utf8');
      const body = content.split('\n')[1]!;
      expect(body.length).toBeGreaterThan(16);
      expect(r.stdout + r.stderr).not.toContain(body);
    }
    expect(leftovers()).toEqual([]);
  });

  it('a file over 16 KiB, and one with two keys', () => {
    const app = bundle();
    const big = join(work, 'big.pem');
    writeFileSync(big, Buffer.alloc(16 * 1024 + 1, 0x41), { mode: 0o600 });
    chmodSync(big, 0o600);
    expect(readFileSync(big).length).toBeGreaterThan(16 * 1024);
    const r = cli(['bundle', 'sign', app, '--key-file', big]);
    expectRefused(r, 'RAY_USAGE', 2);
    expect(r.env.errors[0].message).toContain('16 KiB');

    const two = join(work, 'two.pem');
    const pem = (k: KeyObject) => String(k.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(two, pem(ed25519().privateKey) + pem(ed25519().privateKey), { mode: 0o600 });
    chmodSync(two, 0o600);
    const t = cli(['bundle', 'sign', app, '--key-file', two]);
    expectRefused(t, 'RAY_USAGE', 2);
    expect(t.env.errors[0].message).toContain('exactly one key');
  });

  it('no --key-file at all', () => {
    const r = cli(['bundle', 'sign', bundle()]);
    expectRefused(r, 'RAY_USAGE', 2);
    expect(r.env.errors[0].message).toContain('--key-file');
  });
});

maybeDescribe('bundle sign output', () => {
  it('--output writes the signature there, and verify reads it with --signature', () => {
    const app = bundle();
    const { privateKey, publicKey } = ed25519();
    const out = join(work, 'elsewhere.sig');
    const r = cli([
      'bundle',
      'sign',
      app,
      '--key-file',
      keyFile('k.pem', privateKey),
      '--output',
      out,
    ]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.env.data.signaturePath).toBe(out);
    expect(existsSync(`${app}.sig`)).toBe(false);
    const v = cli([
      'bundle',
      'verify',
      app,
      '--runtime',
      FIXTURE_RUNTIME,
      '--signature',
      out,
      '--trusted-key',
      publicKeyFile('k.pub.pem', publicKey),
      '--require-signature',
    ]);
    expect(v.status, v.stdout).toBe(0);
  });

  it('refuses an existing signature file without --force and replaces it with --force', () => {
    const app = bundle();
    const first = ed25519();
    const second = ed25519();
    const k1 = keyFile('first.pem', first.privateKey);
    const k2 = keyFile('second.pem', second.privateKey);
    expect(cli(['bundle', 'sign', app, '--key-file', k1]).status).toBe(0);
    const before = readFileSync(`${app}.sig`);

    const refused = cli(['bundle', 'sign', app, '--key-file', k2]);
    expectRefused(refused, 'RAY_OUTPUT_EXISTS', 2);
    expect(readFileSync(`${app}.sig`).equals(before)).toBe(true);
    expect(leftovers()).toEqual([`app.ray.sig`]);

    const forced = cli(['bundle', 'sign', app, '--key-file', k2, '--force']);
    expect(forced.status, forced.stdout).toBe(0);
    expect(readFileSync(`${app}.sig`).equals(before)).toBe(false);
    expect(leftovers()).toEqual([`app.ray.sig`]);
    const v = cli([
      'bundle',
      'verify',
      app,
      '--runtime',
      FIXTURE_RUNTIME,
      '--trusted-key',
      publicKeyFile('second.pub.pem', second.publicKey),
      '--require-signature',
    ]);
    expect(v.status, v.stdout).toBe(0);
  });

  it('--force replaces a link at the signature path without writing through it', () => {
    const app = bundle();
    const target = join(work, 'target.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, `${app}.sig`);
    const k = keyFile('k.pem', ed25519().privateKey);
    expectRefused(cli(['bundle', 'sign', app, '--key-file', k]), 'RAY_OUTPUT_EXISTS', 2);
    expect(cli(['bundle', 'sign', app, '--key-file', k, '--force']).status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(JSON.parse(readFileSync(`${app}.sig`, 'utf8')).algorithm).toBe('ed25519');
  });

  it('refuses a signature path that names the bundle or the key file, or a missing directory', () => {
    const app = bundle();
    const before = readFileSync(app);
    const k = keyFile('k.pem', ed25519().privateKey);
    for (const out of [app, k]) {
      const r = cli(['bundle', 'sign', app, '--key-file', k, '--output', out, '--force']);
      expectRefused(r, 'RAY_USAGE', 2);
    }
    expect(readFileSync(app).equals(before)).toBe(true);
    const missing = cli([
      'bundle',
      'sign',
      app,
      '--key-file',
      k,
      '--output',
      join(work, 'no', 'x.sig'),
    ]);
    expectRefused(missing, 'RAY_USAGE', 2);
    expect(missing.env.errors[0].message).toContain('does not exist');
    expect(leftovers()).toEqual([]);
  });
});

maybeDescribe('bundle sign of a bundle the reader refuses', () => {
  for (const id of [
    'archive-traversal-dotdot',
    'archive-symlink',
    'forged-payload-swap',
    'manifest-duplicate-key',
    'limit-json-depth',
  ]) {
    it(`${id} is refused with its corpus code, and nothing is written`, () => {
      const c = expectations.cases.find((x) => x.id === id);
      expect(c, `${id} is a corpus case`).toBeDefined();
      const expected = c!.expect.find((e) => e.operation === 'bundle.inspect')!;
      expect(expected.ok).toBe(false);
      const app = join(work, 'hostile.ray');
      copyFileSync(corpusFile(c!), app);
      const r = cli(['bundle', 'sign', app, '--key-file', keyFile('k.pem', ed25519().privateKey)]);
      expectRefused(r, expected.code!, expected.exit);
      expect(readdirSync(work).sort()).toEqual(['hostile.ray', 'k.pem']);
    });
  }

  it('a file that is not a ZIP', () => {
    const app = join(work, 'garbage.ray');
    writeFileSync(app, 'not an archive');
    const r = cli(['bundle', 'sign', app, '--key-file', keyFile('k.pem', ed25519().privateKey)]);
    expectRefused(r, 'RAY_INVALID_ARCHIVE', 2);
    expect(r.env.errors[0].reason).toBe('not-a-zip');
    expect(leftovers()).toEqual([]);
  });
});

maybeDescribe('bundle sign output carries no key material', () => {
  it('neither stdout nor stderr repeats the private key, with or without --json', () => {
    const { privateKey } = ed25519();
    const k = keyFile('k.pem', privateKey);
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seedHex = der.subarray(der.length - 32).toString('hex');
    const seedB64 = der.toString('base64');
    for (const extra of [[], ['--json']]) {
      const app = bundle('app-good-minimal', `app${extra.length}.ray`);
      const r = cli(['bundle', 'sign', app, '--key-file', k, ...extra]);
      expect(r.status).toBe(0);
      const all = r.stdout + r.stderr;
      expect(all).not.toContain(seedHex);
      expect(all).not.toContain(seedB64);
      expect(all).not.toContain(readFileSync(k, 'utf8').split('\n')[1]!);
    }
  });
});
