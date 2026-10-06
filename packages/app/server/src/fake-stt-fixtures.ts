/**
 * The fixture directory of the fake speech-to-text adapter (`RAYSPEC_STT_FAKE_FIXTURES`), read once
 * at boot. Every regular file directly in the directory whose name ends in `.json` is one session
 * fixture (`parseFakeSttFixture` in `@rayspec/stt-port` states the format); other files,
 * subdirectories and symbolic links are ignored. Files load in the order of their names.
 *
 * Nothing here runs at request time and no path is ever built from a session or track id: the
 * adapter compares a recording's ids with the ids the loaded fixtures declare. A directory that
 * cannot be read, holds no fixture, holds a malformed one, or holds two that answer the same
 * session and track is refused here, at boot, rather than at the first recording.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  FakeSttFixtureError,
  parseFakeSttFixture,
  type SttDualTrackFixture,
} from '@rayspec/stt-port';

/** The environment variable that names the directory. */
const VARIABLE = 'RAYSPEC_STT_FAKE_FIXTURES';

/** Why a fixture directory is refused. The boot reports `message` as its own refusal. */
export class FakeSttFixturesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeSttFixturesError';
  }
}

/** What a fixture directory holds: the fixtures, and the file each came from, in load order. */
export interface LoadedFakeSttFixtures {
  readonly fixtures: SttDualTrackFixture[];
  readonly files: string[];
}

/**
 * Load every fixture file of `dir` (resolved against the working directory). Fail-closed: any
 * defect throws a `FakeSttFixturesError` naming the directory or the file.
 */
export function loadFakeSttFixtures(dir: string): LoadedFakeSttFixtures {
  const root = resolvePath(dir);
  let files: string[];
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    // `isFile()` on a directory entry is false for a symbolic link, so a link is never followed
    // out of the directory.
    files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new FakeSttFixturesError(
      `${VARIABLE} '${dir}' is not a readable directory. Fail-closed.`,
    );
  }
  if (files.length === 0) {
    throw new FakeSttFixturesError(
      `${VARIABLE} '${dir}' holds no .json fixture file. Fail-closed.`,
    );
  }

  const fixtures: SttDualTrackFixture[] = [];
  /** `<session_id>/<track>` → the file that answers it. */
  const answeredBy = new Map<string, string>();
  for (const file of files) {
    const fixture = readFixture(root, file);
    for (const track of fixture.tracks) {
      const key = `${fixture.session_id}/${track.track}`;
      const earlier = answeredBy.get(key);
      if (earlier !== undefined) {
        throw new FakeSttFixturesError(
          `fake STT fixtures ${earlier} and ${file} both answer ${key}. Fail-closed.`,
        );
      }
      answeredBy.set(key, file);
    }
    fixtures.push(fixture);
  }
  return { fixtures, files };
}

/** One fixture file, parsed and checked. */
function readFixture(root: string, file: string): SttDualTrackFixture {
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch (e) {
    throw new FakeSttFixturesError(
      `fake STT fixture ${file}: it could not be read (${
        e instanceof Error ? e.message : String(e)
      }). Fail-closed.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FakeSttFixturesError(`fake STT fixture ${file}: it is not valid JSON. Fail-closed.`);
  }
  try {
    return parseFakeSttFixture(value, file);
  } catch (e) {
    if (e instanceof FakeSttFixtureError) {
      throw new FakeSttFixturesError(`${e.message}. Fail-closed.`);
    }
    throw e;
  }
}
