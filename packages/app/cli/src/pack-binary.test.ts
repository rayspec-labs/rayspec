/**
 * `rayspec pack` through the REAL built CLI (`node dist/index.js`).
 *
 *  - Every example application packs, and its bundle passes `bundle inspect` and `bundle verify`
 *    for the running CLI; the examples that ship a build step are built into a temporary
 *    directory first.
 *  - The same prepared tree, copied into two different temporary directories with different file
 *    times and packed at different times under different time zones, gives the same bytes, and
 *    the archive carries no absolute path, user name or host name.
 *  - An existing output is refused without `--force` and replaced with it; a refused pack leaves
 *    neither an output nor a temporary file.
 *  - A handler, extension or frontend that was not built is refused with the build instruction.
 *  - Every refusal of the resolver reaches the envelope with its code, reason and exit class.
 *  - What it loads: the same module probe as the bundle verbs shows that pack loads no server,
 *    database layer or handler loader.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  buildAcmeNotesBackend,
  buildStreamBackend,
  EXAMPLES,
  elfAddon,
  handlerApp,
  handlerSpec,
  link,
  machOAddon,
  packageFiles,
  privateKeyHeader,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { CLI_DIST, type ParsedJson } from './test-support/bundles.js';
import {
  FORBIDDEN_MODULES,
  installModuleProbe,
  type ProbedRun,
  runProbed,
} from './test-support/module-probe.js';

// The dist guard every suite that spawns the built CLI uses: an unbuilt dist is an ergonomic skip
// locally and a hard failure under CI.
const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `pack-binary.test: SKIPPING — built CLI not found at ${CLI_DIST}; run \`pnpm build\` first.\n`,
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

const valid = schemaValidator('resultEnvelope');
const cliVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const require = createRequire(import.meta.url);

let work: string;
let register: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'rayspec-cli-pack-'));
  register = installModuleProbe(work);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  removeTemporaryDirectories();
});

interface Run extends ProbedRun {
  envelope: ParsedJson;
}

/** Run the built CLI; stdout must be exactly one envelope that the contract schema accepts. */
function cli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Run {
  const r = runProbed(register, work, args, { cwd: options.cwd ?? work, env: options.env });
  const parsed = JSON.parse(r.stdout) as ParsedJson;
  expect(valid(parsed), JSON.stringify(valid.errors)).toBe(true);
  return { ...r, envelope: parsed };
}

/** A fresh, empty output directory. */
function outputDirectory(): string {
  return mkdtempSync(join(work, 'out-'));
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Pack and expect success; returns the run and the output path. */
function packed(
  spec: string,
  flags: string[] = [],
  options: { cwd?: string; env?: Record<string, string>; output?: string } = {},
): Run & { output: string } {
  const output = options.output ?? join(outputDirectory(), 'app.ray');
  const r = cli(['pack', '--spec', spec, '--output', output, ...flags], options);
  expect(r.status, r.stdout).toBe(0);
  return { ...r, output };
}

/** Pack and expect a refusal: no data, no output file and no temporary file in its directory. */
function refusedPack(args: string[], exit: number, code: string, reason?: string): Run {
  const dir = outputDirectory();
  const r = cli(['pack', ...args, '--output', join(dir, 'app.ray')]);
  expect(r.status, r.stdout).toBe(exit);
  expect(r.envelope).toMatchObject({ ok: false, operation: 'pack', data: null });
  expect(r.envelope.errors[0].code).toBe(code);
  if (reason !== undefined) expect(r.envelope.errors[0].reason).toBe(reason);
  expect(readdirSync(dir)).toEqual([]);
  return r;
}

/** Copy an example directory, without whatever a local build or install left in it. */
function copyExample(name: string): string {
  const root = temporaryDirectory('example-');
  cpSync(join(EXAMPLES, name), root, {
    recursive: true,
    filter: (source) => !/[/\\](?:node_modules|dist)(?:[/\\]|$)/.test(source),
  });
  return root;
}

/** The agent-pack example built as a deployer ships it: its extension compiled to `dist`. */
function buildAgentPackDeployment(): string {
  const root = copyExample('agent-pack-deployment');
  const pack = join(root, 'packs', 'agent-pack');
  writeFileSync(
    join(pack, 'package.json'),
    JSON.stringify({
      name: 'agent-pack',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { '@rayspec/handler-sdk': cliVersion, '@rayspec/platform': cliVersion },
    }),
  );
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', join(pack, 'tsconfig.build.json')],
    { stdio: 'pipe' },
  );
  writeTree(root, {
    'packs/agent-pack/dist/package.json': JSON.stringify({ type: 'module' }),
    ...packageFiles('packs/agent-pack/node_modules/@rayspec/platform', {
      name: '@rayspec/platform',
      version: cliVersion,
      type: 'module',
    }),
  });
  const spec = join(root, 'rayspec.yaml');
  writeFileSync(
    spec,
    readFileSync(spec, 'utf8').replace(/^(\s+module: \.\/packs\/agent-pack)$/m, '$1/dist'),
  );
  return spec;
}

/**
 * The expense-claim coder built as its build step builds it: each hole set rendered to JavaScript
 * by `gen-handler --emit js`, a module-type `package.json`, and the spec pointing at the rendered
 * modules. Its build script writes only inside the repository, so the steps run here in a
 * temporary copy.
 */
function buildExpenseClaimCoder(): string {
  const root = copyExample('expense-claim-coder');
  for (const name of ['lookup-categories', 'code-claim']) {
    execFileSync(
      process.execPath,
      [
        CLI_DIST,
        'gen-handler',
        '--holes',
        `holes/${name}.holes.json`,
        '--out',
        'dist/handlers',
        '--emit',
        'js',
        '--file',
        `${name}.gen.js`,
      ],
      { cwd: root, stdio: 'pipe', env: { PATH: process.env.PATH, RAYSPEC_SKIP_DOTENV: '1' } },
    );
  }
  writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
  const spec = readFileSync(join(root, 'rayspec.yaml'), 'utf8');
  writeFileSync(
    join(root, 'dist', 'rayspec.yaml'),
    spec.replace(/(module:\s*handlers\/\S+)\.gen\.ts/g, '$1.gen.js'),
  );
  return join(root, 'dist', 'rayspec.yaml');
}

/** The asset-catalog example built by its own build script into a temporary directory. */
function buildAssetCatalog(): string {
  const out = join(temporaryDirectory('asset-catalog-'), 'app');
  execFileSync(process.execPath, [join(EXAMPLES, 'asset-catalog', 'build.mjs'), `--out=${out}`], {
    stdio: 'pipe',
  });
  return join(out, 'rayspec.yaml');
}

/** Every example that runs as it stands, with its spec. */
const READY_EXAMPLES: readonly [string, string][] = [
  ['acme-notes', 'acme-notes.product.yaml'],
  ['agent-boot-backend', 'agent-boot.rayspec.yaml'],
  ['contract-intake', 'contract-intake.product.yaml'],
  ['document-intake', 'document-intake.product.yaml'],
  ['expense-claim', 'expense-claim.product.yaml'],
  ['invoice-intake', 'invoice-intake.product.yaml'],
  ['lead-qualifier', 'lead-qualifier.rayspec.yaml'],
  ['live-workspace-events', 'live-workspace-events.rayspec.yaml'],
  ['notes-ui', 'rayspec.yaml'],
  ['support-intake-chat', 'support-intake-chat.product.yaml'],
  ['support-ticket-triage', 'support-ticket-triage.product.yaml'],
];

/** Every example with a build step, and how to build it into a temporary directory. */
const BUILT_EXAMPLES: readonly [string, () => string][] = [
  ['acme-notes-backend', () => join(buildAcmeNotesBackend(), 'rayspec.yaml')],
  ['agent-pack-deployment', buildAgentPackDeployment],
  ['asset-catalog', buildAssetCatalog],
  ['expense-claim-coder', buildExpenseClaimCoder],
  ['stream-backend', () => join(buildStreamBackend(), 'rayspec.yaml')],
];

maybeDescribe('pack of every example, then inspect and verify of the bundle', () => {
  it('the lists cover every example that has a spec', () => {
    const withSpec = readdirSync(EXAMPLES).filter((name) =>
      readdirSync(join(EXAMPLES, name)).some(
        (file) => /\.ya?ml$/.test(file) && !file.includes('.invalid.'),
      ),
    );
    expect([...READY_EXAMPLES.map(([n]) => n), ...BUILT_EXAMPLES.map(([n]) => n)].sort()).toEqual(
      withSpec.sort(),
    );
  });

  const cases: [string, () => string][] = [
    ...READY_EXAMPLES.map(([name, spec]): [string, () => string] => [
      name,
      () => join(EXAMPLES, name, spec),
    ]),
    ...BUILT_EXAMPLES,
  ];
  for (const [name, specOf] of cases) {
    it(`${name}: packs, and the bundle is structurally valid and deployable here`, () => {
      const spec = specOf();
      const pack = packed(spec, ['--id', name, '--version', '1.0.0', '--json']);
      const bytes = readFileSync(pack.output);
      expect(pack.envelope.data).toMatchObject({
        outputPath: pack.output,
        preview: false,
        sha256: sha256(bytes),
        size: bytes.length,
        applicationId: name,
        applicationVersion: '1.0.0',
        runtimeVersion: cliVersion,
        target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      });
      // With --json, stderr carries the operation id and nothing else.
      expect(pack.stderr).toBe(`operationId: ${pack.envelope.operationId}\n`);

      const inspect = cli(['bundle', 'inspect', pack.output, '--json']);
      expect(inspect.status, inspect.stdout).toBe(0);
      expect(inspect.envelope.data).toMatchObject({
        verdict: 'structurally-valid',
        sha256: pack.envelope.data.sha256,
        entries: pack.envelope.data.inclusion.length + 1,
        requires: pack.envelope.data.requires,
        bindings: pack.envelope.data.bindings,
        execution: pack.envelope.data.execution,
      });

      const verify = cli(['bundle', 'verify', pack.output, '--json']);
      expect(verify.status, verify.stdout).toBe(0);
      expect(verify.envelope.data).toMatchObject({
        verdict: 'deployable',
        checkedAgainstRuntime: cliVersion,
      });
    });
  }
});

maybeDescribe('a product document that declares span_granularity', () => {
  const STT_CONTRACT = '      - stt.transcript_span\n';

  /** The acme-notes example copied aside, its `stt` capability declaring the key. */
  function withGranularity(value: string): string {
    const root = copyExample('acme-notes');
    const path = join(root, 'acme-notes.product.yaml');
    const text = readFileSync(path, 'utf8');
    const declared = text.replace(STT_CONTRACT, `${STT_CONTRACT}    span_granularity: ${value}\n`);
    expect(declared).not.toBe(text);
    writeFileSync(path, declared);
    return path;
  }

  const identity = ['--id', 'acme-notes', '--version', '1.0.0', '--json'];

  it('packs, and the bundle passes inspect and verify with the manifest fields of the document without it', () => {
    const plain = packed(join(EXAMPLES, 'acme-notes', 'acme-notes.product.yaml'), identity);
    const pack = packed(withGranularity('sentence'), identity);
    expect(pack.envelope.data.requires).toEqual(plain.envelope.data.requires);
    expect(pack.envelope.data.bindings).toEqual(plain.envelope.data.bindings);
    expect(pack.envelope.data.execution).toEqual(plain.envelope.data.execution);
    // The document is part of the bundle, so the two archives differ.
    expect(pack.envelope.data.sha256).not.toBe(plain.envelope.data.sha256);

    const inspect = cli(['bundle', 'inspect', pack.output, '--json']);
    expect(inspect.status, inspect.stdout).toBe(0);
    expect(inspect.envelope.data).toMatchObject({
      verdict: 'structurally-valid',
      requires: plain.envelope.data.requires,
      bindings: plain.envelope.data.bindings,
    });

    const verify = cli(['bundle', 'verify', pack.output, '--json']);
    expect(verify.status, verify.stdout).toBe(0);
    expect(verify.envelope.data).toMatchObject({
      verdict: 'deployable',
      checkedAgainstRuntime: cliVersion,
    });
  });

  it('refuses to pack a value the grammar does not know, naming the key', () => {
    const r = refusedPack(
      ['--spec', withGranularity('word'), ...identity.slice(0, 4)],
      1,
      'RAY_SPEC_INVALID',
    );
    expect(
      r.envelope.errors.slice(1).map((e: { code: string; path?: string }) => [e.code, e.path]),
    ).toEqual([['SPEC_SCHEMA_VIOLATION', 'capabilities[2].span_granularity']]);
  });
});

maybeDescribe('determinism', () => {
  /** A prepared tree with a vendored scoped package, a lock file and a frontend. */
  function vendoredApp(): string {
    const root = handlerApp("import { pad } from '@acme/pad';\nexport const handle = pad;\n", {
      'rayspec.yaml': handlerSpec('handlers/h.js').concat(
        'frontend:\n  - { route: /, dir: web }\n',
      ),
      'package.json': JSON.stringify({
        name: 'probe',
        private: true,
        type: 'module',
        dependencies: { '@acme/pad': '1.2.3' },
      }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
      'node_modules/@acme/pad/package.json': JSON.stringify({
        name: '@acme/pad',
        version: '1.2.3',
        license: 'MIT',
        type: 'module',
        main: 'index.js',
      }),
      'node_modules/@acme/pad/index.js': "export const pad = (s) => ' ' + s;\n",
      'node_modules/@acme/pad/LICENSE': 'MIT License\n',
      'web/index.html': '<!doctype html><title>probe</title>\n',
    });
    return root;
  }

  /** Give every file and directory under `root` the same, different time. */
  function touchAll(root: string, when: Date): void {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      utimesSync(join(entry.parentPath, entry.name), when, when);
    }
    utimesSync(root, when, when);
  }

  /** Every file's bytes under `root`, for telling input content from a leak. */
  function inputText(root: string): string {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
      .join('\n');
  }

  for (const [label, prepare] of [
    ['a built backend with handlers', () => buildAcmeNotesBackend()],
    ['an application with a vendored scoped package and a frontend', vendoredApp],
  ] as const) {
    it(`${label}: two roots, two times, one archive`, async () => {
      const prepared = prepare();
      const a = temporaryDirectory('first-');
      const b = join(temporaryDirectory('second-'), 'nested', 'deeper');
      cpSync(prepared, a, { recursive: true });
      cpSync(prepared, b, { recursive: true });
      touchAll(a, new Date('2001-02-03T04:05:06Z'));
      touchAll(b, new Date('2030-12-31T23:59:58Z'));
      const flags = ['--id', 'same-app', '--version', '2.0.0'];

      const first = packed(join(a, 'rayspec.yaml'), flags, { cwd: a, env: { TZ: 'UTC' } });
      // The archive's clock is fixed; waiting past the two-second resolution of a ZIP time shows
      // that no clock reading reaches it.
      await new Promise((done) => setTimeout(done, 2100));
      const second = packed(join(b, 'rayspec.yaml'), flags, {
        cwd: work,
        env: { TZ: 'Pacific/Kiritimati' },
      });

      const bytesA = readFileSync(first.output);
      const bytesB = readFileSync(second.output);
      expect(bytesA.equals(bytesB)).toBe(true);
      expect(first.envelope.data.sha256).toBe(second.envelope.data.sha256);
      expect(first.envelope.data.inclusion).toEqual(second.envelope.data.inclusion);

      // Nothing of the machine or the directory it was packed from, unless an input carries it.
      const archive = bytesA.toString('latin1');
      const inputs = inputText(a);
      const machine = [
        a,
        b,
        realpathSync(a),
        realpathSync(b),
        tmpdir(),
        homedir(),
        hostname(),
        userInfo().username,
      ].filter((text) => text.length >= 3 && !inputs.includes(text));
      for (const text of machine) expect(archive.includes(text), text).toBe(false);
    });
  }
});

maybeDescribe('the output file', () => {
  const spec = join(EXAMPLES, 'notes-ui', 'rayspec.yaml');
  const identity = ['--id', 'notes-ui', '--version', '1.0.0'];

  it('refuses an existing output without --force and leaves it as it was', () => {
    const dir = outputDirectory();
    const output = join(dir, 'app.ray');
    writeFileSync(output, 'not a bundle');
    const r = cli(['pack', '--spec', spec, '--output', output, ...identity]);
    expect(r.status).toBe(2);
    expect(r.envelope.errors[0]).toMatchObject({ code: 'RAY_OUTPUT_EXISTS', retryable: false });
    // Refused before anything was written, not only when the archive is moved into place.
    expect(r.envelope.errors[0].message).toContain('already exists');
    expect(r.envelope.data).toBeNull();
    expect(readFileSync(output, 'utf8')).toBe('not a bundle');
    expect(readdirSync(dir)).toEqual(['app.ray']);
  });

  it('replaces an existing output with --force', () => {
    const first = packed(spec, identity);
    const before = readFileSync(first.output);
    const second = packed(spec, ['--id', 'notes-ui', '--version', '1.0.1', '--force'], {
      output: first.output,
    });
    const after = readFileSync(first.output);
    expect(after.equals(before)).toBe(false);
    expect(second.envelope.data.sha256).toBe(sha256(after));
    expect(readdirSync(join(first.output, '..'))).toEqual(['app.ray']);
  });

  it('refuses a directory as the output, with or without --force', () => {
    const dir = outputDirectory();
    for (const flags of [[], ['--force']]) {
      const r = cli(['pack', '--spec', spec, '--output', dir, ...identity, ...flags]);
      expect(r.status).toBe(2);
      expect(r.envelope.errors[0].code).toBe('RAY_USAGE');
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  it('refuses an output in a directory that does not exist', () => {
    const output = join(outputDirectory(), 'missing', 'app.ray');
    const r = cli(['pack', '--spec', spec, '--output', output, ...identity]);
    expect(r.status).toBe(2);
    expect(r.envelope.errors[0].code).toBe('RAY_USAGE');
    expect(existsSync(output)).toBe(false);
  });

  it('--preview writes nothing and lists every file on stderr', () => {
    const dir = outputDirectory();
    const output = join(dir, 'app.ray');
    const r = cli(['pack', '--spec', spec, '--output', output, ...identity, '--preview']);
    expect(r.status).toBe(0);
    expect(r.envelope.data).toMatchObject({
      outputPath: null,
      preview: true,
      sha256: null,
      size: null,
      applicationId: 'notes-ui',
    });
    expect(r.envelope.data.inclusion.map((e: { path: string }) => e.path)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
      'payload/web/dist/app.js',
      'payload/web/dist/index.html',
    ]);
    for (const entry of r.envelope.data.inclusion) expect(r.stderr).toContain(entry.path);
    expect(r.stderr).toContain('nothing was written');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('prints the inclusion summary and the digest without --json, and never claims a deployment', () => {
    const r = packed(spec, identity);
    const data = r.envelope.data;
    expect(r.stderr).toContain(`operationId: ${r.envelope.operationId}`);
    expect(r.stderr).toContain(`notes-ui 1.0.0 — application bundle for runtime ${cliVersion}`);
    expect(r.stderr).toContain('spec: payload/rayspec.yaml');
    expect(r.stderr).toContain('requires: declarative-api, declarative-stores, static-frontend');
    expect(r.stderr).toContain(`sha256 ${data.sha256}`);
    expect(r.stderr).toContain('nothing was deployed');
    expect(r.stderr).not.toMatch(/\bdeployed (?:successfully|to)\b|\bis live\b|\bserving\b/i);
  });

  it('pins the runtime --runtime names, which verify then holds it to', () => {
    const r = packed(spec, [...identity, '--runtime', '9.9.9']);
    expect(r.envelope.data.runtimeVersion).toBe('9.9.9');
    const here = cli(['bundle', 'verify', r.output]);
    expect(here.status).toBe(3);
    expect(here.envelope.errors[0].code).toBe('RAY_RUNTIME_UNSUPPORTED');
    const there = cli(['bundle', 'verify', r.output, '--runtime', '9.9.9']);
    expect(there.status).toBe(0);
  });

  it('takes the identity from the spec, and --id / --version override it', () => {
    const root = handlerApp('export const handle = 1;\n');
    const fromSpec = packed(join(root, 'rayspec.yaml'));
    expect(fromSpec.envelope.data).toMatchObject({
      applicationId: 'probe-app',
      applicationVersion: '1.0.0',
    });
    const overridden = packed(join(root, 'rayspec.yaml'), ['--id', 'other', '--version', '3.1.4']);
    expect(overridden.envelope.data).toMatchObject({
      applicationId: 'other',
      applicationVersion: '3.1.4',
    });
  });

  it('adds --include paths, and carries source maps only with --source-maps', () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/app.js': 'x',
      'web/app.js.map': '{}',
      'docs/NOTICE.txt': 'notice\n',
    });
    const spec = join(root, 'rayspec.yaml');
    const plain = packed(spec, ['--include', 'docs/NOTICE.txt']);
    const paths = plain.envelope.data.inclusion.map((e: { path: string }) => e.path);
    expect(paths).toContain('payload/docs/NOTICE.txt');
    expect(paths).not.toContain('payload/web/app.js.map');
    expect(plain.stderr).toContain('web/app.js.map — a source map');
    const withMaps = packed(spec, ['--source-maps']);
    expect(withMaps.envelope.data.inclusion.map((e: { path: string }) => e.path)).toContain(
      'payload/web/app.js.map',
    );
  });
});

maybeDescribe('an application that was not built', () => {
  it('refuses TypeScript handlers and says to compile them', () => {
    const r = refusedPack(
      [
        '--spec',
        join(copyExample('acme-notes-backend'), 'rayspec.yaml'),
        '--id',
        'x',
        '--version',
        '1.0.0',
      ],
      2,
      'RAY_CLOSURE_INVALID',
      'unresolved-import',
    );
    expect(r.envelope.errors[0].message).toContain('Compile the handlers first');
    expect(r.stderr).toContain('nothing was written');
  });

  it('refuses a compiled handler that is missing and says to build first', () => {
    const root = temporaryDirectory();
    writeTree(root, { 'rayspec.yaml': handlerSpec('handlers/h.js') });
    const r = refusedPack(
      ['--spec', join(root, 'rayspec.yaml')],
      2,
      'RAY_CLOSURE_INVALID',
      'unresolved-import',
    );
    expect(r.envelope.errors[0].message).toContain('build the application first');
    expect(r.envelope.errors[0].path).toBe('handlers/h.js');
  });

  it('refuses an extension without its compiled entry and says to build it', () => {
    const r = refusedPack(
      [
        '--spec',
        join(copyExample('stream-backend'), 'rayspec.yaml'),
        '--id',
        'x',
        '--version',
        '1.0.0',
      ],
      2,
      'RAY_CLOSURE_INVALID',
      'unresolved-import',
    );
    expect(r.envelope.errors[0].message).toContain('build the extension');
  });

  it('refuses a frontend directory that was not built', () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web/dist }\n'),
    });
    const r = refusedPack(['--spec', join(root, 'rayspec.yaml')], 2, 'RAY_CLOSURE_INVALID');
    expect(r.envelope.errors[0].message).toContain('build the frontend first');
  });
});

maybeDescribe('refusals reach the envelope with their code and exit class', () => {
  const ready = () => join(handlerApp('export const handle = 1;\n'), 'rayspec.yaml');

  it('usage errors exit 2', () => {
    const spec = ready();
    for (const [args, fragment] of [
      [[], '--spec <path> is required'],
      [['--spec', spec, '--nope'], "Unknown option '--nope'"],
      [['--spec', spec, 'extra'], 'extra'],
      [['--spec', spec, '--runtime', 'latest'], '--runtime must be an exact version'],
      [['--spec', spec, '--include', ''], '--include needs a path'],
      [['--spec', spec, '--build'], 'Build the application yourself first'],
      [['--spec', spec, '--allowlist', spec], '--allowlist requires --against'],
      [['--spec', spec, '--against', ''], '--against needs the path of the previous spec'],
    ] as const) {
      const r = refusedPack([...args], 2, 'RAY_USAGE');
      expect(r.envelope.errors[0].message).toContain(fragment);
    }
    const noOutput = cli(['pack', '--spec', spec]);
    expect(noOutput.status).toBe(2);
    expect(noOutput.envelope.errors[0].message).toContain('--output <file.ray> is required');
  });

  it('a spec that does not parse exits 1 with its SPEC_ codes', () => {
    const r = refusedPack(
      [
        '--spec',
        join(EXAMPLES, 'acme-notes', 'acme-notes.invalid.product.yaml'),
        '--id',
        'x',
        '--version',
        '1.0.0',
      ],
      1,
      'RAY_SPEC_INVALID',
    );
    expect(r.envelope.errors.length).toBeGreaterThan(1);
    for (const error of r.envelope.errors.slice(1)) expect(error.code).toMatch(/^SPEC_/);
  });

  it('a missing or malformed identity exits 2 with the field as the reason', () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': "version: '1.0'\nmetadata:\n  name: probe\n",
      'versioned.yaml': "version: '1.0'\nmetadata:\n  name: probe\n  id: probe\n",
    });
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml')],
      2,
      'RAY_APPLICATION_IDENTITY_MISSING',
      'id',
    );
    refusedPack(
      ['--spec', join(root, 'versioned.yaml')],
      2,
      'RAY_APPLICATION_IDENTITY_MISSING',
      'version',
    );
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml'), '--id', 'Not_An_Id', '--version', '1.0.0'],
      2,
      'RAY_APPLICATION_IDENTITY_MISSING',
      'id',
    );
    // The runtime version is never the application version.
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml'), '--id', 'probe'],
      2,
      'RAY_APPLICATION_IDENTITY_MISSING',
      'version',
    );
  });

  it('an unresolved import exits 2', () => {
    const root = handlerApp("import { x } from './missing.js';\nexport const handle = x;\n");
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml')],
      2,
      'RAY_CLOSURE_INVALID',
      'unresolved-import',
    );
  });

  it('a link out of the application exits 2', () => {
    const outside = temporaryDirectory();
    writeTree(outside, { 'secret.txt': 'outside\n' });
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': 'x',
    });
    link(root, 'web/leak.txt', join(outside, 'secret.txt'));
    refusedPack(['--spec', join(root, 'rayspec.yaml')], 2, 'RAY_CLOSURE_INVALID', 'escaping-link');
  });

  it('an explicitly included file of an excluded class exits 2', () => {
    const root = handlerApp('export const handle = 1;\n', { 'data.sqlite': 'rows' });
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml'), '--include', 'data.sqlite'],
      2,
      'RAY_CLOSURE_INVALID',
      'excluded-file',
    );
  });

  it('a native addon not built for linux/x64 exits 2; one that is, packs', () => {
    const nativeApp = (addon: Uint8Array) =>
      handlerApp("import addon from 'fast-thing';\nexport const handle = addon;\n", {
        ...packageFiles(
          'node_modules/fast-thing',
          { name: 'fast-thing', version: '2.0.0' },
          { 'build/Release/fast.node': addon },
        ),
      });
    const r = refusedPack(
      ['--spec', join(nativeApp(machOAddon()), 'rayspec.yaml')],
      2,
      'RAY_CLOSURE_INVALID',
      'native-module',
    );
    expect(r.envelope.errors[0].message).toContain('fast-thing@2.0.0');
    packed(join(nativeApp(elfAddon()), 'rayspec.yaml'));
  });

  it('a source map named without --source-maps exits 2', () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/app.js': 'x',
      'web/app.js.map': '{}',
    });
    refusedPack(
      ['--spec', join(root, 'rayspec.yaml'), '--include', 'web/app.js.map'],
      2,
      'RAY_CLOSURE_INVALID',
      'source-map-not-opted-in',
    );
  });

  it('a @rayspec/* range that excludes the pinned runtime exits 3', () => {
    const root = handlerApp(
      "import { defineExtension } from '@rayspec/platform';\nexport const handle = defineExtension;\n",
      {
        'package.json': JSON.stringify({
          name: 'probe',
          private: true,
          type: 'module',
          dependencies: { '@rayspec/platform': '^99.0.0' },
        }),
        ...packageFiles('node_modules/@rayspec/platform', {
          name: '@rayspec/platform',
          version: cliVersion,
        }),
      },
    );
    const r = refusedPack(['--spec', join(root, 'rayspec.yaml')], 3, 'RAY_RUNTIME_UNSUPPORTED');
    expect(r.envelope.errors[0].message).toContain('^99.0.0');
  });

  it('a private key in the closure exits 4, naming the path and never the content', () => {
    const root = temporaryDirectory();
    const body = 'c2VjcmV0LWtleS1tYXRlcmlhbA';
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': 'x',
      'web/key.txt': `${privateKeyHeader()}\n${body}\n`,
    });
    const r = refusedPack(['--spec', join(root, 'rayspec.yaml')], 4, 'RAY_SECRET_DETECTED');
    expect(r.envelope.errors[0].path).toBe('payload/web/key.txt');
    expect(r.stdout).not.toContain(body);
    expect(r.stderr).not.toContain(body);
  });

  it('more files than a bundle holds exits 2', () => {
    const root = temporaryDirectory();
    writeTree(root, { 'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n') });
    mkdirSync(join(root, 'web'));
    for (let i = 0; i < 10_000; i++) writeFileSync(join(root, 'web', `f${i}.txt`), '');
    refusedPack(['--spec', join(root, 'rayspec.yaml')], 2, 'RAY_LIMIT_EXCEEDED', 'entry-count');
  });
});

maybeDescribe('help', () => {
  it('pack --help prints its block and leaves out the flag that is refused', () => {
    const r = runProbed(register, work, ['pack', '--help'], { cwd: work });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('rayspec pack --spec <path> --output <file.ray>');
    expect(r.stdout).not.toContain('--build');
    expect(r.stdout).toContain('[--against <old-spec>');
    expect(r.stdout).toContain('[--allowlist <file.json>]');
  });
});

maybeDescribe('what pack loads', () => {
  const ready = () => join(handlerApp('export const handle = 1;\n'), 'rayspec.yaml');

  for (const [label, args] of [
    ['a pack', () => ['--spec', ready(), '--output', join(outputDirectory(), 'a.ray')]],
    ['a preview', () => ['--spec', ready(), '--output', 'x.ray', '--preview']],
    ['a refused pack', () => ['--spec', join(work, 'missing.yaml'), '--output', 'x.ray']],
  ] as const) {
    it(`${label} loads no server, database layer or handler loader`, () => {
      const r = runProbed(register, work, ['pack', ...args()], { cwd: work });
      expect(r.stdout).toContain('"operation": "pack"');
      // The resolver and the bundle codec are what it runs on: the probe saw the real work.
      expect(r.modules.some((m) => /\/packages\/kernel\/bundle-closure\//.test(m))).toBe(true);
      expect(r.modules.some((m) => /\/packages\/kernel\/bundle\//.test(m))).toBe(true);
      for (const [what, pattern] of FORBIDDEN_MODULES) {
        expect(
          r.modules.filter((m) => pattern.test(m)),
          `${label} loaded ${what}`,
        ).toEqual([]);
      }
    });
  }

  it('the accept control: plan, under the same probe, loads the database layer', () => {
    const specDir = mkdtempSync(join(work, 'plan-'));
    writeFileSync(
      join(specDir, 'rayspec.yaml'),
      "version: '1.0'\nmetadata:\n  name: probe\nstores:\n  - name: things\n    columns:\n      - { name: title, type: text }\n",
    );
    const r = runProbed(register, work, ['plan', 'rayspec.yaml'], { cwd: specDir });
    expect(r.status).toBe(0);
    expect(r.modules.some((m) => FORBIDDEN_MODULES[1]![1].test(m))).toBe(true);
  });
});
