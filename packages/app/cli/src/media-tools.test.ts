/**
 * The media-tools warning: which hosts earn it, and that `bundle verify` and the dry-run of a
 * bundle deploy write it to stderr without touching the envelope.
 *
 *  - the lookup: a tool is present as an executable file in a directory of PATH, or at the path its
 *    override names; a directory of that name, a file without the execute bit, a blank PATH and an
 *    override that names nothing are all absent, and an override is not rescued by PATH;
 *  - the notice: none for a bundle that requires no audio capability, however bare the host; none
 *    when both tools are present; one line naming the capabilities and each missing tool otherwise;
 *  - `bundle verify` of a product that requires audio_input and media_playback: the line on stderr
 *    with and without `--json` when a tool is missing, no line when both are present, and the same
 *    envelope and exit code either way; a backend bundle never gets it;
 *  - `deploy --dry-run` of the same bundle writes the line even though the plan is then refused for
 *    a database nothing listens on, and a deploy without `--dry-run` does not write it.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backendSpec,
  EXAMPLES,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { runBundle } from './bundle.js';
import { main } from './index.js';
import { mediaToolNotices, missingMediaTools } from './media-tools.js';
import { runPack } from './pack.js';
import { CLI_DIST, CLI_VERSION, captureOutput, type ParsedJson } from './test-support/bundles.js';

const NOTICE = /^warning: media tools missing — /;

/** A directory holding an executable file for each of `tools`. */
function toolDirectory(tools: readonly string[]): string {
  const dir = temporaryDirectory('media-tools-');
  for (const tool of tools) {
    const file = join(dir, tool);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

let audioBundle = '';
let backendBundle = '';
let bothTools = '';
let noTools = '';

beforeAll(async () => {
  const work = temporaryDirectory('media-tools-bundles-');
  const pack = async (args: string[]) => {
    const packed = await runPack(args, { operationId: randomUUID(), cliVersion: CLI_VERSION });
    if (!packed.envelope.ok) throw new Error(JSON.stringify(packed.envelope.errors));
  };
  // The example product requires audio_input and media_playback.
  audioBundle = join(work, 'audio.ray');
  await pack([
    '--spec',
    join(EXAMPLES, 'acme-notes', 'acme-notes.product.yaml'),
    '--output',
    audioBundle,
    '--id',
    'acme-notes',
    '--version',
    '1.0.0',
  ]);
  const app = temporaryDirectory('media-tools-app-');
  writeTree(app, {
    'rayspec.yaml': backendSpec(
      'stores:\n  - name: probe_notes\n    columns:\n      - { name: body, type: text }\n',
    ),
  });
  backendBundle = join(work, 'backend.ray');
  await pack(['--spec', join(app, 'rayspec.yaml'), '--output', backendBundle]);
  bothTools = toolDirectory(['ffmpeg', 'ffprobe']);
  noTools = temporaryDirectory('media-tools-empty-');
}, 60_000);

afterAll(removeTemporaryDirectories);

describe('the lookup', () => {
  it('finds a tool as an executable file in a directory of PATH', () => {
    expect(missingMediaTools({ PATH: `${noTools}:${bothTools}` })).toEqual([]);
    expect(missingMediaTools({ PATH: toolDirectory(['ffmpeg']) })).toEqual([
      { tool: 'ffprobe', command: 'ffprobe', from: null },
    ]);
  });

  it('counts a directory of that name, a file without the execute bit and no PATH as absent', () => {
    const dir = temporaryDirectory('media-tools-odd-');
    mkdirSync(join(dir, 'ffmpeg'));
    writeFileSync(join(dir, 'ffprobe'), '#!/bin/sh\n', { mode: 0o644 });
    const both = [
      { tool: 'ffmpeg', command: 'ffmpeg', from: null },
      { tool: 'ffprobe', command: 'ffprobe', from: null },
    ];
    expect(missingMediaTools({ PATH: dir })).toEqual(both);
    expect(missingMediaTools({})).toEqual(both);
    expect(missingMediaTools({ PATH: '' })).toEqual(both);
  });

  it('takes an override as the command, trimmed, and does not fall back to PATH for it', () => {
    const elsewhere = toolDirectory(['my-ffmpeg', 'my-ffprobe']);
    expect(
      missingMediaTools({
        PATH: noTools,
        RAYSPEC_FFMPEG_BIN: ` ${join(elsewhere, 'my-ffmpeg')} `,
        RAYSPEC_FFPROBE_BIN: join(elsewhere, 'my-ffprobe'),
      }),
    ).toEqual([]);
    // A bare name in the override is looked up on PATH, as a spawn would.
    expect(missingMediaTools({ PATH: elsewhere, RAYSPEC_FFMPEG_BIN: 'my-ffmpeg' })).toEqual([
      { tool: 'ffprobe', command: 'ffprobe', from: null },
    ]);
    const gone = join(elsewhere, 'gone');
    expect(missingMediaTools({ PATH: bothTools, RAYSPEC_FFMPEG_BIN: gone })).toEqual([
      { tool: 'ffmpeg', command: gone, from: 'RAYSPEC_FFMPEG_BIN' },
    ]);
    // A blank override is no override.
    expect(missingMediaTools({ PATH: bothTools, RAYSPEC_FFPROBE_BIN: '  ' })).toEqual([]);
  });
});

describe('the notice', () => {
  it('is not written for a bundle that requires no audio capability', () => {
    expect(mediaToolNotices([], { PATH: noTools })).toEqual([]);
    expect(mediaToolNotices(['durable-workflow', 'file_input'], {})).toEqual([]);
  });

  it('is not written when both tools are present', () => {
    expect(mediaToolNotices(['audio_input', 'media_playback'], { PATH: bothTools })).toEqual([]);
  });

  it('names the capabilities, each missing tool and the way out', () => {
    const [line, ...rest] = mediaToolNotices(['audio_input', 'durable-workflow'], {
      PATH: toolDirectory(['ffmpeg']),
    });
    expect(rest).toEqual([]);
    expect(line).toMatch(NOTICE);
    expect(line).toContain('the bundle requires audio_input, and on this host');
    expect(line).toContain('ffprobe is not on PATH');
    expect(line).not.toContain('ffmpeg is not on PATH');
    expect(line).toContain('RAYSPEC_FFMPEG_BIN and RAYSPEC_FFPROBE_BIN');
    expect(line).toContain('fails closed');

    const [both] = mediaToolNotices(['media_playback', 'audio_input'], {
      PATH: noTools,
      RAYSPEC_FFPROBE_BIN: '/nowhere/ffprobe',
    });
    expect(both).toContain('the bundle requires audio_input and media_playback');
    expect(both).toContain(
      'ffmpeg is not on PATH and RAYSPEC_FFPROBE_BIN names /nowhere/ffprobe, which is not an ' +
        'executable file',
    );
  });
});

describe('bundle verify', () => {
  const verify = (file: string, env: NodeJS.ProcessEnv) =>
    runBundle(['verify', file], { operationId: randomUUID(), cliVersion: CLI_VERSION, env });

  it('warns for an audio bundle on a host without the tools, and leaves the envelope alone', async () => {
    const absent = await verify(audioBundle, { PATH: noTools });
    const present = await verify(audioBundle, { PATH: bothTools });
    expect(absent.notices).toHaveLength(1);
    expect(absent.notices?.[0]).toMatch(NOTICE);
    expect(absent.notices?.[0]).toContain('audio_input and media_playback');
    expect(present.notices).toEqual([]);
    for (const outcome of [absent, present]) {
      expect(outcome.envelope.ok).toBe(true);
      expect(outcome.envelope.warnings.map((w) => w.code)).toEqual(['RAY_W_UNSIGNED']);
    }
    expect({ ...absent.envelope, operationId: '' }).toEqual({
      ...present.envelope,
      operationId: '',
    });
  });

  it('does not warn for a bundle that requires no audio capability', async () => {
    expect((await verify(backendBundle, { PATH: noTools })).notices).toEqual([]);
  });

  it('warns for a bundle it refuses too', async () => {
    const refused = await runBundle(['verify', audioBundle, '--require-signature'], {
      operationId: randomUUID(),
      cliVersion: CLI_VERSION,
      env: { PATH: noTools },
    });
    expect(refused.envelope.ok).toBe(false);
    expect(refused.notices?.[0]).toMatch(NOTICE);
  });

  describe('through the command line', () => {
    let io = captureOutput();
    const path = process.env.PATH;
    beforeEach(() => {
      io = captureOutput();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      process.env.PATH = path;
    });

    it('writes the line to stderr with and without --json, and exits 0', async () => {
      process.env.PATH = noTools;
      expect(await main(['bundle', 'verify', audioBundle, '--json'])).toBe(0);
      const envelope = JSON.parse(io.out()) as ParsedJson;
      const lines = io.err().trimEnd().split('\n');
      expect(lines[0]).toBe(`operationId: ${envelope.operationId}`);
      expect(lines.slice(1)).toHaveLength(1);
      expect(lines[1]).toMatch(NOTICE);
      expect(JSON.stringify(envelope)).not.toContain('media tools');

      io = captureOutput();
      expect(await main(['bundle', 'verify', audioBundle])).toBe(0);
      expect(
        io
          .err()
          .split('\n')
          .filter((l) => NOTICE.test(l)),
      ).toHaveLength(1);
      expect(io.err()).toContain('verdict: deployable');
    });

    it('writes no line when both tools are on PATH', async () => {
      process.env.PATH = bothTools;
      expect(await main(['bundle', 'verify', audioBundle, '--json'])).toBe(0);
      const envelope = JSON.parse(io.out()) as ParsedJson;
      expect(io.err()).toBe(`operationId: ${envelope.operationId}\n`);
    });
  });
});

const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}

(distBuilt ? describe : describe.skip)('deploy of a bundle', () => {
  /** A database nothing listens on: the plan is refused once the bundle has been read. */
  const NO_DATABASE = 'postgresql://nobody:nothing@127.0.0.1:1/none';
  const deploy = (args: string[], path: string) =>
    spawnSync(process.execPath, [CLI_DIST, 'deploy', ...args], {
      cwd: temporaryDirectory('media-tools-deploy-'),
      encoding: 'utf8',
      env: {
        PATH: path,
        HOME: process.env.HOME ?? '',
        DATABASE_URL: NO_DATABASE,
        RAYSPEC_API_KEY_PEPPER: 'pepper-for-the-media-tools-suite',
      },
    });

  it('a dry-run warns on a host without the tools, with and without --json', () => {
    for (const extra of [[], ['--json']]) {
      const run = deploy([audioBundle, '--dry-run', ...extra], noTools);
      const envelope = JSON.parse(run.stdout) as ParsedJson;
      expect(envelope.operation).toBe('deploy.dry-run');
      expect(envelope.errors[0].code).toBe('RAY_INFRA_UNAVAILABLE');
      expect(run.stderr.split('\n').filter((l) => NOTICE.test(l))).toHaveLength(1);
      expect(run.stdout).not.toContain('media tools');
    }
  });

  it('a dry-run does not warn when both tools are present, or for a backend bundle', () => {
    expect(deploy([audioBundle, '--dry-run'], bothTools).stderr).not.toContain('media tools');
    expect(deploy([backendBundle, '--dry-run'], noTools).stderr).not.toContain('media tools');
  });

  it('a deploy without --dry-run is as it was: no line, the same refusal', () => {
    const run = deploy([audioBundle], noTools);
    expect(run.stderr).not.toContain('media tools');
    expect((JSON.parse(run.stdout) as ParsedJson).ok).toBe(false);
  });
});
