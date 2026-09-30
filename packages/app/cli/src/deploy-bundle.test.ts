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
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(envelope.errors[0].message).toContain('DATABASE_URL');
    expect(envelope.errors[0].message).toContain('no .env file is loaded');
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
