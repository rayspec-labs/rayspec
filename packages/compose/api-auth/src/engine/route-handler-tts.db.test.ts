/**
 * the TTS route-handler seam, DB-backed, end-to-end through the REAL createAuthApp +
 * declared-route interpreter, with a RECORDING stand-in `TtsCapability` (NO provider call in this
 * process — the REAL provider selection + the offline synthesizer are proven in @rayspec/server's
 * `tts-capability.unit.test.ts`).
 *
 * These assert the contract on GROUND TRUTH (fail-the-fix, not pass-the-shape): a declared ROUTE
 * handler that calls `init.tts.synthesize(...)` reaches the capability the DEPLOYMENT injected onto
 * the engine, with the caller's text + plain options crossing verbatim — and it fail-closes when the
 * deployment wired no provider.
 *
 *  (1) SYNTHESIZES THROUGH THE INJECTED CAPABILITY — the handler posts text and gets audio back;
 *      exactly one capability call, carrying the EXACT text.
 *  (2) PLAIN OPTIONS CROSS VERBATIM — voice/speed/format arrive as a plain record (serializable-shaped:
 *      a string + plain options in, a plain result out).
 *  (3) DEPLOYMENT-STATIC, NOT TENANT-PARTITIONED — two distinct tenants reach the SAME injected
 *      capability (it carries no tenant data; the run's tenant stays on `init.db`/`init.blob`).
 *  (4) FAIL-CLOSED WHEN UNWIRED — with no capability injected, `init.tts` is ABSENT (the handler
 *      fail-closes loudly on `undefined`); no silent no-op, no fabricated audio.
 *
 * Skips when DATABASE_URL is absent.
 */
import type {
  ResolvedHandler,
  TtsCapability,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the injected-capability seam — it must never
// silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'route-handler-tts.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip a capability-seam suite.',
  );
}

/**
 * A RECORDING stand-in `TtsCapability` — it encodes the text it was handed into the returned bytes and
 * keeps every call, so a test asserts the WHOLE invariant (exactly one call, the exact text, the exact
 * options). It makes NO provider call (the real adapters are exercised where they are built). The
 * result is the port's REAL shape — the platform re-exports it, so nothing here is cast away.
 */
function recordingTts(): TtsCapability & {
  readonly calls: Array<{ text: string; opts?: TtsSynthesizeOptions }>;
} {
  const calls: Array<{ text: string; opts?: TtsSynthesizeOptions }> = [];
  return {
    calls,
    async synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
      calls.push({ text, opts });
      return {
        bytes: new TextEncoder().encode(`spoke ${text.length} chars`),
        contentType: 'audio/wav',
        durationSeconds: 1,
      };
    },
  };
}

/**
 * A throwaway spec declaring a `notes` store + a single `{handler}` route POST /speak → the
 * `speak_handler` (kind route). The handler is injected directly (engineHandlers) — its fn calls
 * `init.tts`, driven by the request body so each test exercises a different case.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: tts-seam-backend
  description: A throwaway backend with a {handler} route that calls init.tts.
stores:
  - name: notes
    columns:
      - name: title
        type: text
handlers:
  - id: speak_handler
    module: handlers/speak.ts
    export: speak
    kind: route
api:
  - method: POST
    path: /speak
    action:
      kind: handler
      handler: speak_handler
`;

function buildSpec(): RaySpec {
  const parsed = parseSpec(SPEC_YAML);
  if (!parsed.ok) throw new Error(`spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/**
 * The speak route handler (the pack-side consumer of `init.tts`). It reads the text from the request
 * body plus the optional voice/speed/format options, then synthesizes. Fail-closes loudly if
 * `init.tts` is absent (no provider wired) — never a silent no-op.
 *
 * Authored against the SAME contract a real pack writes against; injected here as a ResolvedHandler so
 * the test does not need a path-jailed examples/ pack.
 */
const speakHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as {
      body?: unknown;
      tts?: {
        synthesize(
          text: string,
          opts?: { voice?: string; speed?: number; format?: 'mp3' | 'opus' | 'wav' },
        ): Promise<{ bytes: Uint8Array; contentType: string; durationSeconds?: number | null }>;
      };
    };
    if (!i.tts) {
      // Fail-closed: no TTS provider wired → the capability is absent. Never a silent no-op.
      throw new Error('speak: init.tts is not available (no TTS provider wired). Fail-closed.');
    }
    const body = (i.body ?? {}) as {
      text?: string;
      voice?: string;
      speed?: number;
      format?: 'mp3' | 'opus' | 'wav';
    };
    const result = await i.tts.synthesize(body.text ?? '', {
      ...(body.voice ? { voice: body.voice } : {}),
      ...(body.speed !== undefined ? { speed: body.speed } : {}),
      ...(body.format ? { format: body.format } : {}),
    });
    return {
      audio: new TextDecoder().decode(result.bytes),
      contentType: result.contentType,
      durationSeconds: result.durationSeconds ?? null,
    };
  },
};

/** The text a test posts. */
const TEXT = 'Guten Morgen.';

describe.skipIf(!hasDb)('route-handler init.tts synthesis seam', () => {
  let h: Harness;
  let tts: ReturnType<typeof recordingTts>;
  const SCHEMA = 'rayspec_test_route_handler_tts';

  beforeAll(async () => {
    tts = recordingTts();
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: new Map<string, ResolvedHandler>([['speak_handler', speakHandler]]),
      ttsCapability: tts,
      schema: SCHEMA,
    });
  });
  beforeEach(async () => {
    await h.reset();
    tts.calls.length = 0;
  });
  afterAll(async () => {
    await h.close();
  });

  /** Register → org → switch → JWT (member role: store:read/write + agent:run). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  it('(1) the handler synthesizes through the INJECTED capability (one call, the exact text)', async () => {
    const { token } = await principal('tts@example.com', 'TtsOrg');
    const res = await jsonRequest(h.app, 'POST', '/speak', {
      body: { text: TEXT },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audio: `spoke ${TEXT.length} chars`,
      contentType: 'audio/wav',
      durationSeconds: 1,
    });

    // EXACTLY ONE capability call, carrying the EXACT text the caller posted.
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]?.text).toBe(TEXT);
  });

  it('(2) PLAIN OPTIONS CROSS VERBATIM: voice/speed/format arrive as a plain record', async () => {
    const { token } = await principal('ttsopts@example.com', 'TtsOptsOrg');
    const res = await jsonRequest(h.app, 'POST', '/speak', {
      body: { text: TEXT, voice: 'onyx', speed: 1.25, format: 'mp3' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(tts.calls[0]?.opts).toEqual({ voice: 'onyx', speed: 1.25, format: 'mp3' });

    // A bare call carries an EMPTY option record — the plain record is passed through as authored,
    // never re-shaped by the engine.
    await jsonRequest(h.app, 'POST', '/speak', {
      body: { text: TEXT },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tts.calls[1]?.opts).toEqual({});
  });

  it('(3) DEPLOYMENT-STATIC: two tenants reach the SAME injected capability (it carries no tenant data)', async () => {
    const a = await principal('ttsA@example.com', 'TtsTenantA');
    const b = await principal('ttsB@example.com', 'TtsTenantB');
    expect(a.orgId).not.toBe(b.orgId);

    for (const t of [a.token, b.token]) {
      const res = await jsonRequest(h.app, 'POST', '/speak', {
        body: { text: TEXT },
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.status).toBe(200);
    }
    // Both requests went through the ONE deployment-wired capability — unlike `init.blob`, the TTS
    // capability is not tenant-partitioned (it receives text the handler already assembled).
    expect(tts.calls).toHaveLength(2);
  });

  it('(4) FAIL-CLOSED WHEN UNWIRED: with no capability wired, init.tts is absent (handler fail-closes)', async () => {
    // A SECOND harness whose engine wires NO capability (the exact deployment shape of a backend that
    // never set TTS_PROVIDER). Everything else is identical, so the ONLY cause of the failure is the
    // absent capability.
    const h2 = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: new Map<string, ResolvedHandler>([['speak_handler', speakHandler]]),
      schema: 'rayspec_test_route_handler_tts_unwired',
    });
    try {
      const reg = await jsonRequest(h2.app, 'POST', '/v1/auth/register', {
        body: { email: 'unwired-tts@example.com', password: 'a-long-enough-password' },
      });
      const t0 = (await reg.json()).accessToken as string;
      const orgId = (
        await (
          await jsonRequest(h2.app, 'POST', '/v1/orgs', {
            body: { name: 'UnwiredTtsOrg' },
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).id as string;
      const token = (
        await (
          await jsonRequest(h2.app, 'POST', `/v1/orgs/${orgId}/switch`, {
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).accessToken as string;

      const res = await jsonRequest(h2.app, 'POST', '/speak', {
        body: { text: TEXT },
        headers: { authorization: `Bearer ${token}` },
      });
      // The handler throws on the absent capability → global onError → 500 (a loud fail-closed, NOT a
      // silent no-op). The capability being ABSENT (not a throwing stub) is the contract.
      expect(res.status).toBe(500);
      // Nothing reached the OTHER harness's capability either (no cross-deployment leak).
      expect(tts.calls).toHaveLength(0);
    } finally {
      await h2.close();
    }
  });
});
