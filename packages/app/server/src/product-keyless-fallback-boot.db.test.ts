/**
 * The fixed-transcript fallback of the fake speech adapter, through a real deployment with no
 * provider key and nothing injected (see test-support/keyless-product-boot.ts): with
 * `RAYSPEC_STT_FAKE_FALLBACK=fixed` and no fixture directory, a recording under any id reaches a
 * transcript the declared view reads back.
 *
 * It is its own suite because one process launches the durable worker once, and the full keyless
 * run (product-keyless-boot.db.test.ts) already serves one deployment.
 *
 * Skips without DATABASE_URL; a real durable launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { FAKE_STT_FIXED_SEGMENTS } from '@rayspec/stt-port';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keylessProductHarness, PROVIDER_KEYS } from './test-support/keyless-product-boot.js';

const baseUrl = process.env.DATABASE_URL;

// ran-guard: see the non-skipped describe at the bottom.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let fallbackTestsRan = 0;

const FALLBACK_DB = `rayspec_keyless_fallback_${process.pid}`;

describe.skipIf(!baseUrl)(
  'the fixed transcript answers any recording, with no provider key',
  () => {
    const harness = keylessProductHarness(baseUrl as string, [FALLBACK_DB]);
    beforeAll(() => harness.setup(), 180_000);
    afterAll(() => harness.teardown(), 60_000);

    it('a recording under any id reaches a readable transcript, and the banner says what answered', async () => {
      const { banner } = await harness.bootWithBanner(FALLBACK_DB, {
        STT_PROVIDER: 'fake',
        RAYSPEC_STT_FAKE_FALLBACK: 'fixed',
        RAYSPEC_EXTRACTION_MODE: 'deterministic',
        RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true',
      });
      for (const key of PROVIDER_KEYS) expect(process.env[key], key).toBeUndefined();
      expect(banner).toContain(
        '    STT_PROVIDER=fake (no real transcription — every recording gets the fixed transcript, ' +
          'RAYSPEC_STT_FAKE_FALLBACK=fixed)\n',
      );

      const bearer = await harness.token(FALLBACK_DB);
      await harness.record(bearer, 'any-recording');
      // The fixed transcript carries no labelled line, so the fields the extractor's output shape
      // requires are absent and the run ends at extraction, as an incomplete model answer would —
      // after the transcript was persisted.
      expect(await harness.settledRuns(FALLBACK_DB, 1)).toEqual(['terminal_failure']);
      for (const track of ['mic', 'system']) {
        const transcript = await harness.get(bearer, `/sessions/any-recording/${track}/transcript`);
        expect(transcript.status).toBe('completed');
        expect(transcript.full_text).toBe(FAKE_STT_FIXED_SEGMENTS.join(' '));
        expect(transcript.segments).toEqual([
          { start: 0, end: 5, text: FAKE_STT_FIXED_SEGMENTS[0] },
          { start: 5, end: 10, text: FAKE_STT_FIXED_SEGMENTS[1] },
        ]);
      }
      expect(await harness.query(FALLBACK_DB, 'SELECT 1 FROM note_artifacts')).toEqual([]);
      fallbackTestsRan += 1;
    }, 240_000);
  },
);

/**
 * ran-guard: a separate, non-skipped describe that fails the run when the database is required
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the proof above did not run to its end.
 */
describe('fixed-transcript fallback — ran-guard (the proof must not silently skip when required)', () => {
  it('the fallback case ran to its end when the database is required', () => {
    if (dbRequired) {
      expect(fallbackTestsRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
