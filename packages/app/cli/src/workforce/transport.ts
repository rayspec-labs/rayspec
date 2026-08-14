/**
 * The `workforce` group's transport — the ONE place the CLI resolves WHICH deployment it talks to,
 * WHAT credential it sends, and WHICH tenant that credential acts under. Everything here is
 * fail-closed and local-authorization-free: the CLI is a CLIENT of the deployment's HTTP API — a
 * key without a permission gets the route's own 403 verbatim, because two authorization
 * implementations is one too many.
 *
 * DEPLOYMENT RESOLUTION, first match wins:
 *   1. `--url <base>` on the command;
 *   2. `RAYSPEC_URL` in the environment;
 *   3. a `deployments/<name>.json` entry under the working directory — selected by
 *      `--deployment <name>`, or used implicitly when EXACTLY ONE entry exists.
 * No match, or more than one candidate with no selector, is an ERROR NAMING THE OPTIONS — never a
 * silent guess at localhost. The entry file is a strict `{ "url": "…" }` (unknown keys refused); it
 * carries NO credential — keys come from the flag or the environment, never from a committed file.
 *
 * AUTHENTICATION: `--api-key` → `RAYSPEC_API_KEY`, sent exactly as the HTTP API expects it (the
 * same Bearer header both credential forms ride). Absent ⇒ a typed error — every workforce route is
 * authenticated, so there is nothing useful to send unauthenticated.
 *
 * TENANT SELECTION: an API key IS its organization — the server derives the tenant from the
 * credential, so `--tenant` beside a key is refused as unverifiable rather than silently ignored.
 * A user token (JWT) may span organizations: the CLI resolves the token's ACTIVE org through
 * `GET /v1/auth/me` — no active org without `--tenant` is `tenant_required`; a `--tenant` that
 * differs from the active org is `tenant_mismatch`. The tenant is never a request parameter the
 * CLI invents: the server-derived principal is what every route scopes by.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** A usage/configuration problem in the workforce group (maps to CLI exit 2). */
export class WorkforceCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkforceCliError';
  }
}

/** The strict deployment-entry shape: the base URL and nothing else (no credential in a file). */
const deploymentEntrySchema = z.strictObject({ url: z.url({ protocol: /^https?$/ }) });

export interface WorkforceTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface ResolveTransportInput {
  readonly url?: string;
  readonly apiKey?: string;
  readonly deployment?: string;
  readonly tenant?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Injectable fetch (tests); defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Every base-url source passes the SAME validation — the flag and env are not laxer than the
 * deployment file. */
function validatedBaseUrl(raw: string, source: string): string {
  // `z.url()` alone admits any scheme (`localhost:3000` parses as scheme `localhost:`) — the
  // transport speaks http(s) only, whichever source named the deployment.
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(raw);
  if (!parsed.success) {
    throw new WorkforceCliError(`${source} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  return stripTrailingSlashes(parsed.data);
}

function resolveBaseUrl(input: ResolveTransportInput): string {
  const env = input.env ?? process.env;
  if (input.url !== undefined) return validatedBaseUrl(input.url, '--url');
  const fromEnv = env.RAYSPEC_URL;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return validatedBaseUrl(fromEnv.trim(), 'RAYSPEC_URL');
  }
  const dir = join(input.cwd ?? process.cwd(), 'deployments');
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    // no deployments/ directory — fall through to the fail-closed error below
  }
  const readEntry = (file: string): string => {
    const path = join(dir, file);
    let parsed: z.output<typeof deploymentEntrySchema>;
    try {
      parsed = deploymentEntrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (e) {
      throw new WorkforceCliError(
        `deployments/${file} is not a valid deployment entry (expected a strict {"url": "…"}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return stripTrailingSlashes(parsed.url);
  };
  if (input.deployment !== undefined) {
    const file = `${input.deployment}.json`;
    if (!entries.includes(file)) {
      throw new WorkforceCliError(
        `--deployment ${input.deployment} names no deployments/${file} under the working directory` +
          (entries.length > 0
            ? ` (found: ${entries.join(', ')})`
            : ' (no deployments/ entries found)'),
      );
    }
    return readEntry(file);
  }
  if (entries.length === 1) return readEntry(entries[0] as string);
  if (entries.length > 1) {
    throw new WorkforceCliError(
      `deployment is ambiguous: deployments/ holds ${entries.length} entries (${entries.join(', ')}). ` +
        'Select one with --deployment <name>, or pass --url / set RAYSPEC_URL. Never a silent guess.',
    );
  }
  throw new WorkforceCliError(
    'no deployment resolved: pass --url <base>, set RAYSPEC_URL, or add a deployments/<name>.json ' +
      'entry ({"url": "…"}) under the working directory. Never a silent guess at localhost.',
  );
}

function resolveApiKey(input: ResolveTransportInput): string {
  const env = input.env ?? process.env;
  const key = input.apiKey ?? env.RAYSPEC_API_KEY;
  if (key === undefined || key.trim().length === 0) {
    throw new WorkforceCliError(
      'no credential resolved: pass --api-key or set RAYSPEC_API_KEY. Every workforce command ' +
        'talks to the authenticated HTTP API; the CLI adds no authorization of its own.',
    );
  }
  return key.trim();
}

/** A JWT has three dot-separated segments; the platform's key forms are `<prefix>.<secret>`. */
function isUserToken(credential: string): boolean {
  return credential.split('.').length === 3 && !/^(mk|rk)_/.test(credential);
}

/**
 * Resolve base URL + credential, then enforce the tenant contract (see the header). Network is
 * touched ONLY for a user token's active-org read.
 */
export async function resolveTransport(input: ResolveTransportInput): Promise<WorkforceTransport> {
  const env = input.env ?? process.env;
  const baseUrl = resolveBaseUrl(input);
  const apiKey = resolveApiKey(input);
  const tenant = input.tenant ?? env.RAYSPEC_TENANT_ID;

  if (!isUserToken(apiKey)) {
    if (tenant !== undefined && tenant.trim().length > 0) {
      throw new WorkforceCliError(
        'tenant selection does not apply to an API key: the key is already bound to its ' +
          'organization server-side, and the CLI has no way to verify a different claim. Drop ' +
          '--tenant / RAYSPEC_TENANT_ID, or authenticate with a user token.',
      );
    }
    return { baseUrl, apiKey };
  }

  // A user token may span organizations — resolve its ACTIVE org and enforce the selection.
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}/v1/auth/me`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new WorkforceCliError(
      `could not resolve the token's active organization (GET /v1/auth/me answered ${res.status}). ` +
        'Re-authenticate, or use an org-bound API key.',
    );
  }
  const me = (await res.json()) as { activeOrgId?: string | null };
  const active = me.activeOrgId ?? null;
  if (active === null) {
    throw new WorkforceCliError(
      'tenant_required: the user token has no active organization. Switch into one ' +
        '(POST /v1/orgs/{id}/switch) or select it with --tenant / RAYSPEC_TENANT_ID and re-switch.',
    );
  }
  if (tenant !== undefined && tenant.trim().length > 0 && tenant.trim() !== active) {
    throw new WorkforceCliError(
      `tenant_mismatch: --tenant ${tenant.trim()} does not match the token's active organization ` +
        `${active}. The server derives the tenant from the credential; switch orgs to change it.`,
    );
  }
  return { baseUrl, apiKey };
}

export interface WorkforceApiResult {
  readonly status: number;
  readonly body: unknown;
  /** Selected response headers (lowercase names) — the pagination contract rides here. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * One JSON request against the resolved deployment. Non-2xx responses are NOT thrown: the caller
 * surfaces the route's own error envelope verbatim (`errors: [{code, message}]`) — the 403 a key
 * without `store:write` gets here is the route's 403, untranslated.
 */
export async function workforceRequest(
  transport: WorkforceTransport,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkforceApiResult> {
  const res = await fetchImpl(`${transport.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${transport.apiKey}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // an SSE/plain body (the events replay) stays a string
  }
  const headers: Record<string, string> = {};
  for (const name of ['x-next-cursor', 'x-result-truncated']) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: res.status, body: parsed, headers };
}

/** Map a non-2xx envelope onto the CLI's `errors` array (the server's own words, untranslated). */
export function errorsFrom(result: WorkforceApiResult): { code: string; message: string }[] {
  const envelope = result.body as { error?: { code?: string; message?: string } } | null;
  const code = envelope?.error?.code ?? `http_${result.status}`;
  const message = envelope?.error?.message ?? `the deployment answered ${result.status}`;
  return [{ code, message }];
}
