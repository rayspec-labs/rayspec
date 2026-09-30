/**
 * The deployment state directory on a real filesystem: its permission checks, the protected-file
 * checks the bindings file shares, the immutable content-addressed version directories, the active
 * version switched in one rename, the deployment record written once and the plan records.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import { closureFiles, closureManifest, resolveClosure } from '@rayspec/bundle-closure';
import type { ApplicationManifest } from '@rayspec/bundle-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  RUNTIME,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import {
  newDeploymentId,
  openStateDirectory,
  protectedFileRefusal,
  readProtectedFile,
  removeTree,
  StateDirectoryError,
  verifyVersion,
} from './deployment-state.js';

const stateRoots: string[] = [];

/** A fresh state directory; its read-only version directories are removed after the suite. */
async function freshState() {
  const dir = await openStateDirectory(join(temporaryDirectory('state-'), 's'), { create: true });
  if (dir === null) throw new Error('no state directory');
  stateRoots.push(dir.root);
  return dir;
}

afterAll(async () => {
  for (const root of stateRoots) await removeTree(root);
  removeTemporaryDirectories();
});

let bundlePath = '';
let bundleSha = '';
let manifest: ApplicationManifest;

beforeAll(async () => {
  const app = temporaryDirectory('state-app-');
  writeTree(app, {
    'rayspec.yaml': backendSpec(
      'api:\n  - { method: GET, path: /x, action: { kind: handler, handler: h } }\n' +
        'handlers:\n  - { id: h, module: handlers/h.js, export: handle, kind: route }\n',
    ),
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
    'handlers/h.js': 'export async function handle() { return { ok: true }; }\n',
  });
  const closure = await resolveClosure({
    specPath: join(app, 'rayspec.yaml'),
    runtimeVersion: RUNTIME,
  });
  if (!closure.ok) throw new Error(JSON.stringify(closure.errors));
  bundlePath = join(temporaryDirectory('state-bundle-'), 'app.ray');
  const written = await writeBundle(bundlePath, {
    manifest: closureManifest(closure.value),
    files: closureFiles(closure.value),
  });
  if (!written.ok) throw new Error(JSON.stringify(written.errors));
  bundleSha = written.value.archiveSha256;
  manifest = written.value.manifest as ApplicationManifest;
});

function refusalOf(err: unknown): { code: string; message: string } {
  if (!(err instanceof StateDirectoryError)) throw err;
  return err.error;
}

describe('openStateDirectory', () => {
  it('creates a missing directory with mode 0700, and returns null without create', async () => {
    const root = join(temporaryDirectory('state-'), 'state');
    expect(await openStateDirectory(root, { create: false })).toBeNull();
    expect(existsSync(root)).toBe(false);
    const dir = await openStateDirectory(root, { create: true });
    expect(dir?.root).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory open to others, a link and a file', async () => {
    const base = temporaryDirectory('state-');
    const open = join(base, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    await expect(
      openStateDirectory(open, { create: false }).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_BINDINGS_FILE_INSECURE' });
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, 'link'));
    await expect(
      openStateDirectory(join(base, 'link'), { create: false }).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_BINDINGS_FILE_INSECURE' });
    writeFileSync(join(base, 'file'), 'x');
    await expect(
      openStateDirectory(join(base, 'file'), { create: false }).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_USAGE' });
  });

  it('refuses to create a directory whose parent does not exist', async () => {
    const root = join(temporaryDirectory('state-'), 'missing', 'state');
    await expect(
      openStateDirectory(root, { create: true }).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_USAGE' });
  });
});

describe('protected files', () => {
  it('accepts an owner-only regular file and refuses a missing, open or linked one', async () => {
    const base = temporaryDirectory('protected-');
    const file = join(base, 'bindings.json');
    writeFileSync(file, '{"secret":"canary-value-4711"}', { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(await protectedFileRefusal(file, 'the bindings file')).toBeNull();
    expect((await readProtectedFile(file, 'the bindings file', 1024)).toString()).toContain(
      'canary',
    );

    expect((await protectedFileRefusal(join(base, 'none'), 'the bindings file'))?.error.code).toBe(
      'RAY_USAGE',
    );
    chmodSync(file, 0o644);
    const open = await protectedFileRefusal(file, 'the bindings file');
    expect(open?.error.code).toBe('RAY_BINDINGS_FILE_INSECURE');
    // The refusal names the file's role, never its content.
    expect(open?.error.message).not.toContain('canary');
    chmodSync(file, 0o640);
    expect((await protectedFileRefusal(file, 'the bindings file'))?.error.code).toBe(
      'RAY_BINDINGS_FILE_INSECURE',
    );
    chmodSync(file, 0o600);
    symlinkSync(file, join(base, 'link.json'));
    expect(
      (await protectedFileRefusal(join(base, 'link.json'), 'the bindings file'))?.error.code,
    ).toBe('RAY_BINDINGS_FILE_INSECURE');
    mkdirSync(join(base, 'dir'), { mode: 0o700 });
    expect((await protectedFileRefusal(join(base, 'dir'), 'the bindings file'))?.error.code).toBe(
      'RAY_BINDINGS_FILE_INSECURE',
    );
  });

  it('refuses a file larger than the limit', async () => {
    const file = join(temporaryDirectory('protected-'), 'big.json');
    writeFileSync(file, 'x'.repeat(2048), { mode: 0o600 });
    await expect(
      readProtectedFile(file, 'the bindings file', 1024).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_USAGE' });
  });
});

describe('version directories', () => {
  it('stages a bundle into a read-only directory named by its digest, and verifies it', async () => {
    const dir = await freshState();
    const root = await dir.stageVersion(bundlePath, bundleSha, manifest);
    expect(root).toBe(join(dir.root, 'versions', bundleSha));
    expect(readFileSync(join(root, 'payload', 'handlers', 'h.js'), 'utf8')).toContain('handle');
    expect(statSync(join(root, 'payload', 'handlers', 'h.js')).mode & 0o777).toBe(0o400);
    expect(statSync(join(root, 'payload')).mode & 0o777).toBe(0o500);
    // No staging directory is left behind.
    expect(readdirSync(join(dir.root, 'versions'))).toEqual([bundleSha]);
    // Staging the same bundle again verifies the existing directory and keeps it.
    expect(await dir.stageVersion(bundlePath, bundleSha, manifest)).toBe(root);
    await removeTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it('finds a changed, an added and a removed file in an existing version directory', async () => {
    const dir = await freshState();
    const root = await dir.stageVersion(bundlePath, bundleSha, manifest);
    const handler = join(root, 'payload', 'handlers', 'h.js');

    chmodSync(join(root, 'payload', 'handlers'), 0o700);
    chmodSync(handler, 0o600);
    writeFileSync(handler, 'export async function handle() { return { changed: true }; }\n');
    await expect(
      dir.stageVersion(bundlePath, bundleSha, manifest).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_DIGEST_MISMATCH' });
    await removeTree(root);

    const again = await dir.stageVersion(bundlePath, bundleSha, manifest);
    chmodSync(join(again, 'payload'), 0o700);
    writeFileSync(join(again, 'payload', 'extra.js'), 'export {};\n');
    await expect(verifyVersion(again, manifest).catch(refusalOf)).resolves.toMatchObject({
      code: 'RAY_DIGEST_MISMATCH',
    });
    await removeTree(again);

    const third = await dir.stageVersion(bundlePath, bundleSha, manifest);
    chmodSync(join(third, 'payload', 'handlers'), 0o700);
    symlinkSync('/etc/hosts', join(third, 'payload', 'handlers', 'x.js'));
    await expect(verifyVersion(third, manifest).catch(refusalOf)).resolves.toMatchObject({
      code: 'RAY_DIGEST_MISMATCH',
    });
  });

  it('refuses a bundle whose bytes are not the digest it was planned under, leaving nothing', async () => {
    const dir = await freshState();
    await expect(
      dir.stageVersion(bundlePath, 'b'.repeat(64), manifest).catch(refusalOf),
    ).resolves.toMatchObject({ code: 'RAY_DIGEST_MISMATCH' });
    expect(readdirSync(join(dir.root, 'versions'))).toEqual([]);
  });
});

describe('records', () => {
  it('writes the deployment record once and keeps the first one', async () => {
    const dir = await freshState();
    expect(await dir.readDeployment()).toBeNull();
    const id = newDeploymentId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    const first = {
      deploymentFormatVersion: 1 as const,
      deploymentId: id,
      createdAt: '2026-09-30T12:00:00Z',
      applicationId: 'probe-app',
    };
    expect(await dir.createDeployment(first)).toEqual(first);
    expect(await dir.createDeployment({ ...first, deploymentId: newDeploymentId() })).toEqual(
      first,
    );
    expect(await dir.readDeployment()).toEqual(first);
    expect(statSync(join(dir.root, 'deployment.json')).mode & 0o777).toBe(0o600);
  });

  it('switches the active version in one rename, leaving no temporary file', async () => {
    const dir = await freshState();
    expect(await dir.readActive()).toBeNull();
    await dir.writeActive({
      bundleSha256: 'a'.repeat(64),
      activatedAt: '2026-09-30T12:00:00Z',
      environmentRevision: 2,
    });
    await dir.writeActive({
      bundleSha256: 'b'.repeat(64),
      activatedAt: '2026-09-30T12:01:00Z',
      environmentRevision: 3,
    });
    expect((await dir.readActive())?.bundleSha256).toBe('b'.repeat(64));
    expect(readdirSync(dir.root)).toEqual(['active.json']);
    expect(lstatSync(join(dir.root, 'active.json')).isFile()).toBe(true);
  });

  it('refuses an active record that is a link', async () => {
    const dir = await freshState();
    const elsewhere = join(temporaryDirectory('state-'), 'active.json');
    writeFileSync(elsewhere, '{}', { mode: 0o600 });
    symlinkSync(elsewhere, join(dir.root, 'active.json'));
    await expect(dir.readActive().catch(refusalOf)).resolves.toMatchObject({
      code: 'RAY_BINDINGS_FILE_INSECURE',
    });
  });

  it('round-trips a plan record by its digest', async () => {
    const dir = await freshState();
    const digest = 'c'.repeat(64);
    expect(await dir.readPlanRecord(digest)).toBeNull();
    const path = await dir.writePlanRecord(digest, { planFormatVersion: 1, bundlePath: '/x.ray' });
    expect(path).toBe(join(dir.root, 'plans', `${digest}.json`));
    expect(await dir.readPlanRecord(digest)).toEqual({
      planFormatVersion: 1,
      bundlePath: '/x.ray',
    });
    expect(() => dir.planPath('../escape')).toThrow(RangeError);
  });
});
