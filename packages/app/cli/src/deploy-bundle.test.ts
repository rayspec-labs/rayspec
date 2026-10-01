/**
 * `rayspec deploy <file.ray>` refusals that come before any database, through the REAL built CLI.
 *
 *  - Dispatch: a `.ray` name in any case, or a file that starts with a ZIP signature whatever its
 *    name, takes the bundle path; every other file takes the YAML deploy, which answers exactly as
 *    before. A `.ray` file that is not a ZIP archive is refused as one.
 *  - Arguments, the bindings file (its permissions, its link, its JSON shape, a duplicate name, a
 *    reserved name, a `_FILE` variant) and the configuration are refused with their contract codes
 *    and exit classes, each in the envelope, which validates against the contract's schema.
 *  - No `.env` file in the working directory is read on this path, and no binding value reaches
 *    stdout or stderr.
 *  - Every flag of the bundle path is in `deploy --help` and in the reference's deploy synopsis.
 *
 * Every refusal here names a database that does not exist, so a deploy that reached for it would
 * answer RAY_INFRA_UNAVAILABLE instead of the refusal the arm expects.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import {
  BUNDLE_DEPLOY_ARG_OPTIONS,
  deployTarget,
  hasBundleSuffix,
  isBundleDeploy,
} from './deploy-bundle.js';
import { runPack } from './pack.js';
import { CLI_DIST, type ParsedJson } from './test-support/bundles.js';

const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
const maybeDescribe = distBuilt ? describe : describe.skip;
const valid = schemaValidator('resultEnvelope');

/** A value that must never appear in any output. */
const CANARY = `sk-canary-${randomUUID()}`;
/** A database nothing listens on: reaching for it would be RAY_INFRA_UNAVAILABLE. */
const NO_DATABASE = 'postgresql://nobody:nothing@127.0.0.1:1/none';

let bundle = '';
let work = '';

beforeAll(async () => {
  const app = temporaryDirectory('deploy-bundle-app-');
  writeTree(app, {
    'rayspec.yaml': backendSpec(
      'stores:\n  - name: probe_notes\n    columns:\n      - { name: body, type: text }\n' +
        "api:\n  - { method: POST, path: '/notes', action: { kind: store, store: probe_notes, op: create } }\n" +
        '  - { method: POST, path: /summarize, action: { kind: agent, agent: summarizer } }\n' +
        'agents:\n  - { id: summarizer, name: summarizer, backend: openai, model: gpt-4o-mini, ' +
        'instructions: Summarize. }\n',
    ),
  });
  work = temporaryDirectory('deploy-bundle-work-');
  bundle = join(work, 'app.ray');
  const packed = await runPack(['--spec', join(app, 'rayspec.yaml'), '--output', bundle], {
    operationId: randomUUID(),
    cliVersion: '1.8.0',
  });
  if (!packed.envelope.ok) throw new Error(JSON.stringify(packed.envelope.errors));
}, 60_000);

afterAll(removeTemporaryDirectories);

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  envelope: ParsedJson;
}

function deploy(args: string[], env: Record<string, string> = {}, cwd = work): Run {
  const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: NO_DATABASE,
      RAYSPEC_API_KEY_PEPPER: 'pepper-for-the-refusal-suite',
      ...env,
    },
  });
  let envelope: ParsedJson = {};
  try {
    envelope = JSON.parse(run.stdout) as ParsedJson;
  } catch {
    envelope = {};
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, envelope };
}

function expectRefusal(run: Run, code: string, exit: number, reason?: string): void {
  expect(run.status, run.stderr).toBe(exit);
  expect(valid(run.envelope), JSON.stringify(valid.errors)).toBe(true);
  expect(run.envelope.ok).toBe(false);
  expect(run.envelope.errors[0].code).toBe(code);
  if (reason !== undefined) expect(run.envelope.errors[0].reason).toBe(reason);
  expect(`${run.stdout}${run.stderr}`).not.toContain(CANARY);
}

function bindingsFile(document: unknown, mode = 0o600): string {
  const path = join(temporaryDirectory('deploy-bindings-'), 'bindings.json');
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
  chmodSync(path, mode);
  return path;
}

describe('dispatch', () => {
  it('finds the file argument past the flags that take a value', () => {
    expect(deployTarget(['--port', '9', 'app.ray'])).toBe('app.ray');
    expect(deployTarget(['--bindings-file', 'b.json', '--dry-run', 'x.yaml'])).toBe('x.yaml');
    expect(deployTarget(['--', '--odd.ray'])).toBe('--odd.ray');
    expect(deployTarget(['--dry-run'])).toBeUndefined();
  });

  it('takes a .ray name in any case, and a ZIP file whatever its name', async () => {
    expect(hasBundleSuffix('APP.RAY')).toBe(true);
    expect(hasBundleSuffix('app.ray.yaml')).toBe(false);
    expect(await isBundleDeploy(['missing.Ray'])).toBe(true);
    const zipNamedYaml = join(temporaryDirectory('dispatch-'), 'spec.yaml');
    writeFileSync(zipNamedYaml, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]));
    expect(await isBundleDeploy([zipNamedYaml])).toBe(true);
    const yaml = join(temporaryDirectory('dispatch-'), 'spec.yaml');
    writeFileSync(yaml, "version: '1.0'\n");
    expect(await isBundleDeploy(['--dry-run', yaml])).toBe(false);
    expect(await isBundleDeploy(['no-such-file.yaml'])).toBe(false);
  });
});

maybeDescribe('rayspec deploy <file.ray> — refused before any database', () => {
  it('refuses a .ray file that is not a ZIP archive', () => {
    const garbage = join(work, 'garbage.ray');
    writeFileSync(garbage, 'this is not an archive\n');
    const run = deploy([garbage, '--dry-run']);
    expectRefusal(run, 'RAY_INVALID_ARCHIVE', 2, 'not-a-zip');
    expect(run.envelope.operation).toBe('deploy.dry-run');
    const deployRun = deploy([garbage]);
    expectRefusal(deployRun, 'RAY_INVALID_ARCHIVE', 2, 'not-a-zip');
    expect(deployRun.envelope.operation).toBe('deploy');
  });

  it('refuses a .ray path it cannot open in the bundle reader words, as bundle verify does', () => {
    const cwd = temporaryDirectory('deploy-missing-');
    const missing = join(cwd, 'nothere.ray');
    for (const args of [[missing, '--dry-run'], [missing]]) {
      const run = deploy(args, {}, cwd);
      expectRefusal(run, 'RAY_USAGE', 2);
      expect(run.envelope.errors[0].message).toBe('the archive cannot be opened for reading');
    }
    const verify = spawnSync(process.execPath, [CLI_DIST, 'bundle', 'verify', missing], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    const verified = JSON.parse(verify.stdout) as ParsedJson;
    expect(verified.errors[0]).toMatchObject({
      code: 'RAY_USAGE',
      message: 'the archive cannot be opened for reading',
    });
    const directory = join(cwd, 'directory.ray');
    mkdirSync(directory);
    const notFile = deploy([directory, '--dry-run'], {}, cwd);
    expectRefusal(notFile, 'RAY_USAGE', 2);
    expect(notFile.envelope.errors[0].message).toBe('the archive is not a regular file');
    expect(existsSync(join(cwd, '.rayspec-state'))).toBe(false);
  });

  it('refuses an unsigned bundle under --require-signature, before the state directory exists', () => {
    const cwd = temporaryDirectory('deploy-signature-');
    for (const args of [
      [bundle, '--dry-run', '--require-signature'],
      [bundle, '--require-signature'],
    ]) {
      const run = deploy(args, {}, cwd);
      expectRefusal(run, 'RAY_SIGNATURE_INVALID', 4, 'malformed');
      expect(run.envelope.errors[0].message).toContain('no signature and one is required');
    }
    expect(existsSync(join(cwd, '.rayspec-state'))).toBe(false);
  });

  it('refuses a private key and a key file others can write as --trusted-key', () => {
    const cwd = temporaryDirectory('deploy-trusted-key-');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keys = temporaryDirectory('deploy-keys-');
    const privatePem = join(keys, 'private.pem');
    writeFileSync(privatePem, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    chmodSync(privatePem, 0o600);
    const writable = join(keys, 'writable.pub.pem');
    writeFileSync(writable, publicKey.export({ type: 'spki', format: 'pem' }));
    chmodSync(writable, 0o664);
    const readable = join(keys, 'readable.pub.pem');
    writeFileSync(readable, publicKey.export({ type: 'spki', format: 'pem' }));
    chmodSync(readable, 0o644);

    const withPrivate = deploy([bundle, '--dry-run', '--trusted-key', privatePem], {}, cwd);
    expectRefusal(withPrivate, 'RAY_USAGE', 2);
    expect(withPrivate.envelope.errors[0].message).toContain('holds a private key');
    const withWritable = deploy([bundle, '--dry-run', '--trusted-key', writable], {}, cwd);
    expectRefusal(withWritable, 'RAY_BINDINGS_FILE_INSECURE', 4);
    expect(withWritable.envelope.errors[0].message).toContain('writable by group or others');
    // A link to an acceptable key is refused as well: the file is judged through the handle that
    // reads it, which is never opened through a link.
    const linked = join(keys, 'linked.pub.pem');
    symlinkSync(readable, linked);
    const withLink = deploy([bundle, '--dry-run', '--trusted-key', linked], {}, cwd);
    expectRefusal(withLink, 'RAY_BINDINGS_FILE_INSECURE', 4);
    expect(withLink.envelope.errors[0].message).toContain('is a link or not a regular file');
    expect(existsSync(join(cwd, '.rayspec-state'))).toBe(false);
    // The control: a world-readable public key is accepted, so the run goes on to the database,
    // which does not exist.
    expectRefusal(
      deploy([bundle, '--dry-run', '--trusted-key', readable], {}, cwd),
      'RAY_INFRA_UNAVAILABLE',
      5,
    );
  });

  it('refuses unknown flags and conflicting ones as usage errors', () => {
    expectRefusal(deploy([bundle, '--nope']), 'RAY_USAGE', 2);
    expectRefusal(deploy([bundle, '--dry-run', '--plan-digest', 'a'.repeat(64)]), 'RAY_USAGE', 2);
    expectRefusal(deploy([bundle, '--plan-digest', 'not-a-digest']), 'RAY_USAGE', 2);
    expectRefusal(deploy([bundle, '--dry-run', '--port', '9000']), 'RAY_USAGE', 2);
  });

  it('refuses a bindings file others can read, a linked one and a missing one', () => {
    const open = bindingsFile(
      { bindingsFormatVersion: 1, bindings: [{ name: 'OPENAI_API_KEY', value: CANARY }] },
      0o644,
    );
    expectRefusal(
      deploy([bundle, '--dry-run', '--bindings-file', open]),
      'RAY_BINDINGS_FILE_INSECURE',
      4,
    );
    chmodSync(open, 0o600);
    const linked = join(temporaryDirectory('deploy-bindings-'), 'link.json');
    symlinkSync(open, linked);
    expectRefusal(
      deploy([bundle, '--dry-run', '--bindings-file', linked]),
      'RAY_BINDINGS_FILE_INSECURE',
      4,
    );
    expectRefusal(
      deploy([bundle, '--dry-run', '--bindings-file', join(work, 'none.json')]),
      'RAY_USAGE',
      2,
    );
  });

  it('refuses a bindings file that is not the contract shape, without repeating its content', () => {
    const cases = [
      `{"bindingsFormatVersion":1,"bindings":[{"name":"OPENAI_API_KEY","value":"${CANARY}"`,
      { OPENAI_API_KEY: CANARY },
      { bindingsFormatVersion: 1, bindings: [{ name: 'openai_api_key', value: CANARY }] },
      {
        bindingsFormatVersion: 1,
        bindings: [
          { name: 'APP_TOKEN', value: CANARY },
          { name: 'APP_TOKEN', value: CANARY },
        ],
      },
    ];
    for (const document of cases) {
      expectRefusal(
        deploy([bundle, '--dry-run', '--bindings-file', bindingsFile(document)]),
        'RAY_USAGE',
        2,
      );
    }
  });

  it('refuses a reserved name and a _FILE variant in the bindings file', () => {
    for (const name of [
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'NODE_OPTIONS',
      'OPENAI_API_KEY_FILE',
    ]) {
      const run = deploy([
        bundle,
        '--bindings-file',
        bindingsFile({ bindingsFormatVersion: 1, bindings: [{ name, value: CANARY }] }),
      ]);
      expectRefusal(run, 'RAY_BINDING_RESERVED', 4);
      expect(run.envelope.errors[0].path).toBe('/bindings/0/name');
    }
  });

  it('refuses a name the bundle does not declare, and a provider key it does not use', () => {
    // The bundle declares OPENAI_API_KEY (its agent runs on openai) and nothing else.
    for (const name of ['STRIPE_SECRET_KEY', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']) {
      const run = deploy([
        bundle,
        '--dry-run',
        '--bindings-file',
        bindingsFile({
          bindingsFormatVersion: 1,
          bindings: [
            { name: 'OPENAI_API_KEY', value: CANARY },
            { name, value: CANARY },
          ],
        }),
      ]);
      expectRefusal(run, 'RAY_USAGE', 2);
      expect(run.envelope.errors[0].path).toBe('/bindings/1/name');
      expect(run.envelope.errors[0].message).toContain(
        `${name}, which the bundle does not declare`,
      );
    }
  });

  it('refuses a provider key in the bindings file that the environment also names a file for', () => {
    const run = deploy(
      [
        bundle,
        '--dry-run',
        '--bindings-file',
        bindingsFile({
          bindingsFormatVersion: 1,
          bindings: [{ name: 'OPENAI_API_KEY', value: CANARY }],
        }),
      ],
      { OPENAI_API_KEY_FILE: join(work, 'no-such-key') },
    );
    expectRefusal(run, 'RAY_USAGE', 2);
    expect(run.envelope.errors[0].message).toContain('OPENAI_API_KEY_FILE');
  });

  it('refuses a provider key file that others can read, and one that is a link', () => {
    const dir = temporaryDirectory('deploy-key-file-');
    const open = join(dir, 'open-key');
    writeFileSync(open, CANARY);
    chmodSync(open, 0o644);
    const insecure = deploy([bundle, '--dry-run'], { OPENAI_API_KEY_FILE: open });
    expectRefusal(insecure, 'RAY_BINDINGS_FILE_INSECURE', 4);
    expect(insecure.envelope.errors[0].message).toContain('OPENAI_API_KEY_FILE');
    const target = join(dir, 'key');
    writeFileSync(target, CANARY);
    chmodSync(target, 0o600);
    const link = join(dir, 'linked-key');
    symlinkSync(target, link);
    expectRefusal(
      deploy([bundle, '--dry-run'], { OPENAI_API_KEY_FILE: link }),
      'RAY_BINDINGS_FILE_INSECURE',
      4,
    );
  });

  it('accepts the speech provider key the operator selected, though no bundle declares it', () => {
    const run = deploy(
      [
        bundle,
        '--dry-run',
        '--bindings-file',
        bindingsFile({
          bindingsFormatVersion: 1,
          bindings: [
            { name: 'OPENAI_API_KEY', value: CANARY },
            { name: 'DEEPGRAM_API_KEY', value: CANARY },
          ],
        }),
      ],
      { STT_PROVIDER: 'deepgram' },
    );
    // Past the bindings: the dry-run reaches the database, which does not exist.
    expectRefusal(run, 'RAY_INFRA_UNAVAILABLE', 5);
  });

  it('reads no .env file: a DATABASE_URL there is not used', () => {
    const cwd = temporaryDirectory('deploy-dotenv-');
    writeFileSync(
      join(cwd, '.env'),
      `DATABASE_URL=${NO_DATABASE}\nRAYSPEC_API_KEY_PEPPER=${CANARY}\n`,
    );
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', bundle, '--dry-run'], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    const envelope = JSON.parse(run.stdout) as ParsedJson;
    expect(run.status).toBe(2);
    expect(envelope.errors[0].code).toBe('RAY_USAGE');
    expect(envelope.errors[0].message).toContain('the dry-run cannot plan');
    expect(envelope.errors[0].message).toContain('DATABASE_URL');
    expect(envelope.errors[0].message).toContain('live schema head');
    expect(envelope.errors[0].message).toContain('no .env file is loaded');
    // The words of another command's refusal (tenant provisioning) are not reused here.
    expect(envelope.errors[0].message).not.toMatch(/provision|invite token/);
    expect(`${run.stdout}${run.stderr}`).not.toContain(CANARY);
    // The same .env IS read by the YAML path, which keeps its behavior: its check-env reports the
    // variable as set.
    writeFileSync(join(cwd, 'rayspec.yaml'), backendSpec());
    const legacy = spawnSync(
      process.execPath,
      [CLI_DIST, 'deploy', '--check-env', 'rayspec.yaml'],
      {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      },
    );
    const report = JSON.parse(legacy.stdout) as ParsedJson;
    expect(
      (report.searchedDotenv as string[]).some((p) => p.endsWith(join(basename(cwd), '.env'))),
    ).toBe(true);
  });

  it('names why a dry-run needs the API key pepper when only that is missing', () => {
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', bundle, '--dry-run'], {
      cwd: temporaryDirectory('deploy-pepper-'),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: NO_DATABASE,
      },
    });
    const envelope = JSON.parse(run.stdout) as ParsedJson;
    expect(run.status).toBe(2);
    expect(envelope.errors[0].code).toBe('RAY_USAGE');
    expect(envelope.errors[0].message).toContain('missing: RAYSPEC_API_KEY_PEPPER.');
    expect(envelope.errors[0].message).toContain('binding revision ids');
    expect(envelope.errors[0].message).not.toContain('DATABASE_URL names');
    expect(envelope.errors[0].message).not.toMatch(/provision|invite token/);
  });

  it('writes the envelope without --json too, with the operation id on stderr', () => {
    const run = deploy([bundle, '--nope']);
    expect(run.stderr).toMatch(/^operationId: [0-9a-f-]{36}$/m);
    expect(run.envelope.operationId).toBe(/^operationId: ([0-9a-f-]{36})$/m.exec(run.stderr)?.[1]);
    const withJson = deploy([bundle, '--nope', '--json']);
    expect(withJson.envelope.operation).toBe('deploy');
  });
});

maybeDescribe('the YAML deploy is unchanged', () => {
  it('a dry-run of a spec answers with the legacy verdict, not an envelope', () => {
    const cwd = temporaryDirectory('deploy-yaml-');
    writeFileSync(join(cwd, 'rayspec.yaml'), backendSpec());
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', '--dry-run', 'rayspec.yaml'], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RAYSPEC_SKIP_DOTENV: '1' },
    });
    expect(run.status).toBe(0);
    const verdict = JSON.parse(run.stdout) as ParsedJson;
    expect(verdict).toMatchObject({ ok: true, mode: 'dry-run' });
    expect(verdict.contractVersion).toBeUndefined();
  });
});

maybeDescribe('the flags of the bundle path are documented', () => {
  const flags = Object.keys(BUNDLE_DEPLOY_ARG_OPTIONS).map((name) => `--${name}`);
  const names = (text: string, flag: string): boolean => new RegExp(`${flag}(?![\\w-])`).test(text);

  it('`deploy --help` names every flag', () => {
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', '--help'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    for (const flag of flags) expect(names(run.stdout, flag), flag).toBe(true);
  });

  it('`deploy --help` lists every exit of the bundle deploy, the boot refusal included', () => {
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', '--help'], { encoding: 'utf8' });
    const text = run.stdout.replace(/\s+/g, ' ');
    const block = text.slice(text.indexOf('rayspec deploy <file.ray> [--bindings-file'));
    for (const exit of [
      'Exit 0 stopped',
      '1 the boot refused its configuration (RAY_CHECK_FAILED',
      '2 usage',
      '3 runtime',
      '4 policy',
      '5 lock',
      '6 drift',
      '7 internal error',
    ]) {
      expect(block, exit).toContain(exit);
    }
  });

  it("the reference's bundle deploy synopsis names every flag", () => {
    const doc = readFileSync(new URL('../../../../docs/cli-reference.md', import.meta.url), 'utf8');
    const heading = doc.indexOf('### Deploying a bundle');
    expect(
      heading,
      'the bundle deploy section was not found in docs/cli-reference.md',
    ).toBeGreaterThan(0);
    const section = doc.slice(heading, doc.indexOf('\n## ', heading + 1));
    const synopsis = /```\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
    for (const flag of flags) expect(names(synopsis, flag), flag).toBe(true);
  });
});
