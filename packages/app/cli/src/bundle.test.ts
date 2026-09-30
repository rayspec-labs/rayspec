/**
 * `rayspec bundle inspect` and `rayspec bundle verify` against the golden corpus and against the
 * failure paths of their own arguments.
 *
 * Every corpus case with an inspect or verify expectation runs through `main`, the CLI body, and
 * gives exactly the envelope and exit code it states: `ok`, the verdict, `errors[0].code` and
 * `.reason`, and the exit class. Every envelope is checked against the contract's envelope schema.
 * Two kinds of case need what a command line cannot say: one verify case names a runtime that lacks
 * a capability the running CLI provides, and the limit cases lower a reader limit so a small archive
 * reaches it. Those run through `runBundle`, the verb body `main` calls, with that runtime profile or
 * those limits.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliRuntimeProfile, runBundle } from './bundle.js';
import { envelopeExitCode } from './envelope.js';
import { main } from './index.js';
import {
  baseFilesOf,
  bundleEntries,
  type CaseExpectation,
  type CorpusCase,
  captureOutput,
  casePath,
  corpusFile,
  loadExpectations,
  type ParsedJson,
  rawZip,
  testSigner,
  writePublicKeyPem,
} from './test-support/bundles.js';

const expectations = loadExpectations();
const validEnvelope = schemaValidator('resultEnvelope');
const work = mkdtempSync(join(tmpdir(), 'rayspec-cli-bundle-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let io: ReturnType<typeof captureOutput>;
beforeEach(() => {
  io = captureOutput();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The one JSON object on stdout; parsing the whole stream is the "exactly one object" check. */
function stdoutEnvelope(): ParsedJson {
  const parsed = JSON.parse(io.out());
  expect(validEnvelope(parsed), JSON.stringify(validEnvelope.errors)).toBe(true);
  return parsed;
}

/** What an envelope says, in the terms of an expectation. */
function outcomeOf(envelope: ParsedJson, exit: number) {
  const first = envelope.errors[0];
  return {
    ok: envelope.ok,
    verdict:
      envelope.data?.verdict ??
      (envelope.operation === 'bundle.inspect' ? 'invalid' : 'not-deployable'),
    code: first?.code,
    reason: first?.reason,
    exit,
  };
}

function expected(e: CaseExpectation) {
  return { ok: e.ok, verdict: e.verdict, code: e.code, reason: e.reason, exit: e.exit };
}

const trustedKeyFiles = new Map<string, string>();
function trustedKeyArgs(c: CorpusCase): string[] {
  return (c.construction.trustedSignerSeeds ?? []).flatMap((seed) => {
    let path = trustedKeyFiles.get(seed);
    if (path === undefined) {
      path = writePublicKeyPem(work, `signer-${trustedKeyFiles.size}`, testSigner(seed).publicKey);
      trustedKeyFiles.set(seed, path);
    }
    return ['--trusted-key', path];
  });
}

/**
 * Run one case: through `main` when the command line can express it, else through `runBundle` with
 * the case's lowered limits or narrower runtime.
 */
async function runCase(
  args: string[],
  c: CorpusCase,
  profile = 'fixture',
): Promise<{ envelope: ParsedJson; exit: number }> {
  const limits = (c.construction as { readerLimits?: Record<string, number> }).readerLimits;
  if (limits === undefined && profile !== 'without-static-frontend') {
    const exit = await main(['bundle', ...args]);
    return { envelope: stdoutEnvelope(), exit };
  }
  const outcome = await runBundle(args, {
    operationId: '00000000-0000-4000-8000-000000000000',
    cliVersion: '0.0.0',
    readerLimits: limits,
    runtimeProfile: (v) => {
      const full = cliRuntimeProfile(v);
      if (profile !== 'without-static-frontend') return full;
      return { ...full, capabilities: full.capabilities.filter((id) => id !== 'static-frontend') };
    },
  });
  expect(validEnvelope(outcome.envelope), JSON.stringify(validEnvelope.errors)).toBe(true);
  return { envelope: outcome.envelope as never, exit: envelopeExitCode(outcome.envelope) };
}

const casesFor = (operation: CaseExpectation['operation']) =>
  expectations.cases.flatMap((c) => {
    const e = c.expect.find((x) => x.operation === operation);
    return e === undefined ? [] : [[c.id, c, e] as const];
  });

describe('bundle inspect — every corpus case', () => {
  const cases = casesFor('bundle.inspect');

  it('covers the corpus', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it.each(cases)('%s', async (_id, c, e) => {
    const args = ['inspect', casePath(expectations, c, work)];
    const { envelope, exit } = await runCase(args, c);
    expect(envelope.operation).toBe('bundle.inspect');
    expect(outcomeOf(envelope, exit)).toEqual(expected(e));
    if (!envelope.ok) expect(envelope.data).toBeNull();
  });
});

describe('bundle verify — every corpus case', () => {
  const cases = casesFor('bundle.verify');

  it('covers the corpus, including the spec, secret and signature steps', () => {
    const codes = new Set(cases.map(([, , e]) => e.code));
    for (const code of [
      'RAY_SPEC_INVALID',
      'RAY_MANIFEST_INVALID',
      'RAY_RUNTIME_UNSUPPORTED',
      'RAY_TARGET_UNSUPPORTED',
      'RAY_CAPABILITY_UNSUPPORTED',
      'RAY_BINDING_RESERVED',
      'RAY_SECRET_DETECTED',
      'RAY_SIGNATURE_INVALID',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it.each(cases)('%s', async (_id, c, e) => {
    const profile = e.runtimeProfile ?? 'fixture';
    const version = expectations.runtimeProfiles[profile]!.version;
    const args = ['verify', casePath(expectations, c, work), '--runtime', version];
    args.push(...trustedKeyArgs(c));
    const { envelope, exit } = await runCase(args, c, profile);
    expect(envelope.operation).toBe('bundle.verify');
    expect(outcomeOf(envelope, exit)).toEqual(expected(e));
    if (envelope.data !== null) expect(envelope.data.checkedAgainstRuntime).toBe(version);
  });

  it('a spec the grammar refuses lists its SPEC_ codes after RAY_SPEC_INVALID', async () => {
    const c = expectations.cases.find((x) => x.id === 'spec-invalid')!;
    const exit = await main([
      'bundle',
      'verify',
      corpusFile(c),
      '--runtime',
      '0.0.0-contract-fixture',
    ]);
    expect(exit).toBe(1);
    const codes = stdoutEnvelope().errors.map((e: { code: string }) => e.code);
    expect(codes).toEqual(['RAY_SPEC_INVALID', 'SPEC_SCHEMA_VIOLATION', 'SPEC_UNKNOWN_FIELD']);
  });

  it.each([
    ['a YAML syntax error', 'version: "1.0"\nmetadata:\n  db_password: "hunter2-SECRET-VALUE" [\n'],
    ['an unsupported version', 'version: "hunter2-SECRET-VALUE"\n'],
    ['a schema violation', 'version: "1.0"\nmetadata:\n  name: ["hunter2-SECRET-VALUE"]\n'],
  ])('a spec error from %s never repeats the spec text', async (_label, spec) => {
    const files = baseFilesOf(expectations);
    files.set('payload/rayspec.yaml', Buffer.from(spec));
    const archive = join(work, 'spec-echo.ray');
    writeFileSync(archive, rawZip(bundleEntries(expectations as never, { files })));
    const exit = await main(['bundle', 'verify', archive, '--runtime', '0.0.0-contract-fixture']);
    expect(exit).toBe(1);
    const envelope = stdoutEnvelope();
    expect(envelope.errors[0].code).toBe('RAY_SPEC_INVALID');
    expect(envelope.errors[1].code).toMatch(/^SPEC_/);
    expect(io.out() + io.err()).not.toContain('hunter2');
  });

  it('a spec syntax error keeps its line and column', async () => {
    const files = baseFilesOf(expectations);
    files.set('payload/rayspec.yaml', Buffer.from('version: "1.0"\nmetadata:\n  x: "y" [\n'));
    const archive = join(work, 'spec-position.ray');
    writeFileSync(archive, rawZip(bundleEntries(expectations as never, { files })));
    await main(['bundle', 'verify', archive, '--runtime', '0.0.0-contract-fixture']);
    expect(stdoutEnvelope().errors[1]).toMatchObject({
      code: 'SPEC_YAML_PARSE_ERROR',
      message: expect.stringMatching(
        /^the spec breaks the yaml parse error rule at line 3, column \d+$/,
      ),
    });
  });

  it('a secret finding names the path and never the content', async () => {
    const c = expectations.cases.find((x) => x.id === 'secret-private-key-pem')!;
    await main(['bundle', 'verify', corpusFile(c), '--runtime', '0.0.0-contract-fixture']);
    const envelope = stdoutEnvelope();
    expect(envelope.errors[0].path).toMatch(/^payload\//);
    expect(io.out() + io.err()).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('a verified signature reports the key it verified with', async () => {
    const c = expectations.cases.find((x) => x.id === 'signature-good')!;
    const exit = await main([
      'bundle',
      'verify',
      corpusFile(c),
      '--runtime',
      '0.0.0-contract-fixture',
      ...trustedKeyArgs(c),
    ]);
    expect(exit).toBe(0);
    const { data, warnings } = stdoutEnvelope();
    expect(data.signature.verified).toBe(true);
    expect(data.signature.publicKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(warnings).toEqual([]);
  });
});

describe('bundle verify — runtime and signature choices', () => {
  const good = corpusFile(expectations.cases.find((x) => x.id === 'app-good-minimal')!);

  it("defaults to the running CLI's own version, which the fixture does not pin", async () => {
    const exit = await main(['bundle', 'verify', good]);
    expect(exit).toBe(3);
    const envelope = stdoutEnvelope();
    expect(envelope.errors[0].code).toBe('RAY_RUNTIME_UNSUPPORTED');
    expect(envelope.data.checkedAgainstRuntime).not.toBe('0.0.0-contract-fixture');
  });

  it('an unsigned bundle passes with RAY_W_UNSIGNED, and fails under --require-signature', async () => {
    expect(await main(['bundle', 'verify', good, '--runtime', '0.0.0-contract-fixture'])).toBe(0);
    expect(stdoutEnvelope().warnings.map((w: { code: string }) => w.code)).toEqual([
      'RAY_W_UNSIGNED',
    ]);
    io = captureOutput();
    const exit = await main([
      'bundle',
      'verify',
      good,
      '--runtime',
      '0.0.0-contract-fixture',
      '--require-signature',
    ]);
    expect(exit).toBe(4);
    const envelope = stdoutEnvelope();
    expect(envelope.errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'malformed',
    });
    expect(envelope.data.verdict).toBe('not-deployable');
  });

  it('--signature names the signature file; one that cannot be read is malformed', async () => {
    const signed = expectations.cases.find((x) => x.id === 'signature-good')!;
    const copy = join(work, 'moved.ray');
    writeFileSync(copy, await import('node:fs').then((fs) => fs.readFileSync(corpusFile(signed))));
    const keys = trustedKeyArgs(signed);
    expect(
      await main(['bundle', 'verify', copy, '--runtime', '0.0.0-contract-fixture', ...keys]),
    ).toBe(0);
    // Without the file next to it the bundle is unsigned; --signature points at it.
    expect(stdoutEnvelope().data.signature.present).toBe(false);
    io = captureOutput();
    const withSig = [
      copy,
      '--runtime',
      '0.0.0-contract-fixture',
      '--signature',
      `${corpusFile(signed)}.sig`,
    ];
    expect(await main(['bundle', 'verify', ...withSig, ...keys])).toBe(0);
    expect(stdoutEnvelope().data.signature.verified).toBe(true);
    io = captureOutput();
    const missing = [
      copy,
      '--runtime',
      '0.0.0-contract-fixture',
      '--signature',
      join(work, 'none.sig'),
    ];
    expect(await main(['bundle', 'verify', ...missing, ...keys])).toBe(4);
    expect(stdoutEnvelope().errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'malformed',
    });
  });

  it('a signed bundle with no trusted key is refused as untrusted', async () => {
    const signed = corpusFile(expectations.cases.find((x) => x.id === 'signature-good')!);
    expect(await main(['bundle', 'verify', signed, '--runtime', '0.0.0-contract-fixture'])).toBe(4);
    expect(stdoutEnvelope().errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'untrusted-key',
    });
  });
});

describe('arguments', () => {
  const good = corpusFile(expectations.cases.find((x) => x.id === 'app-good-minimal')!);

  const usage: [string, string[]][] = [
    ['inspect: an unknown flag', ['inspect', '--nope', good]],
    ['inspect: no file', ['inspect']],
    ['inspect: two files', ['inspect', good, good]],
    ['inspect: a verify flag', ['inspect', good, '--runtime', '1.0.0']],
    ['verify: an unknown flag', ['verify', good, '--frobnicate']],
    ['verify: no file', ['verify', '--runtime', '1.0.0']],
    ['verify: a range as the runtime', ['verify', good, '--runtime', '^1.0.0']],
    ['verify: latest as the runtime', ['verify', good, '--runtime', 'latest']],
    ['verify: build metadata in the runtime', ['verify', good, '--runtime', '1.0.0+build.1']],
    ['verify: a partial runtime', ['verify', good, '--runtime', '1.0']],
    ['verify: a runtime with no value', ['verify', good, '--runtime']],
    [
      'verify: a trusted key that does not exist',
      ['verify', good, '--trusted-key', join(work, 'no.pem')],
    ],
    ['verify: an empty --signature', ['verify', good, '--signature', '']],
  ];

  it.each(usage)('%s is RAY_USAGE, exit 2, with the envelope on stdout', async (_label, args) => {
    const exit = await main(['bundle', ...args]);
    expect(exit).toBe(2);
    const envelope = stdoutEnvelope();
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0].code).toBe('RAY_USAGE');
    expect(envelope.data).toBeNull();
    expect(envelope.operation).toBe(args[0] === 'verify' ? 'bundle.verify' : 'bundle.inspect');
  });

  it('a trusted key that is a private key, or not Ed25519, is refused without echoing it', async () => {
    const privatePem = join(work, 'private.pem');
    writeFileSync(
      privatePem,
      testSigner('a private key given by mistake').privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }),
    );
    const rsaLike = join(work, 'not-a-key.pem');
    writeFileSync(rsaLike, '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n');
    for (const key of [privatePem, rsaLike]) {
      io = captureOutput();
      expect(await main(['bundle', 'verify', good, '--trusted-key', key])).toBe(2);
      expect(stdoutEnvelope().errors[0].code).toBe('RAY_USAGE');
      expect(io.out() + io.err()).not.toContain('AAAA');
      expect(io.out() + io.err()).not.toContain('BEGIN PRIVATE');
    }
  });

  it('a trusted key file larger than a key file is refused, even when it starts with a key', async () => {
    const padded = join(work, 'padded.pub.pem');
    const pem = testSigner('a key padded past the size cap').publicKey.export({
      format: 'pem',
      type: 'spki',
    });
    writeFileSync(padded, `${pem}${'\n'.repeat(20_000)}`);
    const exit = await main([
      'bundle',
      'verify',
      good,
      '--runtime',
      '0.0.0-contract-fixture',
      '--trusted-key',
      padded,
    ]);
    expect(exit).toBe(2);
    expect(stdoutEnvelope().errors[0].code).toBe('RAY_USAGE');
  });

  it('a FIFO as the archive, the signature or a trusted key is answered at once', {
    timeout: 10_000,
  }, async () => {
    const fifo = join(work, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await main(['bundle', 'inspect', fifo])).toBe(2);
    expect(stdoutEnvelope().errors[0].code).toBe('RAY_USAGE');
    io = captureOutput();
    const runtime = ['--runtime', '0.0.0-contract-fixture'];
    expect(await main(['bundle', 'verify', good, ...runtime, '--signature', fifo])).toBe(4);
    expect(stdoutEnvelope().errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'malformed',
    });
    io = captureOutput();
    expect(await main(['bundle', 'verify', good, ...runtime, '--trusted-key', fifo])).toBe(2);
    expect(stdoutEnvelope().errors[0].code).toBe('RAY_USAGE');
  });

  it('a file that does not exist is RAY_USAGE', async () => {
    expect(await main(['bundle', 'inspect', join(work, 'absent.ray')])).toBe(2);
    expect(stdoutEnvelope().errors[0].code).toBe('RAY_USAGE');
  });

  it('the group without a subcommand, or with an unknown one, is the usual usage error', async () => {
    await expect(main(['bundle'])).rejects.toThrow(/missing bundle subcommand/);
    await expect(main(['bundle', 'extract', good])).rejects.toThrow(/unknown bundle subcommand/);
    expect(io.out()).toBe('');
  });

  it('with --json the group usage error is an envelope under help', async () => {
    expect(await main(['bundle', '--json'])).toBe(2);
    const envelope = stdoutEnvelope();
    expect(envelope.operation).toBe('help');
    expect(envelope.errors[0].code).toBe('RAY_USAGE');
  });
});

describe('output', () => {
  const good = corpusFile(expectations.cases.find((x) => x.id === 'app-good-minimal')!);

  it('without --json: the envelope on stdout, the operation id and a description on stderr', async () => {
    expect(await main(['bundle', 'inspect', good])).toBe(0);
    const envelope = stdoutEnvelope();
    const err = io.err();
    expect(err.split('\n')[0]).toBe(`operationId: ${envelope.operationId}`);
    expect(envelope.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(err).toContain('format-fixture 0.0.0-contract-fixture');
    expect(err).toContain(envelope.data.sha256);
    expect(err).toContain('structurally valid');
    // It says what the bundle is, never that it is safe.
    expect(err).not.toMatch(/\bsafe\b/i);
  });

  it('with --json: stdout is exactly the envelope and stderr only the operation id', async () => {
    expect(
      await main(['bundle', 'verify', good, '--runtime', '0.0.0-contract-fixture', '--json']),
    ).toBe(0);
    const envelope = stdoutEnvelope();
    expect(io.err()).toBe(`operationId: ${envelope.operationId}\n`);
  });

  it('each invocation takes a fresh operation id', async () => {
    await main(['bundle', 'inspect', good, '--json']);
    const first = stdoutEnvelope().operationId;
    io = captureOutput();
    await main(['bundle', 'inspect', good, '--json']);
    expect(stdoutEnvelope().operationId).not.toBe(first);
  });

  it('a verify description never claims the bundle is safe', async () => {
    expect(await main(['bundle', 'verify', good, '--runtime', '0.0.0-contract-fixture'])).toBe(0);
    stdoutEnvelope();
    expect(io.err()).toContain('deployable');
    expect(io.err()).not.toMatch(/\bsafe\b/i);
  });

  it('inspect reports a signature file next to the archive without checking it', async () => {
    const signed = corpusFile(expectations.cases.find((x) => x.id === 'signature-mismatch')!);
    expect(await main(['bundle', 'inspect', signed, '--json'])).toBe(0);
    expect(stdoutEnvelope().data.signature).toEqual({
      present: true,
      verified: false,
      publicKeySha256: null,
    });
  });
});

describe('--help', () => {
  it('`bundle --help` prints both verbs as plain text, exit 0', async () => {
    expect(await main(['bundle', '--help'])).toBe(0);
    const out = io.out();
    expect(out).toContain('rayspec bundle inspect <file.ray>');
    expect(out).toContain('rayspec bundle verify <file.ray>');
    expect(io.err()).toBe('');
  });

  it('`bundle inspect --help` is scoped to inspect', async () => {
    expect(await main(['bundle', 'inspect', '--help'])).toBe(0);
    expect(io.out()).toContain('rayspec bundle inspect <file.ray> [--json]');
    expect(io.out()).not.toContain('rayspec bundle verify');
  });

  it('`bundle verify --help` names every flag verify accepts', async () => {
    expect(await main(['bundle', 'verify', '--help'])).toBe(0);
    for (const flag of [
      '--runtime',
      '--signature',
      '--trusted-key',
      '--require-signature',
      '--json',
    ]) {
      expect(io.out()).toContain(flag);
    }
    expect(io.out()).not.toMatch(/\bsafe\b/i);
  });

  it('a token after the help flag is refused as for any command', async () => {
    await expect(main(['bundle', 'inspect', '--help', 'x.ray'])).rejects.toThrow(
      /takes no arguments/,
    );
  });

  it('the general usage lists the bundle group', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(io.out()).toContain('PASSIVE bundle commands');
  });
});
