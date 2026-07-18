/**
 * Escape-hatch handler loader (the mechanism, fail-closed).
 *
 * Resolves each `handlers[]` mapping (`{ id, module, export, kind }`) to a concrete function symbol
 * imported from a PATH-JAILED `escapeHatchRoot`, at CONFIG-LOAD / BOOT time. The contract is
 * FAIL-CLOSED: a `..`/absolute/bare-specifier module, a module that does not exist, or a missing /
 * non-function export ABORTS THE DEPLOY here — NEVER a runtime 500 when a route/agent later fires.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PATH JAIL (security-load-bearing).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A `handlers[].module` is AUTHOR-CONTROLLED config. It is a FILESYSTEM PATH relative to
 * `escapeHatchRoot` (NOT a Node import specifier) — so `handlers/x.ts` and `./handlers/x.ts` both
 * mean "the file at <root>/handlers/x.ts". If it could escape the root, a deploy could import an
 * arbitrary file on disk as a "handler" — defeating the `gate:handler-imports` boundary and the whole
 * trusted-escape-hatch-library model. So the loader RESOLVES every module RELATIVE TO THE ROOT (never
 * passes the raw spec to `import()`), and REJECTS before any import:
 *   1. an ABSOLUTE module path (`/etc/...`, `C:\...`) — a handler module is always relative to the root;
 *   2. a `..` traversal segment anywhere in the RAW path — cannot climb out of the root (checked on the
 *      un-normalized spec so an inward-collapsing `./a/../b` is also rejected);
 *   3. a path whose RESOLVED absolute form is not CONTAINED within the resolved `escapeHatchRoot`
 *      (the belt-and-suspenders LEXICAL containment check — catches anything the segment checks missed);
 *   4. a path whose REAL (symlink-resolved) form escapes the root — a `realpath` re-check (#4 below):
 *      checks 1-3 are LEXICAL (`resolve`/`normalize` don't follow symlinks), so a symlink inside the
 *      root pointing OUT would pass them, then `import()` would follow it; the realpath re-check
 *      closes that (best-effort: skipped only when the file doesn't exist yet, where `import()`
 *      fail-closes anyway). Under trusted-author it's defense-in-depth, not an escalation fix.
 *
 * A "bare npm specifier" (`fs`, `lodash`, `@scope/pkg`) is NOT a special case: because EVERY module is
 * resolved RELATIVE TO THE ROOT, `lodash` resolves to `<root>/lodash` (which does not exist → import
 * fail-closes), NOT to the node_modules package — a bare specifier can never reach an npm dependency.
 * Only a path that survives the checks above is imported, and only from within the root.
 *
 * TRUSTED-AUTHOR caveat: once imported + invoked in-process, a handler can reach
 * `fs`/`fetch`/`process.env` via Node globals regardless of the jail — the jail bounds WHICH FILE
 * is loaded as a handler, not what that file may do once running. Real runtime confinement is the
 * per-tenant isolate (see handler-runtime.ts). The before-external-exposure gate is absolute.
 */
import { realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HandlerKind, HandlerSpec } from '@rayspec/spec';
import type { ResolvedHandler } from './handler-runtime.js';

/** A fail-closed loader error — every message names the offending handler id + module for the deploy log. */
export class HandlerLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerLoadError';
  }
}

/**
 * A module importer — injected so the loader is testable WITHOUT a real on-disk module (a test
 * passes a fake importer; production passes the real dynamic `import()`). It receives the
 * ALREADY-JAILED absolute path (the jail runs BEFORE the importer is ever called) and returns the
 * module namespace. Keeping the importer injectable does NOT weaken the jail — the jail is applied
 * here, the importer only ever sees a vetted absolute path inside the root.
 */
export type ModuleImporter = (absolutePath: string) => Promise<Record<string, unknown>>;

/**
 * The TypeScript-source file extensions production refuses to load. The set is CLOSED and matched by a
 * plain `extname` comparison — so the guard is DETERMINISTIC and independent of the Node runtime's
 * behavior (whether or not a given Node version transparently type-strips `.ts` on import).
 */
const TYPESCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * The COMPILED-JAVASCRIPT contract (fail-closed). Production loads escape-hatch handler + extension-pack
 * modules as compiled JavaScript ONLY: this rejects any module resolved to a TypeScript-source file
 * BEFORE it is imported, with an ACTIONABLE message telling the author to compile the module first.
 *
 * WHY AN EXPLICIT EXTENSION CHECK (not "let `import()` fail"): some Node versions transparently
 * type-strip `.ts` on import, so a raw `.ts` handler would RUN — untyped, unchecked, and reliant on an
 * experimental runtime feature that breaks on enums/namespaces/decorators and can be removed. Enforcing
 * the compiled-`.js` boundary HERE, by construction, makes the production contract the same on every
 * Node version. A dev/test caller that intentionally loads un-built source uses `typeStrippingImporter`
 * (the explicit opt-in seam below) — production always uses the guarded `defaultImporter`.
 */
export function assertCompiledJavaScriptModule(absolutePath: string): void {
  const ext = extname(absolutePath).toLowerCase();
  if (TYPESCRIPT_SOURCE_EXTENSIONS.has(ext)) {
    throw new HandlerLoadError(
      `module '${absolutePath}' is TypeScript source ('${ext}') — production loads compiled ` +
        'JavaScript only. Compile it to JavaScript first and deploy the built module: the bundled ' +
        "backend examples ship a build step (run the example's `node build.mjs` and deploy the " +
        'built output). Refusing to load a TypeScript source module (fail-closed).',
    );
  }
}

/**
 * A real dynamic `import()` of an absolute file URL (a vetted in-root path) — the shared import
 * mechanism both importers use, WITHOUT the compiled-JavaScript guard.
 *
 * SECURITY (JAIL-URLDECODE-ESCAPE fix): build the URL with `pathToFileURL` — it PERCENT-ENCODES the
 * path, so a stray `%2e%2e`/`#`/`?` stays LITERAL instead of being URL-DECODED to `..`/fragment/query
 * (a naive `new URL('file://' + path)` decodes `%2e%2e`→`..` and would escape the jail). Then
 * ROUND-TRIP re-assert `fileURLToPath(url) === absolutePath` before importing: this proves the URL
 * round-trip did not alter the (already jail-vetted) path. The jail ALSO rejects `%`/`#`/`?` outright
 * (jailModulePath), so this is layered defense-in-depth — neither layer alone is relied upon.
 */
const importAbsoluteFileUrl = async (absolutePath: string): Promise<Record<string, unknown>> => {
  const url = pathToFileURL(absolutePath);
  const roundTrip = fileURLToPath(url);
  if (roundTrip !== absolutePath) {
    throw new HandlerLoadError(
      `module path '${absolutePath}' did not round-trip through pathToFileURL/fileURLToPath ` +
        `(got '${roundTrip}') — refusing to import (URL-decode escape guard, fail-closed).`,
    );
  }
  return (await import(url.href)) as Record<string, unknown>;
};

/**
 * The default importer (PRODUCTION): assert the module is compiled JavaScript (fail-closed on a
 * TypeScript-source path, deterministically, on any Node version), then dynamically import it. This is
 * the importer `deploy()`/`loadHandlers`/`loadExtensions` use unless a caller explicitly injects
 * another — so the compiled-JavaScript boundary holds at EVERY production module-load site.
 */
export const defaultImporter: ModuleImporter = async (absolutePath) => {
  assertCompiledJavaScriptModule(absolutePath);
  return importAbsoluteFileUrl(absolutePath);
};

/**
 * The DEV/TEST seam importer — an EXPLICIT opt-in that loads a module WITHOUT the compiled-JavaScript
 * guard, relying on the runtime's TypeScript type-stripping (Node's built-in stripping, or the test
 * runner's transform) to execute an un-built `.ts` source. It exists ONLY so dev tooling + tests can
 * exercise un-built example handlers/packs; PRODUCTION never uses it (the production entrypoint injects
 * nothing, so the guarded `defaultImporter` above is used). Passing this importer is the SINGLE, visible
 * way un-built source ever loads — there is no ambient path that bypasses the guard.
 */
export const typeStrippingImporter: ModuleImporter = async (absolutePath) => {
  return importAbsoluteFileUrl(absolutePath);
};

/**
 * Validate a `handlers[].module` against the path jail and return its RESOLVED absolute path inside
 * `escapeHatchRoot`. THROWS `HandlerLoadError` (fail-closed) on any escape attempt. Pure + no I/O so
 * a test exercises the EXACT jail logic the loader runs. Exported for the jail unit test.
 */
export function jailModulePath(
  escapeHatchRoot: string,
  moduleSpec: string,
  handlerId: string,
): string {
  const root = resolve(escapeHatchRoot);

  // (0) URL-SIGNIFICANT chars (JAIL-URLDECODE-ESCAPE fix + LOADER-2): `%`/`#`/`?` are not valid
  // handler-filename chars in this grammar, and each is a jail-bypass vector when the path later
  // becomes a file URL: `%2e%2e` URL-DECODES to `..` (escaping the root past the lexical `..` check
  // below), `#`/`?` start a URL fragment/query that truncates/reinterprets the path. Reject them at
  // the SOURCE, fail-closed, BEFORE any resolution. (defaultImporter also percent-encodes +
  // round-trips as a second layer; neither is relied upon alone.)
  const URL_SIGNIFICANT = /[%#?]/;
  if (URL_SIGNIFICANT.test(moduleSpec)) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' contains a URL-significant character (% # ?) — ` +
        'these are not valid handler-module path chars and are a URL-decode/fragment jail-bypass ' +
        'vector (e.g. %2e%2e → ..). Rejected at the source (path-jail, fail-closed).',
    );
  }

  // (1) absolute module path — a handler module is always relative to the root.
  if (isAbsolute(moduleSpec)) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' is an ABSOLUTE path — handler modules must be ` +
        'relative to the escape-hatch root (path-jail, fail-closed).',
    );
  }

  // (2) `..` traversal anywhere in the RAW segments — cannot climb out of the root. CRITICAL: check
  // the UN-normalized spec, because `normalize('./a/../b.ts')` collapses the `..` away to `b.ts`
  // (still inside) and would slip past a normalized check. We forbid a `..` segment OUTRIGHT (rather
  // than reason about where it lands) so even an inward-collapsing `..` is rejected fail-closed.
  const rawSegments = moduleSpec.split(/[/\\]/);
  if (rawSegments.includes('..')) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' contains a '..' traversal segment — a handler ` +
        'module may not climb out of the escape-hatch root (path-jail, fail-closed).',
    );
  }

  // (3) containment belt-and-suspenders: resolve under the root and confirm the absolute result is
  // INSIDE the root (relative path must not start with `..` and must not be absolute). Catches any
  // normalization-escape the segment checks missed.
  const absolute = resolve(root, normalize(moduleSpec));
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' resolves OUTSIDE the escape-hatch root ` +
        `(${root}) — refusing to load (path-jail, fail-closed).`,
    );
  }
  // Guard the exact-root edge (rel === '') above + ensure the absolute path is under root + sep.
  if (!absolute.startsWith(root + sep)) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' does not resolve to a file UNDER the ` +
        `escape-hatch root (${root}) — refusing to load (path-jail, fail-closed).`,
    );
  }

  // (4) SYMLINK re-check (defense-in-depth — review finding): the checks above are LEXICAL
  // (`resolve`/`normalize` do NOT follow symlinks), so a symlink INSIDE the root pointing OUT would
  // pass containment, then `import()` would follow it out of the jail. Under TRUSTED-AUTHOR this is
  // not an escalation (the author already has in-process code-exec), but resolving symlinks is cheap
  // + the right shape for the future untrusted-author isolate. We `realpath` the REAL root + the deepest
  // EXISTING ancestor of the target and re-assert containment. Best-effort: if the target / an
  // ancestor does not exist yet, we skip (the subsequent `import()` fail-closes on a missing file
  // anyway). NOTE: full symlink confinement of WHAT a handler does at runtime is still an isolate
  // concern — this bounds only WHICH FILE is loaded, consistent with the lexical jail's scope.
  const realRoot = realpathSafe(root);
  const realTarget = realpathSafe(absolute) ?? realpathSafe(deepestExisting(absolute));
  if (realRoot && realTarget && realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new HandlerLoadError(
      `handler '${handlerId}': module '${moduleSpec}' resolves (after following symlinks) to ` +
        `'${realTarget}', OUTSIDE the escape-hatch root '${realRoot}' — refusing to load ` +
        '(path-jail symlink re-check, fail-closed).',
    );
  }
  return absolute;
}

/** `realpathSync`, returning undefined on ENOENT/any error (best-effort symlink resolution). */
function realpathSafe(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** The deepest ANCESTOR of `p` that exists on disk (so we can realpath a not-yet-created target's dir). */
function deepestExisting(p: string): string | undefined {
  let cur = dirname(p);
  // Walk up until realpath succeeds or we hit the filesystem root (dirname is idempotent there).
  for (let i = 0; i < 64; i++) {
    if (realpathSafe(cur) !== undefined) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Resolve ONE handler mapping: jail the module path, import it, assert the named export exists AND is
 * a function, and return the typed `ResolvedHandler` (kind + fn). FAIL-CLOSED: any failure throws
 * `HandlerLoadError` so the deploy aborts at boot, never a runtime 500.
 */
async function resolveOne(
  escapeHatchRoot: string,
  handler: HandlerSpec,
  importer: ModuleImporter,
): Promise<ResolvedHandler> {
  const absolute = jailModulePath(escapeHatchRoot, handler.module, handler.id);

  let mod: Record<string, unknown>;
  try {
    mod = await importer(absolute);
  } catch (e) {
    throw new HandlerLoadError(
      `handler '${handler.id}': failed to import module '${handler.module}' (${absolute}): ` +
        `${e instanceof Error ? e.message : String(e)} (fail-closed at boot).`,
    );
  }

  const exported = mod[handler.export];
  if (exported === undefined) {
    throw new HandlerLoadError(
      `handler '${handler.id}': module '${handler.module}' has no export '${handler.export}' — ` +
        'a missing/mistyped export aborts the deploy at boot (fail-closed), never a runtime 500.',
    );
  }
  if (typeof exported !== 'function') {
    throw new HandlerLoadError(
      `handler '${handler.id}': export '${handler.export}' of '${handler.module}' is not a function ` +
        `(got ${typeof exported}) — a handler export must be a function (fail-closed at boot).`,
    );
  }

  // The grammar's HandlerKind ('tool'|'route'|'trigger') maps 1:1 to the ResolvedHandler tag. Cast
  // the resolved function to the kind's handler type — the cast is sound because the loader only ever
  // calls it through the HandlerRuntime with the matching init shape, and a mismatched author
  // signature is a trusted-author bug (TS-checked at the author's edge, not enforceable across the
  // dynamic-import boundary).
  return makeResolved(handler.kind, exported as never);
}

/** Build the typed ResolvedHandler union member for a kind (one place the kind→type map lives). */
function makeResolved(kind: HandlerKind, fn: never): ResolvedHandler {
  switch (kind) {
    case 'tool':
      return { kind: 'tool', fn };
    case 'route':
      return { kind: 'route', fn };
    case 'trigger':
      return { kind: 'trigger', fn };
    default: {
      // Exhaustiveness: HandlerKind is closed. A new kind without a case fails to typecheck (never)
      // AND fail-closes at runtime rather than silently loading an unwired handler.
      const _exhaustive: never = kind;
      throw new HandlerLoadError(`unknown handler kind '${String(_exhaustive)}' (fail-closed).`);
    }
  }
}

/**
 * Resolve EVERY declared handler into an id → ResolvedHandler map, at boot, fail-closed. A single
 * failed handler aborts the whole load (a partial registry would let a route 500 later). The
 * resulting map is what the tool resolver + the route/trigger interpreters look handlers up in.
 *
 * @param escapeHatchRoot the directory all handler modules are jailed within (the deployment's own
 *                        escape-hatch library dir; the throwaway passes its own dir).
 * @param handlers        the validated `spec.handlers[]`.
 * @param importer        the module importer (default: real dynamic import; tests inject a fake).
 */
export async function loadHandlers(
  escapeHatchRoot: string,
  handlers: readonly HandlerSpec[],
  importer: ModuleImporter = defaultImporter,
): Promise<Map<string, ResolvedHandler>> {
  const resolved = new Map<string, ResolvedHandler>();
  for (const handler of handlers) {
    resolved.set(handler.id, await resolveOne(escapeHatchRoot, handler, importer));
  }
  return resolved;
}

/**
 * MULTI-ROOT handler load (the extension-pack mechanism). Like `loadHandlers`, but each
 * handler is jailed against ITS OWN escape-hatch root — a `rootFor(handlerId)` resolver yields the
 * jailed root for that handler. This is what lets a deployment's OWN handlers AND an extension pack's
 * handlers (each authored + versioned in its own directory) be loaded in one boot pass, with EVERY
 * module path-jailed against the correct root (a pack handler can never climb out of the pack root,
 * the deployment's own handler can never climb out of the deployment root). Used by `loadExtensions`
 * (which has already resolved every pack root, path-jailed); the single-root `loadHandlers` above is
 * the degenerate case (one root for all). FAIL-CLOSED: a missing root for a referenced handler, or
 * any jail/import failure, aborts the whole load. The jail discipline is byte-identical to the
 * single-root path (the same `jailModulePath` per resolved root) — this only varies WHICH root.
 *
 * @param rootFor   handler id → the jailed escape-hatch root that handler's `module` resolves within.
 * @param handlers  the validated (already merged) `handlers[]`.
 * @param importer  the module importer (default: real dynamic import; tests inject a fake).
 */
export async function loadHandlersMultiRoot(
  rootFor: (handlerId: string) => string | undefined,
  handlers: readonly HandlerSpec[],
  importer: ModuleImporter = defaultImporter,
): Promise<Map<string, ResolvedHandler>> {
  const resolved = new Map<string, ResolvedHandler>();
  for (const handler of handlers) {
    const root = rootFor(handler.id);
    if (root === undefined) {
      throw new HandlerLoadError(
        `handler '${handler.id}': no escape-hatch root resolved for it (multi-root load) — every ` +
          'handler must map to a jailed root (the deployment root or an extension-pack root). ' +
          'Fail-closed.',
      );
    }
    resolved.set(handler.id, await resolveOne(root, handler, importer));
  }
  return resolved;
}
