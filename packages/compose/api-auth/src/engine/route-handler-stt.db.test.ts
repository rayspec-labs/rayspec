/**
 * the STT route-handler seam, DB-backed, end-to-end through the REAL createAuthApp +
 * declared-route interpreter, with a RECORDING stand-in `SttCapability` (NO provider call in this
 * process — the REAL provider selection + the bytes→ref resolver wrap are proven in @rayspec/server's
 * stt-capability suites).
 *
 * These assert the contract on GROUND TRUTH (fail-the-fix, not pass-the-shape): a declared ROUTE
 * handler that calls `init.stt.transcribe(...)` reaches the capability the DEPLOYMENT injected onto
 * the engine, with the caller's bytes + plain options crossing verbatim — and it fail-closes when the
 * deployment wired no provider.
 *
 *  (1) TRANSCRIBES THROUGH THE INJECTED CAPABILITY — the handler posts bytes and gets the transcript
 *      back; exactly one capability call, carrying the EXACT bytes.
 *  (2) PLAIN OPTIONS CROSS VERBATIM — contentType/languageHint/detectLanguage arrive as a plain
 *      record (serializable-shaped: bytes + plain options in, plain result out).
 *  (3) DEPLOYMENT-STATIC, NOT TENANT-PARTITIONED — two distinct tenants reach the SAME injected
 *      capability (it carries no tenant data; the run's tenant stays on `init.db`/`init.blob`).
 *  (4) FAIL-CLOSED WHEN UNWIRED — with no capability injected, `init.stt` is ABSENT (the handler
 *      fail-closes loudly on `undefined`); no silent no-op, no fabricated transcript.
 *
 * Skips when DATABASE_URL is absent.
 */
import type { ResolvedHandler, SttCapability, SttTranscribeOptions } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the injected-capability seam — it must never
// silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'route-handler-stt.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip a capability-seam suite.',
  );
}

/**
 * A RECORDING stand-in `SttCapability` — it echoes the byte length back in the transcript and keeps
 * every call, so a test asserts the WHOLE invariant (exactly one call, the exact bytes, the exact
 * options). It makes NO provider call (the real adapters are exercised where they are built).
 */
function recordingStt(): SttCapability & {
  readonly calls: Array<{ bytes: Uint8Array; opts?: SttTranscribeOptions }>;
} {
  const calls: Array<{ bytes: Uint8Array; opts?: SttTranscribeOptions }> = [];
  return {
    calls,
    async transcribe(bytes: Uint8Array, opts?: SttTranscribeOptions) {
      calls.push({ bytes, opts });
      return {
        status: 'completed',
        transcript: { full_text: `heard ${bytes.length} bytes` },
      } as never;
    },
  };
}

/**
 * A throwaway spec declaring a `notes` store + a single `{handler}` route POST /transcribe → the
 * `transcribe_handler` (kind route). The handler is injected directly (engineHandlers) — its fn calls
 * `init.stt`, driven by the request body so each test exercises a different case.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: stt-seam-backend
  description: A throwaway backend with a {handler} route that calls init.stt.
stores:
  - name: notes
    columns:
      - name: title
        type: text
handlers:
  - id: transcribe_handler
    module: handlers/transcribe.ts
    export: transcribe
    kind: route
api:
  - method: POST
    path: /transcribe
    action:
      kind: handler
      handler: transcribe_handler
`;

function buildSpec(): RaySpec {
  const parsed = parseSpec(SPEC_YAML);
  if (!parsed.ok) throw new Error(`spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/**
 * The transcribe route handler (the pack-side consumer of `init.stt`). It reads base64 audio from the
 * request body (bounded by the JSON body cap) plus the optional language options, then transcribes.
 * Fail-closes loudly if `init.stt` is absent (no provider wired) — never a silent no-op.
 *
 * Authored against the SAME contract a real pack writes against; injected here as a ResolvedHandler so
 * the test does not need a path-jailed examples/ pack.
 */
const transcribeHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as {
      body?: unknown;
      stt?: {
        transcribe(
          bytes: Uint8Array,
          opts?: { contentType?: string; languageHint?: string; detectLanguage?: boolean },
        ): Promise<{ status: string; transcript?: { full_text: string } }>;
      };
    };
    if (!i.stt) {
      // Fail-closed: no STT provider wired → the capability is absent. Never a silent no-op.
      throw new Error(
        'transcribe: init.stt is not available (no STT provider wired). Fail-closed.',
      );
    }
    const body = (i.body ?? {}) as {
      audio_base64?: string;
      content_type?: string;
      language_hint?: string;
      detect_language?: boolean;
    };
    const bytes = Uint8Array.from(Buffer.from(body.audio_base64 ?? '', 'base64'));
    const result = await i.stt.transcribe(bytes, {
      ...(body.content_type ? { contentType: body.content_type } : {}),
      ...(body.language_hint ? { languageHint: body.language_hint } : {}),
      ...(body.detect_language !== undefined ? { detectLanguage: body.detect_language } : {}),
    });
    return { status: result.status, text: result.transcript?.full_text };
  },
};

/** The audio a test posts (opaque bytes — the stand-in capability never decodes them). */
const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x7f, 0x10]);
const AUDIO_B64 = Buffer.from(AUDIO).toString('base64');

describe.skipIf(!hasDb)('route-handler init.stt transcription seam', () => {
  let h: Harness;
  let stt: ReturnType<typeof recordingStt>;
  const SCHEMA = 'rayspec_test_route_handler_stt';

  beforeAll(async () => {
    stt = recordingStt();
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: new Map<string, ResolvedHandler>([['transcribe_handler', transcribeHandler]]),
      sttCapability: stt,
      schema: SCHEMA,
    });
  });
  beforeEach(async () => {
    await h.reset();
    stt.calls.length = 0;
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

  it('(1) the handler transcribes through the INJECTED capability (one call, the exact bytes)', async () => {
    const { token } = await principal('stt@example.com', 'SttOrg');
    const res = await jsonRequest(h.app, 'POST', '/transcribe', {
      body: { audio_base64: AUDIO_B64 },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'completed', text: 'heard 8 bytes' });

    // EXACTLY ONE capability call, carrying the EXACT bytes the caller posted.
    expect(stt.calls).toHaveLength(1);
    expect([...(stt.calls[0]?.bytes ?? [])]).toEqual([...AUDIO]);
  });

  it('(2) PLAIN OPTIONS CROSS VERBATIM: contentType/languageHint/detectLanguage arrive as a plain record', async () => {
    const { token } = await principal('opts@example.com', 'OptsOrg');
    const res = await jsonRequest(h.app, 'POST', '/transcribe', {
      body: { audio_base64: AUDIO_B64, content_type: 'audio/ogg', language_hint: 'de' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(stt.calls[0]?.opts).toEqual({ contentType: 'audio/ogg', languageHint: 'de' });

    // A detect-language call carries the boolean (and no hint) — the plain record is passed through
    // as authored, never re-shaped by the engine.
    await jsonRequest(h.app, 'POST', '/transcribe', {
      body: { audio_base64: AUDIO_B64, detect_language: true },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stt.calls[1]?.opts).toEqual({ detectLanguage: true });
  });

  it('(3) DEPLOYMENT-STATIC: two tenants reach the SAME injected capability (it carries no tenant data)', async () => {
    const a = await principal('sttA@example.com', 'SttTenantA');
    const b = await principal('sttB@example.com', 'SttTenantB');
    expect(a.orgId).not.toBe(b.orgId);

    for (const t of [a.token, b.token]) {
      const res = await jsonRequest(h.app, 'POST', '/transcribe', {
        body: { audio_base64: AUDIO_B64 },
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.status).toBe(200);
    }
    // Both requests went through the ONE deployment-wired capability — unlike `init.blob`, the STT
    // capability is not tenant-partitioned (it receives bytes the handler already holds).
    expect(stt.calls).toHaveLength(2);
  });

  it('(4) FAIL-CLOSED WHEN UNWIRED: with no capability wired, init.stt is absent (handler fail-closes)', async () => {
    // A SECOND harness whose engine wires NO capability (the exact deployment shape of a backend that
    // never set STT_PROVIDER). Everything else is identical, so the ONLY cause of the failure is the
    // absent capability.
    const h2 = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: new Map<string, ResolvedHandler>([['transcribe_handler', transcribeHandler]]),
      schema: 'rayspec_test_route_handler_stt_unwired',
    });
    try {
      const reg = await jsonRequest(h2.app, 'POST', '/v1/auth/register', {
        body: { email: 'unwired-stt@example.com', password: 'a-long-enough-password' },
      });
      const t0 = (await reg.json()).accessToken as string;
      const orgId = (
        await (
          await jsonRequest(h2.app, 'POST', '/v1/orgs', {
            body: { name: 'UnwiredSttOrg' },
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

      const res = await jsonRequest(h2.app, 'POST', '/transcribe', {
        body: { audio_base64: AUDIO_B64 },
        headers: { authorization: `Bearer ${token}` },
      });
      // The handler throws on the absent capability → global onError → 500 (a loud fail-closed, NOT a
      // silent no-op). The capability being ABSENT (not a throwing stub) is the contract.
      expect(res.status).toBe(500);
      // Nothing reached the OTHER harness's capability either (no cross-deployment leak).
      expect(stt.calls).toHaveLength(0);
    } finally {
      await h2.close();
    }
  });
});
