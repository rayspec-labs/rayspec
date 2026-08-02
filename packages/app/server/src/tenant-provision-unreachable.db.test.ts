/**
 * The operator provisioning capability is UNREACHABLE from the public listener — structurally, not by
 * a runtime check.
 *
 * Three arms, and they are deliberately of different kinds:
 *
 *   (a) THE STRONG ARM. The whole provisioning flow runs with `RAYSPEC_TENANT_BOOTSTRAP_ENABLED`
 *       UNSET, and then a server is assembled against that SAME database with the flag still unset:
 *       `POST /v1/auth/bootstrap-tenant` is a 404 while `POST /v1/auth/register` is a 201. That is the
 *       posture claim stated as behaviour — provisioning needs no HTTP surface at all, so a production
 *       listener never has to gain one.
 *
 *   (b) and (c) are REGRESSION FENCES, and they are vacuously green today. They are worth their lines
 *       precisely because of that: they go red the moment someone mounts the reservation as a route or
 *       gives the provisioning module a listener, which is the only way this property can be lost.
 *       (b) diffs the route inventory of two apps built from the SAME dependencies, one with the
 *       bootstrap posture on and one without, and asserts the entire difference is the one route #197
 *       already shipped — the reservation contributes zero paths. (c) reads the source and asserts the
 *       complete set of shipped files naming `reserveOrgById`, and that the provisioning module names
 *       no listener primitive.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppDeps, createAuthApp, OrgStore } from '@rayspec/api-auth';
import { setBootSecrets } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';
import { provisionTenant } from './tenant-provision.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_tenant_unreachable_${process.pid}`;
const PEPPER = 'tenant-unreachable-suite-pepper';
const CHOSEN = '00000000-0000-4000-8000-0000000000d1';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
/** Strip comments so a source assertion reads the CODE, not prose that merely names the symbol. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe.skipIf(!baseUrl)('the provisioning capability has no HTTP surface, in any posture', () => {
  let dbUrl = '';
  let server: BootedServer | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_TENANT_BOOTSTRAP_ENABLED',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = PEPPER;
    process.env.DATABASE_URL = dbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8812';
    delete process.env.RAYSPEC_SPEC_PATH;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    // The point of the whole file: this stays unset, before AND after provisioning.
    delete process.env.RAYSPEC_TENANT_BOOTSTRAP_ENABLED;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  it('provisions with the gate UNSET, and the server assembled on that database still has no bootstrap route', async () => {
    expect(process.env.RAYSPEC_TENANT_BOOTSTRAP_ENABLED).toBeUndefined();
    const out = await provisionTenant(
      { databaseUrl: dbUrl, apiKeyPepper: PEPPER },
      { orgId: CHOSEN, name: 'No Route Needed' },
    );
    expect(out.orgId).toBe(CHOSEN);
    expect(out.org).toBe('created');
    expect(out.ownerHandoff).toEqual({ status: 'not_requested' });

    server = await assembleServer(loadServerConfig());
    const bootstrap = await server.app.request('/v1/auth/bootstrap-tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'nope@example.com',
        password: 'a-very-long-password',
        orgName: 'Nope',
        orgId: '00000000-0000-4000-8000-0000000000d2',
      }),
    });
    // Not registered at all — a 404, not a refusal, so there is nothing to probe.
    expect(bootstrap.status).toBe(404);
    // …while the ordinary public surface on the SAME app is alive, so the 404 is the route's absence
    // rather than a broken boot.
    const register = await server.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'public@example.com',
        password: 'a-very-long-password',
        orgName: 'Public',
      }),
    });
    expect(register.status).toBe(201);
    armsRan += 1;
  }, 180_000);

  it('ROUTE INVENTORY: turning the posture on adds exactly one path, and the reservation adds none', () => {
    setBootSecrets({ jwtSigningKeyPem: 'unused-for-route-registration', apiKeyPepper: PEPPER });
    const noop = () => {
      throw new Error('the route-inventory arm must not query a database');
    };
    const db = { select: noop, transaction: noop } as unknown as Db;
    const inventory = (orgStore: OrgStore): Set<string> => {
      const deps = { allowedOrigins: [], db, orgStore } as unknown as AppDeps;
      return new Set(createAuthApp(deps).routes.map((r) => `${r.method} ${r.path}`));
    };

    const byDefault = inventory(new OrgStore(db));
    const gated = inventory(new OrgStore(db, { tenantBootstrapEnabled: true }));
    const added = [...gated].filter((p) => !byDefault.has(p));
    expect(added).toEqual(['POST /v1/auth/bootstrap-tenant']);
    // Nothing was REMOVED either — the posture is purely additive.
    expect([...byDefault].filter((p) => !gated.has(p))).toEqual([]);
    // And no path in either posture is an operator/provisioning surface under another name.
    for (const path of [...byDefault, ...gated]) {
      expect(path).not.toMatch(/reserve|provision|tenant-ensure|ops/i);
    }
    armsRan += 1;
  });

  it('SOURCE GUARD: `reserveOrgById` is named by exactly two shipped files, neither of them a route', () => {
    const shipped = [
      'packages/compose/api-auth/src/stores/org-store.ts',
      'packages/app/server/src/tenant-provision.ts',
    ];
    const named: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
        if (stripComments(readFileSync(full, 'utf8')).includes('reserveOrgById')) {
          named.push(relative(repoRoot, full));
        }
      }
    };
    walk(join(repoRoot, 'packages'));
    expect(named.sort()).toEqual(shipped.sort());

    // The provisioning module reaches no listener: no node-server import, no serve(), no bind host.
    const provision = stripComments(
      readFileSync(join(repoRoot, 'packages/app/server/src/tenant-provision.ts'), 'utf8'),
    );
    expect(provision).not.toMatch(/@hono\/node-server/);
    expect(provision).not.toMatch(/\bserve\s*\(/);
    expect(provision).not.toMatch(/RAYSPEC_HOST/);
    armsRan += 1;
  });
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('the unreachability arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(3);
  else expect(true).toBe(true);
});
