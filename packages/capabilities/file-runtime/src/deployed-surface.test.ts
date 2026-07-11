/**
 * Deployed-surface neutrality, per-route WHOLE-TUPLE — assert the ACTUAL surface a deployment mounts
 * is product-neutral and tracked by the committed manifest, extracted from the SAME functions a
 * deployment calls (`fileCapabilityStores()` + `mountFileCapability()`), never the hand-authored JSON
 * alone. The binary two-route surface is asserted as whole tuples: the upload route mounts as a
 * `{kind:'stream', mode:'ingest'}` route (raw Request + tenant-bound blob), the submit as a
 * `{kind:'handler'}` route, each behind bearer auth — a stream-kind regression changes what the
 * engine hands the handler.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FileSubmittedSink } from './events.js';
import {
  DEFAULT_FILE_BASE_PATH,
  DEFAULT_FILE_HANDLER_IDS,
  mountFileCapability,
} from './rayspec/mount.js';
import { FILE_STORE_NAMES, fileCapabilityStores } from './stores.js';

interface FileManifest {
  stores: string[];
  routes: Array<{ id: string; method: string; path: string; auth: string; kind: string }>;
}

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
const forbiddenProductWords = [
  'meeting',
  'recording',
  'transcription',
  'deepgram',
  'invoice',
  'intake',
  'expense',
  'claim',
  'support',
  'ticket',
] as const;
// The UNION of the record gate's provider pattern (`codex` included) and the graph denylist's
// `provider_native`/`native_payload` markers — the surface must survive BOTH (mind `\bpi\b`).
const providerNamePattern =
  /\b(?:deepgram|openai|anthropic|gemini|pi|codex)\b|provider_native|native_payload/i;

function readManifest(): FileManifest {
  return JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as FileManifest;
}

function mount() {
  const noopSink: FileSubmittedSink = { emit: async () => {} };
  return mountFileCapability({ fileSubmittedSink: noopSink });
}

describe('file capability deployed surface', () => {
  it('the mount, the store schema, and the shared name set agree (single store source)', () => {
    const actualStores = fileCapabilityStores().map((store) => store.name);
    expect(
      mount()
        .stores.map((store) => store.name)
        .sort(),
    ).toEqual([...actualStores].sort());
    expect([...actualStores].sort()).toEqual([...FILE_STORE_NAMES].sort());
  });

  it('the committed manifest tracks the ACTUAL deployed stores and mounted route paths (count-exact, no drift)', () => {
    const rt = readManifest();
    const actualStores = fileCapabilityStores().map((store) => store.name);
    const actualRoutePaths = mount().api.map((route) => route.path);
    expect([...rt.stores].sort()).toEqual([...actualStores].sort());
    const manifestMountedPaths = rt.routes.map((route) => `${DEFAULT_FILE_BASE_PATH}${route.path}`);
    expect([...actualRoutePaths].sort()).toEqual([...manifestMountedPaths].sort());
    expect(mount().api.length).toBe(rt.routes.length);
  });

  it('mounts EVERY manifest route as its whole tuple: stream-ingest upload + handler submit, both bearer', () => {
    const rt = readManifest();
    const mounted = mount();
    const kindToMounted: Record<string, { kind: string; mode?: string; handlerId: string }> = {
      stream_ingest: {
        kind: 'stream',
        mode: 'ingest',
        handlerId: DEFAULT_FILE_HANDLER_IDS.fileUpload,
      },
      handler: { kind: 'handler', handlerId: DEFAULT_FILE_HANDLER_IDS.fileSubmit },
    };
    for (const route of rt.routes) {
      expect(route.auth, `route '${route.id}' auth`).toBe('bearer');
      const expected = kindToMounted[route.kind];
      expect(expected, `route '${route.id}' declares unknown kind '${route.kind}'`).toBeDefined();
      const mountedPath = `${DEFAULT_FILE_BASE_PATH}${route.path}`;
      const actual = mounted.api.find((r) => r.path === mountedPath && r.method === route.method);
      expect(actual, `manifest route '${route.id}' not among mounted routes`).toBeDefined();
      expect(actual?.action.kind, `route '${route.id}' action kind`).toBe(expected?.kind);
      if (expected?.mode !== undefined) {
        expect((actual?.action as { mode?: string }).mode, `route '${route.id}' stream mode`).toBe(
          expected.mode,
        );
      }
      expect((actual?.action as { handler?: string }).handler, `route '${route.id}' handler`).toBe(
        expected?.handlerId,
      );
      expect(
        mounted.handlers.has(expected?.handlerId ?? ''),
        `handler '${expected?.handlerId}' registered`,
      ).toBe(true);
    }
  });

  it('the ACTUAL deployed surface AND the manifest carry no product word and survive the provider-name scan', () => {
    const rt = readManifest();
    const mounted = mount();
    const surface = [
      ...fileCapabilityStores().map((store) => store.name),
      ...mounted.api.map((route) => route.path),
      ...Object.values(mounted.handlerIds),
      DEFAULT_FILE_BASE_PATH,
    ]
      .join('\n')
      .toLowerCase();
    const scanTargets: Array<[string, string]> = [
      ['the ACTUAL deployed file surface', surface],
      ['the file manifest.json', JSON.stringify(rt).toLowerCase()],
    ];
    for (const [what, text] of scanTargets) {
      for (const word of forbiddenProductWords) {
        expect(text.includes(word), `${what}: product word '${word}'`).toBe(false);
      }
      expect(providerNamePattern.test(text), `${what}: provider-name scan`).toBe(false);
    }
  });
});
