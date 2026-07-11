/**
 * `rayspec dev bootstrap-tenant` — create the first tenant + owner against a RUNNING RaySpec backend.
 *
 * LOCAL-DEV ONLY: a pure HTTP client of the SHIPPED auth API (it adds NO platform mechanism). It
 *   1. POST `${baseUrl}/v1/auth/register` `{ email, password, orgName }` — the platform auto-creates the
 *      personal org + owner membership in ONE call → `{ accessToken, activeOrgId }`;
 *   2. POST `${baseUrl}/v1/orgs/${activeOrgId}/switch` with `authorization: Bearer <accessToken>` —
 *      LIVE-rechecks membership + re-mints a JWT SCOPED to that org → `{ accessToken }` (the ORG token).
 *
 * Routes/payloads verified doc-first against `packages/api-auth/src/routes/auth.ts` (register) +
 * `orgs.ts` (switch) + the `RegisterRequest`/`TokenResponse` DTOs in `packages/auth-core/src/dto.ts`.
 *
 * The emitted `orgToken` is the command's DELIBERATE output — an org-scoped credential the operator
 * needs for every tenant route. It is freshly minted for the caller and is NOT a secret-leak (unlike
 * `gen-secrets`, which mints platform-wide signing material and must never echo a value).
 *
 * `fetch` is injectable for unit-testing the request CONSTRUCTION (routes/payloads/headers/sequence)
 * against a mock; a full live-server e2e is out of gate scope (verified manually).
 */
import { parseArgs } from 'node:util';
import { DevCliError } from './errors.js';

export interface BootstrapTenantResult {
  readonly ok: boolean;
  readonly command: 'dev bootstrap-tenant';
  /** The created org (tenant) id. */
  readonly orgId?: string;
  /** The org-scoped access token — the command's DELIBERATE credential output (see the module doc). */
  readonly orgToken?: string;
  /** The email the owner was registered with (echoed for the operator's records — not a secret). */
  readonly email?: string;
  readonly errors: { readonly code: string; readonly message: string }[];
}

/** Injectable dependencies (the test passes a mock fetch). */
export interface BootstrapTenantDeps {
  readonly fetchImpl?: typeof fetch;
}

/** Read a JSON body defensively; returns `{}` on a non-JSON/empty body so we can shape a clean error. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * `rayspec dev bootstrap-tenant --base-url <url> [--email …] [--password …] [--org-name …]`.
 * Returns the org id + org-scoped token; throws `DevCliError` on a usage problem (→ exit 2). An HTTP/
 * network failure or an unexpected response is returned as `ok:false` (→ exit 1).
 */
export async function runBootstrapTenant(
  args: readonly string[],
  deps: BootstrapTenantDeps = {},
): Promise<BootstrapTenantResult> {
  let baseUrlFlag: string | undefined;
  let email: string;
  let password: string;
  let orgName: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        'base-url': { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' },
        'org-name': { type: 'string' },
      },
    });
    baseUrlFlag = values['base-url'];
    email = values.email ?? `owner-${Date.now()}@rayspec.local`;
    password = values.password ?? 'correct-horse-battery-staple-9';
    orgName = values['org-name'] ?? 'My Workspace';
  } catch (e) {
    throw new DevCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!baseUrlFlag || baseUrlFlag.trim().length === 0) {
    throw new DevCliError('--base-url <url> is required (the running RaySpec backend).');
  }
  const base = baseUrlFlag.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    // 1. Register (orgName auto-creates the personal org + owner membership).
    const regRes = await fetchImpl(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, orgName }),
    });
    const regBody = await readJson(regRes);
    const regToken = typeof regBody.accessToken === 'string' ? regBody.accessToken : '';
    const orgId = typeof regBody.activeOrgId === 'string' ? regBody.activeOrgId : '';
    if (!regRes.ok || !regToken || !orgId) {
      return {
        ok: false,
        command: 'dev bootstrap-tenant',
        errors: [
          {
            code: 'REGISTER_FAILED',
            message: `register did not return accessToken+activeOrgId (HTTP ${regRes.status}).`,
          },
        ],
      };
    }

    // 2. Switch into the new org to obtain the ORG-SCOPED token (Bearer; no body).
    const swRes = await fetchImpl(`${base}/v1/orgs/${orgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${regToken}` },
    });
    const swBody = await readJson(swRes);
    const orgToken = typeof swBody.accessToken === 'string' ? swBody.accessToken : '';
    if (!swRes.ok || !orgToken) {
      return {
        ok: false,
        command: 'dev bootstrap-tenant',
        errors: [
          {
            code: 'SWITCH_FAILED',
            message: `org switch did not return an accessToken (HTTP ${swRes.status}).`,
          },
        ],
      };
    }

    return { ok: true, command: 'dev bootstrap-tenant', orgId, orgToken, email, errors: [] };
  } catch (e) {
    return {
      ok: false,
      command: 'dev bootstrap-tenant',
      errors: [{ code: 'REQUEST_ERROR', message: e instanceof Error ? e.message : String(e) }],
    };
  }
}
