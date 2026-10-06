/**
 * The fixture directory of the fake speech-to-text adapter (no DB, no network): which files are
 * fixtures, the order they load in, and every way a directory is refused — at load, which is boot.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeSttAdapter } from '@rayspec/stt-port';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeSttFixturesError, loadFakeSttFixtures } from './fake-stt-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory holding `files` (name → content; an object is written as JSON). */
function dirWith(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-stt-fixtures-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const fixture = (session_id: string, track = 'mic', text = `${session_id} ${track}`) => ({
  session_id,
  tracks: [{ track, segments: [{ text }] }],
});

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FakeSttFixturesError);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('loadFakeSttFixtures — which files of the directory are fixtures', () => {
  it('loads the .json files in name order and ignores everything else', () => {
    const dir = dirWith({
      'b.json': fixture('b'),
      'a.json': fixture('a'),
      'C.json': fixture('upper'),
      'notes.txt': 'not a fixture',
      'a.json.bak': '{ not json',
      '.hidden': 'x',
    });
    mkdirSync(join(dir, 'nested.json'));
    writeFileSync(join(dir, 'nested.json', 'inner.json'), '{ not json');

    const loaded = loadFakeSttFixtures(dir);
    expect(loaded.files).toEqual(['C.json', 'a.json', 'b.json']);
    expect(loaded.fixtures.map((f) => [f.fixture_id, f.session_id])).toEqual([
      ['C', 'upper'],
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  it('resolves a relative directory against the working directory', () => {
    const dir = dirWith({ 'only.json': fixture('s') });
    expect(loadFakeSttFixtures(relative(process.cwd(), dir)).files).toEqual(['only.json']);
  });

  it('loads the fixture the acme-notes example ships', () => {
    const loaded = loadFakeSttFixtures(join(repoRoot, 'examples/acme-notes/stt-fixtures'));
    expect(loaded.files).toEqual(['default.json']);
    expect(loaded.fixtures[0]?.session_id).toBe('*');
    expect(loaded.fixtures[0]?.tracks.map((t) => t.track)).toEqual(['mic', 'system']);
  });

  it('never follows a symbolic link out of the directory', () => {
    const outside = dirWith({ 'secret.json': fixture('outside') });
    const dir = dirWith({ 'inside.json': fixture('inside') });
    symlinkSync(join(outside, 'secret.json'), join(dir, 'link.json'));
    symlinkSync(outside, join(dir, 'linked-dir.json'));

    const loaded = loadFakeSttFixtures(dir);
    expect(loaded.files).toEqual(['inside.json']);
    expect(loaded.fixtures.map((f) => f.session_id)).toEqual(['inside']);
    // A directory whose only .json entry is a link holds no fixture.
    const onlyLink = dirWith();
    symlinkSync(join(outside, 'secret.json'), join(onlyLink, 'link.json'));
    expect(refusal(() => loadFakeSttFixtures(onlyLink))).toBe(
      `RAYSPEC_STT_FAKE_FIXTURES '${onlyLink}' holds no .json fixture file. Fail-closed.`,
    );
  });

  it('a recording id shaped like a path reads nothing: only declared ids are compared', async () => {
    const outside = dirWith({ 'secret.json': fixture('outside') });
    const dir = dirWith({ 'inside.json': fixture('inside') });
    const adapter = new FakeSttAdapter({ fixtures: loadFakeSttFixtures(dir).fixtures });
    const escapes = [
      `../${relative(dirname(dir), outside)}/secret`,
      join(outside, 'secret'),
      join(outside, 'secret.json'),
      'inside.json',
      '..',
    ];
    for (const session_id of escapes) {
      await expect(adapter.transcribeTrack({ session_id, track: 'mic' })).rejects.toThrow(
        `No fake STT fixture for ${session_id}/mic.`,
      );
      await expect(
        adapter.transcribeTrack({ session_id: 'inside', track: session_id }),
      ).rejects.toThrow(`No fake STT fixture for inside/${session_id}.`);
    }
    // The file outside is untouched and the one inside still answers.
    expect(JSON.parse(readFileSync(join(outside, 'secret.json'), 'utf8'))).toEqual(
      fixture('outside'),
    );
    const ok = await adapter.transcribeTrack({ session_id: 'inside', track: 'mic' });
    expect(ok.status).toBe('completed');
  });
});

describe('loadFakeSttFixtures — a directory it refuses', () => {
  it('a path that does not exist, and a file where a directory is expected', () => {
    const missing = join(dirWith(), 'absent');
    expect(refusal(() => loadFakeSttFixtures(missing))).toBe(
      `RAYSPEC_STT_FAKE_FIXTURES '${missing}' is not a readable directory. Fail-closed.`,
    );
    const file = join(dirWith({ 'a.json': fixture('a') }), 'a.json');
    expect(refusal(() => loadFakeSttFixtures(file))).toBe(
      `RAYSPEC_STT_FAKE_FIXTURES '${file}' is not a readable directory. Fail-closed.`,
    );
  });

  it.skipIf(process.getuid?.() === 0)('a directory it has no permission to list', () => {
    const dir = dirWith({ 'a.json': fixture('a') });
    chmodSync(dir, 0o000);
    try {
      expect(refusal(() => loadFakeSttFixtures(dir))).toBe(
        `RAYSPEC_STT_FAKE_FIXTURES '${dir}' is not a readable directory. Fail-closed.`,
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('a directory without a .json file', () => {
    const dir = dirWith({ 'readme.md': 'nothing here' });
    expect(refusal(() => loadFakeSttFixtures(dir))).toBe(
      `RAYSPEC_STT_FAKE_FIXTURES '${dir}' holds no .json fixture file. Fail-closed.`,
    );
  });

  it('a file that is not JSON, and a file that is not a fixture', () => {
    expect(refusal(() => loadFakeSttFixtures(dirWith({ 'bad.json': '{ "session_id": ' })))).toBe(
      'fake STT fixture bad.json: it is not valid JSON. Fail-closed.',
    );
    expect(
      refusal(() =>
        loadFakeSttFixtures(dirWith({ 'ok.json': fixture('a'), 'shape.json': { tracks: [] } })),
      ),
    ).toBe('fake STT fixture shape.json: session_id is not a non-empty string. Fail-closed.');
    expect(
      refusal(() =>
        loadFakeSttFixtures(
          dirWith({ 'seg.json': { session_id: 's', tracks: [{ track: 'mic', segments: [] }] } }),
        ),
      ),
    ).toBe('fake STT fixture seg.json: tracks[0].segments is not a non-empty array. Fail-closed.');
  });

  it.skipIf(process.getuid?.() === 0)('a fixture file it has no permission to read', () => {
    const dir = dirWith({ 'locked.json': fixture('a') });
    chmodSync(join(dir, 'locked.json'), 0o000);
    expect(refusal(() => loadFakeSttFixtures(dir))).toMatch(
      /^fake STT fixture locked\.json: it could not be read \(.*\)\. Fail-closed\.$/,
    );
  });

  it('two files that answer the same session and track', () => {
    const dir = dirWith({
      'one.json': fixture('rec', 'mic'),
      'two.json': {
        session_id: 'rec',
        tracks: [
          { track: 'system', segments: [{ text: 'fine' }] },
          { track: 'mic', segments: [{ text: 'clash' }] },
        ],
      },
    });
    expect(refusal(() => loadFakeSttFixtures(dir))).toBe(
      'fake STT fixtures one.json and two.json both answer rec/mic. Fail-closed.',
    );
    const any = dirWith({ 'a.json': fixture('*'), 'b.json': fixture('*') });
    expect(refusal(() => loadFakeSttFixtures(any))).toBe(
      'fake STT fixtures a.json and b.json both answer */mic. Fail-closed.',
    );
  });

  it('accepts the same track under different sessions, and a named session beside any-session', () => {
    const dir = dirWith({
      'any.json': fixture('*'),
      'one.json': fixture('rec-1'),
      'two.json': fixture('rec-2'),
    });
    expect(loadFakeSttFixtures(dir).files).toEqual(['any.json', 'one.json', 'two.json']);
  });
});
