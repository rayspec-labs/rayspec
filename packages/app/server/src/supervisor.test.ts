/**
 * The supervisor's own decisions, without a database: what a message from the application process
 * may be, the environment that process is started with, the same-user conditions, the order of the
 * schema steps, how a step's refusal crosses the channel, and how the supervisor ends. A child that
 * speaks the channel by hand shows the protocol refusal and the ending of a real process.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DeployError } from '@rayspec/api-auth';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import type { ServerConfig } from './composition-root.js';
import { RuntimeApplyError } from './deploy-apply.js';
import { ProductBootError } from './product-boot.js';
import {
  childEnvironment,
  parseChildMessage,
  privilegedSecretValues,
  refusalError,
  SchemaSteps,
  type SuperviseOptions,
  SupervisorProtocolError,
  sameUserConditions,
  serializeRefusal,
  superviseServing,
  supervisorEnding,
} from './supervisor.js';
import { takeSupervisorHandoff } from './supervisor-handoff.js';

const here = dirname(fileURLToPath(import.meta.url));

const PASSWORD = ['long', 'enough', 'password'].join('-');
const MIGRATION = `postgres://migrator:${PASSWORD}@127.0.0.1:1/app`;
const SNAPSHOT_PASSWORD = ['other', 'snapshot', 'password'].join('-');
const SNAPSHOT = `postgres://snapshotter:${SNAPSHOT_PASSWORD}@127.0.0.1:1/app`;

const temporary: string[] = [];
/** A temporary directory, removed when the file ends. */
function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe('parseChildMessage', () => {
  const request = (fields: Record<string, unknown>) => ({
    type: 'request',
    protocol: 1,
    id: 1,
    ...fields,
  });

  it('accepts each step with exactly its fields', () => {
    expect(parseChildMessage({ type: 'serving', protocol: 1 })).toEqual({ type: 'serving' });
    expect(parseChildMessage(request({ step: 'platform-chain' }))).toMatchObject({
      step: 'platform-chain',
    });
    expect(
      parseChildMessage(
        request({ step: 'before-schema-change', facts: { blobBackend: { kind: 'fs' } } }),
      ),
    ).toMatchObject({ facts: { blobBackend: { kind: 'fs' } } });
    expect(
      parseChildMessage(request({ step: 'product-migration', name: '0000_product_stores.sql' })),
    ).toMatchObject({ name: '0000_product_stores.sql' });
  });

  it('refuses an unknown type, step, field, protocol, id or an oversized message', () => {
    const refused = [
      'not an object',
      { type: 'serving', protocol: 2 },
      { type: 'serving', protocol: 1, extra: 1 },
      { type: 'shell', protocol: 1 },
      request({ step: 'run-sql', sql: 'DROP TABLE orgs' }),
      request({ step: 'platform-chain', sql: 'SELECT 1' }),
      request({ step: 'platform-chain', id: 0 }),
      request({ step: 'before-schema-change', facts: { blobBackend: { kind: 'cloud' } } }),
      request({ step: 'before-schema-change', facts: { other: true } }),
      request({ step: 'product-migration', name: '' }),
      request({ step: 'product-migration', name: 'x.sql', sql: 'DROP TABLE orgs' }),
      request({ step: 'tenant-isolation', padding: 'x'.repeat(70_000) }),
      request({ step: 'product-migration', name: 'x.sql', specSource: 'x'.repeat(5_000_000) }),
    ];
    for (const message of refused) expect(typeof parseChildMessage(message)).toBe('string');
  });
});

describe('childEnvironment', () => {
  const secrets = privilegedSecretValues({
    RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
    RAYSPEC_SNAPSHOT_DATABASE_URL: SNAPSHOT,
  });

  it('drops the connections, their file forms and the handoff, and turns .env loading off', () => {
    const env = childEnvironment(
      {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgres://runtime:r@127.0.0.1:1/app',
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        RAYSPEC_MIGRATION_DATABASE_URL_FILE: '/run/secrets/migration',
        RAYSPEC_SNAPSHOT_DATABASE_URL: MIGRATION,
        RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
        RAYSPEC_SUPERVISOR_HANDOFF: '/tmp/x/handoff.json',
      },
      secrets,
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://runtime:r@127.0.0.1:1/app',
      RAYSPEC_SKIP_DOTENV: '1',
    });
  });

  it('refuses a privileged connection or its password under another name, naming the variable only', () => {
    for (const value of [
      MIGRATION,
      `prefix-${PASSWORD}`,
      SNAPSHOT,
      `prefix-${SNAPSHOT_PASSWORD}`,
    ]) {
      let thrown: unknown;
      try {
        childEnvironment({ APP_SETTING: value }, secrets);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, value).toBeInstanceOf(BootConfigError);
      expect((thrown as Error).message).toContain('APP_SETTING');
      expect((thrown as Error).message).not.toContain(PASSWORD);
      expect((thrown as Error).message).not.toContain(SNAPSHOT_PASSWORD);
    }
  });
});

describe('sameUserConditions', () => {
  const linux = (files: Record<string, string>) => ({
    platform: 'linux' as const,
    read: (path: string) => files[path],
  });
  const LIMITS = (hard: string) =>
    `Limit                     Soft Limit           Hard Limit           Units\nMax core file size        0                    ${hard}                bytes\n`;

  it('holds for a handed-off connection on a kernel that keeps the supervisor private', () => {
    const handoff = join(temporaryDirectory('rayspec-handoff-'), 'handoff.json');
    writeFileSync(
      handoff,
      JSON.stringify({
        handoffFormatVersion: 1,
        values: { RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION },
      }),
      { mode: 0o600 },
    );
    takeSupervisorHandoff({ serving: true }, { RAYSPEC_SUPERVISOR_HANDOFF: handoff });
    expect(
      sameUserConditions(
        { RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION },
        linux({
          '/proc/sys/kernel/yama/ptrace_scope': '1\n',
          '/proc/self/limits': LIMITS('0'),
        }),
      ),
    ).toEqual([]);
  });

  it('names a file mount, a .env value, an open ptrace scope and a core limit', () => {
    takeSupervisorHandoff({ serving: true }, {});
    const open = sameUserConditions(
      {
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
      },
      linux({
        '/proc/sys/kernel/yama/ptrace_scope': '0',
        '/proc/self/limits': LIMITS('unlimited'),
      }),
    );
    expect(open.join('\n')).toMatch(/RAYSPEC_MIGRATION_DATABASE_URL was read from a \.env file/);
    expect(open.join('\n')).toMatch(/RAYSPEC_SNAPSHOT_DATABASE_URL_FILE names a file/);
    expect(open.join('\n')).toMatch(/ptrace_scope/);
    expect(open.join('\n')).toMatch(/core file/);
    for (const line of open) expect(line).not.toContain(PASSWORD);
  });

  it('asks nothing of the kernel elsewhere', () => {
    takeSupervisorHandoff({ serving: true }, { RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION });
    expect(
      sameUserConditions(
        { RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION },
        { platform: 'darwin', read: () => undefined },
      ),
    ).toEqual([expect.stringContaining("stays in the supervisor's environment block")]);
  });
});

describe('SchemaSteps', () => {
  const config = {
    migrationDatabaseUrl: MIGRATION,
    databaseUrl: 'postgres://runtime:r@127.0.0.1:1/app',
  } as ServerConfig;

  it('refuses a step out of the boot order before it touches a database', async () => {
    const steps = new SchemaSteps({ config, warn: () => {} });
    for (const step of ['tenant-isolation', 'workflow-system-schema', 'schema-done'] as const) {
      await expect(steps.run({ type: 'request', id: 1, step })).rejects.toBeInstanceOf(
        SupervisorProtocolError,
      );
    }
    await expect(
      steps.run({ type: 'request', id: 1, step: 'product-migration', name: 'x.sql' }),
    ).rejects.toBeInstanceOf(SupervisorProtocolError);
  });

  it('accepts nothing once closed', async () => {
    const steps = new SchemaSteps({ config, warn: () => {} });
    await steps.close();
    await expect(
      steps.run({ type: 'request', id: 1, step: 'platform-chain' }),
    ).rejects.toBeInstanceOf(SupervisorProtocolError);
  });
});

describe('a refusal across the channel', () => {
  it('keeps its class, its message and its data', () => {
    const errors = [{ code: 'RAY_FENCED', message: 'the environment is fenced' }] as never;
    const apply = refusalError(serializeRefusal(new RuntimeApplyError(errors)));
    expect(apply).toBeInstanceOf(RuntimeApplyError);
    expect((apply as RuntimeApplyError).exitCode).toBe(new RuntimeApplyError(errors).exitCode);
    const config = refusalError(serializeRefusal(new BootConfigError('Boot aborted — x', ['A'])));
    expect(config).toBeInstanceOf(BootConfigError);
    expect((config as BootConfigError).missing).toEqual(['A']);
    const product = refusalError(serializeRefusal(new ProductBootError('bad')));
    expect(product).toBeInstanceOf(ProductBootError);
    expect(product.message).toBe('Boot aborted (Product-YAML) — bad');
    const deploy = refusalError(serializeRefusal(new DeployError('lint/gate', 'blocked')));
    expect(deploy).toBeInstanceOf(DeployError);
    expect(deploy.message).toBe('deploy aborted at [lint/gate]: blocked');
    expect(refusalError(serializeRefusal(new Error('plain'))).message).toBe('plain');
  });
});

describe('supervisorEnding', () => {
  const base = { code: null, signal: null, served: true } as const;

  it('ends with the application process: its code, the forwarded signal, or 1 with a reason', () => {
    expect(supervisorEnding({ ...base, code: 0 })).toEqual({ code: 0, unreported: false });
    expect(supervisorEnding({ ...base, code: 4, served: false })).toEqual({
      code: 4,
      unreported: false,
    });
    expect(supervisorEnding({ ...base, code: 0, forwarded: 'SIGTERM' })).toEqual({
      code: 0,
      unreported: false,
    });
    expect(supervisorEnding({ ...base, signal: 'SIGTERM', forwarded: 'SIGTERM' })).toEqual({
      code: 1,
      signal: 'SIGTERM',
      unreported: false,
    });
    expect(supervisorEnding({ ...base, signal: 'SIGKILL' })).toEqual({
      code: 1,
      reason: 'the application process ended (signal SIGKILL)',
      unreported: true,
    });
    // An exit after serving: the reason is printed, but the application process reported itself.
    expect(supervisorEnding({ ...base, code: 7 })).toEqual({
      code: 7,
      reason: 'the application process exited with code 7',
      unreported: false,
    });
    const violation = supervisorEnding({ ...base, signal: 'SIGKILL', violation: 'x' });
    expect(violation.reason).toMatch(/broke the supervisor protocol \(x\)/);
    expect(violation.unreported).toBe(true);
    const timedOut = supervisorEnding({ ...base, signal: 'SIGKILL', timedOutAfterMs: 40_000 });
    expect(timedOut.reason).toMatch(/did not stop within 40000 ms/);
    expect(timedOut.unreported).toBe(true);
  });
});

describe('guardSupervisorImports', () => {
  it('refuses a module in an application directory, in a real Node process', () => {
    const dir = temporaryDirectory('supervisor-guard-');
    writeFileSync(join(dir, 'canary.mjs'), 'export const loaded = true;\n');
    const probe = join(temporaryDirectory('supervisor-guard-probe-'), 'probe.mjs');
    writeFileSync(
      probe,
      `import { guardSupervisorImports } from ${JSON.stringify(pathToFileURL(join(here, 'supervisor-guard.ts')).href)};\n` +
        `const canary = ${JSON.stringify(pathToFileURL(join(dir, 'canary.mjs')).href)};\n` +
        'const remove = guardSupervisorImports([' +
        JSON.stringify(dir) +
        ']);\n' +
        "let guarded = 'loaded';\n" +
        'try { await import(canary); } catch (err) { guarded = err.message; }\n' +
        'remove();\n' +
        "const after = (await import(canary + '?again')).loaded;\n" +
        'console.log(JSON.stringify({ guarded, after }));\n',
    );
    const run = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { guarded: string; after: boolean };
    expect(out.guarded).toMatch(/does not load application code/);
    expect(out.after).toBe(true);
  });
});

describe('an in-process boot handed the migration connection', () => {
  // The real composition root: the suites' setup names every boot of theirs a test harness.
  const boot = async () =>
    (await vi.importActual<typeof import('./composition-root.js')>('./composition-root.js'))
      .assembleServer;
  const config = {
    migrationDatabaseUrl: MIGRATION,
    databaseUrl: 'postgres://runtime:r@127.0.0.1:1/app',
    hostingPosture: 'local',
  } as ServerConfig;

  it('warns outside the managed posture that the application code can reach the migration role', async () => {
    const assembleServer = await boot();
    const { UNSUPERVISED_ROLE_SEPARATION_WARNING } = await import('./composition-root.js');
    const warned: string[] = [];
    // The configuration is not one that boots: only what the boot says before it refuses counts.
    await assembleServer(config, { bootWarn: (line) => warned.push(line) }).catch(() => {});
    expect(warned).toContain(UNSUPERVISED_ROLE_SEPARATION_WARNING);
    expect(UNSUPERVISED_ROLE_SEPARATION_WARNING).toMatch(/rayspec deploy.*rayspec-serve/);

    const quiet: string[] = [];
    await assembleServer(
      { ...config, migrationDatabaseUrl: undefined },
      { bootWarn: (line) => quiet.push(line) },
    ).catch(() => {});
    await assembleServer(config, {
      bootWarn: (line) => quiet.push(line),
      unsupervisedPrivilege: 'test-harness',
    }).catch(() => {});
    expect(quiet).not.toContain(UNSUPERVISED_ROLE_SEPARATION_WARNING);
  });
});

describe('superviseServing with a child that speaks the channel by hand', () => {
  const config = {
    migrationDatabaseUrl: MIGRATION,
    databaseUrl: 'postgres://runtime:r@127.0.0.1:1/app',
    hostingPosture: 'local',
  } as ServerConfig;

  function child(source: string): string {
    const dir = temporaryDirectory('supervised-child-');
    const file = join(dir, 'child.mjs');
    writeFileSync(file, source);
    return file;
  }

  const supervise = (entry: string, overrides: Partial<SuperviseOptions> = {}) =>
    superviseServing({
      config,
      entry,
      instruction: { kind: 'test' },
      prefix: '[test]',
      privileged: { RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION },
      applicationDirectories: [],
      drainMs: 1_000,
      updateMigrations: [],
      warn: () => {},
      ...overrides,
    });

  /** The text of `path` once it exists, or undefined when it does not within `ms`. */
  async function written(path: string, ms: number): Promise<string | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        if (Date.now() > deadline) return undefined;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  it('stops a child that asks for something the protocol does not have', async () => {
    const exit = await supervise(
      child(
        "process.on('message', () => process.send({ type: 'request', protocol: 1, id: 1, step: 'run-sql', sql: 'SELECT 1' }));\n" +
          'setInterval(() => {}, 1000);\n',
      ),
    );
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.violation).toBe('a request for an unknown step');
  });

  it('starts the child with the instruction and no privileged value, and ends with its code', async () => {
    const exit = await supervise(
      child(
        "process.on('message', (m) => {\n" +
          '  const leaked = Object.entries(process.env).filter(([k, v]) => k.includes("MIGRATION") || String(v).includes(' +
          JSON.stringify(PASSWORD) +
          '));\n' +
          "  process.send({ type: 'serving', protocol: 1 });\n" +
          "  process.exit(m.instruction.kind === 'test' && leaked.length === 0 && process.env.RAYSPEC_SKIP_DOTENV === '1' ? 3 : 9);\n" +
          '});\n',
      ),
    );
    expect(exit).toMatchObject({ code: 3, signal: null, served: true });
  });

  it('kills a child that does not stop within its drain and the grace after a forwarded SIGTERM', async () => {
    const ready = join(temporaryDirectory('supervised-ready-'), 'pid');
    const entry = child(
      "import { writeFileSync } from 'node:fs';\n" +
        "process.on('SIGTERM', () => {});\n" +
        `process.on('message', () => writeFileSync(${JSON.stringify(ready)}, String(process.pid)));\n` +
        'setInterval(() => {}, 1000);\n',
    );
    const before = new Set(process.listeners('SIGTERM'));
    const exiting = supervise(entry, { drainMs: 100, shutdownGraceMs: 200 });
    // The supervisor's own SIGTERM listener, called as the signal would call it.
    const forward = process.listeners('SIGTERM').find((listener) => !before.has(listener));
    expect(forward).toBeDefined();
    const pid = Number(await written(ready, 10_000));
    expect(pid).toBeGreaterThan(0);
    (forward as () => void)();
    const exit = await Promise.race([
      exiting,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000)),
    ]);
    if (exit === undefined) {
      // Never killed: end the child here, so the failure leaves no process behind.
      process.kill(pid, 'SIGKILL');
      await exiting;
    }
    expect(exit).toMatchObject({ signal: 'SIGKILL', forwarded: 'SIGTERM', timedOutAfterMs: 300 });
    const ending = supervisorEnding(exit as NonNullable<typeof exit>);
    expect(ending).toMatchObject({ code: 1, unreported: true });
    expect(ending.reason).toMatch(/did not stop within 300 ms/);
  });

  it('refuses to load a module from the application directories while it supervises', async () => {
    const app = temporaryDirectory('supervised-app-');
    const canary = join(app, 'canary.cjs');
    writeFileSync(canary, 'module.exports = { loaded: true };\n');
    const load = (): string => {
      try {
        return createRequire(import.meta.url)(canary).loaded === true ? 'loaded' : 'empty';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const exiting = supervise(child("process.on('message', () => process.exit(0));\n"), {
      applicationDirectories: [app],
    });
    const during = load();
    expect((await exiting).code).toBe(0);
    expect(during).toMatch(/the supervisor does not load application code/);
    // The guard goes with the child.
    expect(load()).toBe('loaded');
  });

  it('refuses a managed boot while a same-user condition is open, and only warns under another posture', async () => {
    const probe = {
      platform: 'linux' as const,
      read: (path: string) => (path.endsWith('ptrace_scope') ? '0\n' : undefined),
    };
    const entry = child("process.on('message', () => process.exit(0));\n");
    const managed = supervise(entry, {
      config: { ...config, hostingPosture: 'managed' },
      sameUserProbe: probe,
    });
    await expect(managed).rejects.toBeInstanceOf(BootConfigError);
    await expect(managed).rejects.toThrow(/managed hosting posture.*ptrace_scope/s);

    const warnings: string[] = [];
    const exit = await supervise(entry, {
      sameUserProbe: probe,
      warn: (line) => warnings.push(line),
    });
    expect(exit.code).toBe(0);
    expect(warnings.join('\n')).toMatch(/WARNING — the kernel lets a process read the memory/);
  });
});
