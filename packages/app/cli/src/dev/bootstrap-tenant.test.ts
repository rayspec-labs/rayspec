/**
 * `rayspec dev bootstrap-tenant` — the request-CONSTRUCTION contract against a mock fetch (no live
 * server; a full e2e is verified manually, out of gate scope). These assert exactly the wire
 * shape the shipped auth API expects (verified doc-first against api-auth/routes/auth.ts + orgs.ts):
 *
 *   1. POST /v1/auth/register  {email,password,orgName}  (content-type: application/json)
 *   2. POST /v1/orgs/<activeOrgId>/switch  (authorization: Bearer <register accessToken>; no body)
 *   3. emit { orgId: <activeOrgId>, orgToken: <switch accessToken> }
 *
 * Plus the failure paths (a non-2xx register / a switch missing the token → ok:false, no throw).
 */
import { describe, expect, it } from 'vitest';
import { runBootstrapTenant } from './bootstrap-tenant.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A mock fetch that records each call and returns the queued JSON responses in order. */
function mockFetch(responses: { status: number; body: unknown }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const { status, body } = responses[i++] ?? { status: 500, body: {} };
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('dev bootstrap-tenant — request construction + sequence', () => {
  it('register then switch, with the exact routes/payloads/headers; emits orgId + orgToken', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { accessToken: 'REG_TOKEN', activeOrgId: 'org-123' } },
      { status: 200, body: { accessToken: 'ORG_TOKEN' } },
    ]);

    const result = await runBootstrapTenant(
      [
        '--base-url',
        'http://127.0.0.1:8788',
        '--email',
        'me@example.test',
        '--password',
        'pw-correct-horse',
        '--org-name',
        'My Workspace',
      ],
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.orgId).toBe('org-123');
    expect(result.orgToken).toBe('ORG_TOKEN');
    expect(result.email).toBe('me@example.test');

    // Exactly two calls, in order.
    expect(calls).toHaveLength(2);

    // 1. register — POST /v1/auth/register with the JSON body the DTO expects.
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://127.0.0.1:8788/v1/auth/register');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      email: 'me@example.test',
      password: 'pw-correct-horse',
      orgName: 'My Workspace',
    });

    // 2. switch — POST /v1/orgs/<activeOrgId>/switch, Bearer the register token, NO body.
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('http://127.0.0.1:8788/v1/orgs/org-123/switch');
    expect(calls[1].headers.authorization).toBe('Bearer REG_TOKEN');
    expect(calls[1].body).toBeUndefined();
  });

  it('strips a trailing slash from --base-url so routes are well-formed', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { accessToken: 'T', activeOrgId: 'o1' } },
      { status: 200, body: { accessToken: 'OT' } },
    ]);
    await runBootstrapTenant(['--base-url', 'http://localhost:8788/', '--email', 'a@b.test'], {
      fetchImpl,
    });
    expect(calls[0].url).toBe('http://localhost:8788/v1/auth/register');
    expect(calls[1].url).toBe('http://localhost:8788/v1/orgs/o1/switch');
  });

  it('applies sensible dev defaults when only --base-url is given', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { accessToken: 'T', activeOrgId: 'o1' } },
      { status: 200, body: { accessToken: 'OT' } },
    ]);
    const result = await runBootstrapTenant(['--base-url', 'http://localhost:8788'], { fetchImpl });
    expect(result.ok).toBe(true);
    const sent = JSON.parse(calls[0].body ?? '{}');
    expect(sent.email).toMatch(/@rayspec\.local$/);
    expect(typeof sent.password).toBe('string');
    expect(sent.orgName).toBe('My Workspace');
  });

  it('register non-2xx (or missing token/org) → ok:false, no second call, no throw', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 409, body: { error: 'EmailInUse' } }]);
    const result = await runBootstrapTenant(['--base-url', 'http://localhost:8788'], { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('REGISTER_FAILED');
    expect(calls).toHaveLength(1); // never reached the switch
  });

  it('switch missing an accessToken → ok:false (SWITCH_FAILED)', async () => {
    const { fetchImpl } = mockFetch([
      { status: 201, body: { accessToken: 'T', activeOrgId: 'o1' } },
      { status: 200, body: {} }, // no accessToken
    ]);
    const result = await runBootstrapTenant(['--base-url', 'http://localhost:8788'], { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('SWITCH_FAILED');
  });

  it('a missing --base-url is a usage error (DevCliError → exit 2 at the top level)', async () => {
    await expect(runBootstrapTenant([], {})).rejects.toThrow(/--base-url/);
  });
});

/**
 * `--org-id` targets a PRE-CHOSEN tenant id — the id an operator wants to put in
 * `RAYSPEC_PRODUCT_TENANT_ID` before the product deployment exists. It goes to a DIFFERENT route:
 * `/v1/auth/register` is public and unauthenticated and must never accept a client-chosen org id, so
 * the chosen-id path is the operator-gated `/v1/auth/bootstrap-tenant`. Without the flag the command
 * is byte-identical to before (register, no orgId on the wire).
 */
describe('dev bootstrap-tenant — --org-id targets the gated bootstrap route', () => {
  it('posts the chosen id to /v1/auth/bootstrap-tenant, then switches into it', async () => {
    const chosen = '11111111-1111-4111-8111-111111111111';
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { accessToken: 'REG_TOKEN', activeOrgId: chosen } },
      { status: 200, body: { accessToken: 'ORG_TOKEN' } },
    ]);

    const result = await runBootstrapTenant(
      [
        '--base-url',
        'http://127.0.0.1:8788',
        '--email',
        'me@example.test',
        '--password',
        'pw-correct-horse',
        '--org-name',
        'My Workspace',
        '--org-id',
        chosen,
      ],
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.orgId).toBe(chosen);
    expect(result.orgToken).toBe('ORG_TOKEN');

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://127.0.0.1:8788/v1/auth/bootstrap-tenant');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      email: 'me@example.test',
      password: 'pw-correct-horse',
      orgName: 'My Workspace',
      orgId: chosen,
    });
    expect(calls[1].url).toBe(`http://127.0.0.1:8788/v1/orgs/${chosen}/switch`);
  });

  it('WITHOUT the flag the wire shape is unchanged: /v1/auth/register and no orgId in the body', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { accessToken: 'T', activeOrgId: 'o1' } },
      { status: 200, body: { accessToken: 'OT' } },
    ]);
    await runBootstrapTenant(['--base-url', 'http://localhost:8788'], { fetchImpl });
    expect(calls[0].url).toBe('http://localhost:8788/v1/auth/register');
    expect(JSON.parse(calls[0].body ?? '{}')).not.toHaveProperty('orgId');
  });

  it('a malformed --org-id is a usage error — refused before any request is made', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    await expect(
      runBootstrapTenant(['--base-url', 'http://localhost:8788', '--org-id', 'not-a-uuid'], {
        fetchImpl,
      }),
    ).rejects.toThrow(/--org-id must be an org UUID/);
    expect(calls).toHaveLength(0);
  });
});
