/**
 * `rayspec export` and `rayspec resume` before they reach a database: the flags and codes against
 * the contract's verb definitions, every argument refusal, the state directory and output checks
 * that run before any configuration is read, the confirmation that must be possible before anything
 * is read from the source, and the terminal prompt. Every envelope validates against the contract's
 * envelope schema. The database-backed suite (`export.db.test.ts`) runs the verbs end to end.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { schemaValidator } from '@rayspec/bundle-contract';
import { isAgeX25519Recipient } from '@rayspec/server';
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
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

  it('export reports every code the contract lists, and the preflight codes it adds', () => {
    for (const code of exportVerb.errors)
      expect(EXPORT_ERROR_CODES.has(code as never), code).toBe(true);
    const added = [...EXPORT_ERROR_CODES].filter((c) => !exportVerb.errors.includes(c)).sort();
    expect(added).toEqual([
      'RAY_DIGEST_MISMATCH',
      'RAY_FENCE_MISMATCH',
      'RAY_POLICY_DENIED',
      'RAY_RUNTIME_UNSUPPORTED',
      'RAY_TARGET_UNSUPPORTED',
    ]);
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
