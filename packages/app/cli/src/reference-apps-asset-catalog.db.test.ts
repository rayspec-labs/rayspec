/**
 * The asset-catalog reference application — custom code delivered as a compiled extension with a
 * third-party dependency — deployed from its bundle with the real built CLI on a database of its own:
 *  - the deployment serves from a directory that holds only the bundle: the compiled handlers, the
 *    vendored `mime-types` and `mime-db` and the static assets come from the bundle;
 *  - a create derives the content type with `mime-types`, calls the classification service at the
 *    one declared host over HTTPS and writes through the tenant-bound database facade;
 *  - the host network policy is played by an egress proxy programmed from the bundle's
 *    `permissions.egressHosts`: the declared host is tunnelled; after an update whose bundle
 *    declares no host, the same call is denied, the create answers 502 and writes nothing, and the
 *    rows written before the update are kept;
 *  - another organization sees none of the rows; no token is 401; a malformed body is 400.
 *
 * The classification service is local (a test certificate authority the deployment trusts through
 * NODE_EXTRA_CA_CERTS) and is reached only through the proxy (NODE_USE_ENV_PROXY with HTTPS_PROXY).
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  Deployment,
  EXAMPLES,
  inspectAndVerify,
  type Listening,
  ownerWithOrg,
  type ParsedJson,
  pack,
  removeScratch,
  runNode,
  type Served,
  SuiteDatabase,
  scratch,
  signingKeyPem,
  startClassifier,
  startEgressProxy,
  testCertificates,
} from './test-support/reference-apps.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const APP = join(EXAMPLES, 'asset-catalog');
const PORT = 24_600 + (process.pid % 300);
const HOST = 'classifier.example.com';

describe.skipIf(!baseUrl)(
  'asset catalog — an extension with a dependency and declared egress',
  () => {
    const db = new SuiteDatabase(baseUrl ?? '', `rayspec_ref_asset_catalog_${process.pid}`);
    let pem = '';
    let deployment: Deployment;
    let served: Served | undefined;
    let caFile = '';
    let classifier: Listening & { requests: string[] };
    let proxy: Listening & { tunnelled: string[]; denied: string[] };
    /** The hosts the egress policy admits: the active bundle's `permissions.egressHosts`. */
    let policy: readonly string[] = [];
    const bundles: Record<string, { path: string; inspected: ParsedJson }> = {};
    let owner = { orgId: '', token: '' };

    function env(): NodeJS.ProcessEnv {
      return {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: db.url,
        SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? baseUrl ?? '',
        RAYSPEC_JWT_SIGNING_KEY: pem,
        RAYSPEC_API_KEY_PEPPER: 'asset-catalog-suite-pepper',
        ALLOWED_ORIGINS: '',
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: '127.0.0.1,localhost',
        NODE_EXTRA_CA_CERTS: caFile,
      };
    }

    /** Build, optionally rewrite the built spec, pack, verify, and leave only the bundle to deploy. */
    function packApp(name: string, rewrite?: (spec: string) => string) {
      const built = join(scratch(`asset-catalog-${name}-`), 'app');
      runNode(join(APP, 'build.mjs'), [`--out=${built}`]);
      const specPath = join(built, 'rayspec.yaml');
      if (rewrite) writeFileSync(specPath, rewrite(readFileSync(specPath, 'utf8')));
      const output = join(built, `${name}.ray`);
      pack(specPath, output);
      const target = join(deployment.dir, `${name}.ray`);
      copyFileSync(output, target);
      bundles[name] = { path: target, inspected: inspectAndVerify(target).inspected };
      return bundles[name]!;
    }

    async function deploy(name: string): Promise<ParsedJson> {
      if (served) await deployment.stop(served);
      const plan = deployment.dryRun(bundles[name]!.path);
      expect(plan.plan.blockers, JSON.stringify(plan.plan.blockers)).toEqual([]);
      // The host network policy is programmed from the bundle that is about to run.
      policy = bundles[name]!.inspected.egressHosts as string[];
      served = await deployment.serve(bundles[name]!.path, plan.planDigest);
      return plan;
    }

    async function rows(): Promise<ParsedJson[]> {
      return (await db.sql.unsafe(
        'SELECT name, file_name, content_type, category, tenant_id FROM catalog_items ORDER BY name',
      )) as unknown as ParsedJson[];
    }

    beforeAll(async () => {
      if (!baseUrl) return;
      await db.create();
      pem = await signingKeyPem();
      const certs = testCertificates(scratch('asset-catalog-tls-'), HOST);
      caFile = certs.caFile;
      classifier = await startClassifier(certs);
      proxy = await startEgressProxy(classifier.port, () => policy);
      deployment = new Deployment(scratch('asset-catalog-deploy-'), PORT, env);
      packApp('v1');
    }, 240_000);

    afterAll(async () => {
      if (served) await deployment.stop(served).catch(() => undefined);
      deployment?.kill();
      await classifier?.close();
      await proxy?.close();
      removeScratch();
      if (baseUrl) await db.drop();
    }, 60_000);

    it('serves the bundle: classified creates through the declared host, and the static assets', async () => {
      expect(bundles.v1!.inspected).toMatchObject({
        execution: 'in-process',
        egressHosts: [HOST],
      });
      const plan = await deploy('v1');
      expect(plan.plan.permissionChanges.egressAdded).toEqual([HOST]);
      const base = deployment.base;
      expect((await call(`${base}/`)).text).toContain('<h1>Asset catalog</h1>');
      expect((await call(`${base}/catalog.js`)).text).toContain("fetch('/api/items'");

      owner = await ownerWithOrg(base, 'owner@example.test', 'Catalog');
      const cases = [
        { name: 'Logo', file_name: 'logo.png', content_type: 'image/png', category: 'image' },
        {
          name: 'Handbook',
          file_name: 'handbook.pdf',
          content_type: 'application/pdf',
          category: 'document',
        },
        {
          name: 'Unknown',
          file_name: 'data.unknownext',
          content_type: 'application/octet-stream',
          category: 'document',
        },
      ];
      for (const c of cases) {
        const created = await call(`${base}/api/items`, {
          token: owner.token,
          method: 'POST',
          body: { name: c.name, file_name: c.file_name },
        });
        expect(created.status, created.text).toBe(201);
        expect(created.body).toMatchObject(c);
        expect(created.body.tenant_id).toBe(owner.orgId);
      }
      expect(classifier.requests).toEqual(
        cases.map((c) => `/v1/classify?${new URLSearchParams({ content_type: c.content_type })}`),
      );
      // One tunnel or several (a kept-alive connection carries the later calls), each to the host.
      expect(proxy.tunnelled.length).toBeGreaterThan(0);
      expect(new Set(proxy.tunnelled)).toEqual(new Set([`${HOST}:443`]));
      expect(proxy.denied).toEqual([]);
      const listed = await call(`${base}/api/items`, { token: owner.token });
      expect(listed.status).toBe(200);
      expect((listed.body.items as ParsedJson[]).map((i) => i.name).sort()).toEqual([
        'Handbook',
        'Logo',
        'Unknown',
      ]);
      armsRan += 1;
    }, 300_000);

    it('keeps each organization to its own rows, and refuses no token and a malformed body', async () => {
      const base = deployment.base;
      const outsider = await ownerWithOrg(base, 'outsider@example.test', 'Elsewhere');
      const theirs = await call(`${base}/api/items`, { token: outsider.token });
      expect(theirs.status).toBe(200);
      expect(theirs.body.items).toEqual([]);
      expect((await call(`${base}/api/items`)).status).toBe(401);
      const bad = await call(`${base}/api/items`, {
        token: owner.token,
        method: 'POST',
        body: { name: '', file_name: 'x.png' },
      });
      expect(bad.status).toBe(400);
      const stored = await rows();
      expect(stored).toHaveLength(3);
      expect(stored.every((r) => r.tenant_id === owner.orgId)).toBe(true);
      armsRan += 1;
    }, 120_000);

    it('denies the call once the running bundle declares no host, and keeps the rows', async () => {
      const undeclared = packApp('v1-1', (spec) => {
        const egress = '  egressHosts: [classifier.example.com]\n';
        expect(spec).toContain(egress);
        expect(spec).toContain("  version: '1.0.0'\n");
        return spec
          .split(egress)
          .join('')
          .split('\ndeployment:\n')
          .join('\n')
          .split("  version: '1.0.0'\n")
          .join("  version: '1.0.1'\n");
      });
      expect(undeclared.inspected).toMatchObject({ applicationVersion: '1.0.1', egressHosts: [] });
      const plan = await deploy('v1-1');
      expect(plan.plan.permissionChanges.egressRemoved).toEqual([HOST]);
      expect(plan.plan.schemaImpact.productDeltaSha256).toBeNull();
      const before = classifier.requests.length;
      const denied = await call(`${deployment.base}/api/items`, {
        token: owner.token,
        method: 'POST',
        body: { name: 'Blocked', file_name: 'blocked.png' },
      });
      expect(denied.status).toBe(502);
      expect(denied.body.error).toBe('classification_unavailable');
      expect(proxy.denied).toEqual([`${HOST}:443`]);
      expect(classifier.requests.length).toBe(before);
      const stored = await rows();
      expect(stored.map((r) => r.name)).toEqual(['Handbook', 'Logo', 'Unknown']);
      expect(deployment.active()).toBe(undeclared.inspected.sha256);
      armsRan += 1;
    }, 300_000);
  },
);

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('asset-catalog DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(3);
  else expect(true).toBe(true);
});
