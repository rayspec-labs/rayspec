/**
 * THE ROUTE NAMESPACE, against the REAL fixture pack.
 *
 * `route-namespace.test.ts` in `@rayspec/platform` measures the predicates on synthetic input, and
 * `load-extensions.test.ts` measures the refusals on a manifest a fake importer hands the loader.
 * Neither of those loads a pack the repository actually ships, so neither would notice if the pack in
 * the tree stopped satisfying the rule it exists to witness.
 *
 * This suite drives the REAL loader over `packages/test/fixture-pack` — the built pack a deployment
 * document beside it references — and measures three things:
 *
 *   (A) THE PACK'S ROUTE LIES IN ITS OWN NAMESPACE, and the load says which pack contributed it. The
 *       route is an ordinary authenticated `{handler}` route: it goes onto the same app, behind the
 *       same chain, as a deployment-declared one. What is new is that the merge no longer drops the
 *       pack id — without that, a refusal could only print an index into a concatenated array.
 *   (B) A DEPLOYMENT ROUTE THAT REACHES THE ROUTER AS THAT PACK ROUTE IS REFUSED, naming BOTH parties.
 *       The two paths differ only in what the parameter is called, which is not part of a route's
 *       identity: the router matches on position, so one of the two would be dead.
 *   (C) AND A DEPLOYMENT ROUTE OF A DIFFERENT SHAPE IS NOT. This is the accept control for (B): both
 *       arms run the same predicate over the same real pack, so (B) cannot be passing because the
 *       check refuses everything.
 *
 * No database and no boot — the pack is resolved through the real path-jailed loader from its built
 * directory, exactly as the deployment document beside it does.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions, shadowedRouteRefusal } from '@rayspec/platform';
import type { ApiRouteSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const PACK_DEPLOYMENT_DIR = join(repoRoot, 'packages/test/fixture-pack');
const PACK_ID = 'fixture-pack';

/** Resolve + merge the fixture pack exactly as its own deployment document does (`module: ./dist`). */
async function loadFixturePack() {
  return loadExtensions([{ id: PACK_ID, module: './dist', version: '1.0.0' }], {
    packsRoot: PACK_DEPLOYMENT_DIR,
    deploymentRoot: PACK_DEPLOYMENT_DIR,
  });
}

const deploymentRoute = (method: ApiRouteSpec['method'], path: string): ApiRouteSpec =>
  ({ method, path, action: { kind: 'store', store: 'notes', op: 'get' } }) as ApiRouteSpec;

describe('the fixture pack’s contributed route — namespace + attribution', () => {
  it('(A) contributes an authenticated route inside /ext/fixture-pack/, attributed to the pack', async () => {
    const loaded = await loadFixturePack();
    expect(loaded.api).toHaveLength(1);
    const owned = loaded.apiOwners[0];
    expect(owned?.packId).toBe(PACK_ID);
    expect(owned?.prefix).toBe(`/ext/${PACK_ID}/`);
    expect(owned?.route.path.startsWith(`/ext/${PACK_ID}/`)).toBe(true);
    // An authenticated route: it dispatches through a pack handler, so it rides the same
    // requireAuth → resolveTenant → requirePermission chain every declared route rides.
    expect(owned?.route.action.kind).toBe('handler');
  });

  it('(B) a deployment route that differs only in the PARAMETER NAME is refused, naming both', async () => {
    const loaded = await loadFixturePack();
    const packPath = loaded.apiOwners[0]?.route.path ?? '';
    const collidingPath = packPath.replace(/\{[^}/]+\}/, '{id}');
    expect(collidingPath).not.toBe(packPath); // the pack route must carry a parameter to measure this
    const refusal = shadowedRouteRefusal(
      [deploymentRoute(loaded.api[0]?.method ?? 'GET', collidingPath)],
      loaded.apiOwners,
    );
    expect(refusal).toBeDefined();
    expect(refusal).toContain(collidingPath);
    expect(refusal).toContain(packPath);
    expect(refusal).toContain(`extension pack '${PACK_ID}'`);
  });

  it('(C) accept control: a differently-shaped deployment route over the same pack is accepted', async () => {
    const loaded = await loadFixturePack();
    expect(
      shadowedRouteRefusal([deploymentRoute('GET', '/notebooks/{id}')], loaded.apiOwners),
    ).toBeUndefined();
  });
});
