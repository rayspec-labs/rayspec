/**
 * `--json` on the existing commands.
 *
 * Without the flag an existing command writes exactly what it always has. With it, the command's
 * own result object is carried unchanged in `data` of one result envelope, with the warning
 * `RAY_W_LEGACY_OUTPUT`; spec errors become `SPEC_` codes, every other error `RAY_CHECK_FAILED`, a
 * usage error `RAY_USAGE`; the exit code is the one the command has without the flag; and stderr
 * carries the operation id.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';
import { main, run } from './index.js';
import { captureOutput, type ParsedJson } from './test-support/bundles.js';

const valid = schemaValidator('resultEnvelope');

const VALID_SPEC = `
version: '1.0'
metadata:
  name: json-output-test
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

let dir: string;
let prevCwd: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-json-output-'));
  writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
  writeFileSync(join(dir, 'bad.yaml'), "version: '1.0'\nmetadata: { name: x }\nbogus: 1\n", 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});
afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

let io: ReturnType<typeof captureOutput>;
beforeEach(() => {
  io = captureOutput();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function envelopeOnStdout(): ParsedJson {
  const parsed = JSON.parse(io.out());
  expect(valid(parsed), JSON.stringify(valid.errors)).toBe(true);
  expect(io.err().split('\n')[0]).toBe(`operationId: ${parsed.operationId}`);
  return parsed;
}

describe('without --json nothing changes', () => {
  it('doctor writes its own result, byte for byte, and nothing on stderr', async () => {
    expect(await main(['doctor', 'rayspec.yaml'])).toBe(0);
    const direct = await runDoctor(['rayspec.yaml']);
    expect(io.out()).toBe(`${JSON.stringify(direct, null, 2)}\n`);
    expect(io.err()).toBe('');
  });

  it('a --json after the -- terminator is an argument, not the flag', async () => {
    await main(['doctor', '--', '--json']);
    expect(JSON.parse(io.out())).not.toHaveProperty('contractVersion');
  });
});

describe('--json on an existing command', () => {
  it('a valid spec: the result unchanged in data, the legacy warning, exit 0', async () => {
    expect(await main(['doctor', 'rayspec.yaml', '--json'])).toBe(0);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('doctor');
    expect(env.ok).toBe(true);
    expect(env.data).toEqual(JSON.parse(JSON.stringify(await runDoctor(['rayspec.yaml']))));
    expect(env.warnings.map((w: { code: string }) => w.code)).toEqual(['RAY_W_LEGACY_OUTPUT']);
  });

  it('the flag may stand anywhere before the terminator', async () => {
    expect(await main(['--json', 'doctor', 'rayspec.yaml'])).toBe(0);
    expect(envelopeOnStdout().operation).toBe('doctor');
  });

  it('an invalid spec: SPEC_ codes with their paths, exit 1 as without the flag', async () => {
    expect(await main(['doctor', 'bad.yaml', '--json'])).toBe(1);
    const env = envelopeOnStdout();
    expect(env.ok).toBe(false);
    expect(env.errors[0]).toMatchObject({ code: 'SPEC_UNKNOWN_FIELD', path: 'bogus' });
    expect(env.data.ok).toBe(false);
  });

  it('plan reports under its own operation', async () => {
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      expect(await main(['plan', 'rayspec.yaml', '--json'])).toBe(0);
      expect(envelopeOnStdout().operation).toBe('plan');
    } finally {
      if (prev !== undefined) process.env.SHADOW_DATABASE_URL = prev;
    }
  });

  it('deploy --dry-run is deploy.legacy; its string errors become RAY_CHECK_FAILED', async () => {
    expect(await main(['deploy', '--dry-run', 'bad.yaml', '--json'])).toBe(1);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('deploy.legacy');
    expect(env.errors.length).toBeGreaterThan(0);
    for (const e of env.errors) expect(e.code).toBe('RAY_CHECK_FAILED');
    expect(env.data.mode).toBe('dry-run');
  });

  it('--version wraps the version object', async () => {
    expect(await main(['--version', '--json'])).toBe(0);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('version');
    expect(env.data).toMatchObject({ ok: true });
    expect(typeof env.data.version).toBe('string');
  });

  it('--help wraps the help text', async () => {
    expect(await main(['doctor', '--help', '--json'])).toBe(0);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('help');
    expect(env.data.text).toContain('rayspec doctor <spec.yaml>');
  });

  it('a usage error is RAY_USAGE, exit 2, with the envelope on stdout and no usage text', async () => {
    expect(await main(['doctor', '--nope', 'rayspec.yaml', '--json'])).toBe(2);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('doctor');
    expect(env.errors[0].code).toBe('RAY_USAGE');
    expect(env.data).toBeNull();
    expect(io.err()).not.toContain('rayspec — RaySpec CLI');
  });

  it('an unknown command is RAY_USAGE under help', async () => {
    expect(await main(['frobnicate', '--json'])).toBe(2);
    const env = envelopeOnStdout();
    expect(env.operation).toBe('help');
    expect(env.errors[0].code).toBe('RAY_USAGE');
  });

  it('through run(): the exit code is the one main returns', async () => {
    const prev = process.exitCode;
    try {
      await run(['doctor', 'bad.yaml', '--json']);
      expect(process.exitCode).toBe(1);
      envelopeOnStdout();
    } finally {
      process.exitCode = prev;
    }
  });
});
