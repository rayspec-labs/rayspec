/**
 * `/v1/workforce/*` says it is EXPERIMENTAL on the wire.
 *
 * WHY A HEADER **AS WELL AS** AN OPENAPI TAG. This suite was written when no OpenAPI document
 * described these routes, so the header was the ONLY marking an integrator could receive. The
 * served `GET /v1/openapi.json` now carries the whole section (`engine/emit-workforce-openapi.ts`,
 * pinned by `engine/workforce-openapi.db.test.ts`), marked with `x-rayspec-experimental` on the tag
 * and on every operation. The header is NOT superseded by that and this suite is NOT redundant: a
 * document reaches a client GENERATOR, which never makes a request, while the header reaches a
 * CALLER — including the two responses below that carry no body at all to read a marking from, the
 * fail-closed 501 and the unauthenticated 401. The CLI's `rayspec openapi` still emits the
 * PRODUCT-PROFILE view surface and still refuses a backend-profile document; that is unchanged.
 *
 * NOT THE POSTURE NOTICE. `OPENAPI_POSTURE_NOTICE` states the DEPLOYMENT posture (local / trusted /
 * not internet-facing) of the whole API. This states the STABILITY of one section. Different claims,
 * different documents; neither is weakened or duplicated by the other.
 *
 * The header is asserted on the paths that matter most, which are the ones a marking usually
 * misses: the fail-closed 501 (a deployment with no durable worker) and the unauthenticated 401 —
 * a caller who never gets a body still learns what they are talking to. Plus a NEGATIVE control (a
 * non-workforce route must NOT carry it) so the assertion cannot pass by a header applied globally,
 * and a STRUCTURAL check that no route registered in `workforce.ts` sits outside the prefix the
 * middleware globs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { WORKFORCE_EXPERIMENTAL_HEADER, WORKFORCE_EXPERIMENTAL_HEADER_VALUE } from './workforce.js';

const here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel: string): string =>
  readFileSync(resolve(here, `../../../../../${rel}`), 'utf8');

let hOn: Harness;
let hOff: Harness;

/** A registered principal holding the deployment tenant — the 200 path needs a real credential. */
async function principal(h: Harness, email: string, orgName: string): Promise<string> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  return (await switchRes.json()).accessToken as string;
}

describe('/v1/workforce/* carries the experimental marking on the wire', () => {
  beforeAll(async () => {
    hOn = await createHarness({
      workforce: { kick: () => {} },
      schema: 'rayspec_test_workforce_expheader',
    });
    hOff = await createHarness({ schema: 'rayspec_test_workforce_expheader_off' });
  });

  afterAll(async () => {
    await hOn.close();
    await hOff.close();
  });

  it('on a 200 read', async () => {
    const token = await principal(hOn, 'exp-header-ok@example.test', 'Org Exp Header');
    const res = await jsonRequest(hOn.app, 'GET', '/v1/workforce/tasks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBe(
      WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
    );
  });

  it('on the fail-closed 501 (no dispatcher seam wired)', async () => {
    const token = await principal(hOff, 'exp-header-501@example.test', 'Org Exp Header Off');
    const res = await jsonRequest(hOff.app, 'GET', '/v1/workforce/tasks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(501);
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBe(
      WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
    );
  });

  it('on an unauthenticated 401 — a caller with no body still learns what this is', async () => {
    const res = await jsonRequest(hOn.app, 'GET', '/v1/workforce/tasks', {});
    expect(res.status).toBe(401);
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBe(
      WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
    );
  });

  it('on a mutation route as well as a read route', async () => {
    const token = await principal(hOn, 'exp-header-mut@example.test', 'Org Exp Header Mut');
    const res = await jsonRequest(hOn.app, 'POST', '/v1/workforce/tasks/no-such-task/cancel', {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBe(
      WORKFORCE_EXPERIMENTAL_HEADER_VALUE,
    );
  });

  it('NEGATIVE CONTROL: a non-workforce route does NOT carry it', async () => {
    const res = await jsonRequest(hOn.app, 'GET', '/v1/auth/me', {});
    expect(res.headers.get(WORKFORCE_EXPERIMENTAL_HEADER)).toBeNull();
  });

  it('names the section, so the header is readable without this repository', () => {
    expect(WORKFORCE_EXPERIMENTAL_HEADER_VALUE).toContain('workforce');
  });
});

describe('nothing registered in workforce.ts escapes the marked prefix', () => {
  it('every route path in the module sits under /v1/workforce/', () => {
    const source = readRepo('packages/compose/api-auth/src/routes/workforce.ts');
    // Anchored on the REGISTRATION (`app.get(` / `app.post(` / …) and the first string literal
    // that follows it — not on a literal's indentation. The earlier form required exactly four
    // leading spaces, so a reformat, a nested registration, or a `biome` line-width change would
    // have made the scan silently find fewer routes while still passing. It also skips `app.use(`,
    // whose path IS the glob under test rather than a route subject to it.
    // Two steps rather than one clever regex: find each registration, then take the FIRST string
    // literal after it. A single pattern spanning both is a backtracking trap — the first draft of
    // this test used one and silently captured the argument list instead of the path.
    const registrations = [...source.matchAll(/\bapp\.(?:get|post|put|patch|delete|on)\s*\(/g)];
    const paths = registrations.map((m) => {
      const after = source.slice((m.index as number) + m[0].length);
      const literal = /^[^'"`]*?'([^']+)'/.exec(after);
      if (literal === null) throw new Error(`no path literal follows ${m[0]} at ${m.index}`);
      return literal[1] as string;
    });
    expect(paths.length, 'no route path literals parsed out of workforce.ts').toBeGreaterThan(0);
    // Every path found must LOOK like a route, so a scan that drifted onto some other literal
    // fails here rather than reporting a clean sweep over the wrong strings.
    expect(paths.filter((p) => !p.startsWith('/v1/'))).toEqual([]);
    const escaped = paths.filter((p) => !p.startsWith('/v1/workforce/'));
    expect(escaped, 'route(s) outside the prefix the experimental middleware globs').toEqual([]);
  });
});

describe('the forward-compatibility page pins the HTTP row', () => {
  it('names the header a client will see', () => {
    expect(readRepo('docs/workforce-compatibility.md')).toContain(WORKFORCE_EXPERIMENTAL_HEADER);
  });
});
