/**
 * `loadExtensions` — resolve + merge extension packs into a deployment's spec.
 *
 * For each `ExtensionRef` in `spec.extensions`, this:
 *   1. RESOLVES the pack DIRECTORY, path-jailed (DIRECTORY-ONLY — the npm-module branch is NOT built
 *      here; a non-directory / npm-style ref is fail-closed). The pack root is jailed against a
 *      deployer-supplied `packsRoot` exactly as a handler module is jailed against the escape-hatch
 *      root — we NEVER trust a self-declared root (`..`/absolute/symlink/outside-root all rejected).
 *   2. LOADS the pack's `defineExtension` MANIFEST (the branded default export of the pack's entry).
 *   3. VERSION-PIN FAIL-CLOSES: the manifest's `version` MUST equal the `ref.version` exact pin from
 *      the spec — a SKEW is a hard error (the silent-skip class: NEVER a silent skip).
 *   4. JAILS each pack handler `module` against the PACK ROOT (a pack handler can never climb out of
 *      its own pack), and REWRITES it to a jail-safe VIRTUAL path UNDER THE DEPLOYMENT ROOT so the
 *      UNCHANGED `deploy()` → `loadHandlers(deployRoot, mergedSpec.handlers, importer)` jails it
 *      (trivially, in-root) and the supplied multi-root importer imports the REAL pack file.
 *   5. MERGES the pack's store/handler/tooling/api fragments onto the deployment's sections + the
 *      capability instances into the merge result — so a pack store rides the existing migration gate,
 *      a pack route the existing api interpreter, a pack handler the existing loader. `deploy()` / the
 *      migration gate / `dispatchTool` / the chokepoint stay BYTE-UNCHANGED.
 *
 * WHY THE VIRTUAL-PATH REWRITE (the multi-root trick that keeps `deploy()` byte-unchanged): `deploy()`
 * loads handlers from ONE `rollout.escapeHatchRoot` via `loadHandlers`, which path-jails each
 * `handler.module` against THAT single root. A pack lives in its OWN directory (a product pack is in
 * its own repo), NOT under the deployment root, so a pack handler's raw `module` could not be
 * jailed against the deployment root. We therefore rewrite each pack handler's `module` to a UNIQUE,
 * jail-safe, in-deployment-root VIRTUAL path (`.rayspec-ext/<refIndex>__<packId>/<n>__<basename>`,
 * the leading ref-loop INDEX guaranteeing two sanitize-colliding pack ids never share a path) — which the
 * single-root jail accepts (lexically in-root; the file need not exist — the jail's symlink re-check
 * is best-effort-skipped for a missing path) — and provide a custom importer that maps that virtual
 * absolute path back to the REAL pack file (already jailed against the PACK root in step 4). So the
 * pack handler is doubly-jailed (against its pack root here, AND trivially in-root by `deploy()`), and
 * neither `deploy.ts` nor `loadHandlers`'s single-root signature changes.
 */
import { basename, isAbsolute, normalize } from 'node:path';
import {
  type AgentSpecConfig,
  AgentSpecConfig as AgentSpecConfigSchema,
  type ApiRouteSpec,
  ApiRouteSpec as ApiRouteSpecSchema,
  type HandlerSpec,
  HandlerSpec as HandlerSpecSchema,
  type StoreSpec,
  StoreSpec as StoreSpecSchema,
  type ToolSpecConfig,
  ToolSpecConfig as ToolSpecConfigSchema,
} from '@rayspec/spec';
import {
  defaultImporter,
  HandlerLoadError,
  jailModulePath,
  type ModuleImporter,
} from '../handlers/loader.js';
import { type ExtensionCapabilities, isDefinedExtension } from './extension.js';

/** A single `extensions[]` reference (mirrors the spec's `ExtensionRef`; we re-declare to avoid a
 * value-import cycle — only the field shape is needed here). */
export interface ExtensionRefLike {
  readonly id: string;
  readonly module: string;
  readonly version: string;
  readonly config?: Record<string, unknown>;
}

/** The context `loadExtensions` resolves packs within. */
export interface LoadExtensionsContext {
  /**
   * The jailed root every pack `module` (a DIRECTORY) resolves within (`..`/absolute/symlink/outside
   * rejected). The composition root passes the deployment dir (or an explicit `RAYSPEC_PACKS_ROOT`)
   * — never a self-declared one. For the platform's own synthetic fixture this is the fixture dir.
   */
  readonly packsRoot: string;
  /**
   * The DEPLOYMENT escape-hatch root pack handler `module` paths are REWRITTEN to be jail-safe within
   * (so the unchanged single-root `deploy()` load accepts them). The supplied importer maps the
   * virtual path back to the real pack file.
   */
  readonly deploymentRoot: string;
  /**
   * The directory containing the pack's ENTRY module file within the pack root. The pack's manifest
   * is loaded from `<packRoot>/<entry>` (default `index.ts`). Path-jailed under the pack root.
   * (A real npm pack would resolve its `main`; the directory MVP uses a fixed/declared entry file.)
   */
  readonly entryFile?: string;
  /** The module importer (default: the real path-jailed dynamic import; a test injects a fake). */
  readonly importer?: ModuleImporter;
}

/** The merged result `loadExtensions` returns (everything the composition root threads into deploy). */
export interface LoadedExtensions {
  /** The merged store fragments (deployment stores are merged in by the caller — packs only here). */
  readonly stores: StoreSpec[];
  /** The merged handler fragments — pack handler `module` paths REWRITTEN to jail-safe virtual paths. */
  readonly handlers: HandlerSpec[];
  /** The merged tooling fragments. */
  readonly tooling: ToolSpecConfig[];
  /** The merged api route fragments. */
  readonly api: ApiRouteSpec[];
  /** The merged agent fragments (pack-contributed OOTB agents, registered post-merge). */
  readonly agents: AgentSpecConfig[];
  /** The capability instances packs provided (the LAST pack to set a field wins; a collision throws). */
  readonly capabilities: ExtensionCapabilities;
  /**
   * The multi-root importer the caller passes as `rollout.importer`: it maps a rewritten virtual pack
   * handler path → the REAL pack file (pre-jailed against the pack root), and falls through to the
   * default importer for a deployment's own (non-pack) handler. KEEPS `deploy()` byte-unchanged.
   */
  readonly importer: ModuleImporter;
  /**
   * The discovered pack handler ROOTS (real pack dirs) — one per loaded pack — for the manifest-derived
   * gates to scan. (The gates DISCOVER these at gate time by reading the same manifests; this is the
   * in-process equivalent for an end-to-end test that wants the roots without re-reading.)
   */
  readonly packHandlerRoots: string[];
}

/** A fail-closed extension-load error (every message names the offending pack id for the deploy log). */
export class ExtensionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionLoadError';
  }
}

/** The virtual-path prefix pack handler modules are rewritten under (jail-safe, in-deployment-root). */
export const EXTENSION_VIRTUAL_PREFIX = '.rayspec-ext';

/**
 * Resolve + merge every extension pack referenced by `refs`. FAIL-CLOSED at the first problem (an
 * unresolvable/non-directory module, a version skew, a non-manifest entry, a handler jail escape) —
 * never a silent skip. Returns the merged fragments + capability instances + the multi-root importer.
 * An empty `refs` returns empty fragments + the default importer (a no-op — absent extensions = no-op).
 */
export async function loadExtensions(
  refs: readonly ExtensionRefLike[],
  ctx: LoadExtensionsContext,
): Promise<LoadedExtensions> {
  const importer = ctx.importer ?? defaultImporter;
  const entryFile = ctx.entryFile ?? 'index.ts';

  const stores: StoreSpec[] = [];
  const handlers: HandlerSpec[] = [];
  const tooling: ToolSpecConfig[] = [];
  const api: ApiRouteSpec[] = [];
  const agents: AgentSpecConfig[] = [];
  const capabilities: { blobFactory?: ExtensionCapabilities['blobFactory'] } = {};
  const packHandlerRoots: string[] = [];

  // virtual rewritten absolute path → real pre-jailed pack-file absolute path (the importer's map).
  const virtualToReal = new Map<string, string>();

  const seenIds = new Set<string>();
  for (const [refIndex, ref] of refs.entries()) {
    if (seenIds.has(ref.id)) {
      throw new ExtensionLoadError(
        `extension '${ref.id}' is referenced more than once in extensions[] — pack ids must be ` +
          'unique (fail-closed).',
      );
    }
    seenIds.add(ref.id);

    // (1) DIRECTORY-ONLY path-jailed resolution. We reuse the handler path-jail (root-parameterized):
    //     it rejects `..`/absolute/symlink/outside-root + URL-significant chars. The npm-module branch
    //     is NOT built here — a bare specifier (`@scope/pkg`) resolves UNDER packsRoot (→ does not
    //     exist → import fail-closes); we additionally reject it up-front as "directory-only".
    if (isBareSpecifier(ref.module)) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': module '${ref.module}' looks like an npm package specifier — the ` +
          'npm-module branch is NOT built (directory-only). Reference the pack as a directory ' +
          'path relative to the packs root (fail-closed).',
      );
    }
    const packRoot = jailModulePathFor(ctx.packsRoot, ref.module, ref.id);

    // The pack's ENTRY module within the pack root (jailed against the pack root). The manifest is the
    // branded default export of that module.
    const entryAbsolute = jailModulePathFor(packRoot, entryFile, ref.id);
    let mod: Record<string, unknown>;
    try {
      mod = await importer(entryAbsolute);
    } catch (e) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': failed to load pack entry '${entryFile}' (${entryAbsolute}): ` +
          `${e instanceof Error ? e.message : String(e)} — a pack's entry module must default-export ` +
          'a defineExtension(...) manifest (fail-closed).',
      );
    }
    const manifest = mod.default;
    if (!isDefinedExtension(manifest)) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': pack entry '${entryFile}' does not default-export a defineExtension ` +
          '(...) manifest (got ' +
          `${manifest === undefined ? 'no default export' : typeof manifest}) — the entry must be ` +
          '`export default defineExtension({ version, fragments, … })`. Fail-closed.',
      );
    }

    // (3) VERSION-PIN FAIL-CLOSED (the silent-skip class). The deployment's exact `ref.version`
    //     pin MUST equal the pack manifest's declared version. A SKEW is a HARD ERROR, never a skip.
    if (manifest.version !== ref.version) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': version SKEW — the spec pins version '${ref.version}' but the pack ` +
          `manifest declares version '${manifest.version}'. A version skew is a HARD fail-closed ` +
          'error (never a silent skip): pin the exact version the pack declares, or update the pack.',
      );
    }

    // VALIDATE each pack fragment through its spec section SCHEMA at load — so a malformed pack
    // fragment FAILS CLOSED here (with a clear, pack-attributed error) AND Zod DEFAULTS (e.g. a
    // store's `foreignKeys: []`) are applied, so the merged fragments are well-formed StoreSpec/etc.
    // The merged spec is STILL re-validated by deploy()'s parseSpec (cross-section lint: dangling
    // refs, dup ids across deployment+pack) — this is the per-fragment shape gate that complements it.
    const fragments = manifest.fragments;

    // (4) JAIL each pack handler against the PACK root, then rewrite its module to a jail-safe virtual
    //     path under the deployment root (so the unchanged single-root deploy() load accepts it).
    let handlerN = 0;
    for (const rawH of fragments.handlers ?? []) {
      const h = parseFragment(HandlerSpecSchema, rawH, ref.id, 'handler');
      // FIX A (gate scan-surface == loader accept-surface): a pack handler `module` MUST live UNDER the
      // pack's `handlers/` dir — the SAME `<packDir>/handlers/` subtree the two manifest-derived gates
      // (check-handler-imports.mjs / check-extension-capability.mjs) scan. Without this, a pack could
      // declare a handler at any in-pack path (e.g. `lib/x.ts`); the loader would jail+load+execute it,
      // yet NEITHER gate would scan it → a forbidden import / a self-constructed raw DB/blob capability
      // would go UNDETECTED. Requiring the FIRST normalized path segment === `handlers` makes the
      // loader's accept-surface provably EQUAL the gate's scan-surface. (`..`/absolute/URL-significant
      // are still rejected by the pack-root jail below; this is the additional handlers/-subtree gate.)
      if (!isUnderHandlersDir(h.module)) {
        throw new ExtensionLoadError(
          `extension '${ref.id}': handler '${h.id}' module '${h.module}' is not under the pack's ` +
            '`handlers/` directory. A pack handler module MUST live under `handlers/` (the subtree ' +
            'BOTH escape-hatch gates scan); a handler outside it would load unscanned (fail-closed).',
        );
      }
      // Jail the pack handler module against the PACK root (a pack handler can never climb out).
      const realHandlerAbsolute = jailModulePathFor(packRoot, h.module, `${ref.id}:${h.id}`);
      // FIX C (virtual-path collision): derive the virtual segment from a GUARANTEED-unique authority —
      // the ref's loop INDEX (`<refIndex>__<sanitize(id)>`) — so two DISTINCT `ref.id`s that
      // sanitize-collide (`acme:v1` vs `acme_v1`, both valid `z.string().min(1)`) can NEVER collapse
      // to the same virtual path (which would last-write-wins OVERWRITE one pack's handler with the
      // other's real file). `handlerN` resets per pack, so the (refIndex, handlerN) pair is unique.
      const virtualModule = `${EXTENSION_VIRTUAL_PREFIX}/${refIndex}__${sanitize(
        ref.id,
      )}/${handlerN}__${sanitize(basename(h.module))}`;
      handlerN += 1;
      // Re-jail the virtual path against the DEPLOYMENT root (lexically in-root; proves it's safe) and
      // record virtual→real so the importer redirects the unchanged loader to the real pack file.
      const virtualAbsolute = jailModulePathFor(
        ctx.deploymentRoot,
        virtualModule,
        `${ref.id}:${h.id}`,
      );
      // FIX C (defense-in-depth): a virtual path must map to EXACTLY one real file. If a collision ever
      // re-emerges (a future change to the segment derivation), FAIL CLOSED naming both packs rather
      // than silently last-write-wins cross-wiring one pack's declared handler to another's code.
      if (virtualToReal.has(virtualAbsolute)) {
        throw new ExtensionLoadError(
          `extension '${ref.id}': handler '${h.id}' rewrites to the virtual path '${virtualModule}' ` +
            `which is already mapped (from another pack handler). A virtual handler path must map to ` +
            'exactly one real file — refusing to overwrite (fail-closed collision).',
        );
      }
      virtualToReal.set(virtualAbsolute, realHandlerAbsolute);
      handlers.push({ ...h, module: virtualModule });
    }
    packHandlerRoots.push(packRoot);

    // (5) MERGE the remaining fragments (stores/tooling/api/agents), each validated through its section
    //     schema. A pack agent is validated by the SAME `AgentSpecConfig` schema a
    //     deployment agent is — and post-merge it is INDISTINGUISHABLE from a deployment agent: it lands
    //     in the merged `agents[]`, its `tools[]` lint-resolve against the merged `tooling[]` (the pack's
    //     own tooling fragment ⊕ the deployment's), its `backend` is resolved by the deployment's
    //     `agentBackendsFactory`, and `buildAgentRegistry` registers it for the run surface. No special
    //     case — the per-fragment shape gate here + deploy()'s cross-section lint are the entire validation.
    for (const s of fragments.stores ?? [])
      stores.push(parseFragment(StoreSpecSchema, s, ref.id, 'store'));
    for (const t of fragments.tooling ?? [])
      tooling.push(parseFragment(ToolSpecConfigSchema, t, ref.id, 'tool'));
    for (const r of fragments.api ?? [])
      api.push(parseFragment(ApiRouteSpecSchema, r, ref.id, 'api route'));
    for (const ag of fragments.agents ?? [])
      agents.push(parseFragment(AgentSpecConfigSchema, ag, ref.id, 'agent'));

    // Capability instances → the same merge result. A second pack setting the SAME capability is a
    // fail-closed collision (two packs cannot both own the single blob backend at N=1).
    const caps = manifest.capabilities;
    if (caps?.blobFactory) {
      if (capabilities.blobFactory) {
        throw new ExtensionLoadError(
          `extension '${ref.id}': provides a blobFactory capability but another pack already provided ` +
            'one — at most one pack may own the blob backend (fail-closed collision).',
        );
      }
      capabilities.blobFactory = caps.blobFactory;
    }
  }

  // The multi-root importer: a rewritten virtual pack-handler path → the real pack file; otherwise the
  // default (a deployment's own handler, already jailed against the deployment root by the loader).
  const mergedImporter: ModuleImporter = async (absolutePath: string) => {
    const real = virtualToReal.get(absolutePath);
    return importer(real ?? absolutePath);
  };

  return {
    stores,
    handlers,
    tooling,
    api,
    agents,
    capabilities,
    importer: mergedImporter,
    packHandlerRoots,
  };
}

/**
 * Validate one pack fragment through its spec section Zod SCHEMA (fail-closed + apply defaults). A
 * malformed fragment throws an `ExtensionLoadError` naming the pack + the section. We use `.parse`
 * (throws) over `.safeParse` so the FIRST malformed fragment aborts the load with an actionable error.
 * (The merged spec is STILL cross-section-linted by deploy()'s parseSpec — this is the shape gate.)
 */
function parseFragment<T>(
  schema: { parse: (v: unknown) => T },
  value: unknown,
  packId: string,
  what: string,
): T {
  try {
    return schema.parse(value);
  } catch (e) {
    throw new ExtensionLoadError(
      `extension '${packId}': a ${what} fragment is malformed: ` +
        `${e instanceof Error ? e.message : String(e)} (fail-closed at load).`,
    );
  }
}

/** A bare npm specifier (`fs`, `lodash`, `@scope/pkg`) — NOT a directory path. Directory paths begin
 * with `.`/`/` or a drive letter; everything else is a bare specifier (the npm branch — not built). */
function isBareSpecifier(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(spec)) return false; // a Windows drive-absolute path
  return true;
}

/** Sanitize a path segment for the virtual handler path (no separators / URL-significant chars). */
function sanitize(seg: string): string {
  return seg.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * True iff a pack handler `module` lives UNDER the pack's `handlers/` dir — its FIRST path segment is
 * exactly `handlers` after normalization (FIX A: the loader's accept-surface must equal the gates'
 * `<packDir>/handlers/` scan-surface, so a pack handler is never loaded unscanned). REJECTS an
 * absolute path, a `..` traversal segment (a `handlers/../lib/x.ts` that climbs back out), and any
 * first segment other than `handlers` (a `lib/x.ts`). A leading `./` is tolerated (normalized away).
 * (The pack-root path-jail STILL runs afterwards — this is the additional handlers/-subtree gate.)
 */
function isUnderHandlersDir(moduleSpec: string): boolean {
  if (isAbsolute(moduleSpec)) return false;
  // A `..` segment anywhere (checked on the RAW spec, before normalization collapses an inward `..`)
  // cannot be allowed: `handlers/../lib/x.ts` would otherwise climb out of the handlers/ subtree.
  if (moduleSpec.split(/[/\\]/).includes('..')) return false;
  const segments = normalize(moduleSpec).split(/[/\\]/).filter(Boolean);
  // Require at least `handlers/<file>` (a bare `handlers` dir or empty is not a handler module).
  return segments.length >= 2 && segments[0] === 'handlers';
}

/**
 * Path-jail `moduleSpec` against `root`, returning the resolved absolute path INSIDE root — re-using
 * the handler loader's `jailModulePath` (root-parameterized) so a pack root / pack handler / virtual
 * path is jailed with the EXACT discipline a handler module is (the security-load-bearing jail lives
 * in ONE place). Wraps the `HandlerLoadError` it throws in an `ExtensionLoadError` for the deploy log.
 */
function jailModulePathFor(root: string, moduleSpec: string, id: string): string {
  try {
    return jailModulePath(root, moduleSpec, id);
  } catch (e) {
    if (e instanceof HandlerLoadError) {
      throw new ExtensionLoadError(
        `extension '${id}': ${e.message.replace(/^handler '[^']*': /, '')}`,
      );
    }
    throw e;
  }
}
