/**
 * A module-resolution probe for the built CLI: a hook registered with `--import` records every
 * module the process resolves, so a test can show what a command loads and, above all, what it
 * never loads.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_DIST } from './bundles.js';

/** The module-resolution hook: every resolved URL is appended to the file named by the env. */
const HOOKS = `import { appendFileSync } from 'node:fs';
let log;
export function initialize(data) { log = data.log; }
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  appendFileSync(log, resolved.url + '\\n');
  return resolved;
}
`;
const REGISTER = `import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url), { data: { log: process.env.RAYSPEC_CLI_TEST_MODULE_LOG } });
`;

/**
 * Module locations a passive bundle command or `pack` must never load: the server, the database
 * layer, the platform (whose handler loader imports handler modules), the product composition,
 * the Postgres driver, the durable engine and the HTTP framework.
 */
export const FORBIDDEN_MODULES: readonly [string, RegExp][] = [
  ['the server', /\/packages\/app\/server\/|\/@rayspec\/server\//],
  ['the database layer', /\/packages\/kernel\/db\/|\/@rayspec\/db\//],
  ['the platform and its handler loader', /\/packages\/kernel\/platform\/|\/@rayspec\/platform\//],
  ['the product composition', /\/packages\/compose\/|\/@rayspec\/product-yaml\//],
  ['the Postgres driver', /\/node_modules\/postgres\//],
  ['the durable engine', /@dbos-inc/],
  ['the HTTP framework', /\/node_modules\/hono\/|@hono\//],
];

/** Write the hook and its registration into `dir`; returns the file to pass to `--import`. */
export function installModuleProbe(dir: string): string {
  writeFileSync(join(dir, 'hooks.mjs'), HOOKS);
  const register = join(dir, 'register.mjs');
  writeFileSync(register, REGISTER);
  return register;
}

export interface ProbedRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every module URL the process resolved, in order. */
  modules: string[];
}

/**
 * Run the built CLI under the probe with a minimal environment (no `.env` is loaded). `env` adds
 * variables; `timeout` turns a hang into a failure.
 */
export function runProbed(
  register: string,
  logDir: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string>; timeout?: number },
): ProbedRun {
  const log = join(logDir, `modules-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, '');
  const r = spawnSync(process.execPath, ['--import', register, CLI_DIST, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RAYSPEC_SKIP_DOTENV: '1',
      RAYSPEC_CLI_TEST_MODULE_LOG: log,
      ...options.env,
    },
  });
  const modules = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, modules };
}
