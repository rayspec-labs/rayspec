/**
 * `rayspec tenant ensure` — the SECRET-FREE, exactly-one-JSON-object output contract.
 *
 * The command provisions an organization and, when asked for an owner handoff, mints an invite token
 * that is a tenant-takeover credential until it is consumed. So the one property this suite exists to
 * pin is negative: that token reaches the requested FILE and nothing else. It never appears on stdout,
 * it never appears on stderr, and the result object has no field capable of carrying it — which is why
 * the key-set assertion below is written as an exact allowlist rather than a set of `not.toHaveProperty`
 * probes: a future field named `inviteToken` would have to break the allowlist to exist at all.
 *
 * `@rayspec/server` is replaced wholesale, so the provisioning layer is never loaded and the minted
 * token stays in this file's memory — the token really exists, and really never reaches a stream,
 * without the suite touching a database or a disk. The usage arms drive the same `main()` the shipped
 * bin does, so the exit codes are the shipped mapping (2 = usage, 1 = operational, 0 = ok).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';

const DB_URL = 'postgres://provision-user:provision-pass@provision-host:5432/provision-db';
const PEPPER = 'provision-suite-pepper-value-never-printed';
const ORG_ID = '3f0d0c8a-2a7e-4f2c-9a1b-6d5e4c3b2a10';
const INVITE_OUT = '/tmp/rayspec-tenant-ensure-suite-does-not-exist/owner.token';

/**
 * The token the fake provisioning layer mints. It is 43 base64url characters, the exact shape
 * `mintInviteToken` produces, so the "no 8-character substring of it appears" assertion is a
 * statement about a realistic credential rather than a short literal that could not collide anyway.
 */
const state = vi.hoisted(() => ({
  token: 'Zq7Kx2Lm9PvR4nTbW6yH1sJdF8gCeA3oU5iQwX0rYkM',
  calls: [] as unknown[],
}));

vi.mock('@rayspec/server', () => ({
  loadTenantProvisionSecrets: () => ({ databaseUrl: DB_URL, apiKeyPepper: PEPPER }),
  provisionTenant: async (secrets: unknown, input: Record<string, unknown>) => {
    state.calls.push({ secrets, input });
    // The real implementation writes the token to `ownerInviteOut` and returns a result that names the
    // FILE, never the token. Keeping the token in this module's memory models exactly that split.
    return {
      orgId: ORG_ID,
      name: input.name,
      slug: 'acme',
      org: 'created',
      ownerHandoff: input.ownerEmail
        ? {
            status: 'issued',
            inviteId: '9c2b1e6d-4a3f-4c58-8b7d-0e1f2a3b4c5d',
            email: input.ownerEmail,
            expiresAt: '2026-08-02T13:00:00.000Z',
            tokenFile: input.ownerInviteOut,
          }
        : { status: 'not_requested' },
      acceptPath: '/v1/invites/accept',
    };
  },
}));

let outChunks: string[];
let errChunks: string[];
let savedSkipDotenv: string | undefined;

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  state.calls = [];
  // Hermetic: never let a repo-root `.env` put a real DATABASE_URL into this process.
  savedSkipDotenv = process.env.RAYSPEC_SKIP_DOTENV;
  process.env.RAYSPEC_SKIP_DOTENV = '1';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSkipDotenv === undefined) delete process.env.RAYSPEC_SKIP_DOTENV;
  else process.env.RAYSPEC_SKIP_DOTENV = savedSkipDotenv;
});

describe('tenant ensure — exactly one JSON object, and no secret material anywhere', () => {
  it('emits ONE parseable object whose key set is the allowlist, with no token-shaped field', async () => {
    const code = await main([
      'tenant',
      'ensure',
      '--org-id',
      ORG_ID,
      '--name',
      'Acme',
      '--owner-email',
      'Owner@Example.COM',
      '--owner-invite-out',
      INVITE_OUT,
    ]);
    expect(code).toBe(0);

    const stdout = outChunks.join('');
    // The WHOLE buffer parses — one object, not a log line followed by one, and not two objects.
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual([
      'acceptPath',
      'command',
      'errors',
      'name',
      'ok',
      'org',
      'orgId',
      'ownerHandoff',
      'slug',
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('tenant ensure');
    expect(parsed.orgId).toBe(ORG_ID);
    expect(parsed.acceptPath).toBe('/v1/invites/accept');
    // The handoff names the FILE the token went to, and the invite it belongs to — never the token.
    expect(parsed.ownerHandoff).toEqual({
      status: 'issued',
      inviteId: '9c2b1e6d-4a3f-4c58-8b7d-0e1f2a3b4c5d',
      email: 'Owner@Example.COM',
      expiresAt: '2026-08-02T13:00:00.000Z',
      tokenFile: INVITE_OUT,
    });

    const streams = stdout + errChunks.join('');
    expect(streams).not.toContain(state.token);
    // Not even a fragment: 8 base64url characters is already enough to make a leaked prefix a
    // meaningful head start, so the whole token is checked window by window.
    for (let i = 0; i + 8 <= state.token.length; i += 1) {
      expect(streams).not.toContain(state.token.slice(i, i + 8));
    }
    expect(streams).not.toContain(DB_URL);
    expect(streams).not.toContain(PEPPER);
    // No key ANYWHERE in the tree could hold one either.
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) for (const item of v) walk(item);
      else if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) {
          keys.add(k);
          walk(item);
        }
      }
    };
    walk(parsed);
    for (const banned of ['token', 'inviteToken', 'orgToken', 'accessToken', 'password']) {
      expect(keys.has(banned)).toBe(false);
    }
  });

  it('without --owner-email the handoff is not_requested and nothing is minted', async () => {
    const code = await main(['tenant', 'ensure', '--org-id', ORG_ID, '--name', 'Acme']);
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join(''));
    expect(parsed.ownerHandoff).toEqual({ status: 'not_requested' });
    expect(errChunks.join('')).toBe('');
  });

  it('passes the operator flags through verbatim, including the TTL override and the reissue', async () => {
    const code = await main([
      'tenant',
      'ensure',
      '--org-id',
      ORG_ID,
      '--name',
      'Acme',
      '--owner-email',
      'owner@example.com',
      '--owner-invite-out',
      INVITE_OUT,
      '--invite-ttl-seconds',
      '900',
      '--reissue-owner-invite',
    ]);
    expect(code).toBe(0);
    expect(state.calls).toHaveLength(1);
    expect((state.calls[0] as { input: unknown }).input).toEqual({
      orgId: ORG_ID,
      name: 'Acme',
      ownerEmail: 'owner@example.com',
      ownerInviteOut: INVITE_OUT,
      inviteTtlSeconds: 900,
      reissueOwnerInvite: true,
    });
  });
});

describe('tenant ensure — usage problems are exit 2, before any provisioning call', () => {
  it('--owner-email without --owner-invite-out is refused (a token needs somewhere to land)', async () => {
    await expect(
      main([
        'tenant',
        'ensure',
        '--org-id',
        ORG_ID,
        '--name',
        'Acme',
        '--owner-email',
        'owner@example.com',
      ]),
    ).rejects.toThrow(/--owner-invite-out/);
    expect(outChunks.join('')).toBe('');
    expect(state.calls).toHaveLength(0);
  });

  it('a malformed --org-id is refused before the database is opened', async () => {
    await expect(
      main(['tenant', 'ensure', '--org-id', 'not-a-uuid', '--name', 'Acme']),
    ).rejects.toThrow(/--org-id/);
    expect(state.calls).toHaveLength(0);
  });

  it('a missing --org-id / --name and an unknown flag are all usage errors', async () => {
    await expect(main(['tenant', 'ensure', '--name', 'Acme'])).rejects.toThrow(/--org-id/);
    await expect(main(['tenant', 'ensure', '--org-id', ORG_ID])).rejects.toThrow(/--name/);
    await expect(
      main(['tenant', 'ensure', '--org-id', ORG_ID, '--name', 'Acme', '--nope']),
    ).rejects.toThrow(/invalid arguments/i);
    expect(state.calls).toHaveLength(0);
  });

  it('a non-numeric --invite-ttl-seconds is a usage error, not a silent default', async () => {
    await expect(
      main([
        'tenant',
        'ensure',
        '--org-id',
        ORG_ID,
        '--name',
        'Acme',
        '--invite-ttl-seconds',
        'soon',
      ]),
    ).rejects.toThrow(/--invite-ttl-seconds/);
    expect(state.calls).toHaveLength(0);
  });

  it('a missing / unknown tenant subcommand is a usage error naming the group', async () => {
    await expect(main(['tenant'])).rejects.toThrow(/missing tenant subcommand/i);
    await expect(main(['tenant', 'frobnicate'])).rejects.toThrow(/unknown tenant subcommand/i);
  });
});
