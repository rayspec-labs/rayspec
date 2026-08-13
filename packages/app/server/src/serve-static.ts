/**
 * Static frontend serving — mount a spec's declared `frontend[]` static assets alongside the API.
 *
 * A backend document may declare `frontend: [{ route, dir, spa?, cleanUrls? }]` (grammar.ts) so it can
 * ship its own built web UI next to the routes it exposes. `mountFrontend` registers ONE hardened static
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
 * CLEAN URLS — `cleanUrls: true` (opt-in, default false) resolves an extensionless request the way
 * Netlify / Vercel / GitHub Pages do, so a site whose navigation links `/docs/getting-started` while
 * the built file is `docs/getting-started.html` serves rather than 404s. The mount's full resolution
 * order is then: the EXACT path when it is a file → `<path>.html` → `<path>/index.html` → (only for
 * `spa: true`) the SPA fallback → the root `404.html` / the uniform 404. EXTENSIONLESS is the option's
 * exact domain: a path whose LAST segment carries a `.` names a typed asset (`/app.js`, `/data.json`)
 * and is NEVER rewritten, so a request for a typed file that is not there stays a 404 rather than
 * coming back `200 text/html` from a `<name>.<ext>.html` sibling; only the last segment is inspected,
 * so a dotted directory on the way (`/guide/1.2/notes`) still resolves. Two consequences worth
 * stating: `<path>.html` is tried BEFORE `<path>/index.html`, so on a site that ships BOTH forms the
 * `.html` file wins where the directory index does today (visible only once the mount opts in); and,
 * because the flag adds candidates rather than a catch-all, 404 stays the TERMINAL outcome — the
 * distinction `spa: true` necessarily destroys — for every `spa: false` mount. The resolution runs
 * AFTER the reserved-prefix decline, the fail-closed path guard, the range guard and the method guard,
 * and `<path>.html` passes the SAME dotfile / traversal / symlink-escape hardening as any other served
 * path; a mount that does not set the flag resolves byte-identically to before.
 *
 * CUSTOM 404 PAGE — at the GENUINE-miss fall-through (a request that resolved to no file, has no
 * `dir/index.html`, and no SPA fallback took over), if the mount root ships a `404.html` it is served
 * with status 404 and `text/html` — the GitHub Pages / Netlify / Cloudflare Pages convention. Absent ⇒
 * the platform's uniform 404, byte-unchanged (fully backward compatible). This runs ONLY after the
 * reserved-prefix decline and the fail-closed path guard, so a reserved namespace (`/v1`, `/health`,
 * `/oidc`) and a refused attack path (traversal / dotfile / symlink-escape) keep the uniform 404 and
 * never reach the custom page; on an `spa:true` mount the SPA `index.html` still wins, so the custom
 * page is a plain (`spa:false`) mount's not-found surface. Only the EXACT root FILE `404.html` is
 * eligible: a `404.html` that is a directory, is absent, or is a symlink escaping the served directory
 * is refused (→ the uniform 404, never followed). A HEAD/OPTIONS miss carries the 404 metadata
 * (`Content-Type` + `Content-Length`) but no body, honoring the module's HEAD contract.
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
 *
 * CONTENT METHODS — a static mount is a CONTENT surface: it serves GET, HEAD and OPTIONS, and answers
 * every OTHER verb with a 405 carrying `Allow: GET, HEAD, OPTIONS` and the platform's uniform JSON error
 * envelope. Without it a `POST`/`DELETE` to a path that does not exist under an `spa:true` mount reaches
 * the SPA fallback and comes back as 200 + `index.html` — a success status a client cannot tell apart
 * from a completed write. The guard runs AFTER the reserved-prefix decline, the fail-closed path guard
 * and the range guard (each keeps its exact response for every verb) and BEFORE the file server, so it
 * covers the served files, the SPA fallback and the `404.html` page alike.
 *
 * SECURITY HEADERS — when the caller supplies `securityHeaders`, EVERY response this mount itself
 * serves (a file, the SPA fallback, the custom `404.html` page, the range 416 and the method 405)
 * carries Content-Security-Policy + Permissions-Policy — the two headers the platform's global chain
 * deliberately leaves to a fronting proxy, which a native (proxy-less) serve of the declared frontend
 * must emit itself. The decline/refusal fall-throughs (`next()` — a reserved prefix, a guard-refused
 * path, a genuine miss with no `404.html`) are NOT stamped: those responses belong to the platform
 * surface, whose header chain stays byte-identical. The static (frontend-only) boot OMITS the
 * parameter — `assembleStaticServer` already applies the same two values app-wide, so the static
 * profile's emission stays single-sourced (no double stamp, no drift).
 *
 * INLINE ASSETS vs. THE ACTIVE POLICY — that same Content-Security-Policy is what a served page has to
 * satisfy, and a page that does not satisfy it fails INVISIBLY on this side: the response is 200 and
 * the bytes are whatever the build produced, and only the browser applies the policy. So the boot's
 * one pass over the declared mounts (`frontendMountsReadiness`) also scans their HTML for the inline
 * shapes the ACTIVE policy has no `'unsafe-inline'` for and emits ONE warn-only line naming the files
 * (`blockedInlineAssetWarning`). It is a bounded, heuristic text scan, and what it produces is a
 * string for a warn sink that no caller reads back — serving a page the policy blocks is a
 * deployment's choice to make, and RAYSPEC_FRONTEND_CSP is how it overrides the baseline.
 */
import {
  accessSync,
  closeSync,
  constants,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { errorEnvelope } from '@rayspec/auth-core';
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
 * Does `subPath`'s LAST segment carry a file EXTENSION — i.e. does it contain a `.`? That is the exact
 * test that keeps the clean-URL resolution to the EXTENSIONLESS paths it is defined for: `/docs/intro`
 * is a page link, `/data.json` and `/app.js` name typed assets. Only the last segment is inspected, so a
 * dotted DIRECTORY on the way (`/guide/1.2/notes`) leaves the leaf extensionless and still resolves.
 */
function lastSegmentHasExtension(subPath: string): boolean {
  return subPath.slice(subPath.lastIndexOf('/') + 1).includes('.');
}

/**
 * Resolve the CLEAN-URL target for `subPath` under `baseDir` — the `<subPath>.html` file a
 * `cleanUrls:true` mount serves for an extensionless request (see the module header). Returns the file
 * `{ path, size }` from the stat that proved it a file, or `undefined` when the clean-URL form does not
 * apply, in which case the caller's resolution continues UNCHANGED:
 *
 *   - a DIRECTORY request (the mount root, or a path ending in `/`) keeps its `index.html` — appending
 *     `.html` there would name the hidden file `docs/.html`, which the dotfile guard refuses anyway;
 *   - a TYPED path — one whose last segment carries an extension (`/app.js`, `/data.json`) — is NOT a
 *     clean URL and is left alone, so a MISSING typed asset stays a 404 instead of being answered
 *     `200 text/html` from a `<name>.<ext>.html` sibling. This is what keeps 404 terminal for an
 *     `spa:false` mount in the case that matters most: a fetch/XHR for a file that is not there;
 *   - an EXACT match wins over the clean-URL form: `<subPath>.html` is the fallback for a request path
 *     that is not itself a servable file, never a redirect of one that is;
 *   - `<subPath>.html` runs the SAME fail-closed hardening the request path itself got (`isSafeStaticPath`),
 *     so a dotfile, a candidate escaping the served directory, and a symlink pointing out of it are refused.
 */
function resolveCleanUrlTarget(
  baseDir: string,
  realBaseDir: string,
  subPath: string,
): { path: string; size: number } | undefined {
  if (subPath === '' || subPath.endsWith('/')) return undefined;
  if (lastSegmentHasExtension(subPath)) return undefined;
  if (statSyncSafe(join(baseDir, subPath))?.isFile() === true) return undefined;
  const htmlSubPath = `${subPath}.html`;
  if (!isSafeStaticPath(baseDir, realBaseDir, htmlSubPath)) return undefined;
  const htmlFile = join(baseDir, htmlSubPath);
  const htmlStat = statSyncSafe(htmlFile);
  return htmlStat?.isFile() ? { path: htmlFile, size: htmlStat.size } : undefined;
}

/**
 * Resolve the on-disk file the mount will read for `subPath` under `baseDir`, mirroring the resolution
 * the request itself takes: `join(baseDir, subPath)` when that is a file, then — for a `cleanUrls:true`
 * mount only — `<subPath>.html`, then, if the candidate is a directory, its `index.html`. Returns the
 * file `{ path, size }` from the SAME stat that proved it a file (so the range check never re-stats), or
 * `undefined` when nothing servable exists (a miss — `serveStatic` will 404 / the SPA fallback takes
 * over, so the range guard must NOT intercept it via this resolution). With `cleanUrls:false` the
 * resolution is byte-for-byte `serveStatic`'s own.
 */
function resolveStaticTarget(
  baseDir: string,
  realBaseDir: string,
  subPath: string,
  cleanUrls: boolean,
): { path: string; size: number } | undefined {
  const candidate = join(baseDir, subPath);
  const stat = statSyncSafe(candidate);
  if (stat?.isFile()) return { path: candidate, size: stat.size };
  // CLEAN URLS: `<subPath>.html` is tried BEFORE the directory's `index.html` — the order the hosts
  // this option mirrors use, and the order the mount serves in.
  if (cleanUrls) {
    const cleanTarget = resolveCleanUrlTarget(baseDir, realBaseDir, subPath);
    if (cleanTarget !== undefined) return cleanTarget;
  }
  if (stat?.isDirectory()) {
    const indexFile = join(candidate, 'index.html');
    const indexStat = statSyncSafe(indexFile);
    return indexStat?.isFile() ? { path: indexFile, size: indexStat.size } : undefined;
  }
  return undefined;
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
 * RFC-7233 range validation, additive in front of `serveStatic`. Resolves the target the way the mount
 * will serve it (reusing its single stat's size — no re-stat, no unchecked cast), including a
 * `cleanUrls:true` mount's `<path>.html`, and, if the range is unsatisfiable, returns a proper 416
 * instead of `serveStatic`'s malformed 0-byte 206 (closed beyond EOF) or `ERR_OUT_OF_RANGE` → 500 (open
 * beyond EOF). When the requested path resolves to NO file, an `spa:true` mount would fall through to
 * the SPA fallback, which re-runs the SAME buggy Range math against `baseDir/index.html` — so the range
 * is validated against that `index.html` too. Only a genuine miss with no SPA fallback returns
 * `undefined`, letting `serveStatic` produce its normal 404.
 */
function unsatisfiableRangeResponse(
  baseDir: string,
  realBaseDir: string,
  subPath: string,
  spa: boolean,
  cleanUrls: boolean,
  rangeHeader: string,
): Response | undefined {
  const target = resolveStaticTarget(baseDir, realBaseDir, subPath, cleanUrls);
  if (target !== undefined) return unsatisfiableRangeForSize(target.size, rangeHeader);
  // Direct target missed. For an spa:true mount the request falls through to `index.html` — guard the
  // range against the file the SPA fallback will actually serve so the buggy math never runs on it.
  if (spa) {
    const indexStat = statSyncSafe(join(baseDir, 'index.html'));
    if (indexStat?.isFile()) return unsatisfiableRangeForSize(indexStat.size, rangeHeader);
  }
  return undefined;
}

/** The methods a static CONTENT mount serves; every other verb is answered 405 (see the guard below). */
const CONTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The `Allow` header the 405 advertises — the same set, in the same order. */
const ALLOW_HEADER = 'GET, HEAD, OPTIONS';

/**
 * The platform request id the uniform error envelope echoes. `mountFrontend` is generic over the app's
 * Env, so the variable is read structurally: on the assembled app the `requestId` middleware has already
 * set it, while a bare Hono (no middleware) has none — then the fall-back is the SAME `'unknown'` the
 * platform's own error paths use, so the envelope shape never varies.
 */
function requestIdOf(vars: Readonly<Record<string, unknown>>): string {
  const rid = vars.requestId;
  return typeof rid === 'string' ? rid : 'unknown';
}

/**
 * Serve the mount-root `404.html` on a GENUINE content miss (no file, no `dir/index.html`, no SPA
 * fallback), returning it with status 404 and `text/html` — the GitHub Pages / Netlify / Cloudflare
 * Pages convention for a custom not-found page. Returns `undefined` when the mount ships no such page,
 * so the caller falls through to the platform's uniform 404 UNCHANGED (fully backward compatible for a
 * deployment that ships no root `404.html`). Runs the SAME fail-closed hardening as the rest of the
 * module: it serves ONLY the EXACT root FILE `404.html` — a `404.html` that is a directory, or is
 * absent, yields `undefined` (→ the uniform 404), and the safe-path guard rejects a dotfile/traversal
 * `404.html` and a `404.html` symlink escaping the served directory (never followed). `method` carries
 * the request verb: for HEAD/OPTIONS the response carries the metadata (status + `Content-Type` +
 * `Content-Length`) but NO body, honoring the module's HEAD contract; every other verb gets the bytes.
 * Reached ONLY after the reserved-prefix decline and the fail-closed path guard, so a reserved
 * namespace or a refused attack path keeps the uniform 404 and never gets here.
 */
function serveNotFoundPage(
  baseDir: string,
  realBaseDir: string,
  method: string,
): Response | undefined {
  // Only the EXACT root FILE `404.html` (never a directory named 404.html); same fail-closed hardening
  // as the rest of the module, so a `404.html` symlink escaping the served directory is refused.
  if (!isSafeStaticPath(baseDir, realBaseDir, '/404.html')) return undefined;
  const file = join(baseDir, '404.html');
  const stat = statSyncSafe(file);
  if (stat === undefined || !stat.isFile()) return undefined;
  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
  // HEAD/OPTIONS carry the metadata but never a body (the module's HEAD contract).
  if (method === 'HEAD' || method === 'OPTIONS') {
    return new Response(null, {
      status: 404,
      headers: { ...headers, 'Content-Length': String(stat.size) },
    });
  }
  return new Response(readFileSync(file), { status: 404, headers });
}

/**
 * Whether the declared frontend mounts can be served: `'ok'` when every mount is servable, else
 * `'unavailable'`. This is what `/health` reports as its `frontend` field.
 */
export type FrontendReadiness = 'ok' | 'unavailable';

/**
 * Which requirement a declared mount fails when it cannot be served:
 *   - `'dir'`       — the resolved `dir` is not a readable, traversable directory;
 *   - `'spa-index'` — the directory is fine, but an `spa:true` mount has no readable `index.html`.
 * The two are reported apart because the boot guard names the offending file in its abort message.
 */
export type MountUnservableReason = 'dir' | 'spa-index';

/**
 * Can ONE declared mount be served from disk? `undefined` when it can, else which requirement it
 * fails. `specDir` is the spec file's directory, against which `mount.dir` is resolved — the SAME
 * resolution `mountFrontend` performs.
 *
 * "Servable" is what `mountFrontend` needs from disk for the mount to answer anything:
 *   - the resolved `dir` is a directory, readable AND traversable (`statSync().isDirectory()` alone
 *     passes a mode-0000 directory, from which every asset then EACCES-misses — so `R_OK|X_OK` too);
 *   - for an `spa:true` mount, `dir/index.html` is a readable FILE — the fallback that mount serves
 *     for every unmatched deep link, so without it the SPA answers nothing.
 *
 * THE ONE definition of servable, shared by the two callers that must not disagree: the deploy guard
 * in `deployDeclaredSpec`, which fail-closes the FULL-PLATFORM boot on an unservable mount, and
 * `frontendMountsReadiness` below, which is what `/health` reports. When they disagreed, a mount that
 * failed only the second check booted into a readiness the process could never recover from. The
 * static (frontend-only) boot has no such gate: `assembleStaticServer` reports an unservable mount
 * through `frontendMountsReadiness` and serves on.
 */
export function mountUnservableReason(
  mount: FrontendSpec,
  specDir: string,
): MountUnservableReason | undefined {
  const baseDir = resolve(specDir, mount.dir);
  try {
    if (!statSync(baseDir).isDirectory()) return 'dir';
    accessSync(baseDir, constants.R_OK | constants.X_OK);
  } catch {
    // Missing, unreadable, or not the expected kind — all the same answer: it cannot be served.
    return 'dir';
  }
  if (!mount.spa) return undefined;
  const index = join(baseDir, 'index.html');
  try {
    if (!statSync(index).isFile()) return 'spa-index';
    accessSync(index, constants.R_OK);
  } catch {
    return 'spa-index';
  }
  return undefined;
}

/**
 * Can every declared mount in `mounts` be served from disk? `'ok'` when `mountUnservableReason` clears
 * every one of them, else `'unavailable'`. An empty `mounts` list is `'ok'`: nothing is declared, so
 * nothing can be unservable.
 *
 * CALL THIS ONCE AT BOOT and cache the result. `/health` is polled by load balancers every second; the
 * probe must answer from the cached value and touch no filesystem per call.
 *
 * `inlineScan`, when supplied, ALSO runs the bounded inline-asset scan below against the SAME mounts
 * and emits its one warning on the supplied sink. This is the boot's single pass over the declared
 * mounts, which is the whole reason the scan is docked here rather than on its own hook: both callers
 * (`assembleStaticServer` and `assembleServer`) call this once and hand only the RETURNED value to
 * `registerHealthRoute`, so no `/health` request re-enters it. The scan is EMIT-ONLY: the readiness
 * returned below is computed from `mountUnservableReason` alone, and the scan's own product is a
 * string passed to `warn`. A caller that omits `inlineScan` runs the same loop it always did.
 */
export function frontendMountsReadiness(
  mounts: readonly FrontendSpec[],
  specDir: string,
  inlineScan?: InlineAssetScan,
): FrontendReadiness {
  if (inlineScan !== undefined) {
    const warning = blockedInlineAssetWarning(mounts, specDir, inlineScan.csp);
    if (warning !== undefined) inlineScan.warn(warning);
  }
  for (const mount of mounts) {
    if (mountUnservableReason(mount, specDir) !== undefined) return 'unavailable';
  }
  return 'ok';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inline assets vs. the ACTIVE Content-Security-Policy — the boot-time warning (see the module
// header's INLINE ASSETS section).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The boot-time inline-asset scan's inputs: the policy to judge against, and where to report. */
export interface InlineAssetScan {
  /**
   * The ACTIVE Content-Security-Policy value — what the boot will actually stamp on this mount's
   * responses (RAYSPEC_FRONTEND_CSP when set, else the shipped default). Judging a page against the
   * DEFAULT while the deployment serves something else would warn about a policy nobody is using.
   */
  csp: string;
  /** Where the ONE warning goes — the boot's warn sink. */
  warn: (message: string) => void;
}

/**
 * THE BOUND, part 1: how many HTML files one boot may open, across ALL declared mounts together. A
 * build can carry thousands of pages and a boot must not pay for them; the file this budget makes
 * the scan DECLINE is what sets `filesTruncated` and prints the bound's line, so the number is never
 * a silent claim of full coverage — and a build of exactly this many pages, which cost the scan
 * nothing it refused, is never told otherwise.
 */
export const INLINE_ASSET_SCAN_FILE_LIMIT = 200;

/**
 * THE BOUND, part 2: how many bytes of ONE file the scan reads. Only this prefix is examined; an
 * inline block past it is not seen, and the warning says so when at least one file was longer.
 */
export const INLINE_ASSET_SCAN_BYTE_LIMIT = 1024 * 1024;

/**
 * THE BOUND, part 3: how many offending FILES the warning names. The rest are counted, not listed —
 * a boot log is not a report, and the count is what tells the reader the list is partial.
 */
export const INLINE_ASSET_SCAN_REPORT_LIMIT = 5;

/** The four inline shapes that fall back to `default-src` when no more specific directive is set. */
type InlineAssetKind = 'style-element' | 'script-element' | 'style-attribute' | 'event-attribute';

/**
 * For each shape: what to call it in the warning, and the CSP fallback chain that governs it — the
 * specific directive first, then the shape's `-src`, then `default-src`. That is the CSP Level 3
 * fallback: `style-src-elem`/`style-src-attr` fall back to `style-src`, `script-src-elem`/
 * `script-src-attr` to `script-src`, and both `-src` directives fall back to `default-src`. The FIRST
 * directive of the chain that is present in the policy is the one that decides; the later ones are
 * not consulted.
 */
const INLINE_ASSET_KINDS: Readonly<
  Record<InlineAssetKind, { readonly label: string; readonly chain: readonly string[] }>
> = {
  'style-element': {
    label: 'inline <style> element',
    chain: ['style-src-elem', 'style-src', 'default-src'],
  },
  'script-element': {
    label: 'inline <script> element',
    chain: ['script-src-elem', 'script-src', 'default-src'],
  },
  'style-attribute': {
    label: 'style= attribute',
    chain: ['style-src-attr', 'style-src', 'default-src'],
  },
  'event-attribute': {
    label: 'on*= handler attribute',
    chain: ['script-src-attr', 'script-src', 'default-src'],
  },
};

/**
 * Split a policy string into `directive-name → source list`, both lower-cased. A directive that
 * appears twice keeps its FIRST occurrence, which is how CSP Level 3 has a user agent treat a
 * repeated directive name, and an empty segment — a trailing `;`, a `;;` — is skipped.
 */
function parseContentSecurityPolicy(policy: string): ReadonlyMap<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>();
  for (const segment of policy.split(';')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const name = tokens[0]?.toLowerCase();
    if (name === undefined) continue;
    if (!directives.has(name))
      directives.set(
        name,
        tokens.slice(1).map((t) => t.toLowerCase()),
      );
  }
  return directives;
}

/** A hash or nonce source expression, whose content this scan does not evaluate (see below). */
function isHashOrNonceSource(source: string): boolean {
  return (
    source.startsWith("'nonce-") ||
    source.startsWith("'sha256-") ||
    source.startsWith("'sha384-") ||
    source.startsWith("'sha512-")
  );
}

/**
 * Which directive of `kind`'s chain BLOCKS an inline block of that shape — `undefined` when nothing
 * in the policy does, which is the answer that keeps the boot quiet.
 *
 * Three ways to come back `undefined`. The first two follow from the policy text; the third is a
 * deliberate silence:
 *   - no directive of the chain is in the policy at all ⇒ nothing in it governs the shape;
 *   - the governing directive carries `'unsafe-inline'` ⇒ allowed, which is what that keyword is;
 *   - the governing directive carries a HASH or NONCE source. This scan does NOT compute the digest
 *     of the block it found or read a page's nonce attributes, so it cannot tell an allow-listed
 *     block from a stale one — and a deployment that went to the trouble of listing hashes is the
 *     one that has already done this work. It stays silent rather than accuse it wrongly; the cost
 *     is that a NON-matching block under such a policy is missed. Stated in the warning's own
 *     heuristic note and in the tests that pin it.
 */
function blockingDirective(
  policy: ReadonlyMap<string, readonly string[]>,
  kind: InlineAssetKind,
): string | undefined {
  for (const name of INLINE_ASSET_KINDS[kind].chain) {
    const sources = policy.get(name);
    if (sources === undefined) continue;
    if (sources.some(isHashOrNonceSource)) return undefined;
    if (sources.includes("'unsafe-inline'")) return undefined;
    return name;
  }
  return undefined;
}

/**
 * Pull an HTML start tag's attributes out of its raw attribute text, lower-casing names and
 * unquoting values. Deliberately small: it recognises `name`, `name=value`, `name="value"` and
 * `name='value'`, which is what the shapes below need to decide (`src`, `type`, `style`, `on*`).
 */
function parseTagAttributes(raw: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]*))?/g;
  for (let m = pattern.exec(raw); m !== null; m = pattern.exec(raw)) {
    const name = m[1]?.toLowerCase();
    if (name === undefined) continue;
    const value = m[2] ?? '';
    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
    if (!attributes.has(name)) attributes.set(name, unquoted);
  }
  return attributes;
}

/**
 * A `<script>` whose `type` names a DATA block (`application/json`, `application/ld+json`, any
 * `+json`) — a browser does not execute one, and reporting it would be a false positive on a shape
 * generated builds emit constantly. Everything else without a `src` is treated as inline code,
 * including `type="module"`, `type="importmap"` and any type this scan does not recognise: on an
 * unknown type it errs toward reporting.
 */
function isDataScriptType(type: string | undefined): boolean {
  if (type === undefined) return false;
  const normalized = type.trim().toLowerCase();
  return normalized.endsWith('+json') || normalized === 'application/json';
}

/**
 * Which of the four inline shapes does `html` carry? A HEURISTIC text scan, NOT an HTML parser —
 * what it does do, so a reader knows what the answer is worth:
 *   - HTML comments are removed first, so a commented-out `<style>` is not reported;
 *   - `<script>` and `<style>` bodies are skipped as raw text (the spec's raw-text elements), so a
 *     `style="…"` inside a JS string or a CSS `content` value is not reported as an attribute; a
 *     body that is only whitespace is not reported as an inline block either;
 *   - attributes are read off START TAGS only, so the words `style=` / `onclick=` in page COPY are
 *     not reported — and off EVERY start tag, `<script>` and `<style>` included, whose `on*=` and
 *     `style=` the policy governs exactly like any other element's (only their BODIES are skipped).
 * What it does NOT do: resolve malformed markup the way a browser's tokenizer would, follow
 * `<template>` or `srcdoc` content, or evaluate anything a script writes at runtime. False positives
 * and misses both remain possible, which is exactly why this is warn-only and says so in the message.
 */
function inlineAssetKinds(html: string): ReadonlySet<InlineAssetKind> {
  const source = html.replace(/<!--[\s\S]*?-->/g, ' ');
  // One lower-cased copy for the end-tag search below — a per-tag `toLowerCase()` would re-copy the
  // whole file for every `<script>`/`<style>` on it.
  const lowered = source.toLowerCase();
  const found = new Set<InlineAssetKind>();
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  for (let m = tagPattern.exec(source); m !== null; m = tagPattern.exec(source)) {
    const name = m[1]?.toLowerCase();
    if (name === undefined) continue;
    const attributes = parseTagAttributes(m[2] ?? '');

    // Attributes come off EVERY start tag, `<script>`/`<style>` included: a `<script src=… onerror=…>`
    // or a `<style onload=…>` carries a handler the policy governs exactly like any other element's,
    // and it is the raw-text BODY skip below — not skipping these tags — that keeps a `style="…"`
    // inside a JS string or a CSS value from being read as an attribute.
    if (attributes.has('style')) found.add('style-attribute');
    // `on` + at least three letters — the shortest real handler names (`onblur`, `oncut`) clear it,
    // while an ordinary `once`/`on` attribute does not. Heuristic, like the rest of this scan.
    for (const attribute of attributes.keys()) {
      if (/^on[a-z]{3,}$/.test(attribute)) {
        found.add('event-attribute');
        break;
      }
    }

    if (name === 'script' || name === 'style') {
      // Consume the raw-text body up to the matching end tag (or to EOF when it is unterminated),
      // both to judge emptiness and so its content cannot masquerade as markup below.
      const bodyStart = tagPattern.lastIndex;
      const closeAt = lowered.indexOf(`</${name}`, bodyStart);
      const body = source.slice(bodyStart, closeAt === -1 ? undefined : closeAt);
      if (closeAt !== -1) tagPattern.lastIndex = closeAt + name.length + 2;
      const external = name === 'script' && attributes.has('src');
      const data = name === 'script' && isDataScriptType(attributes.get('type'));
      if (!external && !data && body.trim() !== '') {
        found.add(name === 'script' ? 'script-element' : 'style-element');
      }
    }
  }
  return found;
}

/**
 * Read at most `INLINE_ASSET_SCAN_BYTE_LIMIT` bytes of a file; `truncated` when it is longer. The
 * buffer is sized to the file (capped), so a directory of small pages never allocates the cap.
 */
function readHtmlPrefix(file: string, size: number): { text: string; truncated: boolean } {
  const fd = openSync(file, 'r');
  try {
    const wanted = Math.min(size, INLINE_ASSET_SCAN_BYTE_LIMIT);
    const buffer = Buffer.alloc(wanted);
    const read = readSync(fd, buffer, 0, wanted, 0);
    return {
      text: buffer.toString('utf8', 0, read),
      truncated: size > INLINE_ASSET_SCAN_BYTE_LIMIT,
    };
  } finally {
    closeSync(fd);
  }
}

/** One offending file: its path relative to the spec, and the blocked shapes it carries. */
interface InlineAssetFinding {
  file: string;
  detail: string;
}

/** What the scan of one mount tree accumulates, shared across mounts so the bound is a boot bound. */
interface InlineAssetScanState {
  readonly blocked: ReadonlyMap<InlineAssetKind, string>;
  readonly specDir: string;
  /** REAL paths of the files already examined — a link and its target are one file, examined once. */
  readonly seen: Set<string>;
  /** REAL paths of the directories already walked — what makes a symlink cycle terminate. */
  readonly seenDirs: Set<string>;
  readonly findings: InlineAssetFinding[];
  filesScanned: number;
  /** Set ONLY when an HTML file was actually declined for want of budget — see `scanHtmlTree`. */
  filesTruncated: boolean;
  bytesTruncated: boolean;
}

/**
 * What one directory entry resolves to, when the mount would serve it at all: its REAL path (the
 * file's identity, so a link and its target are not examined twice) and its kind. `undefined` when
 * the entry cannot be resolved or stat'ed, and when its real path lies OUTSIDE `realMountDir` —
 * `isSafeStaticPath`'s check (c) applies the same `realpathSync`-inside-`realBaseDir` test to every
 * request, so an escaping symlink is refused by the mount and a finding on it would name a file the
 * mount never hands out.
 *
 * `realDir` is the caller's ALREADY-REAL directory path, so a non-symlink entry's real path is
 * `join(realDir, name)` — no syscall — and containment holds by construction. Only a symlink pays
 * for a `realpathSync`.
 */
function resolveScanEntry(
  entry: Dirent,
  realDir: string,
  realMountDir: string,
): { real: string; isDirectory: boolean; isFile: boolean } | undefined {
  if (!entry.isSymbolicLink()) {
    return {
      real: join(realDir, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    };
  }
  let real: string;
  let stats: Stats;
  try {
    real = realpathSync(join(realDir, entry.name));
    stats = statSync(real);
  } catch {
    return undefined; // broken link, or unreadable — the mount misses on it too
  }
  if (real !== realMountDir && !real.startsWith(realMountDir + sep)) return undefined;
  return { real, isDirectory: stats.isDirectory(), isFile: stats.isFile() };
}

/**
 * Walk one directory tree, examining its `.html`/`.htm` files until the file bound is spent. Entries
 * are sorted so a truncated scan covers the same files on every boot. `dir` is the path the mount
 * SERVES this tree at (what a finding is named by); `realDir` is its resolved real path.
 *
 * What it walks is what the mount hands out, and each skip is the mount's own refusal — both
 * refusals are requested against a real boot, and asserted 404, by the coverage arms of
 * `frontend-inline-asset-csp.test.ts`:
 *   - a DOT-SEGMENT entry is skipped — `isSafeStaticPath`'s check (a) refuses any REQUEST-path
 *     segment beginning with `.`, so nothing under it is servable UNDER THAT NAME. Reachable it may
 *     still be, through an in-tree link from elsewhere in the tree; that is the next bullet's job,
 *     and it is how a `dist/index.html -> dist/.build/index.html` build gets covered;
 *   - a SYMLINK is FOLLOWED when `resolveScanEntry` proves its target inside the mount's real
 *     directory, because the mount serves it — `isSafeStaticPath` refuses symlink-ESCAPE only, so
 *     skipping in-tree links would leave a served page unscanned — and skipped when it escapes,
 *     which that same check (c) refuses per request;
 *   - a directory whose REAL path was already walked is skipped, which is what terminates a link
 *     cycle (`dist/self -> dist`) and what makes two mounts over one directory one walk.
 *
 * THE FILE BOUND is recorded, never inferred: `filesTruncated` is set at the moment an HTML file is
 * DECLINED for want of budget, so a build of exactly `INLINE_ASSET_SCAN_FILE_LIMIT` pages — budget
 * spent, nothing left — reports no truncation. Once a file has been declined the answer cannot
 * change, so the walk stops there rather than keep looking for more it will not read.
 *
 * An unreadable directory or file is skipped, not reported: this is a warning path, and
 * `frontendMountsReadiness` is what answers for a mount that cannot be served.
 */
function scanHtmlTree(
  dir: string,
  realDir: string,
  realMountDir: string,
  state: InlineAssetScanState,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (state.filesTruncated) return; // a declined file already settled it
    if (entry.name.startsWith('.')) continue;
    const resolved = resolveScanEntry(entry, realDir, realMountDir);
    if (resolved === undefined) continue;
    const full = join(dir, entry.name);
    if (resolved.isDirectory) {
      if (state.seenDirs.has(resolved.real)) continue;
      state.seenDirs.add(resolved.real);
      scanHtmlTree(full, resolved.real, realMountDir, state);
      continue;
    }
    if (!resolved.isFile || !/\.html?$/i.test(entry.name)) continue;
    if (state.seen.has(resolved.real)) continue; // already examined under another servable path
    state.seen.add(resolved.real);
    if (state.filesScanned >= INLINE_ASSET_SCAN_FILE_LIMIT) {
      state.filesTruncated = true;
      return;
    }
    state.filesScanned += 1;
    let prefix: { text: string; truncated: boolean };
    try {
      prefix = readHtmlPrefix(full, statSync(full).size);
    } catch {
      continue;
    }
    if (prefix.truncated) state.bytesTruncated = true;
    const detail = [...inlineAssetKinds(prefix.text)]
      .flatMap((kind) => {
        const directive = state.blocked.get(kind);
        return directive === undefined ? [] : [`${INLINE_ASSET_KINDS[kind].label} (${directive})`];
      })
      .sort();
    if (detail.length > 0) {
      state.findings.push({
        file: relative(state.specDir, full).split(sep).join('/'),
        detail: detail.join(', '),
      });
    }
  }
}

/**
 * The ONE boot warning for served pages carrying an inline block the ACTIVE policy blocks —
 * `undefined` when there is nothing to say, which is every clean build and every deployment whose
 * policy already permits the shapes it ships. A scan that found NOTHING is silent even when a bound
 * truncated it: this warning exists to name offending files, and a boot line reporting only how far
 * a scan got would fire on every large clean build forever.
 *
 * Order of work, cheapest first: decide from the POLICY ALONE which of the four shapes could be
 * blocked at all, and when none can be, return without opening a single file — a deployment that
 * set `RAYSPEC_FRONTEND_CSP` to something permissive pays nothing for this. Only then walk the
 * mounts, under the three bounds above.
 *
 * Every filesystem call below is individually wrapped — an unreadable directory or file is skipped
 * rather than raised — and the returned string is handed to a warn sink whose value nothing reads
 * back, so whatever this finds (or fails to read), the boot proceeds as it would have.
 */
export function blockedInlineAssetWarning(
  mounts: readonly FrontendSpec[],
  specDir: string,
  csp: string,
): string | undefined {
  const policy = parseContentSecurityPolicy(csp);
  const blocked = new Map<InlineAssetKind, string>();
  for (const kind of Object.keys(INLINE_ASSET_KINDS) as InlineAssetKind[]) {
    const directive = blockingDirective(policy, kind);
    if (directive !== undefined) blocked.set(kind, directive);
  }
  if (blocked.size === 0) return undefined;

  const state: InlineAssetScanState = {
    blocked,
    specDir,
    seen: new Set(),
    seenDirs: new Set(),
    findings: [],
    filesScanned: 0,
    filesTruncated: false,
    bytesTruncated: false,
  };
  for (const mount of mounts) {
    if (state.filesTruncated) break;
    const dir = resolve(specDir, mount.dir);
    // The mount's own real base directory, resolved exactly as `mountFrontend` resolves it (same
    // fallback on failure), so the walk's containment test and the request guard's agree.
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      realDir = dir;
    }
    if (state.seenDirs.has(realDir)) continue; // two mounts may declare the same directory
    state.seenDirs.add(realDir);
    scanHtmlTree(dir, realDir, realDir, state);
  }
  if (state.findings.length === 0) return undefined;

  const total = state.findings.length;
  const listed = state.findings.slice(0, INLINE_ASSET_SCAN_REPORT_LIMIT);
  const lines = [
    `warning: ${total} served HTML ${total === 1 ? 'file carries' : 'files carry'} an inline ` +
      'block that the ACTIVE Content-Security-Policy does not permit. The mount serves them 200 ' +
      'with the bytes unchanged and the browser is the only thing that applies the policy — and it ' +
      'need not say so either: a refused inline <style> can produce no console message at all, so ' +
      'the browser console is not a reliable way to check this.',
    ...listed.map((f) => `  ${f.file} — ${f.detail}`),
  ];
  if (total > listed.length) {
    lines.push(
      `  … and ${total - listed.length} more — this warning names the first ` +
        `${INLINE_ASSET_SCAN_REPORT_LIMIT}.`,
    );
  }
  if (state.filesTruncated) {
    lines.push(
      `  Bound: the scan stopped after ${INLINE_ASSET_SCAN_FILE_LIMIT} HTML files — at least one ` +
        'more served HTML file was NOT examined.',
    );
  }
  if (state.bytesTruncated) {
    lines.push(
      `  Bound: at least one file is larger than ${INLINE_ASSET_SCAN_BYTE_LIMIT} bytes — only that ` +
        'much of it was examined.',
    );
  }
  lines.push(
    '  This is a HEURISTIC text scan of the served HTML, not an HTML parser, and it does not ' +
      'compute hashes: markup quoted inside an attribute or a string can be named here, unusual ' +
      'markup can be missed, and a policy carrying a hash or nonce source is treated as permitting ' +
      'that shape.',
    '  Either move the inline block into a served file, or set RAYSPEC_FRONTEND_CSP to a policy ' +
      'that permits it. The boot is unaffected either way — this is a warning, not a refusal.',
  );
  return lines.join('\n');
}

/**
 * The two frontend security-header VALUES a mount stamps on every response it serves (see the module
 * header's SECURITY HEADERS section). The VALUES come from the caller — the composition root resolves
 * them from RAYSPEC_FRONTEND_CSP / RAYSPEC_PERMISSIONS_POLICY with the shared secure defaults, so the
 * env overrides mean the same thing in both boot shapes.
 */
export interface FrontendSecurityHeaders {
  /** The Content-Security-Policy header value. */
  csp: string;
  /** The Permissions-Policy header value. */
  permissionsPolicy: string;
}

/**
 * Register a hardened static handler per declared frontend mount on `app`.
 *
 *  - `mounts`  — the parsed `FrontendSpec[]` (from the deployed spec's `frontend` section).
 *  - `specDir` — the spec file's directory; each mount's `dir` is resolved relative to it.
 *  - `securityHeaders` — when present, stamped on every response the mount itself serves (the
 *    full-backend boot passes it; the static boot omits it — its app-wide chain already emits both).
 *
 * Mounts are registered LONGEST-route-first so a more-specific prefix (e.g. `/admin`) is not shadowed
 * by a `/` catch-all: Hono runs matching handlers in registration order, so the longer prefix's handler
 * runs first and terminates the request before the root mount is reached.
 */
export function mountFrontend<E extends Env>(
  app: Hono<E>,
  mounts: readonly FrontendSpec[],
  specDir: string,
  securityHeaders?: FrontendSecurityHeaders,
): void {
  // Stamp the mount's security headers (when the boot supplies them) on a response THIS mount serves.
  // Runs at the return points that answer the request — never on a `next()` fall-through, so the
  // platform surface (reserved prefixes, refused paths, the uniform 404) keeps its exact headers.
  const stamped = (res: Response): Response => {
    if (securityHeaders !== undefined) {
      res.headers.set('Content-Security-Policy', securityHeaders.csp);
      res.headers.set('Permissions-Policy', securityHeaders.permissionsPolicy);
    }
    return res;
  };

  // Longest route first (more-specific prefixes win over a `/` catch-all).
  const ordered = [...mounts].sort((a, b) => b.route.length - a.route.length);

  for (const mount of ordered) {
    const { route, spa, cleanUrls } = mount;
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

    // CLEAN URLS: the same byte server pointed at `<path>.html`. `serveStatic` hands the rewrite the
    // FULL decoded request path, so the rewrite strips the route prefix exactly as `fileServer`'s does
    // and appends the extension. Only invoked once `resolveCleanUrlTarget` has proven that file exists
    // and is safe to serve, so this server never resolves a path the guards have not cleared.
    const cleanUrlServer = cleanUrls
      ? serveStatic({
          root: baseDir,
          rewriteRequestPath: (p: string): string =>
            `${route === '/' ? p : p.slice(route.length)}.html`,
        })
      : undefined;

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
        const rangeRes = unsatisfiableRangeResponse(
          baseDir,
          realBaseDir,
          subPath,
          spa,
          cleanUrls,
          rangeHeader,
        );
        if (rangeRes) return stamped(rangeRes);
      }
      // METHOD: a static mount is a CONTENT surface — it serves GET/HEAD/OPTIONS and answers every other
      // verb 405 with `Allow` + the platform's uniform JSON envelope, instead of handing it to the file
      // server or the SPA fallback. A POST/DELETE to a path that no longer exists under an spa:true mount
      // would otherwise come back as 200 + index.html, a success status a client cannot tell apart from a
      // completed write. Runs AFTER the reserved-prefix decline, the fail-closed path guard and the range
      // guard — so a reserved namespace, a refused attack path and an unsatisfiable range keep their exact
      // responses for EVERY verb — and BEFORE the file server, so it covers the served files, the SPA
      // fallback and the `404.html` page alike. ALTERNATIVE CONSIDERED: answer 404 instead, which reveals
      // less about which paths exist. Rejected — a static mount's paths are public content anyway, so the
      // existence signal costs nothing, while 405 + `Allow` names the removed-route case exactly (the
      // surface does not take this method) rather than folding it into the not-found bucket, where it is
      // indistinguishable from a mistyped path.
      if (!CONTENT_METHODS.has(c.req.method)) {
        return stamped(
          c.json(
            errorEnvelope('METHOD_NOT_ALLOWED', 'Method not allowed.', requestIdOf(c.var)),
            405,
            { Allow: ALLOW_HEADER },
          ),
        );
      }
      // CLEAN URLS (opt-in): an EXTENSIONLESS path that is not itself a file is served as
      // `<path>.html` — BEFORE the file server, whose own resolution would answer `<path>/index.html`.
      // A typed path (`/app.js`, `/data.json`) is out of the option's domain and is never rewritten.
      // Runs AFTER every guard above, so a reserved namespace, a refused attack path, an unsatisfiable
      // range and a non-content verb keep their exact responses; when no such file exists the request
      // falls through to the file server UNCHANGED, so `<path>/index.html`, the SPA fallback and the
      // terminal 404 all keep their turn in that order.
      if (cleanUrlServer && resolveCleanUrlTarget(baseDir, realBaseDir, subPath) !== undefined) {
        const cleanRes = await cleanUrlServer(c, noop);
        if (cleanRes) return stamped(cleanRes);
      }
      // Serve the file; on a hit serveStatic returns the Response. On a miss it returns undefined —
      // then the SPA fallback (if any) gets a turn; if THAT misses too, fall through to the 404.
      const fileRes = await fileServer(c, noop);
      if (fileRes) return stamped(fileRes);
      if (spaServer) {
        const spaRes = await spaServer(c, noop);
        if (spaRes) return stamped(spaRes);
      }
      // A genuine miss with no SPA fallback: if the mount ships a root `404.html`, serve it with status 404
      // (the GitHub Pages / Netlify / Cloudflare Pages convention). Absent → the platform's uniform 404, unchanged.
      const notFoundRes = serveNotFoundPage(baseDir, realBaseDir, c.req.method);
      if (notFoundRes) return stamped(notFoundRes);
      return next();
    };

    // Register the exact route AND its subtree (`/` uses `/` + `/*`). Both point at the same handler.
    const patterns = route === '/' ? ['/', '/*'] : [route, `${route}/*`];
    for (const pattern of patterns) app.use(pattern, handler);
  }
}
