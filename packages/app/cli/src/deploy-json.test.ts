/**
 * A serving `rayspec deploy <spec.yaml> --json`, through the REAL built CLI.
 *
 * With `--json` the boot banners move to stderr and the process writes ONE result envelope on stdout
 * when it stops: `ok: true` after a signal-driven shutdown, `ok: false` with the refusal as
 * `RAY_CHECK_FAILED` when the boot is refused. Its exit codes are the ones it has without the flag:
 * 0 after a shutdown, 1 for a refusal. Without the flag the banner stays on stdout.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_DIST } from './test-support/bundles.js';

const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `deploy-json.test: SKIPPING — built CLI not found at ${CLI_DIST}; run \`pnpm build\` first.\n`,
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

const valid = schemaValidator('resultEnvelope');
const PORT = 23000 + (process.pid % 900);

const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata:
  name: deploy-json-ui
frontend:
  - { route: /, dir: web/dist, spa: true }
`;
const STORE_SPEC = `version: '1.0'
metadata:
  name: deploy-json-api
stores:
  - name: items
    columns:
      - { name: title, type: text }
`;

let root = '';
beforeAll(() => {
  if (!distBuilt) return;
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-deploy-json-'));
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(root, 'static.yaml'), FRONTEND_ONLY_SPEC);
  writeFileSync(join(root, 'store.yaml'), STORE_SPEC);
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Run {
  child: ChildProcess;
  out(): string;
  err(): string;
  exited: Promise<number | null>;
}

function deploy(args: string[]): Run {
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', ...args], {
    cwd: root,
    // Built explicitly so no ambient database URL or boot secret reaches the child.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RAYSPEC_SKIP_DOTENV: '1' },
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    err += String(d);
  });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, out: () => out, err: () => err, exited };
}

async function waitFor(run: Run, predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (run.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`deploy did not reach the expected state\n${run.out()}\n${run.err()}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

maybeDescribe('rayspec deploy --json (serving)', () => {
  it('a refused boot writes one ok:false envelope and exits 1', async () => {
    const run = deploy(['store.yaml', '--json', '--port', String(PORT)]);
    expect(await run.exited).toBe(1);
    const env = JSON.parse(run.out());
    expect(valid(env)).toBe(true);
    expect(env.operation).toBe('deploy.legacy');
    expect(env.ok).toBe(false);
    expect(env.errors[0].code).toBe('RAY_CHECK_FAILED');
    expect(env.errors[0].message).toMatch(/required/);
    expect(run.err().split('\n')[0]).toBe(`operationId: ${env.operationId}`);
  });

  it('a served deployment stopped by SIGTERM writes one ok:true envelope; banners go to stderr', async () => {
    const run = deploy(['static.yaml', '--json', '--port', String(PORT + 1)]);
    await waitFor(run, () => run.err().includes(`:${PORT + 1}`));
    expect(run.out()).toBe('');
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(0);
    const env = JSON.parse(run.out());
    expect(valid(env)).toBe(true);
    expect(env).toMatchObject({
      ok: true,
      operation: 'deploy.legacy',
      data: { ok: true, mode: 'serve', stoppedBy: 'SIGTERM' },
    });
    expect(env.warnings.map((w: { code: string }) => w.code)).toEqual(['RAY_W_LEGACY_OUTPUT']);
  });

  it('without --json the banner stays on stdout and no envelope is written', async () => {
    const run = deploy(['static.yaml', '--port', String(PORT + 2)]);
    await waitFor(run, () => run.out().includes(`:${PORT + 2}`));
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(run.out()).not.toContain('contractVersion');
    expect(run.err()).not.toContain('operationId');
  });
});
