/**
 * Canary secrets, one for each kind of binding the runtime holds, through every sink the platform
 * writes to: log lines, error envelopes (HTTP and runtime control), and traces (a run's recorded
 * error and the agent SDK's trace export). Each canary is registered the way production registers it
 * — read through the reader that resolves it — never by calling the registry directly; the assertion
 * is that no canary survives any sink. (Receipts are proven against the database in
 * `operation-lease.db.test.ts`; the bundle deploy's own output in `packages/app/cli`.)
 */

import { Console } from 'node:console';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { errorEnvelope } from '@rayspec/auth-core';
import { bundleError, type ResultEnvelope } from '@rayspec/bundle-contract';
import {
  classifyUpstreamError,
  installOutputRedaction,
  resetRegisteredSecretsForTests,
} from '@rayspec/core';
import { setApplicationBindings } from '@rayspec/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedactingTraceExporter } from './agent-tracing.js';
import { loadServerConfig } from './composition-root.js';
import {
  grantProviderCredentials,
  providerCredential,
  resetGrantedProviderCredentialsForTests,
} from './provider-credentials.js';
import { type RuntimeControlAdapter, withRedactedEnvelopes } from './runtime-control.js';

const canary = (kind: string) => `canary-${kind}-${randomUUID()}`;

/** One canary per kind of binding, each registered by the reader that resolves it in production. */
const CANARIES = {
  providerKeyFromFile: canary('provider-file'),
  providerKeyFromBindingsFile: canary('provider-bindings'),
  providerKeyFromEnvironment: canary('provider-env'),
  applicationSecret: canary('app-secret'),
  applicationConfig: canary('app-config'),
  bootSecret: canary('pepper'),
};

const dir = mkdtempSync(join(tmpdir(), 'rayspec-canaries-'));

beforeAll(() => {
  resetRegisteredSecretsForTests();
  // A provider key from its _FILE, as the boot reads it.
  const keyFile = join(dir, 'openai-key');
  writeFileSync(keyFile, CANARIES.providerKeyFromFile);
  chmodSync(keyFile, 0o600);
  expect(providerCredential({ OPENAI_API_KEY_FILE: keyFile }, 'OPENAI_API_KEY')).toBe(
    CANARIES.providerKeyFromFile,
  );
  // A provider key a bundle deploy granted from its bindings file.
  grantProviderCredentials(new Map([['DEEPGRAM_API_KEY', CANARIES.providerKeyFromBindingsFile]]));
  // A provider key from the plain environment, read for use.
  expect(
    providerCredential(
      { ANTHROPIC_API_KEY: CANARIES.providerKeyFromEnvironment },
      'ANTHROPIC_API_KEY',
    ),
  ).toBe(CANARIES.providerKeyFromEnvironment);
  // The application's own bindings, of kind secret and kind config.
  setApplicationBindings({
    declared: ['WEBHOOK_SIGNING_SECRET', 'REPORT_RECIPIENT'],
    providerCredentials: [],
    values: new Map([
      ['WEBHOOK_SIGNING_SECRET', CANARIES.applicationSecret],
      ['REPORT_RECIPIENT', CANARIES.applicationConfig],
    ]),
  });
  // A boot secret, as the boot resolves it.
  loadServerConfig(
    {
      DATABASE_URL: 'postgres://app:db-password-canary-0001@db.internal:5432/app',
      RAYSPEC_JWT_SIGNING_KEY: 'pem-is-not-parsed-here',
      RAYSPEC_API_KEY_PEPPER: CANARIES.bootSecret,
    },
    () => {},
  );
});

afterAll(() => {
  setApplicationBindings(undefined);
  resetGrantedProviderCredentialsForTests();
  resetRegisteredSecretsForTests();
  rmSync(dir, { recursive: true, force: true });
});

const ALL = Object.entries(CANARIES);

function expectNoCanary(text: string): void {
  for (const [kind, value] of ALL) expect(text, kind).not.toContain(value);
  expect(text).not.toContain('db-password-canary-0001');
}

describe('canary secrets of every binding kind', () => {
  it('never reach a log line, whoever prints it', () => {
    const written: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    });
    installOutputRedaction([stream]);
    const log = new Console({ stdout: stream, stderr: stream });
    for (const [kind, value] of ALL) log.log(`[${kind}] the value is ${value}`);
    log.error(new Error(`a handler threw with ${CANARIES.applicationSecret} in its message`));
    log.log({ config: { DATABASE_URL: 'postgres://app:db-password-canary-0001@db.internal/app' } });
    const text = Buffer.concat(written).toString('utf8');
    expectNoCanary(text);
    expect(text).toContain('[redacted]');
  });

  it('never reach an HTTP error envelope, message or details', () => {
    for (const [, value] of ALL) {
      const envelope = errorEnvelope('VALIDATION_ERROR', `rejected ${value}`, 'req-1', {
        field: `echo ${value}`,
      });
      expectNoCanary(JSON.stringify(envelope));
    }
  });

  it('never reach a runtime-control result envelope', async () => {
    const leaky = (value: string): ResultEnvelope<null> => ({
      contractVersion: '1.0.0-rc.1',
      ok: false,
      operation: 'runtime.prepare',
      operationId: randomUUID(),
      data: null,
      errors: [bundleError('RAY_INFRA_UNAVAILABLE', `the database said: ${value}`)],
      warnings: [{ code: 'RAY_W_UNSIGNED', message: `about ${value}` }],
    });
    for (const [, value] of ALL) {
      const adapter = withRedactedEnvelopes({
        prepare: async () => leaky(value),
        inspect: async () => leaky(value),
        quiesce: async () => leaky(value),
        resume: async () => leaky(value),
        health: async () => leaky(value),
      } as unknown as RuntimeControlAdapter);
      for (const op of ['prepare', 'inspect', 'quiesce', 'resume', 'health'] as const) {
        const envelope = await (adapter[op] as (r: unknown) => Promise<unknown>)({});
        expectNoCanary(JSON.stringify(envelope));
      }
    }
  });

  it("never reach a run's recorded error (the journal and the run record)", () => {
    for (const [, value] of ALL) {
      const classified = classifyUpstreamError(
        Object.assign(new Error(`502 upstream failed for key ${value}`), { status: 502 }),
      );
      expect(classified.errorClass).toBe('upstream_5xx');
      expectNoCanary(classified.message);
    }
  });

  it('never reach an exported agent trace', async () => {
    const exported: unknown[] = [];
    const exporter = new RedactingTraceExporter({
      async export(items) {
        for (const item of items) exported.push(item.toJSON());
      },
    });
    await exporter.export(
      ALL.map(([kind, value]) => ({
        tracingApiKey: undefined,
        toJSON: () => ({
          object: 'trace.span',
          span_data: { type: 'function', name: kind, input: `{"arg":"${value}"}`, output: value },
        }),
      })),
    );
    expect(exported).toHaveLength(ALL.length);
    expectNoCanary(JSON.stringify(exported));
  });
});
