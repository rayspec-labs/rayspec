/**
 * Static frontend serving — mount a spec's declared `frontend[]` static assets alongside the API.
 *
 * A backend document may declare `frontend: [{ route, dir, spa? }]` (grammar.ts) so it can ship its
 * own built web UI next to the routes it exposes. `mountFrontend` registers ONE hardened static
 * handler per mount on the assembled Hono app, AFTER every API/auth/`/health`/OIDC route is
 * registered — so an API route, `/health`, and every `/v1/*`/`/oidc/*` platform path ALWAYS win over
 * a static mount (Hono runs matching handlers in registration order; a returning handler terminates,
 * and a static miss falls through to the platform's uniform 404).
 *
 * RESERVED NAMESPACES — even a `route: '/'` `spa:true` catch-all NEVER answers a path under a
 * platform-reserved prefix (`/v1`, `/health`, `/oidc` — the SAME set lint.ts's frontend rule guards,
 * imported here so the two cannot drift). Such a request is declined UP FRONT, so a registered platform
 * route wins and an UNregistered one reaches the platform's uniform JSON 404 — never a served file or
 * the SPA shell. Siblings (`/healthz`, `/oidc-typo`) and ordinary app deep links are unaffected.
 *
 * SCOPE — LOCAL / single-node / NOT internet-facing (mirrors the composition root). The real byte
 * serving is delegated to `@hono/node-server`'s `serveStatic` (conservative content-types, Range/HEAD).
 * `serveStatic` rejects `..`/`\`/`//` in the request path but does NOT block dotfiles or a symlink that
 * escapes the served directory — so this module adds an explicit fail-closed guard IN FRONT of it:
 *
 *   (a) DOTFILES / HIDDEN — any path segment that begins with `.` (covers `.env`, `.git`, and the
 *       `.`/`..` traversal segments) is refused.
 *   (b) TRAVERSAL — the resolved candidate path must stay inside the served directory after
 *       `path.resolve` (covers `..` and URL-encoded `..%2f`); a candidate that climbs out is refused.
 *   (c) SYMLINK-ESCAPE — if the target exists, its `fs.realpathSync` must stay inside the served
 *       directory's real path; a symlink pointing outside is refused.
 *
 * A refused request passes through to `next()` → the platform's uniform 404 (never the SPA shell, even
 * for an `spa:true` mount — a traversal/dotfile attempt must not be answered with `index.html`). A
 * directory is never listed. This module is import-safe (no side effects at module load).
 *
 * RANGE (RFC-7233): `serveStatic` 2.0.6 mishandles an UNSATISFIABLE byte range — a CLOSED range beyond
 * EOF (e.g. `bytes=999999-1000000` on a small file) yields a malformed 0-byte 206, and an OPEN one
 * (`bytes=99999-`) throws `ERR_OUT_OF_RANGE` (surfaced as a 500). An additive range guard runs AFTER the
 * fail-closed path guard, for every verb EXCEPT HEAD/OPTIONS (serveStatic special-cases only those two —
 * answering them 200 full-size, ignoring Range — so they are left byte-identical, never a 416; every
 * other verb, GET/POST/PUT/PATCH/DELETE, hits its buggy Range branch), ONLY when a `Range` header is present:
 * when the range is unsatisfiable (`start >= size`, or a reversed `start > end`) it returns a proper 416
 * whose `Content-Range` names the full size; every honored / clamped 206 falls through to `serveStatic`
 * UNCHANGED (byte-identical). When the path resolves to no file the guard ALSO checks the file the SPA
 * fallback would serve: on an `spa:true` mount a missed deep link would otherwise re-run the same buggy
 * Range math against `index.html`, so its range is validated against `index.html` too — only a genuine
 * miss with no SPA fallback falls through unguarded to `serveStatic`'s normal 404.
 */
import { existsSync, realpathSync, type Stats, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type FrontendSpec, RESERVED_ROUTE_PREFIXES } from '@rayspec/spec';
import type { Env, Hono, MiddlewareHandler, Next } from 'hono';

/** Decode a request path ONCE, tolerant of a malformed escape (fall back to the raw string). */
function decodeOnce(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Is `path` (the FULL decoded request path) under a platform-reserved namespace (`/v1`, `/health`,
 * `/oidc`)? Such a path must NEVER be answered by a static mount — decline it so a registered platform
 * route wins and an unregistered one gets the uniform 404 (never a file / SPA shell). Uses the SAME set
 * as lint.ts's frontend rule (imported from @rayspec/spec) so the runtime and the lint cannot drift.
 * Matches a prefix exactly or as a path segment (`/v1`, `/v1/x`), NOT a sibling (`/healthz`).
 */
function isReservedRoutePath(path: string): boolean {
  return RESERVED_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Is `subPath` (the request path with the mount `route` prefix stripped, decoded) SAFE to serve from
 * `baseDir`? Fail-closed on dotfiles, traversal, and symlink-escape (see the module header). `realBaseDir`
 * is `baseDir`'s pre-resolved real path (computed once at mount time) so the symlink check needs no
 * per-request `realpathSync(baseDir)`.
 */
function isSafeStaticPath(baseDir: string, realBaseDir: string, subPath: string): boolean {
  // (a) DOTFILES / HIDDEN — reject any segment starting with `.` (covers `.env`, `.`/`..` traversal).
  const segments = subPath.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith('.'))) return false;

  // (b) TRAVERSAL — resolve the candidate RELATIVE to baseDir (the leading `.` neutralizes an absolute
  // sub-path) and require it to stay inside baseDir. Covers `..` and its URL-encoded forms.
  const rel = subPath.startsWith('/') ? subPath : `/${subPath}`;
  const candidate = resolve(baseDir, `.${rel}`);
  if (candidate !== baseDir && !candidate.startsWith(baseDir + sep)) return false;

  // (c) SYMLINK-ESCAPE — if the target exists, its real path must also stay inside baseDir's real path.
  // A non-existent candidate is not an escape (serveStatic will simply miss → 404 / SPA fallback).
  if (existsSync(candidate)) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return false;
    }
    if (real !== realBaseDir && !real.startsWith(realBaseDir + sep)) return false;
  }
  return true;
}

/** `statSync` that returns `undefined` instead of throwing on a missing/unreadable path. */
function statSyncSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the on-disk file `serveStatic` will read for `subPath` under `baseDir`, mirroring its own
 * resolution: `join(baseDir, subPath)`, and if that is a directory, its `index.html`. Returns the file
 * `{ path, size }` from the SAME stat that proved it a file (so the range check never re-stats), or
 * `undefined` when nothing servable exists (a miss — `serveStatic` will 404 / the SPA fallback takes
 * over, so the range guard must NOT intercept it via this resolution).
 */
function resolveStaticTarget(
  baseDir: string,
  subPath: string,
): { path: string; size: number } | undefined {
  const candidate = join(baseDir, subPath);
  const stat = statSyncSafe(candidate);
  if (stat === undefined) return undefined;
  if (stat.isDirectory()) {
    const indexFile = join(candidate, 'index.html');
    const indexStat = statSyncSafe(indexFile);
    return indexStat?.isFile() ? { path: indexFile, size: indexStat.size } : undefined;
  }
  return stat.isFile() ? { path: candidate, size: stat.size } : undefined;
}

/**
 * Given a known file `size`, return a 416 iff `rangeHeader` is UNSATISFIABLE against it, else
 * `undefined`. Parses the header with the SAME tokenizer `serveStatic` uses (`bytes=` stripped, split on
 * `-`, `start = parseInt || 0`, closed `end = parseInt`). UNSATISFIABLE = `start >= size` (an open OR
 * closed range that begins at/after EOF) or a reversed `start > end`; the 416 carries a `Content-Range`
 * naming the full size. A honored / clamped range returns `undefined` so the request falls through to
 * `serveStatic` UNCHANGED — every currently-served 206 keeps its exact bytes.
 */
function unsatisfiableRangeForSize(size: number, rangeHeader: string): Response | undefined {
  const [startToken, endToken] = rangeHeader.replace(/bytes=/, '').split('-', 2);
  const start = Number.parseInt(startToken ?? '', 10) || 0;
  const end = Number.parseInt(endToken ?? '', 10); // NaN for an open/absent end (start >= size covers it)
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return undefined;
}

/**
 * RFC-7233 range validation, additive in front of `serveStatic`. Resolves the target the way
 * `serveStatic` will (reusing its single stat's size — no re-stat, no unchecked cast) and, if the range
 * is unsatisfiable, returns a proper 416 instead of `serveStatic`'s malformed 0-byte 206 (closed beyond
 * EOF) or `ERR_OUT_OF_RANGE` → 500 (open beyond EOF). When the requested path resolves to NO file, an
 * `spa:true` mount would fall through to the SPA fallback, which re-runs the SAME buggy Range math
 * against `baseDir/index.html` — so the range is validated against that `index.html` too. Only a genuine
 * miss with no SPA fallback returns `undefined`, letting `serveStatic` produce its normal 404.
 */
function unsatisfiableRangeResponse(
  baseDir: string,
  subPath: string,
  spa: boolean,
  rangeHeader: string,
): Response | undefined {
  const target = resolveStaticTarget(baseDir, subPath);
  if (target !== undefined) return unsatisfiableRangeForSize(target.size, rangeHeader);
  // Direct target missed. For an spa:true mount the request falls through to `index.html` — guard the
  // range against the file the SPA fallback will actually serve so the buggy math never runs on it.
  if (spa) {
    const indexStat = statSyncSafe(join(baseDir, 'index.html'));
    if (indexStat?.isFile()) return unsatisfiableRangeForSize(indexStat.size, rangeHeader);
  }
  return undefined;
}

/**
 * Register a hardened static handler per declared frontend mount on `app`.
 *
 *  - `mounts`  — the parsed `FrontendSpec[]` (from the deployed spec's `frontend` section).
 *  - `specDir` — the spec file's directory; each mount's `dir` is resolved relative to it.
 *
 * Mounts are registered LONGEST-route-first so a more-specific prefix (e.g. `/admin`) is not shadowed
 * by a `/` catch-all: Hono runs matching handlers in registration order, so the longer prefix's handler
 * runs first and terminates the request before the root mount is reached.
 */
export function mountFrontend<E extends Env>(
  app: Hono<E>,
  mounts: readonly FrontendSpec[],
  specDir: string,
): void {
  // Longest route first (more-specific prefixes win over a `/` catch-all).
  const ordered = [...mounts].sort((a, b) => b.route.length - a.route.length);

  for (const mount of ordered) {
    const { route, spa } = mount;
    const baseDir = resolve(specDir, mount.dir);
    // Pre-resolve the served directory's real path once (the boot guard already proved it exists +
    // is a directory). If it cannot be resolved, fall back to baseDir — serveStatic then misses.
    let realBaseDir: string;
    try {
      realBaseDir = realpathSync(baseDir);
    } catch {
      realBaseDir = baseDir;
    }

    // The byte server. For a non-root route, strip the route prefix so `join(baseDir, subPath)`
    // targets the served directory (serveStatic hands the rewrite the FULL decoded request path).
    const fileServer =
      route === '/'
        ? serveStatic({ root: baseDir })
        : serveStatic({
            root: baseDir,
            rewriteRequestPath: (p: string): string => {
              const stripped = p.slice(route.length);
              return stripped.length > 0 ? stripped : '/';
            },
          });

    // SPA fallback: an unmatched deep link under the mount returns `index.html` (History-API routing).
    // Only reached for a SAFE path that missed the file server — a guard-refused path never gets here.
    const spaServer = spa ? serveStatic({ path: join(baseDir, 'index.html') }) : undefined;

    // A no-op `next` handed to the file/SPA servers so a MISS returns `undefined` (they only advance
    // the chain on a hit by returning a Response). We then decide the fall-through ourselves — a miss
    // must not immediately advance to the platform 404 before the SPA fallback gets a turn.
    const noop: Next = async () => {};

    const handler: MiddlewareHandler<E> = async (c, next) => {
      const decoded = decodeOnce(c.req.path);
      // Platform-reserved namespaces (/v1, /health, /oidc) are NEVER served statically — decline BEFORE
      // the file/SPA server so a registered platform route wins and an unregistered one reaches the
      // uniform 404 (a `/` spa:true catch-all must not answer `/v1/does-not-exist` with the SPA shell).
      if (isReservedRoutePath(decoded)) return next();
      const subPath = route === '/' ? decoded : decoded.slice(route.length);
      // Fail-closed guard BEFORE serving — a refused path skips the file/SPA server entirely and
      // falls through to the platform's uniform 404 (never the SPA shell).
      if (!isSafeStaticPath(baseDir, realBaseDir, subPath)) return next();
      // RFC-7233: an UNSATISFIABLE Range (start at/after EOF, or reversed) gets a proper 416 rather than
      // serveStatic's malformed 0-byte 206 (closed beyond EOF) or ERR_OUT_OF_RANGE → 500 (open beyond
      // EOF). Runs AFTER the fail-closed guard (a refused path already 404'd) and ONLY when a Range
      // header is present. serveStatic special-cases ONLY HEAD/OPTIONS (it answers them 200 full-size,
      // ignoring Range) and routes EVERY other verb (GET/POST/PUT/PATCH/DELETE) through the buggy Range
      // branch — so the guard exempts HEAD/OPTIONS (kept byte-identical, never a 416) and fires for all
      // the rest. On a direct-file miss under an spa:true mount it also guards the index.html the SPA
      // fallback would serve; every honored / clamped range still falls through to serveStatic.
      const rangeHeader = c.req.header('Range');
      if (rangeHeader !== undefined && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
        const rangeRes = unsatisfiableRangeResponse(baseDir, subPath, spa, rangeHeader);
        if (rangeRes) return rangeRes;
      }
      // Serve the file; on a hit serveStatic returns the Response. On a miss it returns undefined —
      // then the SPA fallback (if any) gets a turn; if THAT misses too, fall through to the 404.
      const fileRes = await fileServer(c, noop);
      if (fileRes) return fileRes;
      if (spaServer) {
        const spaRes = await spaServer(c, noop);
        if (spaRes) return spaRes;
      }
      return next();
    };

    // Register the exact route AND its subtree (`/` uses `/` + `/*`). Both point at the same handler.
    const patterns = route === '/' ? ['/', '/*'] : [route, `${route}/*`];
    for (const pattern of patterns) app.use(pattern, handler);
  }
}
