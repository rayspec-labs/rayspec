/**
 * The workforce transport's fail-closed resolution matrix — every branch that could have guessed,
 * proven to refuse instead: no URL source → error naming the three mechanisms (never localhost);
 * two deployment entries with no selector → error naming both; a malformed entry → error; no
 * credential → error; `--tenant` beside an org-bound API key → refused as unverifiable; a user
 * token resolves its active org (tenant_required / tenant_mismatch).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTransport, WorkforceCliError } from './workforce/transport.js';

let dir = '';

/** A minimal fake JWT (three dot segments) — never verified locally, only shape-classified. */
const USER_TOKEN = 'aaaa.bbbb.cccc';
const API_KEY = 'rk_live1.secretsecretsecret';

function meAnswering(activeOrgId: string | null): typeof fetch {
  return (async (input: unknown) => {
    expect(String(input)).toContain('/v1/auth/me');
    return new Response(JSON.stringify({ activeOrgId }), { status: 200 });
  }) as typeof fetch;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-wf-transport-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deployment resolution (first match wins, never a guess)', () => {
  it('--url wins outright and trailing slashes are normalized', async () => {
    const t = await resolveTransport({
      url: 'https://api.example.test///',
      apiKey: API_KEY,
      env: {},
      cwd: dir,
    });
    expect(t.baseUrl).toBe('https://api.example.test');
  });

  it('RAYSPEC_URL is the second source', async () => {
    const t = await resolveTransport({
      apiKey: API_KEY,
      env: { RAYSPEC_URL: 'https://env.example.test/' },
      cwd: dir,
    });
    expect(t.baseUrl).toBe('https://env.example.test');
  });

  it('a malformed --url or RAYSPEC_URL is refused BEFORE any request leaves the process', async () => {
    await expect(
      resolveTransport({ url: 'not a url', apiKey: API_KEY, env: {}, cwd: dir }),
    ).rejects.toThrow(/--url is not a valid URL/);
    await expect(
      resolveTransport({ apiKey: API_KEY, env: { RAYSPEC_URL: 'localhost:3000' }, cwd: dir }),
    ).rejects.toThrow(/RAYSPEC_URL is not a valid URL/);
  });

  it('a single unambiguous deployments/<name>.json resolves implicitly', async () => {
    const cwd = join(dir, 'single');
    mkdirSync(join(cwd, 'deployments'), { recursive: true });
    writeFileSync(
      join(cwd, 'deployments', 'prod.json'),
      JSON.stringify({ url: 'https://prod.example.test' }),
    );
    const t = await resolveTransport({ apiKey: API_KEY, env: {}, cwd });
    expect(t.baseUrl).toBe('https://prod.example.test');
  });

  it('two entries with no --deployment is an error NAMING them, never a pick', async () => {
    const cwd = join(dir, 'ambiguous');
    mkdirSync(join(cwd, 'deployments'), { recursive: true });
    writeFileSync(join(cwd, 'deployments', 'a.json'), JSON.stringify({ url: 'https://a.test' }));
    writeFileSync(join(cwd, 'deployments', 'b.json'), JSON.stringify({ url: 'https://b.test' }));
    await expect(resolveTransport({ apiKey: API_KEY, env: {}, cwd })).rejects.toThrow(
      /ambiguous.*a\.json.*b\.json/s,
    );
    const t = await resolveTransport({ apiKey: API_KEY, env: {}, cwd, deployment: 'b' });
    expect(t.baseUrl).toBe('https://b.test');
  });

  it('an unknown --deployment and a malformed entry are typed refusals', async () => {
    const cwd = join(dir, 'malformed');
    mkdirSync(join(cwd, 'deployments'), { recursive: true });
    writeFileSync(
      join(cwd, 'deployments', 'bad.json'),
      JSON.stringify({ url: 'https://x.test', apiKey: 'never-in-a-file' }),
    );
    await expect(
      resolveTransport({ apiKey: API_KEY, env: {}, cwd, deployment: 'nope' }),
    ).rejects.toThrow(WorkforceCliError);
    await expect(resolveTransport({ apiKey: API_KEY, env: {}, cwd })).rejects.toThrow(
      /strict \{"url"/,
    );
  });

  it('no source at all is the fail-closed error naming the three mechanisms — never localhost', async () => {
    await expect(resolveTransport({ apiKey: API_KEY, env: {}, cwd: dir })).rejects.toThrow(
      /--url.*RAYSPEC_URL.*deployments/s,
    );
  });
});

describe('credential + tenant rules', () => {
  it('no credential is a typed refusal (nothing useful to send unauthenticated)', async () => {
    await expect(resolveTransport({ url: 'https://x.test', env: {}, cwd: dir })).rejects.toThrow(
      /--api-key|RAYSPEC_API_KEY/,
    );
  });

  it('--tenant beside an org-bound API key is refused as unverifiable', async () => {
    await expect(
      resolveTransport({
        url: 'https://x.test',
        apiKey: API_KEY,
        tenant: '00000000-0000-4000-8000-000000000001',
        env: {},
        cwd: dir,
      }),
    ).rejects.toThrow(/already bound/);
  });

  it('a user token with no active org is tenant_required', async () => {
    await expect(
      resolveTransport({
        url: 'https://x.test',
        apiKey: USER_TOKEN,
        env: {},
        cwd: dir,
        fetchImpl: meAnswering(null),
      }),
    ).rejects.toThrow(/tenant_required/);
  });

  it('a user token whose active org differs from --tenant is tenant_mismatch', async () => {
    await expect(
      resolveTransport({
        url: 'https://x.test',
        apiKey: USER_TOKEN,
        tenant: '00000000-0000-4000-8000-000000000002',
        env: {},
        cwd: dir,
        fetchImpl: meAnswering('00000000-0000-4000-8000-000000000001'),
      }),
    ).rejects.toThrow(/tenant_mismatch/);
  });

  it('a user token whose active org matches --tenant resolves', async () => {
    const t = await resolveTransport({
      url: 'https://x.test',
      apiKey: USER_TOKEN,
      tenant: '00000000-0000-4000-8000-000000000001',
      env: {},
      cwd: dir,
      fetchImpl: meAnswering('00000000-0000-4000-8000-000000000001'),
    });
    expect(t.apiKey).toBe(USER_TOKEN);
  });
});
