/**
 * Anthropic adapter — what the REAL child process is given. No network, no credentials.
 *
 * The same technique as `cancellation.real-process.test.ts`: the real SDK spawns a `.mjs` stand-in
 * for the `claude` binary (`pathToClaudeCodeExecutable`), which writes the environment it received to
 * a file and exits. The claim under test is the one the adapter makes about isolation: the child
 * gets this backend's own credential and its per-tenant config directory, and never another
 * provider's key, a database connection, a platform setting, or a credential of another agent left in
 * this process's environment.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, AuthMode, RunContext, StepReport } from '@rayspec/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter, anthropicChildEnv } from './index.js';

const tempDirs: string[] = [];
const ENV_NAMES = [
  'OPENAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DATABASE_URL',
  'RAYSPEC_API_KEY_PEPPER',
  'PGPASSWORD',
  'DBOS_SYSTEM_DATABASE_URL',
] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class NoopJournal {
  async lookup(): Promise<{ output: unknown } | null> {
    return null;
  }
  async lookupToolCache(): Promise<{ output: unknown } | null> {
    return null;
  }
  async record(_step: StepReport & { authMode: AuthMode }): Promise<string> {
    return 'step';
  }
}

const spec: AgentSpec = {
  name: 'isolation-probe',
  instructions: 'You are a probe.',
  model: 'claude-haiku-4-5',
  input: 'report your environment',
  maxTurns: 1,
  tools: [],
};

/** Run once against a stand-in child that dumps its environment; return what it received. */
async function childEnvironment(adapterCredentials?: {
  apiKey?: string;
  oauthToken?: string;
}): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-anth-env-'));
  tempDirs.push(dir);
  const dump = join(dir, 'env.json');
  const exePath = join(dir, 'fake-claude.mjs');
  writeFileSync(
    exePath,
    [
      `import { writeFileSync } from 'node:fs';`,
      `writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));`,
      `process.exit(0);`,
      '',
    ].join('\n'),
  );
  const configRoot = mkdtempSync(join(tmpdir(), 'rayspec-anth-env-root-'));
  tempDirs.push(configRoot);
  const adapter = new AnthropicAdapter({
    configRoot,
    pathToClaudeCodeExecutable: exePath,
    ...(adapterCredentials !== undefined ? { credentials: adapterCredentials } : {}),
  });
  const ctx: RunContext = {
    runId: `run-${randomUUID()}`,
    tenantId: 'tenant-a',
    journal: new NoopJournal(),
    replay: false,
    tools: [],
    onEvent: async () => {},
  };
  // The stand-in speaks no protocol, so the run fails once it exits; only its environment matters.
  await adapter.run(spec, ctx).catch(() => undefined);
  for (let i = 0; !existsSync(dump) && i < 200; i++) await sleep(25);
  return JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
}

describe('the anthropic child receives its own credential and nothing else of the kind', () => {
  it('withholds other providers keys, database URLs and platform settings', { timeout: 30_000 }, async () => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    const canary = (what: string) => `canary-${what}-${randomUUID()}`;
    process.env.OPENAI_API_KEY = canary('openai');
    process.env.DEEPGRAM_API_KEY = canary('deepgram');
    process.env.CODEX_API_KEY = canary('codex');
    process.env.DATABASE_URL = `postgres://app:${canary('db')}@db.internal/app`;
    process.env.RAYSPEC_API_KEY_PEPPER = canary('pepper');
    process.env.PGPASSWORD = canary('pg');
    process.env.DBOS_SYSTEM_DATABASE_URL = `postgres://sys:${canary('sys')}@db.internal/sys`;
    // Another agent's Anthropic key, left in the environment: this backend was given its own token.
    process.env.ANTHROPIC_API_KEY = canary('other-agent');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const own = canary('own-token');

    const env = await childEnvironment({ oauthToken: own });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(own);
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/tenant-tenant-a$/);
    expect(env.PATH).toBe(process.env.PATH);
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPGRAM_API_KEY',
      'CODEX_API_KEY',
      'DATABASE_URL',
      'RAYSPEC_API_KEY_PEPPER',
      'PGPASSWORD',
      'DBOS_SYSTEM_DATABASE_URL',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    const everything = JSON.stringify(env);
    expect(everything).not.toContain('canary-openai');
    expect(everything).not.toContain('canary-other-agent');
    expect(everything).not.toContain('canary-db');
  });

  it('without explicit credentials, reads its own two from the environment, and still nothing else', { timeout: 30_000 }, async () => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-from-the-environment';
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'openai-key-from-the-environment';

    const env = await childEnvironment();

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-from-the-environment');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('anthropicChildEnv', () => {
  it('copies what is not withheld, then sets the credentials and the config directory', () => {
    const env = anthropicChildEnv(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.internal:3128',
        ANTHROPIC_BASE_URL: 'https://gateway.internal',
        RAYSPEC_HOSTING_POSTURE: 'managed',
        CLOUD_PROVIDER_TOKEN: 'x',
        OPENAI_API_KEY_FILE: '/run/secrets/openai',
        UNSET: undefined,
      },
      { apiKey: 'own-key' },
      '/var/rayspec/anthropic/tenant-a',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.internal:3128',
      ANTHROPIC_BASE_URL: 'https://gateway.internal',
      ANTHROPIC_API_KEY: 'own-key',
      CLAUDE_CONFIG_DIR: '/var/rayspec/anthropic/tenant-a',
    });
  });
});
