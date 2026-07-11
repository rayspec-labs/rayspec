/**
 * Test-support: load the synthetic stream-backend deployment spec AND merge its extension PACK via the
 * REAL `loadExtensions` mechanism.
 *
 * Post-S4 the stream-backend `rayspec.yaml` is THIN — `version` + `metadata` + one `extensions[]`
 * ref; the whole stream surface (stores + ingest/playback/mint handlers + routes) lives in a
 * `defineExtension` pack under `examples/stream-backend/packs/stream-pack`. So the S2 ingest + S3
 * playback acceptance tests load the MERGED spec through the EXACT mechanism a real deployment uses:
 *   1. parseSpec(thin YAML) → the deployment spec (just the `extensions[]` ref);
 *   2. loadExtensions(spec.extensions, …) → the pack's merged store/handler/api fragments + the
 *      multi-root importer (a rewritten virtual pack-handler path → the real pack file);
 *   3. assemble the merged spec (deployment ⊕ pack fragments);
 *   4. loadHandlers(deploymentRoot, mergedSpec.handlers, loaded.importer) — the SAME path-jailed loader
 *      a deployment uses, with the multi-root importer redirecting the virtual paths to the pack files.
 *
 * This is the real acceptance: the S2/S3 stream surface is now CARRIED by the pack mechanism end-to-end
 * (the same surface, now via extensions[]). Used by stream-ingest.db.test.ts + stream-playback.db.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions, loadHandlers, type ResolvedHandler } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';

const here = dirname(fileURLToPath(import.meta.url));
// packages/api-auth/src/test-support -> repo-root/examples/stream-backend
export const STREAM_DEPLOYMENT_DIR = resolve(here, '../../../../../examples/stream-backend');
const YAML_PATH = resolve(STREAM_DEPLOYMENT_DIR, 'rayspec.yaml');

/** The merged stream spec + the multi-root-loaded handlers (the pack mechanism, exercised for real). */
export interface LoadedStreamPack {
  /** The merged spec (deployment ⊕ pack fragments) — stores/handlers/api come from the pack. */
  spec: RaySpec;
  /** The boot-loaded pack handlers (id → resolved fn + kind), loaded via the multi-root importer. */
  handlers: ReadonlyMap<string, ResolvedHandler>;
}

/**
 * Load the thin stream-backend deployment spec, merge its extension pack via `loadExtensions`, and
 * load the (now pack-contributed) handlers via the multi-root importer. Returns the MERGED spec + the
 * handler map — exactly what `createHarness({ engineSpec, engineHandlers })` consumes.
 */
export async function loadStreamPack(): Promise<LoadedStreamPack> {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) {
    throw new Error(`stream-backend deployment spec invalid: ${JSON.stringify(parsed.errors)}`);
  }
  const base = parsed.value;

  // Resolve + merge the pack (DIRECTORY-ONLY path-jailed; version-pin fail-closed; pack-handler-jailed).
  const loaded = await loadExtensions(base.extensions, {
    packsRoot: STREAM_DEPLOYMENT_DIR,
    deploymentRoot: STREAM_DEPLOYMENT_DIR,
  });

  // Assemble the merged spec (deployment ⊕ pack fragments); drop the spent `extensions[]` ref.
  const spec: RaySpec = {
    ...base,
    stores: [...base.stores, ...loaded.stores],
    handlers: [...base.handlers, ...loaded.handlers],
    tooling: [...base.tooling, ...loaded.tooling],
    api: [...base.api, ...loaded.api],
    extensions: [],
  };

  // Load the handlers via the REAL path-jailed loader + the multi-root importer (virtual pack-handler
  // path → the real pack file). This is the composition-root path, exercised in-test.
  const handlers = await loadHandlers(STREAM_DEPLOYMENT_DIR, spec.handlers, loaded.importer);

  return { spec, handlers };
}

/**
 * The INGEST-ONLY variant of the merged spec (drops the playback route + its handler ref) — used by
 * the S2 ingest acceptance so the boot completes without the playback-route media-token requirement.
 * Mirrors the pre-S4 `ingestOnlySpec` helper, now over the pack-merged spec.
 */
export function ingestOnly(merged: LoadedStreamPack): LoadedStreamPack {
  const spec: RaySpec = {
    ...merged.spec,
    api: merged.spec.api.filter(
      (r) => !(r.action.kind === 'stream' && r.action.mode === 'playback'),
    ),
    handlers: merged.spec.handlers.filter((h) => h.id !== 'chunk_playback_handler'),
  };
  const handlers = new Map([...merged.handlers].filter(([id]) => id !== 'chunk_playback_handler'));
  return { spec, handlers };
}
