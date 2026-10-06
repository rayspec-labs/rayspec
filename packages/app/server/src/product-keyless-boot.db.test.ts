/**
 * A product deployment that runs end to end with no provider key, on ground truth: the real
 * composition root, the real durable workflow path, a throwaway database.
 *
 * NOTHING IS INJECTED (see test-support/keyless-product-boot.ts): the environment is the only
 * configuration, exactly as `rayspec deploy` reads it. The document is the acme-notes example as
 * committed, whose extraction config names a real backend and model.
 *
 *   1. Without the new settings the same environment is refused as it always was; the managed
 *      hosting posture refuses each setting; a fixture directory the boot cannot use is refused —
 *      all before any product table exists.
 *   2. With the fake speech adapter answering from the example's fixture directory and the
 *      deterministic provider standing in for the configured backend, an uploaded recording runs
 *      upload → transcribe → extract → ground → persist, and the declared views read the transcript
 *      and the grounded notes back. Every persisted claim cites the span it was read from. The boot
 *      banner names each provider that is not real and what answers in its place.
 *
 * The fixed-transcript fallback has its own suite (product-keyless-fallback-boot.db.test.ts): one
 * process launches the durable worker once.
 *
 * Skips without DATABASE_URL; a real durable launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductBootError } from './product-boot.js';
import {
  ACME_CONFIG,
  ACME_FIXTURES,
  keylessProductHarness,
  PROVIDER_KEYS,
} from './test-support/keyless-product-boot.js';

const baseUrl = process.env.DATABASE_URL;

// ran-guard: the suite skips without a database so a credential-free run stays ergonomic, but a
// required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost DATABASE_URL must not read green. The
// separate, non-skipped describe at the bottom fails on exactly that.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let keylessTestsRan = 0;

const RUN_DB = `rayspec_keyless_run_${process.pid}`;
const REFUSAL_DB = `rayspec_keyless_refusal_${process.pid}`;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.skipIf(!baseUrl)('a product deployment runs end to end with no provider key', () => {
  const harness = keylessProductHarness(baseUrl as string, [RUN_DB, REFUSAL_DB]);
  beforeAll(() => harness.setup(), 180_000);
  afterAll(() => harness.teardown(), 60_000);

  it('without the new settings the boot refuses as before, and the managed posture refuses each one', async () => {
    // The environment a product repository could set before: the committed config names a real
    // backend, so the deterministic provider refuses it. The message is the released one.
    expect(
      await harness.refusalOf(REFUSAL_DB, {
        STT_PROVIDER: 'fake',
        RAYSPEC_EXTRACTION_MODE: 'deterministic',
      }),
    ).toBe(
      "Boot aborted (Product-YAML) — extractor 'note_extractor': " +
        'RAYSPEC_EXTRACTION_MODE=deterministic, but its extraction config selects the backend ' +
        "'openai' — the deterministic extraction provider never stands in for a provider the " +
        'application chose. Run RAYSPEC_EXTRACTION_MODE=live, or set "backend": "deterministic" ' +
        'for a development or test run. Fail-closed.',
    );

    // The managed posture: a real provider is selected, and one keyless setting is left over.
    const managed = {
      RAYSPEC_HOSTING_POSTURE: 'managed',
      STT_PROVIDER: 'deepgram',
      DEEPGRAM_API_KEY: ['inert', 'test', 'value'].join('-'),
      RAYSPEC_EXTRACTION_MODE: 'live',
    };
    const unsupported =
      'Boot aborted (Product-YAML) — RAYSPEC_HOSTING_POSTURE=managed does not support ';
    expect(
      await harness.refusalOf(REFUSAL_DB, { ...managed, RAYSPEC_STT_FAKE_FIXTURES: ACME_FIXTURES }),
    ).toBe(
      `${unsupported}RAYSPEC_STT_FAKE_FIXTURES: it configures the fake speech-to-text adapter, ` +
        "whose capability 'stt-fake' is test-only. Unset it. Fail-closed.",
    );
    expect(
      await harness.refusalOf(REFUSAL_DB, { ...managed, RAYSPEC_STT_FAKE_FALLBACK: 'fixed' }),
    ).toBe(
      `${unsupported}RAYSPEC_STT_FAKE_FALLBACK: it configures the fake speech-to-text adapter, ` +
        "whose capability 'stt-fake' is test-only. Unset it. Fail-closed.",
    );
    expect(
      await harness.refusalOf(REFUSAL_DB, {
        ...managed,
        RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true',
      }),
    ).toBe(
      `${unsupported}RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: it selects the deterministic ` +
        "extraction provider, whose capability 'extraction-deterministic' is test-only. " +
        'Unset it. Fail-closed.',
    );
    // The whole keyless recipe under the managed posture: the fake provider is refused first, with
    // the refusal the posture always gave it.
    expect(
      await harness.refusalOf(REFUSAL_DB, {
        RAYSPEC_HOSTING_POSTURE: 'managed',
        STT_PROVIDER: 'fake',
        RAYSPEC_STT_FAKE_FIXTURES: ACME_FIXTURES,
        RAYSPEC_EXTRACTION_MODE: 'deterministic',
        RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true',
      }),
    ).toContain(
      "RAYSPEC_HOSTING_POSTURE=managed does not support the speech-to-text provider (STT_PROVIDER) 'fake'",
    );

    // Outside the posture: a fixture directory the boot cannot use, a setting beside a real
    // provider, and the stand-in under a live run are each refused at boot.
    const keyless = {
      STT_PROVIDER: 'fake',
      RAYSPEC_EXTRACTION_MODE: 'deterministic',
      RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true',
    };
    const absent = join(ACME_FIXTURES, 'absent');
    const unreadable = harness.boot(REFUSAL_DB, { ...keyless, RAYSPEC_STT_FAKE_FIXTURES: absent });
    await expect(unreadable).rejects.toBeInstanceOf(ProductBootError);
    await expect(unreadable).rejects.toThrow(
      `RAYSPEC_STT_FAKE_FIXTURES '${absent}' is not a readable directory. Fail-closed.`,
    );
    expect(
      await harness.refusalOf(REFUSAL_DB, {
        ...keyless,
        STT_PROVIDER: 'deepgram',
        DEEPGRAM_API_KEY: managed.DEEPGRAM_API_KEY,
        RAYSPEC_STT_FAKE_FIXTURES: ACME_FIXTURES,
      }),
    ).toContain("RAYSPEC_STT_FAKE_FIXTURES is set, but STT_PROVIDER is 'deepgram'");
    expect(
      await harness.refusalOf(REFUSAL_DB, { ...keyless, RAYSPEC_EXTRACTION_MODE: 'live' }),
    ).toContain(
      'RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN=true needs RAYSPEC_EXTRACTION_MODE=deterministic',
    );

    // Every one of those refused before the boot changed anything.
    const [tables] = await harness.query<{ present: boolean }>(
      REFUSAL_DB,
      "SELECT to_regclass('public.note_artifacts') IS NOT NULL AS present",
    );
    expect(tables?.present).toBe(false);
    keylessTestsRan += 1;
  }, 180_000);

  it('upload → transcribe → extract → ground → persist → read, from the environment alone', async () => {
    const configBefore = sha256(ACME_CONFIG);
    expect(JSON.parse(readFileSync(ACME_CONFIG, 'utf8'))).toMatchObject({
      backend: 'openai',
      model: 'gpt-5',
    });

    const { server, banner } = await harness.bootWithBanner(RUN_DB, {
      STT_PROVIDER: 'fake',
      RAYSPEC_STT_FAKE_FIXTURES: ACME_FIXTURES,
      RAYSPEC_EXTRACTION_MODE: 'deterministic',
      RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true',
    });
    expect(server.deployMode).toBe('materialized');
    // No provider key was in the environment the deployment booted and ran in.
    for (const key of PROVIDER_KEYS) expect(process.env[key], key).toBeUndefined();

    // The banner names each provider that is not real, and what answers in its place.
    expect(banner).toBe(
      '\n⚠️  RAYSPEC PRODUCT BOOT — NON-REAL PROVIDER(S) SELECTED ⚠️\n' +
        '    STT_PROVIDER=fake (no real transcription — RAYSPEC_STT_FAKE_FIXTURES answers from ' +
        '1 fixture file(s); a recording none of them matches will not transcribe)\n' +
        '    RAYSPEC_EXTRACTION_MODE=deterministic (no real extraction model — the ' +
        'deterministic provider reads labelled lines and is not for production extraction)\n' +
        '    RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN=true (the deterministic provider answers ' +
        "for note_extractor (config backend 'openai'); no configured backend is called)\n" +
        '    This is a DEV/CI posture — NOT a production configuration. If this is prod, fix the env.\n',
    );

    const bearer = await harness.token(RUN_DB);
    // Two recordings under ids nobody wrote a fixture for: the any-session fixture answers both.
    const sessions = ['keyless-rec-1', 'keyless-rec-2'];
    for (const [i, session] of sessions.entries()) {
      await harness.record(bearer, session);
      expect(await harness.settledRuns(RUN_DB, i + 1)).toEqual(Array(i + 1).fill('completed'));
    }

    const fixture = JSON.parse(readFileSync(join(ACME_FIXTURES, 'default.json'), 'utf8')) as {
      tracks: { track: string; segments: { text: string }[] }[];
    };
    expect(fixture.tracks[0]?.segments[3]?.text).toBe('items: Keep the upload API stable.');
    for (const session of sessions) {
      // The transcript view reads back the fixture's segments, one five-second slot each.
      for (const track of fixture.tracks) {
        const transcript = await harness.get(
          bearer,
          `/sessions/${session}/${track.track}/transcript`,
        );
        expect(transcript).toMatchObject({
          session_id: session,
          track: track.track,
          status: 'completed',
          model: 'fake-model',
          full_text: track.segments.map((s) => s.text).join(' '),
        });
        expect(transcript.segments).toEqual(
          track.segments.map((s, i) => ({ start: i * 5, end: (i + 1) * 5, text: s.text })),
        );
      }

      // The notes view reads back the grounded notes. Each claim cites the span of the segment its
      // labelled line was read from — `mic:s3` is the fourth segment of the mic track.
      expect(await harness.get(bearer, `/sessions/${session}/notes`)).toEqual({
        session_id: session,
        digest: {
          headline: 'The upload API stays stable.',
          detail: 'Both tracks keep the current upload API until the client moves.',
          output_language: 'en',
        },
        items: [
          {
            text: 'Keep the upload API stable.',
            evidence: ['mic:s3'],
            evidence_span_ids: ['mic:s3'],
          },
        ],
        pointers: [
          {
            text: 'Move the client later.',
            evidence: ['system:s0'],
            evidence_span_ids: ['system:s0'],
          },
        ],
        queries: [],
        labels: [
          {
            text: 'The client moves later.',
            evidence: ['system:s1'],
            evidence_span_ids: ['system:s1'],
          },
        ],
        counts: { item: 1, pointer: 1, query: 0, label: 1, digest: 1, total: 4 },
      });
    }

    // The persisted rows carry the citations, and nothing else was persisted.
    const rows = await harness.query<{ artifact_kind: string; span_ids: string[] | null }>(
      RUN_DB,
      `SELECT artifact_kind, payload->'evidence_span_ids' AS span_ids FROM note_artifacts
        WHERE session_id = $1 ORDER BY artifact_kind`,
      [sessions[0]],
    );
    expect(rows.map((r) => [r.artifact_kind, r.span_ids])).toEqual([
      ['digest', expect.anything()],
      ['item', ['mic:s3']],
      ['label', ['system:s1']],
      ['pointer', ['system:s0']],
    ]);

    // The committed production config was read, not rewritten.
    expect(sha256(ACME_CONFIG)).toBe(configBefore);
    keylessTestsRan += 1;
  }, 240_000);
});

/**
 * ran-guard: a separate, non-skipped describe that fails the run when the database is required
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the proofs above did not run to their end. A local run with
 * no database and no opt-in still skips (the assertion is a no-op there).
 */
describe('keyless product run — ran-guard (the proof must not silently skip when required)', () => {
  it('both keyless cases ran to their end when the database is required', () => {
    if (dbRequired) {
      expect(keylessTestsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
