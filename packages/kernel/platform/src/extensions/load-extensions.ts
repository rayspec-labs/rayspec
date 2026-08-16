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
 *   3b. RESOLVES the top-level SECTIONS the manifest claims: the key must be a safe identifier that
 *      the core grammar does not own and that no other pack has claimed, and the claim's schema
 *      module is loaded through the SAME jailed, `.js`-preferred resolution as the entry. The
 *      resolved claims are what `parseSpecWithPacks` hands the document's own top-level nodes to.
 *   4. JAILS each pack handler `module` against the PACK ROOT (a pack handler can never climb out of
 *      its own pack), and REWRITES it to a jail-safe VIRTUAL path UNDER THE DEPLOYMENT ROOT so the
 *      UNCHANGED `deploy()` → `loadHandlers(deployRoot, mergedSpec.handlers, importer)` jails it
 *      (trivially, in-root) and the supplied multi-root importer imports the REAL pack file.
 *   4b. RESOLVES the MIGRATION CHAIN the manifest declares, if any: the declared `tablePrefix` is
 *      MANDATORY (a chain with no namespace could reach into anything), and the chain directory is
 *      jailed against the PACK ROOT exactly as the entry and every handler module are. What the
 *      chain CONTAINS, and whether its namespace collides with the platform's or with another
 *      pack's, is decided by `applyPackMigrations` — the one door it reaches a database through.
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
import { existsSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import type { PackMigrationChain } from '@rayspec/db';
import {
  type AgentSpecConfig,
  AgentSpecConfig as AgentSpecConfigSchema,
  type ApiRouteSpec,
  ApiRouteSpec as ApiRouteSpecSchema,
  CORE_TOP_LEVEL_KEYS,
  type HandlerSpec,
  HandlerSpec as HandlerSpecSchema,
  isCoreTopLevelKey,
  isSectionSchemaLike,
  SafeIdentifier,
  type SectionClaim,
  type StoreSpec,
  StoreSpec as StoreSpecSchema,
  sectionValidatorFrom,
  type ToolSpecConfig,
  ToolSpecConfig as ToolSpecConfigSchema,
  typeScriptSourceExtensionOf,
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
  /**
   * The TOP-LEVEL SECTION CLAIMS the loaded packs make — one per `{ key, schemaModule }` a manifest
   * declares, each carrying the claiming pack's id and the validator built from its schema module.
   * The deployment's parse hands the matching top-level node to `validate` (see `parseSpecWithPacks`);
   * a key no claim covers stays an unknown field, refused by the unchanged strict top level.
   */
  readonly sections: SectionClaim[];
  /**
   * The MIGRATION CHAINS the loaded packs declare — one per pack that owns platform tables, in the
   * order the deployment's `extensions[]` lists them, each with its directory already resolved to an
   * absolute path inside the pack. The boot hands these to `applyPackMigrations` AFTER the platform
   * chain has been applied; a pack that declares none contributes nothing here.
   */
  readonly migrations: PackMigrationChain[];
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

/**
 * A fail-closed extension-load error (every message names the offending pack id for the deploy log).
 * `packId` carries the same id as a FIELD, so a caller that has to re-report the failure in its own
 * vocabulary — the pack-aware parse turns it into a typed `SpecError` — can name the pack without
 * reading it back out of the message.
 *
 * `unresolved` separates the ONE failure that means the pack is not on this deployment (its entry
 * module did not import — a missing directory, a missing file, an unbuilt pack) from every failure
 * that happened AFTER the pack was found and read (a version skew, a claim collision, a handler
 * outside `handlers/`). The distinction is load-bearing rather than cosmetic: the two classes
 * prescribe opposite remedies — deploy the pack, versus fix the pack that is already deployed — and
 * the caller that re-reports this has no other way to tell them apart. The path jail deliberately
 * does NOT count as unresolved: it fails on a `..`, an absolute path or a symlink escape in the
 * declared `module`, which is a mis-declaration, and it passes cleanly for a directory that simply
 * is not there (it is lexical — the missing pack surfaces at the entry import a step later).
 */
export class ExtensionLoadError extends Error {
  readonly packId: string | undefined;
  /** True iff the pack could not be resolved on this deployment at all (its entry did not import). */
  readonly unresolved: boolean;
  constructor(message: string, packId?: string, unresolved = false) {
    super(message);
    this.name = 'ExtensionLoadError';
    this.packId = packId;
    this.unresolved = unresolved;
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
  const sections: SectionClaim[] = [];
  const migrations: PackMigrationChain[] = [];
  // claimed top-level key → the pack that claimed it first (so a collision can name BOTH packs).
  const sectionOwners = new Map<string, string>();

  // virtual rewritten absolute path → real pre-jailed pack-file absolute path (the importer's map).
  const virtualToReal = new Map<string, string>();

  const seenIds = new Set<string>();
  for (const [refIndex, ref] of refs.entries()) {
    if (seenIds.has(ref.id)) {
      throw new ExtensionLoadError(
        `extension '${ref.id}' is referenced more than once in extensions[] — pack ids must be ` +
          'unique (fail-closed).',
        ref.id,
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
        ref.id,
      );
    }
    const packRoot = jailModulePathFor(ctx.packsRoot, ref.module, ref.id);

    // The pack's ENTRY module within the pack root (jailed against the pack root, `.js`-preferred). The
    // manifest is the branded default export of that module. A BUILT pack ships a compiled `index.js`;
    // resolvePackModule resolves that when it exists (so the production importer loads compiled JS), and
    // a source-only pack resolves to `index.ts` (which the production importer rejects fail-closed).
    const entryAbsolute = resolvePackModule(packRoot, entryFile, ref.id);
    let mod: Record<string, unknown>;
    try {
      mod = await importer(entryAbsolute);
    } catch (e) {
      // The one UNRESOLVED failure: the pack's entry did not import, so the pack is not here.
      throw new ExtensionLoadError(
        `extension '${ref.id}': failed to load pack entry '${entryFile}' (${entryAbsolute}): ` +
          `${e instanceof Error ? e.message : String(e)} — a pack's entry module must default-export ` +
          'a defineExtension(...) manifest (fail-closed).',
        ref.id,
        true,
      );
    }
    const manifest = mod.default;
    if (!isDefinedExtension(manifest)) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': pack entry '${entryFile}' does not default-export a defineExtension ` +
          '(...) manifest (got ' +
          `${manifest === undefined ? 'no default export' : typeof manifest}) — the entry must be ` +
          '`export default defineExtension({ version, fragments, … })`. Fail-closed.',
        ref.id,
      );
    }

    // (3) VERSION-PIN FAIL-CLOSED (the silent-skip class). The deployment's exact `ref.version`
    //     pin MUST equal the pack manifest's declared version. A SKEW is a HARD ERROR, never a skip.
    if (manifest.version !== ref.version) {
      throw new ExtensionLoadError(
        `extension '${ref.id}': version SKEW — the spec pins version '${ref.version}' but the pack ` +
          `manifest declares version '${manifest.version}'. A version skew is a HARD fail-closed ` +
          'error (never a silent skip): pin the exact version the pack declares, or update the pack.',
        ref.id,
      );
    }

    // VALIDATE each pack fragment through its spec section SCHEMA at load — so a malformed pack
    // fragment FAILS CLOSED here (with a clear, pack-attributed error) AND Zod DEFAULTS (e.g. a
    // store's `foreignKeys: []`) are applied, so the merged fragments are well-formed StoreSpec/etc.
    // The merged spec is STILL re-validated by deploy()'s parseSpec (cross-section lint: dangling
    // refs, dup ids across deployment+pack) — this is the per-fragment shape gate that complements it.
    const fragments = manifest.fragments;

    // (3b) THE TOP-LEVEL SECTIONS THIS PACK CLAIMS. Each claim is checked against three fail-closed
    //      rules before its schema module is loaded through the SAME jailed, `.js`-preferred
    //      resolution the entry and every handler use: the key is a safe identifier, the key is not
    //      one the CORE grammar owns (the denylist is read off the grammar itself, so a section added
    //      to the document grammar closes to packs the moment it is declared), and no other pack has
    //      claimed it (a collision names BOTH packs — neither can be the winner by accident).
    for (const claim of manifest.sections ?? []) {
      sections.push(await resolveSectionClaim(claim, ref.id, packRoot, sectionOwners, importer));
    }

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
          ref.id,
        );
      }
      // Jail the pack handler module against the PACK root (a pack handler can never climb out),
      // `.js`-preferred: a BUILT pack's compiled `handlers/<n>.js` sibling is loaded when it exists
      // (so the production importer loads compiled JS with NO manifest rewrite — the manifest keeps its
      // authored `.ts` module path); a source-only pack resolves to the `.ts` the production importer rejects.
      const realHandlerAbsolute = resolvePackModule(
        packRoot,
        h.module,
        `${ref.id}:${h.id}`,
        ref.id,
      );
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
        ref.id,
      );
      // FIX C (defense-in-depth): a virtual path must map to EXACTLY one real file. If a collision ever
      // re-emerges (a future change to the segment derivation), FAIL CLOSED naming both packs rather
      // than silently last-write-wins cross-wiring one pack's declared handler to another's code.
      if (virtualToReal.has(virtualAbsolute)) {
        throw new ExtensionLoadError(
          `extension '${ref.id}': handler '${h.id}' rewrites to the virtual path '${virtualModule}' ` +
            `which is already mapped (from another pack handler). A virtual handler path must map to ` +
            'exactly one real file — refusing to overwrite (fail-closed collision).',
          ref.id,
        );
      }
      virtualToReal.set(virtualAbsolute, realHandlerAbsolute);
      handlers.push({ ...h, module: virtualModule });
    }
    packHandlerRoots.push(packRoot);

    // (4b) THE MIGRATION CHAIN, if the pack owns platform tables. Both fields are required and the
    //      directory is jailed against the PACK root, so a chain can no more be read from outside the
    //      pack than a handler can be loaded from there. `tablePrefix` is mandatory rather than
    //      defaulted: a default would be a namespace nobody declared, and the whole safety of running
    //      two chains against one database is that each one's namespace was declared and checked.
    if (manifest.migrations !== undefined) {
      migrations.push(resolvePackMigrationChain(manifest.migrations, ref.id, packRoot));
    }

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
          ref.id,
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
    sections,
    migrations,
    capabilities,
    importer: mergedImporter,
    packHandlerRoots,
  };
}

/**
 * Resolve ONE `{ dir, tablePrefix }` declaration into the chain the boot applies, or FAIL CLOSED
 * naming the pack. Both fields are load-bearing and neither has a default: a chain with no directory
 * names nothing, and a chain with no table prefix has no namespace — and a namespace that was never
 * declared is one nothing can check the chain against.
 */
function resolvePackMigrationChain(
  declared: { readonly dir?: unknown; readonly tablePrefix?: unknown },
  packId: string,
  packRoot: string,
): PackMigrationChain {
  const { dir, tablePrefix } = declared;
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new ExtensionLoadError(
      `extension '${packId}': declares a migration chain with no \`dir\` — the chain is a directory ` +
        'of .sql files (plus meta/_journal.json) inside the pack, and the manifest must say which ' +
        'one. Fail-closed.',
      packId,
    );
  }
  if (typeof tablePrefix !== 'string' || tablePrefix.length === 0) {
    throw new ExtensionLoadError(
      `extension '${packId}': declares a migration chain with no \`tablePrefix\`. The prefix is the ` +
        "namespace the chain's tables and indexes live in, and it is what keeps a pack chain and " +
        'the platform chain out of each other — a chain with no declared namespace could reach into ' +
        'any table in the database. Fail-closed.',
      packId,
    );
  }
  return {
    packId,
    // Jailed against the PACK root with the same discipline as the entry and every handler module:
    // `..`/absolute/symlink/outside-root are all rejected, so a pack's chain is a pack's own.
    dir: jailModulePathFor(packRoot, dir, packId),
    tablePrefix,
  };
}

/**
 * Resolve ONE `{ key, schemaModule }` claim into a `SectionClaim` the deployment's parse can use, or
 * FAIL CLOSED naming the pack. Every refusal here is a deploy-time refusal: nothing about a claim is
 * decided later, so a pack cannot end up owning a key it was not allowed to claim.
 *
 * `sectionOwners` is the running key → pack-id map; a second claim on a key names BOTH packs, because
 * "one of these two packs already had it" is the only actionable form of that message.
 */
async function resolveSectionClaim(
  claim: { readonly key: string; readonly schemaModule: string },
  packId: string,
  packRoot: string,
  sectionOwners: Map<string, string>,
  importer: ModuleImporter,
): Promise<SectionClaim> {
  const { key, schemaModule } = claim;
  if (!SafeIdentifier.safeParse(key).success) {
    throw new ExtensionLoadError(
      `extension '${packId}': claims the top-level section '${key}', which is not a safe identifier ` +
        '(lowercase letters/digits/underscore, starting with a letter or underscore, at most 63 ' +
        'characters). A claimed key is a document key an author writes — fail-closed.',
      packId,
    );
  }
  if (isCoreTopLevelKey(key)) {
    throw new ExtensionLoadError(
      `extension '${packId}': claims the top-level section '${key}', which the core spec grammar ` +
        `already owns (${CORE_TOP_LEVEL_KEYS.join(', ')}). A pack may not claim a core key — the ` +
        'document would have two owners for one section (fail-closed collision).',
      packId,
    );
  }
  const owner = sectionOwners.get(key);
  if (owner !== undefined) {
    throw new ExtensionLoadError(
      `extension '${packId}': claims the top-level section '${key}', which extension '${owner}' ` +
        'already claims. Two packs cannot both own one top-level key — nothing would decide whose ' +
        'grammar validates it (fail-closed collision).',
      packId,
    );
  }

  // The schema module is resolved with the SAME discipline as the pack entry: jailed against the
  // PACK root (`..`/absolute/symlink/outside-root rejected), compiled `.js` sibling preferred.
  const schemaAbsolute = resolvePackModule(packRoot, schemaModule, `${packId}:${key}`, packId);
  let mod: Record<string, unknown>;
  try {
    mod = await importer(schemaAbsolute);
  } catch (e) {
    throw new ExtensionLoadError(
      `extension '${packId}': failed to load the schema module '${schemaModule}' ` +
        `(${schemaAbsolute}) for the claimed section '${key}': ` +
        `${e instanceof Error ? e.message : String(e)} (fail-closed).`,
      packId,
    );
  }
  const schema = mod.default;
  if (!isSectionSchemaLike(schema)) {
    throw new ExtensionLoadError(
      `extension '${packId}': the schema module '${schemaModule}' for the claimed section '${key}' ` +
        `does not default-export something that can validate a node (got ${
          schema === undefined ? 'no default export' : typeof schema
        }) — it must default-export a value with a \`safeParse\` method. Fail-closed.`,
      packId,
    );
  }

  sectionOwners.set(key, packId);
  return { key, packId, validate: sectionValidatorFrom(schema, key, packId) };
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
      packId,
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
 * Resolve a pack module (the pack entry or a pack handler) against the pack root, path-jailed, PREFERRING
 * a compiled `.js` sibling when one exists on disk.
 *
 * A pack is AUTHORED in TypeScript (`index.ts`, `handlers/*.ts`) and its build step emits compiled `.js`
 * siblings that production loads (the production importer loads compiled JavaScript only, fail-closed on
 * a `.ts` path). So when the declared module is a TypeScript-source path AND its `.js` sibling exists in
 * the pack (a BUILT pack), we resolve — and FULLY RE-JAIL — the `.js` sibling. A source-only pack (no
 * build) resolves to the declared `.ts`, which the production importer rejects fail-closed (the dev/test
 * seam importer loads it). This lets a BUILT pack deploy with NO manifest rewrite (the manifest keeps its
 * authored `.ts` module paths) while the production compiled-JavaScript boundary still holds.
 */
function resolvePackModule(packRoot: string, moduleSpec: string, id: string, packId = id): string {
  const ext = typeScriptSourceExtensionOf(moduleSpec);
  if (ext !== undefined) {
    const compiledSpec = `${moduleSpec.slice(0, -ext.length)}.js`;
    // Re-jail the compiled sibling spec with the FULL discipline (traversal/containment/symlink), then
    // prefer it only when it actually exists on disk (a built pack); otherwise fall through to the source.
    const compiledAbsolute = jailModulePathFor(packRoot, compiledSpec, id, packId);
    if (existsSync(compiledAbsolute)) return compiledAbsolute;
  }
  return jailModulePathFor(packRoot, moduleSpec, id, packId);
}

/**
 * Path-jail `moduleSpec` against `root`, returning the resolved absolute path INSIDE root — re-using
 * the handler loader's `jailModulePath` (root-parameterized) so a pack root / pack handler / virtual
 * path is jailed with the EXACT discipline a handler module is (the security-load-bearing jail lives
 * in ONE place). Wraps the `HandlerLoadError` it throws in an `ExtensionLoadError` for the deploy log.
 */
function jailModulePathFor(root: string, moduleSpec: string, id: string, packId = id): string {
  try {
    return jailModulePath(root, moduleSpec, id);
  } catch (e) {
    if (e instanceof HandlerLoadError) {
      throw new ExtensionLoadError(
        `extension '${id}': ${e.message.replace(/^handler '[^']*': /, '')}`,
        packId,
      );
    }
    throw e;
  }
}
