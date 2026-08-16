/**
 * The ROUTE NAMESPACE a pack is confined to, and the shadowing question a merged route surface has to
 * answer before any of it is registered.
 *
 * A pack contributes routes exactly as a deployment does: they land in the same `api[]`, are served by
 * the same interpreter, behind the same auth chain. That is the right design, and it leaves two things
 * undecided that this module decides.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * (1) CONFINEMENT — which paths a pack may claim at all.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every route a pack contributes must lie under ONE prefix that pack owns: `/ext/<packId>/` by
 * default, or a prefix its manifest declares. Without it a pack fragment can name any path, including
 * one a deployment already serves, and the deployment finds out by watching a route stop working.
 *
 * The default lives under `/ext/`, NOT under `/v1/`: `/v1/*` is the auth and OIDC surface, which the
 * declared-route registrar refuses at boot, and carving an exception into the guard that protects the
 * credential surface would cost more than the tidier-looking path is worth. A deployment-declared
 * route already lives outside `/v1/` (a `/notebooks` is an ordinary declared path), and a pack
 * contributes routes exactly as a deployment does — so `/ext/<packId>/` is the same kind of path,
 * namespaced by who brought it.
 *
 * Two packs' claims are compared by CONTAINMENT rather than by string equality, because `/shared/` and
 * `/shared/deep/` are two different strings that own overlapping paths — one of them contains the
 * other, and equality sees nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * (2) SHADOWING — whether two routes that are not the same STRING are the same ROUTE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A router matches a path parameter by POSITION; what the parameter is NAMED never reaches it. So
 * `GET /notebooks/{id}` and `GET /notebooks/{notebook_id}` are ONE route: both register, the first
 * match wins, and the second is unreachable for the life of the process with nothing saying so. The
 * comparison key is therefore the method plus the ROUTER-NORMALIZED path (`normalizeRoutePath`), and
 * the refusal names BOTH parties — a message naming only the offender leaves the reader to find the
 * route it collides with by hand, which is exactly the work the check exists to have already done.
 *
 * WHY THESE ARE PREDICATES AND NOT THROWS. The same two questions are asked at two different edges
 * with two different failure vocabularies: `loadExtensions` refuses a pack with an `ExtensionLoadError`
 * naming the pack, and the composition root refuses a merged document with a `BootConfigError` naming
 * the spec file. Returning the reason lets both edges keep their own error type, and lets the rules
 * themselves be measured without either.
 */
import { type ApiRouteSpec, normalizeRoutePath } from '@rayspec/spec';

/**
 * The path prefix under which a pack's DEFAULT namespace is minted (`/ext/<packId>/`). Deliberately
 * outside `/v1/` — see the module header.
 */
export const PACK_ROUTE_PREFIX_ROOT = '/ext/';

/**
 * The pack ids that can be spelled into the default namespace directly. A pack id is a free string in
 * the document grammar, but the default prefix INTERPOLATES it into a URL path, so an id carrying a
 * `/`, a `%`, a `?` or whitespace would silently mint a namespace that is not the one it reads as. Such
 * a pack is not refused a namespace — it is required to DECLARE one (`routePrefix`), which is the only
 * form in which the path it wants is written down rather than derived.
 */
const PACK_ID_AS_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** One pack-contributed route, carrying the pack that contributed it and the namespace it lies in. */
export interface PackContributedRoute {
  /** The `extensions[].id` of the pack whose manifest declared this route. */
  readonly packId: string;
  /** The canonical namespace that pack is confined to (its default, or its declared `routePrefix`). */
  readonly prefix: string;
  /** The validated route fragment — the SAME object that was merged into the document's `api[]`. */
  readonly route: ApiRouteSpec;
}

/**
 * The canonical form of a route prefix: exactly one trailing `/`. Canonicalising is what turns both
 * containment questions into a plain string-prefix test, so `/uploads` and `/uploads/` cannot mean two
 * different namespaces, and `/ext/a/` is never read as containing `/ext/ab/`.
 */
export function canonicalRoutePrefix(declared: string): string {
  return declared.endsWith('/') ? declared : `${declared}/`;
}

/**
 * Why `declared` cannot serve as a pack's route namespace, or `undefined` when it can. The three
 * refusals are the three ways a prefix stops being a namespace at all: it is not a path, it is EVERY
 * path, or it is not a fixed string and so nothing can be compared against it.
 */
export function routePrefixRefusal(declared: string): string | undefined {
  if (!declared.startsWith('/')) {
    return `route prefix '${declared}' must start with '/' — it is an absolute path on the deployment's own route surface`;
  }
  if (canonicalRoutePrefix(declared) === '/') {
    return `route prefix '${declared}' is the whole route surface — a pack confined to '/' is confined to nothing`;
  }
  if (normalizeRoutePath(declared) !== declared) {
    return `route prefix '${declared}' carries a path parameter — a namespace has to be a fixed path, or no route and no other pack's claim can be compared against it`;
  }
  return undefined;
}

/**
 * The namespace a pack with no declared `routePrefix` is confined to, or `undefined` when its id
 * cannot be spelled into a path (see `PACK_ID_AS_PATH_SEGMENT` — such a pack must declare its own).
 */
export function defaultPackRoutePrefix(packId: string): string | undefined {
  if (!PACK_ID_AS_PATH_SEGMENT.test(packId)) return undefined;
  return `${PACK_ROUTE_PREFIX_ROOT}${packId}/`;
}

/**
 * True iff `path` lies inside `prefix` (which must be canonical). The bare prefix itself counts — a
 * pack that serves its own collection at `/ext/p` is inside its namespace — while a path that merely
 * SHARES leading characters with it (`/ext/parties` against `/ext/p/`) does not.
 */
export function isUnderRoutePrefix(path: string, prefix: string): boolean {
  return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

/**
 * True iff two canonical namespaces own any path in common — i.e. one CONTAINS the other. String
 * equality would clear `/shared/` against `/shared/deep/`, which own overlapping paths.
 */
export function routePrefixesOverlap(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** How a party is named in a shadowing refusal — the deployment itself, or the pack that brought it. */
function party(packId: string | undefined): string {
  return packId === undefined ? 'the deployment' : `extension pack '${packId}'`;
}

/**
 * The reason a pack-contributed route reaches the router as a route that is already there, or
 * `undefined` when the merged surface is unambiguous.
 *
 * Compares each pack route against the DEPLOYMENT's own routes, against every OTHER pack's routes, and
 * against the rest of its own pack's — the three pairings in which attribution exists and a refusal
 * can therefore name who to talk to. Two DEPLOYMENT routes are deliberately NOT reported here: that
 * pair belongs to the document's own lint rule, which reports it at the member that declared it and
 * which applies the same normalization, so a hand-written document is covered whether a pack is
 * involved or not.
 */
export function shadowedRouteRefusal(
  deploymentRoutes: readonly ApiRouteSpec[],
  packRoutes: readonly PackContributedRoute[],
): string | undefined {
  // The router-normalized key → the first route to claim it, and who brought it.
  const claimed = new Map<string, { readonly path: string; readonly packId?: string }>();
  const keyOf = (method: string, path: string) => `${method} ${normalizeRoutePath(path)}`;
  for (const route of deploymentRoutes) {
    const key = keyOf(route.method, route.path);
    // A deployment-vs-deployment duplicate is the lint rule's to report; keep the FIRST claim so the
    // pack refusal below names the earliest party rather than an arbitrary one.
    if (!claimed.has(key)) claimed.set(key, { path: route.path });
  }
  for (const contributed of packRoutes) {
    const { route, packId } = contributed;
    const key = keyOf(route.method, route.path);
    const first = claimed.get(key);
    if (first === undefined) {
      claimed.set(key, { path: route.path, packId });
      continue;
    }
    return (
      `route ${route.method} ${route.path} contributed by ${party(packId)} is the SAME route as ` +
      `${route.method} ${first.path} from ${party(first.packId)} once the router is done with it ` +
      '(a path parameter matches by position, so what it is NAMED is not part of the route). Both ' +
      'would register on one route and only the first would ever be reached — refusing to deploy a ' +
      'route surface where one of the two is dead (fail-closed).'
    );
  }
  return undefined;
}
