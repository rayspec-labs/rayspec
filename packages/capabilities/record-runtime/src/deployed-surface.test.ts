/**
 * Deployed-surface neutrality — assert the ACTUAL surface a deployment mounts is product-neutral and
 * tracked by the committed manifest, extracted from the SAME functions a deployment calls
 * (`recordCapabilityStores()` + `mountRecordCapability()`), never the hand-authored JSON alone. A
 * rename of a store or a route/base path/handler id to a product word would otherwise leave the
 * manifest stale-but-neutral and this suite green. The submit-ingress surface is EXACTLY one
 * authenticated handler-kind POST route.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RecordSubmittedSink } from './events.js';
import { DEFAULT_RECORD_BASE_PATH, mountRecordCapability } from './rayspec/mount.js';
import { RECORD_STORE_NAMES, recordCapabilityStores } from './stores.js';

interface RecordManifest {
  stores: string[];
  routes: Array<{ id: string; method: string; path: string; auth: string; kind: string }>;
}

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
const forbiddenProductWords = ['meeting', 'recording', 'transcription', 'deepgram'] as const;
// The provider-name scan the Product-YAML graph denylist runs — the capability's own surface must
// survive it too (mind the `\bpi\b` word-boundary class).
const providerNamePattern = /\b(?:deepgram|openai|anthropic|gemini|pi|codex)\b/i;

function readManifest(): RecordManifest {
  return JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as RecordManifest;
}

function mount() {
  const noopSink: RecordSubmittedSink = { emit: async () => {} };
  return mountRecordCapability({ recordSubmittedSink: noopSink });
}

describe('record capability deployed surface', () => {
  it('the mount, the store schema, and the shared name set agree (single store source)', () => {
    const actualStores = recordCapabilityStores().map((store) => store.name);
    expect(
      mount()
        .stores.map((store) => store.name)
        .sort(),
    ).toEqual([...actualStores].sort());
    expect([...actualStores].sort()).toEqual([...RECORD_STORE_NAMES].sort());
  });

  it('the committed manifest tracks the ACTUAL deployed stores and mounted route paths (no drift)', () => {
    const rt = readManifest();
    const actualStores = recordCapabilityStores().map((store) => store.name);
    const actualRoutePaths = mount().api.map((route) => route.path);
    expect([...rt.stores].sort()).toEqual([...actualStores].sort());
    const manifestMountedPaths = rt.routes.map(
      (route) => `${DEFAULT_RECORD_BASE_PATH}${route.path}`,
    );
    expect([...actualRoutePaths].sort()).toEqual([...manifestMountedPaths].sort());
  });

  it('mounts EXACTLY one authenticated handler-kind POST submit route', () => {
    const rt = readManifest();
    const mounted = mount();
    expect(mounted.api.length).toBe(1);
    expect(mounted.api[0]?.method).toBe('POST');
    expect(mounted.api[0]?.action.kind).toBe('handler');
    expect(rt.routes[0]?.auth).toBe('bearer');
  });

  it('the ACTUAL deployed surface AND the manifest carry no product word and survive the provider-name scan', () => {
    const rt = readManifest();
    const mounted = mount();
    const surface = [
      ...recordCapabilityStores().map((store) => store.name),
      ...mounted.api.map((route) => route.path),
      ...Object.values(mounted.handlerIds),
      DEFAULT_RECORD_BASE_PATH,
    ]
      .join('\n')
      .toLowerCase();
    const scanTargets: Array<[string, string]> = [
      ['the ACTUAL deployed record surface', surface],
      ['the record manifest.json', JSON.stringify(rt).toLowerCase()],
    ];
    for (const [what, text] of scanTargets) {
      for (const word of forbiddenProductWords) {
        expect(text.includes(word), `${what}: product word '${word}'`).toBe(false);
      }
      expect(providerNamePattern.test(text), `${what}: provider-name scan`).toBe(false);
    }
  });
});
