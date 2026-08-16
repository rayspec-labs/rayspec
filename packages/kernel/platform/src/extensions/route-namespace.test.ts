/**
 * The route-namespace vocabulary — the two questions a pack's routes have to answer before they are
 * allowed onto the deployment's app, asked here without a loader, a document or a database.
 *
 *   - CONTAINMENT: is this path inside the namespace this pack claimed, and does that namespace
 *     overlap one another pack already claimed? Overlap is decided by containment rather than by
 *     string equality, because `/ext/a/` and `/ext/a/sub/` are two different strings that own the
 *     same paths.
 *   - SHADOWING: do two routes reach the router as the SAME route? The router matches on POSITION,
 *     so a parameter's NAME is not part of a route's identity — `/notes/{id}` and `/notes/{note_id}`
 *     are one route, the second registration is unreachable, and nothing says so today.
 */
import type { ApiRouteSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  canonicalRoutePrefix,
  isUnderRoutePrefix,
  PACK_ROUTE_PREFIX_ROOT,
  type PackContributedRoute,
  routePrefixesOverlap,
  routePrefixRefusal,
  shadowedRouteRefusal,
} from './route-namespace.js';

const route = (method: ApiRouteSpec['method'], path: string): ApiRouteSpec =>
  ({ method, path, action: { kind: 'handler', handler: 'h' } }) as ApiRouteSpec;

const contributed = (packId: string, prefix: string, path: string): PackContributedRoute => ({
  packId,
  prefix,
  route: route('GET', path),
});

describe('canonicalRoutePrefix / routePrefixRefusal — what a namespace may be', () => {
  it('the default namespace root is /ext/ (never under /v1/, which the boot guard refuses)', () => {
    expect(PACK_ROUTE_PREFIX_ROOT).toBe('/ext/');
  });

  it('canonicalises to a single trailing slash, so containment is a plain prefix test', () => {
    expect(canonicalRoutePrefix('/uploads')).toBe('/uploads/');
    expect(canonicalRoutePrefix('/uploads/')).toBe('/uploads/');
  });

  it('refuses a prefix that is not an absolute path', () => {
    expect(routePrefixRefusal('uploads')).toMatch(/must start with/);
  });

  it('refuses the bare root (a pack that owns / owns everything)', () => {
    expect(routePrefixRefusal('/')).toMatch(/whole route surface/);
  });

  it('refuses a prefix carrying a {param} (a namespace nothing can be compared against)', () => {
    expect(routePrefixRefusal('/ext/{tenant}/')).toMatch(/parameter/);
  });

  it('accepts an ordinary literal prefix', () => {
    expect(routePrefixRefusal('/ext/my-pack/')).toBeUndefined();
  });
});

describe('isUnderRoutePrefix — a pack route must lie inside its own namespace', () => {
  it('accepts the paths inside the namespace, including the bare prefix itself', () => {
    expect(isUnderRoutePrefix('/ext/p/turns', '/ext/p/')).toBe(true);
    expect(isUnderRoutePrefix('/ext/p/turns/{id}', '/ext/p/')).toBe(true);
    expect(isUnderRoutePrefix('/ext/p/', '/ext/p/')).toBe(true);
    expect(isUnderRoutePrefix('/ext/p', '/ext/p/')).toBe(true);
  });

  it('refuses a path that only SHARES A PREFIX with the namespace (the sibling-name trap)', () => {
    expect(isUnderRoutePrefix('/ext/parties', '/ext/p/')).toBe(false);
    expect(isUnderRoutePrefix('/notebooks/{id}', '/ext/p/')).toBe(false);
  });
});

describe('routePrefixesOverlap — two claims are compared by CONTAINMENT, not by equality', () => {
  it('a namespace nested inside another overlaps it (string equality would miss this)', () => {
    expect(routePrefixesOverlap('/ext/a/', '/ext/a/sub/')).toBe(true);
    expect(routePrefixesOverlap('/ext/a/sub/', '/ext/a/')).toBe(true);
  });

  it('the same namespace overlaps itself', () => {
    expect(routePrefixesOverlap('/ext/a/', '/ext/a/')).toBe(true);
  });

  it('two sibling namespaces do not overlap, and a shared leading string is not containment', () => {
    expect(routePrefixesOverlap('/ext/a/', '/ext/b/')).toBe(false);
    expect(routePrefixesOverlap('/ext/a/', '/ext/ab/')).toBe(false);
  });
});

describe('shadowedRouteRefusal — the router matches on position, so a parameter NAME is not identity', () => {
  it('refuses a pack route that reaches the router as a deployment route, naming BOTH parties', () => {
    const refusal = shadowedRouteRefusal(
      [route('GET', '/notebooks/{id}')],
      [contributed('acme', '/notebooks/', '/notebooks/{notebook_id}')],
    );
    expect(refusal).toBeDefined();
    expect(refusal).toContain('/notebooks/{id}');
    expect(refusal).toContain('/notebooks/{notebook_id}');
    expect(refusal).toContain("extension pack 'acme'");
    expect(refusal).toContain('deployment');
  });

  it('refuses two PACKS whose routes reach the router as one route, naming both packs', () => {
    const refusal = shadowedRouteRefusal(
      [],
      [
        contributed('alpha', '/shared/', '/shared/items/{id}'),
        contributed('beta', '/shared/', '/shared/items/{item_id}'),
      ],
    );
    expect(refusal).toBeDefined();
    expect(refusal).toContain("extension pack 'alpha'");
    expect(refusal).toContain("extension pack 'beta'");
  });

  it('an EXACT duplicate is refused too (the raw-string case the lint rule already had)', () => {
    expect(
      shadowedRouteRefusal(
        [route('GET', '/notebooks/{id}')],
        [contributed('acme', '/notebooks/', '/notebooks/{id}')],
      ),
    ).toBeDefined();
  });

  it('the METHOD is part of a route identity — the same path under two methods is two routes', () => {
    const packRoute: PackContributedRoute = {
      packId: 'acme',
      prefix: '/notebooks/',
      route: route('POST', '/notebooks/{notebook_id}'),
    };
    expect(shadowedRouteRefusal([route('GET', '/notebooks/{id}')], [packRoute])).toBeUndefined();
  });

  it('no false positive: differently-shaped paths are different routes', () => {
    expect(
      shadowedRouteRefusal(
        [route('GET', '/notebooks/{id}')],
        [contributed('acme', '/ext/acme/', '/ext/acme/notebooks/{id}')],
      ),
    ).toBeUndefined();
  });

  it('says nothing about two DEPLOYMENT routes — that pair is the lint rule’s to report', () => {
    expect(
      shadowedRouteRefusal([route('GET', '/notebooks/{id}'), route('GET', '/notebooks/{n}')], []),
    ).toBeUndefined();
  });
});
