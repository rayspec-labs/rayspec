/**
 * The two boot settings this change adds, parsed fail-closed like every other boot setting:
 * RAYSPEC_HOSTING_POSTURE (`local` or `managed`) and RAYSPEC_SHUTDOWN_DRAIN_MS (0 to ten minutes).
 * An unset or blank value is the default; anything else that is not exactly valid refuses the boot.
 */
import { describe, expect, it } from 'vitest';
import {
  BootConfigError,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  parseHostingPosture,
  parseShutdownDrainMs,
} from './composition-root.js';

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
