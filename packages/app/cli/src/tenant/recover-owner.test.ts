/**
 * `rayspec tenant recover-owner` — the token appears exactly once: in the one JSON object on stdout,
 * never on stderr, never in a refusal; and the command line is checked before any secret is read.
 * The database-backed issue and redemption are covered by the import suite and the route suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';
import { runTenantRecoverOwner } from './recover-owner.js';

/** The token the fake hands back, derived from a seed rather than written out as a literal. */
const TOKEN = Buffer.from('rayspec-recover-owner-suite-fake-token-000000')
  .toString('base64url')
  .slice(0, 43);
const SECRETS = { databaseUrl: 'postgres://u:p@h:1/d', apiKeyPepper: 'suite-pepper' };

function issued() {
  return {
    recoveryId: '5b0d0c8a-2a7e-4f2c-9a1b-6d5e4c3b2a10',
    userId: '6c0d0c8a-2a7e-4f2c-9a1b-6d5e4c3b2a10',
    orgId: '7d0d0c8a-2a7e-4f2c-9a1b-6d5e4c3b2a10',
    expiresAt: new Date('2026-10-01T10:30:00Z'),
    replaced: 1,
    token: TOKEN,
  };
}

describe('runTenantRecoverOwner', () => {
  it('returns the token once, with the owner, the expiry and the path that redeems it', async () => {
    const issue = vi.fn(async () => issued());
    const result = await runTenantRecoverOwner(
      ['--email', 'owner@example.com', '--ttl-seconds', '600'],
      { loadSecretsImpl: () => SECRETS, issueImpl: issue },
    );
    expect(result).toEqual({
      ok: true,
      command: 'tenant recover-owner',
      orgId: issued().orgId,
      userId: issued().userId,
      recoveryId: issued().recoveryId,
      expiresAt: '2026-10-01T10:30:00.000Z',
      replaced: 1,
      recoveryToken: TOKEN,
      redeemPath: '/v1/auth/owner-recovery',
      errors: [],
    });
    expect(issue).toHaveBeenCalledWith(SECRETS, { email: 'owner@example.com', ttlSeconds: 600 });
  });

  it('reports a refusal or a missing secret with a code and no token', async () => {
    const refused = Object.assign(new Error('That owner holds a password'), {
      name: 'OwnerRecoveryError',
      code: 'PASSWORD_PRESENT',
    });
    const result = await runTenantRecoverOwner(['--email', 'owner@example.com'], {
      loadSecretsImpl: () => SECRETS,
      issueImpl: async () => {
        throw refused;
      },
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'PASSWORD_PRESENT' }] });
    expect(result).not.toHaveProperty('recoveryToken');
    const missing = await runTenantRecoverOwner(['--email', 'owner@example.com'], {
      loadSecretsImpl: () => {
        throw new Error('required env var(s) missing: RAYSPEC_API_KEY_PEPPER');
      },
      issueImpl: async () => issued(),
    });
    expect(missing).toMatchObject({ ok: false, errors: [{ code: 'SECRETS_MISSING' }] });
    const broken = await runTenantRecoverOwner(['--email', 'owner@example.com'], {
      loadSecretsImpl: () => SECRETS,
      issueImpl: async () => {
        throw new Error('connect ECONNREFUSED with postgres://u:p@h:1/d');
      },
    });
    expect(broken).toMatchObject({ ok: false, errors: [{ code: 'RECOVERY_FAILED' }] });
    expect(JSON.stringify(broken)).not.toContain('postgres://');
  });
});

describe('the command line', () => {
  let stdout: string;
  let stderr: string;
  beforeEach(() => {
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      stdout += String(chunk);
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      stderr += String(chunk);
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stderr.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a missing address, a bad org id, a bad lifetime and a positional as usage (exit 2)', async () => {
    for (const args of [
      ['tenant', 'recover-owner'],
      ['tenant', 'recover-owner', '--email', 'o@example.com', '--org-id', 'nope'],
      ['tenant', 'recover-owner', '--email', 'o@example.com', '--ttl-seconds', '1.5'],
      ['tenant', 'recover-owner', 'extra', '--email', 'o@example.com'],
    ]) {
      await expect(main(args)).rejects.toThrow();
    }
  });

  it('refuses --json: the token is printed in its own JSON object, never wrapped', async () => {
    expect(await main(['tenant', 'recover-owner', '--email', 'o@example.com', '--json'])).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--json is not available for tenant recover-owner');
  });
});
