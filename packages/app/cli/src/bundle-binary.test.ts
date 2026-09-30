/**
 * `rayspec bundle inspect` and `verify` through the REAL built CLI (`node dist/index.js`).
 *
 * Two properties only a real process can show:
 *
 *  - WHAT IT LOADS. A module-resolution hook, registered with `--import`, records every module the
 *    process resolves. Inspecting and verifying a bundle must resolve nothing of the server, the
 *    database layer, the platform (whose handler loader imports handler modules), the product
 *    composition, the Postgres driver, the durable engine or the HTTP framework. The accept control
 *    runs `rayspec plan` under the same hook and sees the database layer, so an empty list is a
 *    finding and not a blind probe.
 *  - THAT NOTHING RUNS. The canary bundle carries a module that, if it were imported, would write a
 *    canary file and open a TCP connection to a listener this test owns, plus a package manifest with
 *    install hooks that would do the same. Inspect and verify leave both untouched; the control
 *    imports the same module in a child process and trips both, which proves the probe would notice.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_DIST, corpusFile, loadExpectations, REPO_ROOT } from './test-support/bundles.js';
import { FORBIDDEN_MODULES, installModuleProbe, runProbed } from './test-support/module-probe.js';

// The dist guard every suite that spawns the built CLI uses (see deploy-static-profile.test.ts): an
// unbuilt dist is an ergonomic skip locally and a hard failure under CI.
const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `bundle-binary.test: SKIPPING — built CLI not found at ${CLI_DIST}; run \`pnpm build\` first.\n`,
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

const expectations = loadExpectations();
const valid = schemaValidator('resultEnvelope');
const cliVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const CANARY_FILE_ENV = 'RAYSPEC_CLI_TEST_CANARY_FILE';
const CANARY_PORT_ENV = 'RAYSPEC_CLI_TEST_CANARY_PORT';

/** What the payload does when it is imported: write the canary, then connect to the listener. */
const PAYLOAD = `import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
writeFileSync(process.env.${CANARY_FILE_ENV}, 'executed');
await new Promise((done) => {
  const socket = connect(Number(process.env.${CANARY_PORT_ENV}), '127.0.0.1', () => {
    socket.end();
    done();
  });
  socket.on('error', done);
});
export async function run() {}
`;

/** A spec that routes to the payload module as a handler, so verify has a real handler to pass. */
const SPEC = `version: '1.0'
metadata:
  name: canary
api:
  - method: POST
    path: /run
    action: { kind: handler, handler: run }
handlers:
  - id: run
    module: ./handlers/index.mjs
    export: run
    kind: route
`;

let work: string;
let register: string;
let archive: string;
let canary: string;
let server: Server;
let connections = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'rayspec-cli-binary-'));
  canary = join(work, 'canary');
  register = installModuleProbe(work);
  writeFileSync(join(work, 'payload.mjs'), PAYLOAD);
  server = createServer((socket) => {
    connections++;
    socket.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));

  const base = expectations.bases.application!.files;
  archive = join(work, 'canary.ray');
  const written = await writeBundle(archive, {
    manifest: {
      formatVersion: 1,
      kind: 'application',
      application: { id: 'canary-app', version: '1.0.0' },
      runtime: { version: cliVersion },
      target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      spec: 'payload/rayspec.yaml',
      requires: ['custom-handlers', 'declarative-api'],
      bindings: [],
      permissions: { egressHosts: [], execution: 'in-process' },
    },
    files: [
      { path: 'payload/rayspec.yaml', bytes: Buffer.from(SPEC) },
      { path: 'payload/handlers/index.mjs', bytes: Buffer.from(PAYLOAD) },
      {
        path: 'payload/handlers/package.json',
        bytes: Buffer.from(
          JSON.stringify({
            type: 'module',
            main: 'index.mjs',
            scripts: { preinstall: 'node index.mjs', postinstall: 'node index.mjs' },
          }),
        ),
      },
      { path: 'payload/sbom.cdx.json', bytes: Buffer.from(base['payload/sbom.cdx.json']!.utf8) },
      {
        path: 'payload/THIRD-PARTY-NOTICES.txt',
        bytes: Buffer.from(base['payload/THIRD-PARTY-NOTICES.txt']!.utf8),
      },
    ],
  });
  if (!written.ok) throw new Error(`the canary bundle was not written: ${written.errors[0]!.code}`);
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(work, { recursive: true, force: true });
});

function listenerPort(): string {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listener port');
  return String(address.port);
}

/** Run the built CLI, recording every module it resolves. */
function cli(args: string[], cwd = work) {
  // A payload that ran would wait on this process's listener, which cannot answer while the
  // synchronous spawn blocks; the timeout turns that into a failure instead of a hang.
  return runProbed(register, work, args, {
    cwd,
    timeout: 30_000,
    env: { [CANARY_FILE_ENV]: canary, [CANARY_PORT_ENV]: listenerPort() },
  });
}

const settle = () => new Promise((done) => setTimeout(done, 150));

maybeDescribe('the canary bundle through the real CLI', () => {
  it('inspect describes it without running it', async () => {
    const r = cli(['bundle', 'inspect', archive]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(valid(env)).toBe(true);
    expect(env.data).toMatchObject({
      verdict: 'structurally-valid',
      applicationId: 'canary-app',
      execution: 'in-process',
      requires: ['custom-handlers', 'declarative-api'],
    });
    await settle();
    expect(existsSync(canary)).toBe(false);
    expect(connections).toBe(0);
  });

  it('verify finds it deployable on this CLI without running it', async () => {
    const r = cli(['bundle', 'verify', archive, '--json']);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(valid(env)).toBe(true);
    expect(env.data).toMatchObject({ verdict: 'deployable', checkedAgainstRuntime: cliVersion });
    expect(r.stderr).toBe(`operationId: ${env.operationId}\n`);
    await settle();
    expect(existsSync(canary)).toBe(false);
    expect(connections).toBe(0);
  });

  it('the probe detects execution: importing the same module trips both canaries', async () => {
    // Asynchronous, so this process's listener can answer the connection while the child runs.
    const status = await new Promise<number | null>((done) => {
      const child = execFile(process.execPath, [join(work, 'payload.mjs')], {
        env: {
          PATH: process.env.PATH,
          [CANARY_FILE_ENV]: canary,
          [CANARY_PORT_ENV]: listenerPort(),
        },
      });
      child.on('exit', (code) => done(code));
    });
    expect(status).toBe(0);
    await settle();
    expect(readFileSync(canary, 'utf8')).toBe('executed');
    expect(connections).toBe(1);
    rmSync(canary);
    connections = 0;
  });
});

maybeDescribe('what the bundle verbs load', () => {
  const good = corpusFile(expectations.cases.find((c) => c.id === 'app-good-minimal')!);

  for (const [label, args] of [
    ['inspect', ['bundle', 'inspect', good]],
    ['verify', ['bundle', 'verify', good, '--runtime', '0.0.0-contract-fixture']],
    ['verify of a bundle with handlers', ['bundle', 'verify', '__CANARY__']],
    [
      'a refused archive',
      [
        'bundle',
        'verify',
        corpusFile(expectations.cases.find((c) => c.id === 'archive-traversal-dotdot')!),
      ],
    ],
  ] as const) {
    it(`${label} loads no server, database layer or handler loader`, () => {
      const r = cli(args.map((a) => (a === '__CANARY__' ? archive : a)));
      expect(r.stdout).toContain('"contractVersion"');
      // The bundle codec and the spec grammar are what it runs on: the probe saw the real work.
      expect(r.modules.some((m) => /\/packages\/kernel\/bundle\//.test(m))).toBe(true);
      expect(r.modules.some((m) => /\/packages\/kernel\/spec\//.test(m))).toBe(true);
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
    const r = cli(['plan', 'rayspec.yaml'], specDir);
    expect(r.status).toBe(0);
    expect(r.modules.some((m) => FORBIDDEN_MODULES[1]![1].test(m))).toBe(true);
  });

  it('the repo root the probe resolves against is this checkout', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
