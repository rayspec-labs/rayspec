/**
 * The hosting boot settings, parsed fail-closed like every other boot setting:
 * RAYSPEC_HOSTING_POSTURE (`local` or `managed`), RAYSPEC_SHUTDOWN_DRAIN_MS (0 to ten minutes),
 * RAYSPEC_SINGLE_TENANT (`true` or `false`) and RAYSPEC_TRUSTED_PROXIES (addresses and CIDR ranges).
 * An unset or blank value is the default; anything else that is not exactly valid refuses the boot.
 */
import type { Db } from '@rayspec/db';
import { MANAGED_RUN_CANCEL_POLL_MS, resolveExecutionPolicy } from '@rayspec/platform';
import { describe, expect, it } from 'vitest';
import {
  BootConfigError,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  durableRunAuthorizer,
  hardenedPosture,
  loadServerConfig,
  MAX_SHUTDOWN_DRAIN_MS,
  parseHostingPosture,
  parseShutdownDrainMs,
  parseSingleTenantMode,
  parseTrustedProxies,
} from './composition-root.js';
import { createRuntimeControl } from './runtime-control.js';
import { SUPPORTED_BACKEND_MATRIX } from './supported-backends.js';

describe('RAYSPEC_HOSTING_POSTURE', () => {
  it('defaults to local when unset or blank', () => {
    expect(parseHostingPosture({})).toBe('local');
    expect(parseHostingPosture({ RAYSPEC_HOSTING_POSTURE: '  ' })).toBe('local');
  });

  it('accepts exactly local and managed', () => {
    expect(parseHostingPosture({ RAYSPEC_HOSTING_POSTURE: 'managed' })).toBe('managed');
    expect(parseHostingPosture({ RAYSPEC_HOSTING_POSTURE: ' local ' })).toBe('local');
  });

  it.each(['Managed', 'public', 'true', 'managed,local'])('refuses %s', (value) => {
    expect(() => parseHostingPosture({ RAYSPEC_HOSTING_POSTURE: value })).toThrow(BootConfigError);
  });
});

describe('RAYSPEC_SHUTDOWN_DRAIN_MS', () => {
  it('defaults to ten seconds when unset or blank', () => {
    expect(parseShutdownDrainMs({})).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
    expect(DEFAULT_SHUTDOWN_DRAIN_MS).toBe(10_000);
    expect(parseShutdownDrainMs({ RAYSPEC_SHUTDOWN_DRAIN_MS: '' })).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
  });

  it('accepts 0 and the ten-minute ceiling', () => {
    expect(parseShutdownDrainMs({ RAYSPEC_SHUTDOWN_DRAIN_MS: '0' })).toBe(0);
    expect(parseShutdownDrainMs({ RAYSPEC_SHUTDOWN_DRAIN_MS: String(MAX_SHUTDOWN_DRAIN_MS) })).toBe(
      MAX_SHUTDOWN_DRAIN_MS,
    );
  });

  it.each(['-1', '1.5', '1e3', '600001', 'ten', '10s'])('refuses %s', (value) => {
    expect(() => parseShutdownDrainMs({ RAYSPEC_SHUTDOWN_DRAIN_MS: value })).toThrow(
      BootConfigError,
    );
  });
});

describe('RAYSPEC_SINGLE_TENANT', () => {
  it('is off when unset or blank, so an existing deployment is unchanged', () => {
    expect(parseSingleTenantMode({})).toBe(false);
    expect(parseSingleTenantMode({ RAYSPEC_SINGLE_TENANT: '  ' })).toBe(false);
  });

  it('accepts exactly true and false', () => {
    expect(parseSingleTenantMode({ RAYSPEC_SINGLE_TENANT: 'true' })).toBe(true);
    expect(parseSingleTenantMode({ RAYSPEC_SINGLE_TENANT: ' false ' })).toBe(false);
  });

  it.each(['TRUE', '1', 'yes', 'on', 'true,false'])('refuses %s', (value) => {
    expect(() => parseSingleTenantMode({ RAYSPEC_SINGLE_TENANT: value })).toThrow(BootConfigError);
  });

  it('reaches the boot configuration, and a bad value refuses it', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      RAYSPEC_JWT_SIGNING_KEY: 'k',
      RAYSPEC_API_KEY_PEPPER: 'p',
    };
    const warn = () => {};
    expect(loadServerConfig(base, warn).singleTenant).toBe(false);
    expect(loadServerConfig({ ...base, RAYSPEC_SINGLE_TENANT: 'true' }, warn).singleTenant).toBe(
      true,
    );
    expect(() => loadServerConfig({ ...base, RAYSPEC_SINGLE_TENANT: 'yes' }, warn)).toThrow(
      BootConfigError,
    );
  });
});

describe('RAYSPEC_TRUSTED_PROXIES', () => {
  it('defaults to an empty list when unset or blank, and drops blank entries', () => {
    expect(parseTrustedProxies({})).toEqual([]);
    expect(parseTrustedProxies({ RAYSPEC_TRUSTED_PROXIES: ' , ' })).toEqual([]);
    expect(parseTrustedProxies({ RAYSPEC_TRUSTED_PROXIES: '10.0.0.0/8, ,::1' })).toEqual([
      '10.0.0.0/8',
      '::1',
    ]);
  });

  it('accepts addresses and ranges of both families, mapped spellings included', () => {
    const list = '10.0.0.0/8,127.0.0.1,::1/128,2001:db8::/32,::ffff:10.0.0.0/104,::ffff:10.0.0.0/8';
    expect(parseTrustedProxies({ RAYSPEC_TRUSTED_PROXIES: list })).toEqual(list.split(','));
  });

  it.each([
    '10.0.0.0/',
    '10.0.0.0/33',
    '10.0.0.0/8.0',
    '10.0.0.0/0x8',
    '::/',
    '::/129',
    'proxy.internal',
  ])('refuses %s and names it', (entry) => {
    const env = { RAYSPEC_TRUSTED_PROXIES: `10.0.0.0/8, ${entry}` };
    expect(() => parseTrustedProxies(env)).toThrow(BootConfigError);
    expect(() => parseTrustedProxies(env)).toThrow(`'${entry}'`);
  });

  it('reaches the boot configuration, and a bad entry refuses it', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      RAYSPEC_JWT_SIGNING_KEY: 'k',
      RAYSPEC_API_KEY_PEPPER: 'p',
    };
    const warn = () => {};
    expect(loadServerConfig(base, warn).trustedProxies).toEqual([]);
    expect(
      loadServerConfig({ ...base, RAYSPEC_TRUSTED_PROXIES: '10.0.0.0/8' }, warn).trustedProxies,
    ).toEqual(['10.0.0.0/8']);
    expect(() => loadServerConfig({ ...base, RAYSPEC_TRUSTED_PROXIES: '10.0.0.0/' }, warn)).toThrow(
      BootConfigError,
    );
  });
});

describe('the hosting report beside inspect()', () => {
  // The report reads no database; a handle that would throw on use proves it.
  const noDb = {} as Db;
  const report = (env: NodeJS.ProcessEnv) =>
    createRuntimeControl({ db: noDb, env }).inspectHosting();

  it('reports cross-process cancellation off under the local posture without an interval', () => {
    expect(report({})).toEqual({
      hostingPosture: 'local',
      crossProcessCancellation: { enabled: false, pollIntervalMs: null, source: 'off' },
      applicationTenants: { singleTenantMode: false, maxApplicationTenants: null },
      executionPolicy: resolveExecutionPolicy({}),
      supportedBackends: SUPPORTED_BACKEND_MATRIX,
      egress: { enforcement: 'host-network-policy', platformOutboundGuard: true },
      agentTraceExport: 'openai',
    });
  });

  it('reports it on by default under the managed posture', () => {
    expect(report({ RAYSPEC_HOSTING_POSTURE: 'managed' })).toEqual({
      hostingPosture: 'managed',
      crossProcessCancellation: {
        enabled: true,
        pollIntervalMs: MANAGED_RUN_CANCEL_POLL_MS,
        source: 'hosting-posture',
      },
      applicationTenants: { singleTenantMode: false, maxApplicationTenants: null },
      executionPolicy: resolveExecutionPolicy({ RAYSPEC_HOSTING_POSTURE: 'managed' }),
      supportedBackends: SUPPORTED_BACKEND_MATRIX,
      egress: { enforcement: 'host-network-policy', platformOutboundGuard: true },
      agentTraceExport: 'off',
    });
  });

  it('reports the agent trace export the boot applies', () => {
    const exported = (env: NodeJS.ProcessEnv) => report(env).agentTraceExport;
    // The agent SDK's own default, which exports, unless something turns it off.
    expect(exported({})).toBe('openai');
    // The managed posture turns it off unless the operator states otherwise.
    expect(exported({ RAYSPEC_HOSTING_POSTURE: 'managed' })).toBe('off');
    expect(exported({ RAYSPEC_HOSTING_POSTURE: 'managed', RAYSPEC_AGENT_TRACING: 'openai' })).toBe(
      'openai',
    );
    // An explicit value, and the SDK switch the deploy path writes.
    expect(exported({ RAYSPEC_AGENT_TRACING: 'off' })).toBe('off');
    expect(exported({ RAYSPEC_AGENT_TRACING: 'openai' })).toBe('openai');
    expect(exported({ OPENAI_AGENTS_DISABLE_TRACING: '1' })).toBe('off');
    // A value the boot refuses cannot be attested as off.
    expect(
      exported({ RAYSPEC_AGENT_TRACING: 'nonsense', RAYSPEC_HOSTING_POSTURE: 'managed' }),
    ).toBe('openai');
  });

  it('reports the execution policy the managed posture applies, with where each bound came from', () => {
    const policy = report({
      RAYSPEC_HOSTING_POSTURE: 'managed',
      RAYSPEC_AGENT_QUEUE_MAX: '7',
    }).executionPolicy;
    expect(policy.posture).toBe('managed');
    expect(policy.runMaxMs.source).toBe('hosting-posture');
    expect(policy.queueMax).toEqual({ value: 7, source: 'explicit' });
  });

  it('reports the tenant limit from RAYSPEC_SINGLE_TENANT', () => {
    expect(report({ RAYSPEC_SINGLE_TENANT: 'true' }).applicationTenants).toEqual({
      singleTenantMode: true,
      maxApplicationTenants: 1,
    });
    expect(() => report({ RAYSPEC_SINGLE_TENANT: 'maybe' })).toThrow(BootConfigError);
  });

  it('reports an explicit interval as explicit, under either posture', () => {
    expect(report({ RAYSPEC_RUN_CANCEL_POLL_MS: '750' }).crossProcessCancellation).toEqual({
      enabled: true,
      pollIntervalMs: 750,
      source: 'explicit',
    });
  });

  it('refuses a posture the boot would refuse', () => {
    expect(() => report({ RAYSPEC_HOSTING_POSTURE: 'public' })).toThrow(BootConfigError);
  });
});

describe('the hardened posture switch', () => {
  it('is on with role separation or single-tenant mode, and off with neither', () => {
    expect(hardenedPosture({})).toBe(false);
    expect(hardenedPosture({ singleTenant: false })).toBe(false);
    expect(hardenedPosture({ singleTenant: true })).toBe(true);
    expect(hardenedPosture({ migrationDatabaseUrl: 'postgres://m@h/db' })).toBe(true);
  });

  it('wires the queued-run re-check only in the hardened posture', async () => {
    const stores = {
      identityStore: { liveMembership: async () => undefined },
      apiKeyStore: { findById: async () => undefined },
    } as unknown as Parameters<typeof durableRunAuthorizer>[0];
    // Outside it the worker gets no check, so a queued job runs as it always did.
    expect(durableRunAuthorizer({ ...stores, hardenedPosture: false })).toBeUndefined();
    expect(durableRunAuthorizer({ ...stores })).toBeUndefined();
    const check = durableRunAuthorizer({ ...stores, hardenedPosture: true });
    expect(check).toBeDefined();
    const job = {
      runId: 'r1',
      tenantId: '00000000-0000-0000-0000-00000000000a',
      requestedBy: { kind: 'user', userId: '00000000-0000-0000-0000-0000000000u1' },
    } as unknown as Parameters<NonNullable<typeof check>>[0];
    // A member with no live membership is refused.
    expect(await check?.(job)).toBe(false);
  });
});
