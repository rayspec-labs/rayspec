import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAKE_STT_ADAPTER_ID,
  FAKE_STT_ANY_SESSION,
  FAKE_STT_FIXED_SEGMENTS,
  FakeSttAdapter,
  FakeSttFixtureError,
  parseFakeSttFixture,
  type SttDualTrackFixture,
} from './fake-adapter.js';
import { SttAdapterRegistry } from './registry.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

describe('FakeSttAdapter', () => {
  const short = readFixture('examples/acme-notes/fixtures/acme-notes-short-session.json');
  const dual = readFixture('examples/acme-notes/fixtures/acme-notes-dual-track-session.json');

  it('normalizes the short-session fixture into provider-neutral artifacts', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [short, dual] });
    const result = await adapter.transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
      media_artifact_ref: 'fixture:acme-short/mic',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed result');
    expect(result.transcript.provider).toBe(FAKE_STT_ADAPTER_ID);
    expect(result.transcript.transcript_id).toBe('stt.transcript.acme-short.mic');
    expect(result.transcript.segments[0]?.id).toBe('stt.segment.acme-short.mic.0000');
    expect(result.transcript.words[0]?.id).toBe('stt.word.acme-short.mic.0000');
    expect(result.transcript.spans[0]?.id).toBe('mic:s0');
    expect(JSON.stringify(result.transcript).toLowerCase()).not.toContain('deepgram');
  });

  it('covers both tracks in the dual-track fixture', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [short, dual] });
    const results = await adapter.transcribeSession({
      session_id: 'acme-dual',
      tracks: [
        { session_id: 'acme-dual', track: 'mic' },
        { session_id: 'acme-dual', track: 'system' },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    const completed = results.filter((result) => result.status === 'completed');
    expect(completed.map((result) => result.transcript.spans[0]?.id)).toEqual([
      'mic:s0',
      'system:s0',
    ]);
  });

  it('simulates pending, failed, and malformed-provider-output states', async () => {
    const pending = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'pending',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });
    const failed = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'failed',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });
    const malformed = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'malformed_provider_output',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });

    expect(pending.status).toBe('pending');
    expect(failed.status).toBe('failed');
    expect(malformed.status).toBe('failed');
    if (malformed.status !== 'failed') throw new Error('expected failed result');
    expect(malformed.error.code).toBe('malformed_provider_output');
  });

  it('registers adapters by stable id', () => {
    const registry = new SttAdapterRegistry();
    registry.register(new FakeSttAdapter({ fixtures: [short] }));
    expect(registry.ids()).toEqual([FAKE_STT_ADAPTER_ID]);
    expect(registry.get(FAKE_STT_ADAPTER_ID).id).toBe(FAKE_STT_ADAPTER_ID);
  });
});

/** The completed transcript of one track, or a thrown error naming what came back instead. */
async function transcribe(adapter: FakeSttAdapter, session_id: string, track: string) {
  const result = await adapter.transcribeTrack({ session_id, track });
  if (result.status !== 'completed') throw new Error(`expected completed, got ${result.status}`);
  return result.transcript;
}

const NAMED: SttDualTrackFixture = {
  fixture_id: 'named',
  session_id: 's1',
  tracks: [{ track: 'mic', segments: [{ text: 'Named session, mic.' }] }],
};
const ANY: SttDualTrackFixture = {
  fixture_id: 'any',
  session_id: FAKE_STT_ANY_SESSION,
  tracks: [
    { track: 'mic', segments: [{ text: 'Any session, mic one.' }, { text: 'Mic two.' }] },
    { track: 'system', segments: [{ text: 'Any session, system.' }] },
  ],
};

describe('FakeSttAdapter — which fixture answers a recording', () => {
  it('without a fixture or a fallback a recording is refused, with the message it always had', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [] });
    await expect(
      adapter.transcribeSession({
        session_id: 's1',
        tracks: [{ session_id: 's1', track: 'mic' }],
      }),
    ).rejects.toThrow('No fake STT fixture for s1/mic.');
    await expect(adapter.transcribeTrack({ session_id: 's1', track: 'mic' })).rejects.toThrow(
      new Error('No fake STT fixture for s1/mic.'),
    );
  });

  it("a fixture for the recording's own session wins over an any-session fixture", async () => {
    for (const fixtures of [
      [NAMED, ANY],
      [ANY, NAMED],
    ]) {
      const transcript = await transcribe(new FakeSttAdapter({ fixtures }), 's1', 'mic');
      expect(transcript.full_text).toBe('Named session, mic.');
      expect(transcript.provider_run_id).toBe('fake-run:named:mic');
    }
  });

  it('an any-session fixture answers every session, as a transcript of that session', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [ANY] });
    const transcript = await transcribe(adapter, 'rec-42', 'mic');
    expect(transcript.session_id).toBe('rec-42');
    expect(transcript.transcript_id).toBe('stt.transcript.rec-42.mic');
    expect(transcript.spans.map((span) => span.id)).toEqual(['mic:s0', 'mic:s1']);
    expect(transcript.spans.map((span) => span.text)).toEqual([
      'Any session, mic one.',
      'Mic two.',
    ]);
    expect(transcript.provider).toBe(FAKE_STT_ADAPTER_ID);
    expect((await transcribe(adapter, 'another', 'system')).session_id).toBe('another');
  });

  it('a session fixture without the track leaves that track to the any-session fixture', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [NAMED, ANY] });
    expect((await transcribe(adapter, 's1', 'system')).full_text).toBe('Any session, system.');
  });

  it('a track no fixture holds is refused when there is no fallback', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [NAMED, ANY] });
    await expect(adapter.transcribeTrack({ session_id: 's1', track: 'aux' })).rejects.toThrow(
      'No fake STT fixture for s1/aux.',
    );
  });

  it('the fixed fallback answers a recording nothing else matches', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [NAMED], fallback: 'fixed' });
    const transcript = await transcribe(adapter, 'unknown-session', 'mic');
    expect(transcript.spans.map((span) => [span.id, span.start, span.end, span.text])).toEqual([
      ['mic:s0', 0, 5, FAKE_STT_FIXED_SEGMENTS[0]],
      ['mic:s1', 5, 10, FAKE_STT_FIXED_SEGMENTS[1]],
    ]);
    expect(FAKE_STT_FIXED_SEGMENTS).toEqual([
      'This is the fixed transcript of the fake speech-to-text adapter.',
      'No audio was read and no provider was called.',
    ]);
    expect(transcript.full_text).toBe(FAKE_STT_FIXED_SEGMENTS.join(' '));
    expect(transcript.session_id).toBe('unknown-session');
    expect(transcript.provider).toBe(FAKE_STT_ADAPTER_ID);
    expect(transcript.provider_run_id).toBe('fake-run:fixed:mic');
    expect(transcript.model).toBe('fake-model');
    expect(transcript.language).toBeNull();
    expect(transcript.confidence).toBe(0.99);
    expect(transcript.duration_seconds).toBe(10);
    expect('span_granularity' in transcript).toBe(false);
  });

  it('the fixed fallback never replaces a fixture that matches', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [NAMED, ANY], fallback: 'fixed' });
    expect((await transcribe(adapter, 's1', 'mic')).full_text).toBe('Named session, mic.');
    expect((await transcribe(adapter, 's2', 'mic')).full_text).toBe(
      'Any session, mic one. Mic two.',
    );
    expect((await transcribe(adapter, 's2', 'aux')).full_text).toBe(
      FAKE_STT_FIXED_SEGMENTS.join(' '),
    );
  });

  it('a session or track id is only ever compared, so a path-shaped id matches nothing', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [NAMED] });
    for (const [session, track] of [
      ['../s1', 'mic'],
      ['s1', '../mic'],
      ['/etc/passwd', 'mic'],
      [FAKE_STT_ANY_SESSION, 'mic'],
    ] as const) {
      await expect(adapter.transcribeTrack({ session_id: session, track })).rejects.toThrow(
        `No fake STT fixture for ${session}/${track}.`,
      );
    }
  });

  it('uses the start and end a segment gives, and five-second slots where it gives none', async () => {
    const adapter = new FakeSttAdapter({
      fixtures: [
        {
          session_id: 's1',
          tracks: [
            {
              track: 'mic',
              segments: [
                { text: 'First.', start: 1.5, end: 3.25 },
                { text: 'Second.' },
                { span_id: 'mic:closing', text: 'Third.', start: 12, end: 20.5 },
              ],
            },
          ],
        },
      ],
    });
    const transcript = await transcribe(adapter, 's1', 'mic');
    expect(transcript.spans.map((span) => [span.id, span.start, span.end])).toEqual([
      ['mic:s0', 1.5, 3.25],
      ['mic:s1', 5, 10],
      ['mic:closing', 12, 20.5],
    ]);
    expect(transcript.duration_seconds).toBe(20.5);
    // A fixture without a fixture_id is named after its session in the run id.
    expect(transcript.provider_run_id).toBe('fake-run:s1:mic');
  });
});

describe('parseFakeSttFixture — the format of one fixture file', () => {
  const dualPath = 'examples/acme-notes/fixtures/acme-notes-dual-track-session.json';

  it('accepts the shipped dual-track example as it is, ignoring the keys it does not read', () => {
    const fixture = parseFakeSttFixture(readFixture(dualPath), 'dual.json');
    expect(fixture).toEqual({
      fixture_id: 'acme-notes-dual-track-session',
      session_id: 'acme-dual',
      tracks: [
        {
          track: 'mic',
          status: 'completed',
          segments: [{ span_id: 'mic:s0', text: "Let's keep the upload API stable." }],
        },
        {
          track: 'system',
          status: 'completed',
          segments: [{ span_id: 'system:s0', text: 'Agreed, the client can move later.' }],
        },
      ],
    });
  });

  it('names a fixture after its file when it carries no fixture_id', () => {
    const fixture = parseFakeSttFixture(
      {
        session_id: '*',
        tracks: [{ track: 'mic', segments: [{ text: 'One.', start: 0, end: 2 }] }],
      },
      'default.json',
    );
    expect(fixture).toEqual({
      fixture_id: 'default',
      session_id: '*',
      tracks: [{ track: 'mic', segments: [{ text: 'One.', start: 0, end: 2 }] }],
    });
  });

  const segment = { text: 'One.' };
  const track = { track: 'mic', segments: [segment] };
  const refused: Array<[string, unknown, string]> = [
    ['an array', [], 'it is not a JSON object'],
    ['a string', 'text', 'it is not a JSON object'],
    ['null', null, 'it is not a JSON object'],
    ['no session_id', { tracks: [track] }, 'session_id is not a non-empty string'],
    [
      'a blank session_id',
      { session_id: ' ', tracks: [track] },
      'session_id is not a non-empty string',
    ],
    [
      'a numeric fixture_id',
      { fixture_id: 7, session_id: 's', tracks: [track] },
      'fixture_id is not a non-empty string',
    ],
    ['no tracks', { session_id: 's' }, 'tracks is not a non-empty array'],
    ['empty tracks', { session_id: 's', tracks: [] }, 'tracks is not a non-empty array'],
    [
      'a track that is not an object',
      { session_id: 's', tracks: ['mic'] },
      'tracks[0].track is not a non-empty string',
    ],
    [
      'a track without a name',
      { session_id: 's', tracks: [track, { segments: [segment] }] },
      'tracks[1].track is not a non-empty string',
    ],
    ['a repeated track', { session_id: 's', tracks: [track, track] }, "track 'mic' appears twice"],
    [
      'a track that is not completed',
      { session_id: 's', tracks: [{ ...track, status: 'pending' }] },
      "tracks[0].status is 'pending', not 'completed'",
    ],
    [
      'a track without segments',
      { session_id: 's', tracks: [{ track: 'mic' }] },
      'tracks[0].segments is not a non-empty array',
    ],
    [
      'a track with no segment',
      { session_id: 's', tracks: [{ track: 'mic', segments: [] }] },
      'tracks[0].segments is not a non-empty array',
    ],
    [
      'a segment without text',
      { session_id: 's', tracks: [{ track: 'mic', segments: [segment, {}] }] },
      'tracks[0].segments[1].text is not a non-empty string',
    ],
    [
      'a segment that is not an object',
      { session_id: 's', tracks: [{ track: 'mic', segments: ['One.'] }] },
      'tracks[0].segments[0].text is not a non-empty string',
    ],
    [
      'an empty span id',
      { session_id: 's', tracks: [{ track: 'mic', segments: [{ text: 'One.', span_id: '' }] }] },
      'tracks[0].segments[0].span_id is not a non-empty string',
    ],
    [
      'a repeated span id',
      {
        session_id: 's',
        tracks: [
          {
            track: 'mic',
            segments: [
              { text: 'One.', span_id: 'a' },
              { text: 'Two.', span_id: 'a' },
            ],
          },
        ],
      },
      "span id 'a' appears twice in track 'mic'",
    ],
    [
      'a span id that collides with a default one',
      {
        session_id: 's',
        tracks: [
          { track: 'mic', segments: [{ text: 'One.', span_id: 'mic:s1' }, { text: 'Two.' }] },
        ],
      },
      "span id 'mic:s1' appears twice in track 'mic'",
    ],
    ...(
      [
        { start: -1, end: 2 },
        { start: 3, end: 2 },
        { start: '0', end: 2 },
        { start: 0, end: null },
        { start: 0, end: Number.POSITIVE_INFINITY },
      ] as const
    ).map((times): [string, unknown, string] => [
      `segment times ${JSON.stringify(times)}`,
      { session_id: 's', tracks: [{ track: 'mic', segments: [{ text: 'One.', ...times }] }] },
      'tracks[0].segments[0] has a start or end that is not a number from 0 with end at or after start',
    ]),
  ];

  it.each(refused)('refuses %s', (_what, value, why) => {
    let thrown: unknown;
    try {
      parseFakeSttFixture(value, 'broken.json');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FakeSttFixtureError);
    expect((thrown as FakeSttFixtureError).message).toBe(`fake STT fixture broken.json: ${why}`);
    expect((thrown as FakeSttFixtureError).fileName).toBe('broken.json');
  });
});
