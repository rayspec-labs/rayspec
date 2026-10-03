/**
 * `rayspec export` and `rayspec resume` before they reach a database: the flags and codes against
 * the contract's verb definitions, every argument refusal, the state directory and output checks
 * that run before any configuration is read, the confirmation that must be possible before anything
 * is read from the source, and the terminal prompt. Every envelope validates against the contract's
 * envelope schema. The database-backed suite (`export.db.test.ts`) runs the verbs end to end.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { inspectBundle } from '@rayspec/bundle';
import { type ApplicationManifest, schemaValidator } from '@rayspec/bundle-contract';
import {
  EXPORT_LOCK_NAME,
  ExportReceiptLog,
  exportReceiptName,
  isAgeX25519Recipient,
  openStateDirectory,
} from '@rayspec/server';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askConfirmation,
  EXPORT_ARG_OPTIONS,
  EXPORT_ERROR_CODES,
  type ExportOutcome,
  parseExportArgs,
  runExport,
} from './export.js';
import { runPack } from './pack.js';
import { RESUME_ARG_OPTIONS, RESUME_ERROR_CODES, runResume } from './resume.js';
import { CONTRACT_ROOT } from './test-support/bundles.js';

const valid = schemaValidator('resultEnvelope');

interface ContractVerb {
  verb: string;
  flags: { flag: string; value: string | null; required: boolean }[];
  errors: string[];
}
const verbs = (
  JSON.parse(readFileSync(join(CONTRACT_ROOT, 'contract', 'cli-verbs.json'), 'utf8')) as {
    verbs: ContractVerb[];
  }
).verbs;
const exportVerb = verbs.find((v) => v.verb === 'rayspec export')!;
const resumeVerb = verbs.find((v) => v.verb === 'rayspec resume')!;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    // A staged version directory is read-only.
    spawnSync('chmod', ['-R', 'u+w', d]);
    rmSync(d, { recursive: true, force: true });
  }
});
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

let recipient = '';
beforeAll(async () => {
  recipient = await identityToRecipient(await generateX25519Identity());
});

const DEPLOYMENT = 'abcdef0123456789';

/** A state directory holding one deployment record, mode 0700. */
function stateDirWith(deploymentId = DEPLOYMENT): string {
  const root = temp('rayspec-export-cli-');
  const state = join(root, '.rayspec-state');
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(
    join(state, 'deployment.json'),
    `${JSON.stringify({
      applicationId: 'field-notes',
      createdAt: '2026-10-01T10:00:00Z',
      deploymentFormatVersion: 1,
      deploymentId,
    })}\n`,
    { mode: 0o600 },
  );
  return state;
}

function args(over: Record<string, string | null> = {}, state = stateDirWith()): string[] {
  const values: Record<string, string | null> = {
    '--deployment': DEPLOYMENT,
    '--state-dir': state,
    '--recipient': recipient,
    '--output': join(temp('rayspec-export-out-'), 'migration.ray'),
    '--run-history': 'included',
    '--confirm-quiesce': null,
    ...over,
  };
  const out: string[] = [];
  for (const [flag, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === null) out.push(flag);
    else if (value !== '<omit>') out.push(flag, value);
  }
  return out;
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<ExportOutcome> {
  const outcome = await runExport(argv, {
    operationId: randomUUID(),
    json: true,
    env,
    terminal: null,
    progress: () => {},
  });
  expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
  return outcome;
}

const first = (o: { envelope: { errors: { code: string; reason?: string }[] } }) =>
  `${o.envelope.errors[0]?.code ?? 'ok'}${o.envelope.errors[0]?.reason ? `/${o.envelope.errors[0].reason}` : ''}`;

describe('the verbs against their contract definitions', () => {
  it('export knows exactly the flags the contract defines', () => {
    const contract = exportVerb.flags.map((f) => f.flag).filter((f) => f !== '--json');
    expect(
      Object.keys(EXPORT_ARG_OPTIONS)
        .map((f) => `--${f}`)
        .sort(),
    ).toEqual(contract.sort());
    for (const f of exportVerb.flags) {
      if (f.flag === '--json') continue;
      const option = EXPORT_ARG_OPTIONS[f.flag.slice(2) as keyof typeof EXPORT_ARG_OPTIONS];
      expect(option.type, f.flag).toBe(f.value === null ? 'boolean' : 'string');
    }
  });

  it('resume knows exactly the flags the contract defines', () => {
    const contract = resumeVerb.flags.map((f) => f.flag).filter((f) => f !== '--json');
    expect(
      Object.keys(RESUME_ARG_OPTIONS)
        .map((f) => `--${f}`)
        .sort(),
    ).toEqual(contract.sort());
  });

  it('export reports exactly the codes the contract lists', () => {
    expect([...EXPORT_ERROR_CODES].sort()).toEqual([...exportVerb.errors].sort());
  });

  it('resume reports exactly the codes the contract lists', () => {
    expect([...RESUME_ERROR_CODES].sort()).toEqual([...resumeVerb.errors].sort());
  });
});

describe('the arguments', () => {
  const parse = (argv: string[]) => {
    try {
      return parseExportArgs(argv, isAgeX25519Recipient);
    } catch (e) {
      return (e as { errors?: { code: string; path?: string }[] }).errors?.[0];
    }
  };

  it('parses a complete command line, with the default state directory and deadline', () => {
    expect(
      parse([
        '--deployment',
        DEPLOYMENT,
        '--recipient',
        recipient,
        '--output',
        'out.ray',
        '--run-history',
        'excluded',
        '--source-stopped',
      ]),
    ).toEqual({
      deploymentId: DEPLOYMENT,
      stateDir: '.rayspec-state',
      recipient,
      output: 'out.ray',
      runHistoryPolicy: 'excluded',
      confirmQuiesce: false,
      quiesceDeadlineSeconds: 300,
      sourceStopped: true,
    });
  });

  it('refuses each missing or malformed argument with RAY_USAGE at its path', () => {
    const base = [
      '--deployment',
      DEPLOYMENT,
      '--recipient',
      recipient,
      '--output',
      'o.ray',
      '--run-history',
      'included',
    ];
    const without = (flag: string) => {
      const at = base.indexOf(flag);
      return [...base.slice(0, at), ...base.slice(at + 2)];
    };
    expect(parse(without('--deployment'))).toMatchObject({
      code: 'RAY_USAGE',
      path: '/deployment',
    });
    expect(parse(without('--recipient'))).toMatchObject({ code: 'RAY_USAGE', path: '/recipient' });
    expect(parse(without('--output'))).toMatchObject({ code: 'RAY_USAGE', path: '/output' });
    expect(parse(without('--run-history'))).toMatchObject({
      code: 'RAY_USAGE',
      path: '/run-history',
    });
    expect(parse([...without('--run-history'), '--run-history', 'redacted'])).toMatchObject({
      path: '/run-history',
    });
    expect(parse([...base, '--quiesce-deadline', '0'])).toMatchObject({
      path: '/quiesce-deadline',
    });
    expect(parse([...base, '--quiesce-deadline', '86401'])).toMatchObject({
      path: '/quiesce-deadline',
    });
    expect(parse([...base, '--quiesce-deadline', '12s'])).toMatchObject({
      path: '/quiesce-deadline',
    });
    expect(parse([...base, '--quiesce-deadline', '86400'])).toMatchObject({
      quiesceDeadlineSeconds: 86400,
    });
    expect(parse([...base, '--passphrase', 'x'])).toMatchObject({ code: 'RAY_USAGE' });
    expect(parse([...base, 'extra'])).toMatchObject({ code: 'RAY_USAGE' });
    expect(parse([...without('--deployment'), '--deployment', 'Not_An_Id'])).toMatchObject({
      path: '/deployment',
    });
  });

  it('refuses every recipient that is not an age X25519 recipient', async () => {
    const identity = await generateX25519Identity();
    for (const bad of [
      identity,
      recipient.toUpperCase(),
      `${recipient.slice(0, -1)}${recipient.endsWith('q') ? 'p' : 'q'}`,
      'a passphrase of several words',
      `age1pq1${recipient.slice(4)}`,
    ]) {
      const refused = parse([
        '--deployment',
        DEPLOYMENT,
        '--recipient',
        bad,
        '--output',
        'o.ray',
        '--run-history',
        'included',
      ]);
      expect(refused, bad.slice(0, 10)).toMatchObject({ code: 'RAY_USAGE', path: '/recipient' });
    }
  });
});

describe('the checks before the source is read', () => {
  it("refuses a deployment id that is not the state directory's (RAY_USAGE)", async () => {
    const outcome = await run(args({ '--deployment': '0123456789abcdef' }));
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.path).toBe('/deployment');
  });

  it('refuses a missing state directory and one open to others', async () => {
    expect(first(await run(args({ '--state-dir': join(temp('rayspec-none-'), 'absent') })))).toBe(
      'RAY_USAGE',
    );
    const open = stateDirWith();
    chmodSync(open, 0o755);
    expect(first(await run(args({}, open)))).toBe('RAY_BINDINGS_FILE_INSECURE');
  });

  it('refuses an output that exists, and one whose directory does not', async () => {
    const out = join(temp('rayspec-export-out-'), 'taken.ray');
    writeFileSync(out, 'kept');
    expect(first(await run(args({ '--output': out })))).toBe('RAY_OUTPUT_EXISTS');
    expect(readFileSync(out, 'utf8')).toBe('kept');
    expect(first(await run(args({ '--output': join(temp('rayspec-x-'), 'no', 'dir.ray') })))).toBe(
      'RAY_USAGE',
    );
  });

  it('refuses without --confirm-quiesce when there is no terminal or --json, before any configuration is read', async () => {
    const outcome = await run(args({ '--confirm-quiesce': '<omit>' }));
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.path).toBe('/confirm-quiesce');
  });

  it('refuses --json without --confirm-quiesce even at a terminal, and asks nothing', async () => {
    const output = new PassThrough();
    let shown = '';
    output.on('data', (c: Buffer) => {
      shown += c.toString('utf8');
    });
    const outcome = await runExport(args({ '--confirm-quiesce': '<omit>' }), {
      operationId: randomUUID(),
      json: true,
      env: {},
      terminal: { input: new PassThrough(), output },
      progress: () => {},
    });
    expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.path).toBe('/confirm-quiesce');
    expect(shown).toBe('');
  });

  it('refuses without DATABASE_URL, reading no .env file', async () => {
    const outcome = await run(args());
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.message).toContain('DATABASE_URL');
  });

  it('refuses a RAYSPEC_PG_DUMP that is not an absolute path', async () => {
    const outcome = await run(args(), {
      DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
      RAYSPEC_BLOB_ROOT: temp('rayspec-blobs-'),
      RAYSPEC_PG_DUMP: 'pg_dump',
    });
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(outcome.envelope.errors[0]?.message).toContain('RAYSPEC_PG_DUMP');
  });

  it("resume refuses a deployment id that is not the state directory's, and a bad epoch", async () => {
    const state = stateDirWith();
    const resume = async (argv: string[]) => {
      const outcome = await runResume(argv, { operationId: randomUUID(), json: true, env: {} });
      expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
      return outcome;
    };
    expect(
      first(
        await resume([
          '--deployment',
          'ffff0123456789ab',
          '--fence-epoch',
          '1',
          '--state-dir',
          state,
        ]),
      ),
    ).toBe('RAY_USAGE');
    expect(
      first(
        await resume(['--deployment', DEPLOYMENT, '--fence-epoch', '-1', '--state-dir', state]),
      ),
    ).toBe('RAY_USAGE');
    expect(first(await resume(['--deployment', DEPLOYMENT, '--state-dir', state]))).toBe(
      'RAY_USAGE',
    );
    // A well-formed request still needs DATABASE_URL from the environment.
    expect(
      first(await resume(['--deployment', DEPLOYMENT, '--fence-epoch', '1', '--state-dir', state])),
    ).toBe('RAY_USAGE');
  });
});

describe('the confirmation at the terminal', () => {
  async function answer(text: string | null): Promise<{ confirmed: boolean; shown: string }> {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (c: Buffer) => {
      shown += c.toString('utf8');
    });
    const asked = askConfirmation({ input, output }, ['the plan', 'line two']);
    if (text === null) input.end();
    else input.write(`${text}\n`);
    return { confirmed: await asked, shown };
  }

  it('shows the plan and accepts yes only', async () => {
    const yes = await answer('yes');
    expect(yes.confirmed).toBe(true);
    expect(yes.shown).toContain('the plan\nline two\n');
    expect((await answer('  YES ')).confirmed).toBe(true);
    expect((await answer('y')).confirmed).toBe(false);
    expect((await answer('')).confirmed).toBe(false);
    expect((await answer(null)).confirmed).toBe(false);
  });

  it('is abandoned when the signal aborts', async () => {
    const controller = new AbortController();
    const asked = askConfirmation(
      { input: new PassThrough(), output: new PassThrough() },
      ['plan'],
      controller.signal,
    );
    controller.abort();
    await expect(asked).rejects.toThrow();
  });
});

// ─── the deployed application and its blobs ──────────────────────────────────────────────────────

/**
 * A state directory whose active version is a packed application, with or without an extension.
 * Where an extension's application keeps its blobs is what its boot recorded in the database, so
 * without a reachable database the export cannot tell.
 */
async function deployedStateDir(withExtension: boolean): Promise<string> {
  const source = temp('rayspec-export-app-');
  const files: Record<string, string> = {
    'rayspec.yaml':
      "version: '1.0'\nmetadata:\n  name: probe\n  id: probe-app\n  version: '1.0.0'\n" +
      (withExtension ? 'extensions:\n  - { id: ext, module: ./ext, version: 1.0.0 }\n' : ''),
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
  };
  if (withExtension) {
    files['ext/package.json'] = JSON.stringify({ name: 'ext', version: '1.0.0', type: 'module' });
    files['ext/index.js'] = 'export default {};\n';
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  const bundle = join(source, 'app.ray');
  const packed = await runPack(['--spec', join(source, 'rayspec.yaml'), '--output', bundle], {
    operationId: randomUUID(),
    cliVersion: '1.8.0',
  });
  expect(packed.envelope.ok, JSON.stringify(packed.envelope.errors)).toBe(true);
  const inspected = await inspectBundle(bundle);
  if (!inspected.ok) throw new Error(JSON.stringify(inspected.errors));
  const state = stateDirWith();
  const dir = await openStateDirectory(state, { create: false });
  if (dir === null) throw new Error('no state directory');
  const sha256 = inspected.value.archiveSha256;
  await dir.stageVersion(bundle, sha256, inspected.value.manifest as ApplicationManifest);
  await dir.writeActive({
    bundleSha256: sha256,
    activatedAt: '2026-10-01T10:00:00Z',
    environmentRevision: 1,
  });
  return state;
}

describe('the blob store an export reads', () => {
  const unreachable = { DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' };

  it('reads the recorded blob backend of an application that loads an extension, before the scratch space is taken', async () => {
    const state = await deployedStateDir(true);
    for (const blobRoot of [{ RAYSPEC_BLOB_ROOT: temp('rayspec-blobs-') }, {}]) {
      const outcome = await run(args({}, state), { ...unreachable, ...blobRoot });
      // Whatever the blob root, the record decides, and it cannot be read.
      expect(first(outcome)).toBe('RAY_INFRA_UNAVAILABLE');
      expect(outcome.envelope.errors[0]?.message).toContain('environment database');
      expect(existsSync(join(state, 'scratch'))).toBe(false);
    }
  }, 60_000);

  it('reads the fs blob root of an application without an extension', async () => {
    const state = await deployedStateDir(false);
    const outcome = await run(args({}, state), {
      ...unreachable,
      RAYSPEC_BLOB_ROOT: temp('rayspec-blobs-'),
    });
    // Past the blob decision, the unreachable database is what stops it.
    expect(first(outcome)).toBe('RAY_INFRA_UNAVAILABLE');
  }, 60_000);
});

// ─── resume after a killed export ────────────────────────────────────────────────────────────────

describe('resume after an export that was killed', () => {
  it('removes the plaintext the killed export left and closes its receipt, even when it is refused afterwards', async () => {
    const state = stateDirWith();
    const dir = await openStateDirectory(state, { create: false });
    if (dir === null) throw new Error('no state directory');
    const killed = randomUUID();
    const log = ExportReceiptLog.start(dir, killed, {
      deploymentId: DEPLOYMENT,
      recipient,
      runHistoryPolicy: 'included',
      sourceStopped: false,
      quiesceDeadlineSeconds: 300,
    });
    await log.transition('PRECHECK', { fenceEpoch: 2, fenceState: 'open', recovery: 'none' });
    await log.transition('QUIESCING', { fenceEpoch: 2, fenceState: 'open', recovery: 'r' });
    const scratch = await dir.scratchDirectory();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(scratch, EXPORT_LOCK_NAME),
      JSON.stringify({ pid: Number(dead.stdout), operationId: killed }),
    );
    mkdirSync(join(scratch, 'rayspec-snapshot-left'), { mode: 0o700 });
    writeFileSync(join(scratch, 'rayspec-snapshot-left', 'objects.bin'), 'bytes of an upload');

    const lines: string[] = [];
    const resumer = randomUUID();
    const outcome = await runResume(
      ['--deployment', DEPLOYMENT, '--fence-epoch', '3', '--state-dir', state],
      { operationId: resumer, json: true, env: {}, progress: (line) => lines.push(line) },
    );
    expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
    // No DATABASE_URL: the fence is not touched, but the plaintext is gone already.
    expect(first(outcome)).toBe('RAY_USAGE');
    expect(readdirSync(scratch)).toEqual([]);
    expect(lines.join('\n')).toContain(`interrupted export (${killed})`);
    const receipt = JSON.parse(
      readFileSync(join(state, 'receipts', `${exportReceiptName(killed)}.json`), 'utf8'),
    ) as { outcome: string; transitions: { state: string; closedBy?: string }[] };
    expect(receipt.outcome).toBe('blocked');
    expect(receipt.transitions.at(-1)).toMatchObject({ state: 'BLOCKED', closedBy: resumer });
  });
});
