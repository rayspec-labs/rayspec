/**
 * The two boot settings this change adds, parsed fail-closed like every other boot setting:
 * RAYSPEC_HOSTING_POSTURE (`local` or `managed`) and RAYSPEC_SHUTDOWN_DRAIN_MS (0 to ten minutes).
 * An unset or blank value is the default; anything else that is not exactly valid refuses the boot.
 */
import type { Db } from '@rayspec/db';
import { MANAGED_RUN_CANCEL_POLL_MS } from '@rayspec/platform';
import { describe, expect, it } from 'vitest';
import {
  BootConfigError,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  parseHostingPosture,
  parseShutdownDrainMs,
} from './composition-root.js';
import { createRuntimeControl } from './runtime-control.js';

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

describe('the hosting report beside inspect()', () => {
  // The report reads no database; a handle that would throw on use proves it.
  const noDb = {} as Db;
  const report = (env: NodeJS.ProcessEnv) =>
    createRuntimeControl({ db: noDb, env }).inspectHosting();

  it('reports cross-process cancellation off under the local posture without an interval', () => {
    expect(report({})).toEqual({
      hostingPosture: 'local',
      crossProcessCancellation: { enabled: false, pollIntervalMs: null, source: 'off' },
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
    });
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
