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
 */
import { existsSync, realpathSync } from 'node:fs';
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
