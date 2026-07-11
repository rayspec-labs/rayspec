/**
 * Deployed-surface neutrality — assert the ACTUAL surface a deployment mounts is product-neutral and
 * tracked by the committed manifest, NOT merely the hand-authored manifest.json. A future rename of a
 * store (stores.ts) or a route/base path or handler id (mount.ts) to a product word would otherwise
 * leave the manifest stale-but-neutral and this suite green — so the checks extract the real surface
 * from the SAME functions a deployment calls (`audioCapabilityStores()` + `mountAudioCapability()`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionFinalizedSink } from './events.js';
import { DEFAULT_AUDIO_BASE_PATH, mountAudioCapability } from './rayspec/mount.js';
import { audioCapabilityStores } from './stores.js';

interface RuntimeManifest {
  stores: string[];
  routes: Array<{ path: string }>;
}

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
const forbiddenProductWords = [
  'memovo',
  'meeting',
  'recording',
  'transcription',
  'deepgram',
] as const;

function actualSurface(): {
  stores: string[];
  routePaths: string[];
  handlerIds: string[];
  mountedStores: string[];
} {
  const noopSink: SessionFinalizedSink = { emit: async () => {} };
  const mounted = mountAudioCapability({ sessionFinalizedSink: noopSink });
  return {
    stores: audioCapabilityStores().map((store) => store.name),
    routePaths: mounted.api.map((route) => route.path),
    handlerIds: Object.values(mounted.handlerIds),
    mountedStores: mounted.stores.map((store) => store.name),
  };
}

function readManifest(): RuntimeManifest {
  return JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as RuntimeManifest;
}

describe('audio capability deployed surface', () => {
  it('mountAudioCapability().stores equals audioCapabilityStores() (single store-schema source)', () => {
    const { stores, mountedStores } = actualSurface();
    expect([...mountedStores].sort()).toEqual([...stores].sort());
  });

  it('the committed manifest tracks the ACTUAL deployed stores and mounted route paths (no drift)', () => {
    const rt = readManifest();
    const { stores, routePaths } = actualSurface();
    expect([...rt.stores].sort()).toEqual([...stores].sort());
    const manifestMountedPaths = rt.routes.map(
      (route) => `${DEFAULT_AUDIO_BASE_PATH}${route.path}`,
    );
    expect([...routePaths].sort()).toEqual([...manifestMountedPaths].sort());
  });

  it('the ACTUAL deployed surface (stores.ts / mount.ts) carries no product-specific vocabulary', () => {
    const { stores, routePaths, handlerIds } = actualSurface();
    const surface = [...stores, ...routePaths, ...handlerIds, DEFAULT_AUDIO_BASE_PATH]
      .join('\n')
      .toLowerCase();
    for (const word of forbiddenProductWords) {
      expect(surface.includes(word), `product word '${word}'`).toBe(false);
    }
  });
});
