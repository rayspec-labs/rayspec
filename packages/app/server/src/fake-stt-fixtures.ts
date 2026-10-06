/**
 * The fixture directory of the fake speech-to-text adapter (`RAYSPEC_STT_FAKE_FIXTURES`), read once
 * at boot. Every entry directly in the directory whose name ends in `.json` and that is a regular
 * file, or a symbolic link to a regular file inside the directory, is one session fixture
 * (`parseFakeSttFixture` in `@rayspec/stt-port` states the format). Other files, subdirectories
 * and links that lead anywhere else are ignored. Files load in the order of their names.
 *
 * Nothing here runs at request time and no path is ever built from a session or track id: the
 * adapter compares a recording's ids with the ids the loaded fixtures declare. A directory that
 * cannot be read, holds no fixture, holds a malformed one, or holds two that answer the same
 * session and track is refused here, at boot, rather than at the first recording.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import {
  FakeSttFixtureError,
  parseFakeSttFixture,
  type SttDualTrackFixture,
} from '@rayspec/stt-port';

/** The environment variable that names the directory. */
const VARIABLE = 'RAYSPEC_STT_FAKE_FIXTURES';

/** The largest fixture file that loads, in bytes. A transcript fixture is a few kilobytes. */
export const FAKE_STT_FIXTURE_MAX_BYTES = 1024 * 1024;

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
  const files: string[] = [];
  let skippedLinks = 0;
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    const realRoot = realpathSync(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (entry.isFile()) {
        files.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        // A mounted volume lays its files out as links into a data directory beside them, so a
        // link is followed — but only to a regular file whose real path is inside the directory.
        if (linksToFileInside(realRoot, join(root, entry.name))) files.push(entry.name);
        else skippedLinks += 1;
      }
    }
    files.sort();
  } catch {
    throw new FakeSttFixturesError(
      `${VARIABLE} '${dir}' is not a readable directory. Fail-closed.`,
    );
  }
  if (files.length === 0) {
    const links =
      skippedLinks === 0
        ? ''
        : skippedLinks === 1
          ? ' (1 symbolic link that does not lead to a file inside the directory was skipped)'
          : ` (${skippedLinks} symbolic links that do not lead to a file inside the directory were skipped)`;
    throw new FakeSttFixturesError(
      `${VARIABLE} '${dir}' holds no .json fixture file${links}. Fail-closed.`,
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

/** Whether the symbolic link at `path` leads to a regular file inside `realRoot`. */
function linksToFileInside(realRoot: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    return real.startsWith(realRoot + sep) && statSync(real).isFile();
  } catch {
    // A link that leads nowhere.
    return false;
  }
}

/** One fixture file, parsed and checked. */
function readFixture(root: string, file: string): SttDualTrackFixture {
  let text: string;
  try {
    if (statSync(join(root, file)).size > FAKE_STT_FIXTURE_MAX_BYTES) {
      throw new FakeSttFixturesError(
        `fake STT fixture ${file}: it is larger than ${FAKE_STT_FIXTURE_MAX_BYTES} bytes. ` +
          'Fail-closed.',
      );
    }
    text = readFileSync(join(root, file), 'utf8');
  } catch (e) {
    if (e instanceof FakeSttFixturesError) throw e;
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
