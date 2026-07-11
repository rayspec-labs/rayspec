/**
 * Deployed-surface neutrality, per-route WHOLE-TUPLE — assert the ACTUAL surface a deployment mounts
 * is product-neutral and tracked by the committed manifest, extracted from the SAME functions a
 * deployment calls (`conversationCapabilityStores()` + `mountConversationCapability()`), never the
 * hand-authored JSON alone. Both routes are plain JSON handler routes (this capability moves no
 * bytes): the PUT is the idempotent create, the POST the turn submit. The transaction posture is
 * pinned whole (only the turn-submit entry runs handler-managed; every other route keeps the engine
 * tx). The neutrality scan reaches store COLUMN names and runs a two-tier provider/model matcher,
 * belted by its own self-test so a future "simplification" of the matcher goes red, not silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TurnSubmittedSink } from './events.js';
import {
  DEFAULT_CONVERSATION_BASE_PATH,
  DEFAULT_CONVERSATION_HANDLER_IDS,
  mountConversationCapability,
} from './rayspec/mount.js';
import { CONVERSATION_STORE_NAMES, conversationCapabilityStores } from './stores.js';

interface ConversationManifest {
  stores: string[];
  routes: Array<{ id: string; method: string; path: string; auth: string; kind: string }>;
}

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
// The neutral surface must name none of: the donor product vocabulary, the acceptance-product
// vocabulary, or the conversational-product vocabulary (incl. the informal 'chat' token — this
// capability is deliberately named CONVERSATION on its neutral surface). Collision-checked: none of
// these appears on the capability's own neutral surface or manifest.
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
  'chat',
  'recruiting',
  'screener',
  'candidate',
] as const;
// A two-tier provider/model scan: (a) SUBSTRING tier for unambiguous provider/model names, caught
// even glued inside an identifier (`gpt` is a deliberate plain substring — no English word carries
// the trigram, and only the substring catches `gpt-4o`/`gpt4`/`use_gpt`); (b) SEPARATOR-BOUNDARY
// tier for short ambiguous names (`pi` sits inside api/pipeline/topic), snake-case-aware so
// `pi_native`/`use-pi` hit while `api`/`pipeline` stay clean.
const PROVIDER_SUBSTRING_TOKENS = [
  'deepgram',
  'openai',
  'anthropic',
  'gemini',
  'claude',
  'codex',
  'gpt',
  'provider_native',
  'native_payload',
] as const;
const PROVIDER_BOUNDARY_TOKENS = ['pi'] as const;

/** The two-tier provider/model scan: the FIRST matched token, or null if the text is clean. */
function providerScanHit(text: string): string | null {
  const lower = text.toLowerCase();
  for (const token of PROVIDER_SUBSTRING_TOKENS) {
    if (lower.includes(token)) return token;
  }
  for (const token of PROVIDER_BOUNDARY_TOKENS) {
    if (new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`).test(lower)) return token;
  }
  return null;
}

function readManifest(): ConversationManifest {
  return JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as ConversationManifest;
}

function mount() {
  const noopSink: TurnSubmittedSink = { emit: async () => {} };
  // The mount requires a responder factory (a submitted turn produces a real reply); the surface
  // facts asserted below are construction-time, so a neutral noop responder suffices.
  return mountConversationCapability({
    turnSubmittedSink: noopSink,
    turnResponder: () => ({
      agentId: 'probe',
      historyWindow: { turns: 1, chars: 1 },
      respond: async () => ({ status: 'completed', runId: 'probe', text: '' }),
    }),
  });
}

describe('conversation provider/model scan (matcher self-test)', () => {
  it('hits the glued/model tokens the plain word-boundary scan missed, and clears innocent identifiers', () => {
    const mustHit: Array<[string, string]> = [
      ['openai_reply', 'openai'],
      ['deepgram_stt', 'deepgram'],
      ['gpt5_prompt', 'gpt'],
      ['use_gpt', 'gpt'],
      ['gpt-4o-mini', 'gpt'],
      ['claude_style', 'claude'],
      ['Anthropic', 'anthropic'],
      ['pi_native_run', 'pi'],
      ['use-pi', 'pi'],
    ];
    for (const [sample, expected] of mustHit) {
      expect(providerScanHit(sample), `'${sample}' must hit '${expected}'`).toBe(expected);
    }
    for (const innocent of [
      'api',
      'api_key',
      'pipeline',
      'topic',
      'topic_map',
      'mapping',
      'rapid',
    ]) {
      expect(providerScanHit(innocent), `innocent '${innocent}' must stay clean`).toBeNull();
    }
  });
});

describe('conversation capability deployed surface', () => {
  it('the mount, the store schema, and the shared name set agree (single store source)', () => {
    const actualStores = conversationCapabilityStores().map((store) => store.name);
    expect(
      mount()
        .stores.map((store) => store.name)
        .sort(),
    ).toEqual([...actualStores].sort());
    expect([...actualStores].sort()).toEqual([...CONVERSATION_STORE_NAMES].sort());
  });

  it('the committed manifest tracks the ACTUAL deployed stores and mounted route paths (count-exact, no drift)', () => {
    const rt = readManifest();
    const actualStores = conversationCapabilityStores().map((store) => store.name);
    const mounted = mount();
    const actualRoutePaths = mounted.api.map((route) => route.path);
    expect([...rt.stores].sort()).toEqual([...actualStores].sort());
    const manifestMountedPaths = rt.routes.map(
      (route) => `${DEFAULT_CONVERSATION_BASE_PATH}${route.path}`,
    );
    expect([...actualRoutePaths].sort()).toEqual([...manifestMountedPaths].sort());
    expect(mounted.api.length).toBe(rt.routes.length);
  });

  it('mounts EVERY manifest route as a whole handler-route tuple: PUT create + POST turn submit, both bearer', () => {
    const rt = readManifest();
    const mounted = mount();
    const idToMounted: Record<string, { method: string; handlerId: string }> = {
      conversation_create: {
        method: 'PUT',
        handlerId: DEFAULT_CONVERSATION_HANDLER_IDS.conversationCreate,
      },
      conversation_turn_submit: {
        method: 'POST',
        handlerId: DEFAULT_CONVERSATION_HANDLER_IDS.turnSubmit,
      },
    };
    for (const route of rt.routes) {
      expect(route.auth, `route '${route.id}' auth`).toBe('bearer');
      expect(route.kind, `route '${route.id}' kind`).toBe('handler');
      const expected = idToMounted[route.id];
      expect(expected, `route '${route.id}' is a known conversation route`).toBeDefined();
      expect(route.method, `route '${route.id}' method`).toBe(expected?.method);
      const mountedPath = `${DEFAULT_CONVERSATION_BASE_PATH}${route.path}`;
      const actual = mounted.api.find((r) => r.path === mountedPath && r.method === route.method);
      expect(actual, `manifest route '${route.id}' among mounted routes`).toBeDefined();
      expect(actual?.action.kind, `route '${route.id}' action kind`).toBe('handler');
      expect((actual?.action as { handler?: string }).handler, `route '${route.id}' handler`).toBe(
        expected?.handlerId,
      );
      expect(
        mounted.handlers.has(expected?.handlerId ?? ''),
        `handler '${expected?.handlerId}' registered`,
      ).toBe(true);
    }
    // The whole-invariant belt: no mounted route may be anything but a plain handler route.
    for (const route of mounted.api) {
      expect(route.action.kind, `EVERY route handler-kind (${route.method} ${route.path})`).toBe(
        'handler',
      );
    }
  });

  it('pins the transaction posture whole: ONLY the turn-submit entry is handler-managed; every other route keeps the engine tx', () => {
    const mounted = mount();
    for (const [id, entry] of mounted.handlers) {
      const expectedTx =
        id === DEFAULT_CONVERSATION_HANDLER_IDS.turnSubmit ? 'handler-managed' : undefined;
      expect(entry.routeTx, `handler '${id}' routeTx`).toBe(expectedTx);
    }
  });

  it('the ACTUAL surface (incl. store columns) AND the manifest carry no product word and survive the two-tier provider scan', () => {
    const rt = readManifest();
    const mounted = mount();
    const storeSpecs = conversationCapabilityStores();
    const surface = [
      ...storeSpecs.map((store) => store.name),
      ...storeSpecs.flatMap((store) => store.columns.map((column) => column.name)),
      ...mounted.api.map((route) => route.path),
      ...Object.values(mounted.handlerIds),
      DEFAULT_CONVERSATION_BASE_PATH,
    ]
      .join('\n')
      .toLowerCase();
    const scanTargets: Array<[string, string]> = [
      ['the ACTUAL deployed conversation surface (stores incl. columns / mount)', surface],
      ['the conversation manifest.json', JSON.stringify(rt).toLowerCase()],
    ];
    for (const [what, text] of scanTargets) {
      for (const word of forbiddenProductWords) {
        expect(text.includes(word), `${what}: product word '${word}'`).toBe(false);
      }
      expect(providerScanHit(text), `${what}: provider/model token`).toBeNull();
    }
  });
});
