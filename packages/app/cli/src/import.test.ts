/**
 * `rayspec import` before it reaches a database: the command line, the configuration it requires
 * (the target's migration role), the protected identity file, and `--discard-failed` on a state
 * directory that holds no failed import. Every answer is one valid result envelope; nothing here
 * opens a connection (the database URLs name a port nothing listens on).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor, schemaValidator } from '@rayspec/bundle-contract';
import { generateX25519Identity } from 'age-encryption';
import { afterAll, describe, expect, it } from 'vitest';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { parseImportArgs, runImport } from './import.js';

const valid = schemaValidator('resultEnvelope');
afterAll(() => removeTemporaryDirectories());

const UNREACHABLE = {
  DATABASE_URL: 'postgres://runtime:pw@127.0.0.1:1/target',
  RAYSPEC_MIGRATION_DATABASE_URL: 'postgres://migrator:pw@127.0.0.1:1/target',
};

async function run(args: string[], env: NodeJS.ProcessEnv = UNREACHABLE) {
  const outcome = await runImport(args, {
    operationId: randomUUID(),
    json: true,
    env: { PATH: process.env.PATH ?? '', ...env },
    progress: () => {},
  });
  expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
  const first = outcome.envelope.errors[0];
  return {
    code: first?.code ?? 'ok',
    reason: first?.reason,
    message: first?.message ?? '',
    exit: exitCodeFor(outcome.envelope.errors),
    envelope: outcome.envelope,
  };
}

describe('parseImportArgs', () => {
  it('requires the bundle, the target and the identity file, and keeps --discard-failed alone', () => {
    const usage = (args: string[]) => {
      try {
        parseImportArgs(args);
        return 'parsed';
      } catch (err) {
        return (err as { errors?: { code: string }[] }).errors?.[0]?.code ?? 'thrown';
      }
    };
    expect(usage(['m.ray', '--identity-file', 'k'])).toBe('RAY_USAGE');
    expect(usage(['m.ray', '--target', 't'])).toBe('RAY_USAGE');
    expect(usage(['--target', 't', '--identity-file', 'k'])).toBe('RAY_USAGE');
    expect(usage(['a.ray', 'b.ray', '--target', 't', '--identity-file', 'k'])).toBe('RAY_USAGE');
    expect(
      usage([
        'm.ray',
        '--target',
        't',
        '--identity-file',
        'k',
        '--dry-run',
        '--bindings-file',
        'b',
      ]),
    ).toBe('RAY_USAGE');
    expect(usage(['m.ray', '--target', 't', '--discard-failed'])).toBe('RAY_USAGE');
    expect(usage(['--target', 't', '--discard-failed', '--dry-run'])).toBe('RAY_USAGE');
    expect(usage(['m.ray', '--target', 't', '--identity-file', 'k', '--unknown'])).toBe(
      'RAY_USAGE',
    );
    expect(
      parseImportArgs(['m.ray', '--target', 't', '--identity-file', 'k', '--dry-run']),
    ).toMatchObject({
      bundle: 'm.ray',
      target: 't',
      identityFile: 'k',
      dryRun: true,
      discardFailed: false,
    });
    expect(parseImportArgs(['--target', 't', '--discard-failed'])).toMatchObject({
      bundle: null,
      discardFailed: true,
    });
  });
});

describe('runImport before a database', () => {
  async function identityFile(mode: number, text?: string): Promise<string> {
    const path = join(temporaryDirectory('import-identity-'), 'identity.txt');
    writeFileSync(path, text ?? `${await generateX25519Identity()}\n`);
    chmodSync(path, mode);
    return path;
  }
  const args = (identity: string, target = join(temporaryDirectory('import-target-'), 'state')) => [
    join(temporaryDirectory('import-bundle-'), 'missing.ray'),
    '--target',
    target,
    '--identity-file',
    identity,
    '--dry-run',
  ];

  it('refuses an import without the migration role, and a relative pg_restore', async () => {
    const identity = await identityFile(0o600);
    const noMigration = await run(args(identity), { DATABASE_URL: UNREACHABLE.DATABASE_URL });
    expect(noMigration).toMatchObject({ code: 'RAY_USAGE', exit: 2 });
    expect(noMigration.message).toContain('RAYSPEC_MIGRATION_DATABASE_URL');
    const relative = await run(args(identity), {
      ...UNREACHABLE,
      RAYSPEC_PG_RESTORE: 'bin/pg_restore',
    });
    expect(relative).toMatchObject({ code: 'RAY_USAGE' });
    expect(relative.message).toContain('RAYSPEC_PG_RESTORE');
  });

  it('refuses an identity file others can read, and one that holds no X25519 identity, without printing it', async () => {
    const open = await run(args(await identityFile(0o644)));
    expect(open).toMatchObject({ code: 'RAY_BINDINGS_FILE_INSECURE', exit: 4 });
    const keys = [await generateX25519Identity(), await generateX25519Identity()];
    const two = await run(args(await identityFile(0o600, `${keys.join('\n')}\n`)));
    expect(two).toMatchObject({ code: 'RAY_USAGE', exit: 2 });
    for (const key of keys) expect(JSON.stringify(two.envelope)).not.toContain(key);
  });

  it('refuses a target state directory open to others', async () => {
    const target = join(temporaryDirectory('import-target-'), 'open');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    expect(await run(args(await identityFile(0o600), target))).toMatchObject({
      code: 'RAY_BINDINGS_FILE_INSECURE',
      exit: 4,
    });
  });

  it('discards nothing where no import failed, and never a deployment', async () => {
    const empty = join(temporaryDirectory('import-target-'), 'state');
    expect(await run(['--target', empty, '--discard-failed'])).toMatchObject({
      code: 'ok',
      exit: 0,
    });
    const deployed = join(temporaryDirectory('import-target-'), 'state');
    mkdirSync(deployed, { mode: 0o700 });
    writeFileSync(
      join(deployed, 'deployment.json'),
      JSON.stringify({
        deploymentFormatVersion: 1,
        deploymentId: '0123456789abcdef',
        createdAt: '2026-10-01T08:00:00Z',
        applicationId: 'notes',
      }),
      { mode: 0o600 },
    );
    expect(await run(['--target', deployed, '--discard-failed'])).toMatchObject({
      code: 'RAY_USAGE',
      exit: 2,
    });
    // A target that already holds a deployment is not imported into.
    const refused = await run(args(await identityFile(0o600), deployed));
    expect(refused).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY', exit: 4 });
  });
});
