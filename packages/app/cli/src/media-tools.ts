/**
 * Whether this host can run ffmpeg and ffprobe, asked when a bundle requires an audio capability.
 *
 * A product that declares `audio_input` or `media_playback` stitches a recording's Ogg-Opus chunks
 * with ffmpeg and checks the result with ffprobe (`@rayspec/audio-runtime`, remux.ts), once before
 * the recording is transcribed and once to make it playable. Both steps fail closed without the
 * tools: the deployment boots and serves, and then no recording transcribes or plays. `rayspec
 * bundle verify` and the dry-run of a bundle deploy therefore say so beforehand, on stderr.
 *
 * WHY A LINE ON STDERR. The result envelope's `warnings` take only the codes of the bundle
 * contract's vocabulary, which has none for a host tool, and the data of both verbs is closed. The
 * notice is written with or without `--json`, next to the operation id; the envelope, the verdict
 * and the exit code are what they are without it.
 *
 * WHAT IS LOOKED AT. The command the capability would start — `RAYSPEC_FFMPEG_BIN` and
 * `RAYSPEC_FFPROBE_BIN`, trimmed, or `ffmpeg` and `ffprobe` — resolved the way a spawn resolves it:
 * a command with a path separator is that file, any other is looked up in each directory of PATH.
 * It counts as present when it is a file this user may execute. Nothing is started: both verbs run
 * nothing, and a tool that is present but broken is found by the runtime image's own checks, not
 * here.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';

/** The bundle capability ids whose runtime starts ffmpeg and ffprobe. */
export const MEDIA_TOOL_CAPABILITIES = ['audio_input', 'media_playback'] as const;

/** The tools, each with the variable that names another executable for it. */
export const MEDIA_TOOLS = [
  { tool: 'ffmpeg', variable: 'RAYSPEC_FFMPEG_BIN' },
  { tool: 'ffprobe', variable: 'RAYSPEC_FFPROBE_BIN' },
] as const;

/** A tool this host cannot run, and where it was looked for. */
export interface MissingMediaTool {
  tool: (typeof MEDIA_TOOLS)[number]['tool'];
  /** The command the capability would start. */
  command: string;
  /** The variable that named the command, or null when it is the default looked up on PATH. */
  from: (typeof MEDIA_TOOLS)[number]['variable'] | null;
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolves(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes(sep)) return executableFile(command);
  return (env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && executableFile(join(dir, command)));
}

/** The media tools `env` cannot run, in the order of `MEDIA_TOOLS`. */
export function missingMediaTools(env: NodeJS.ProcessEnv): MissingMediaTool[] {
  const missing: MissingMediaTool[] = [];
  for (const { tool, variable } of MEDIA_TOOLS) {
    const named = env[variable]?.trim();
    const command = named || tool;
    if (!resolves(command, env)) missing.push({ tool, command, from: named ? variable : null });
  }
  return missing;
}

/**
 * The stderr lines for a bundle that requires `requires` on a host with `env`: none when it
 * requires no audio capability or both tools are present, otherwise one warning.
 */
export function mediaToolNotices(
  requires: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const needed = MEDIA_TOOL_CAPABILITIES.filter((id) => requires.includes(id));
  if (needed.length === 0) return [];
  const missing = missingMediaTools(env);
  if (missing.length === 0) return [];
  const where = missing
    .map((m) =>
      m.from === null
        ? `${m.tool} is not on PATH`
        : `${m.from} names ${m.command}, which is not an executable file`,
    )
    .join(' and ');
  return [
    `warning: media tools missing — the bundle requires ${needed.join(' and ')}, and on this host ` +
      `${where}. A deployment here starts and serves, but stitching a recording fails closed: it ` +
      'is neither transcribed nor made playable. Install ffmpeg (it brings ffprobe), or name the ' +
      `executables with ${MEDIA_TOOLS.map((t) => t.variable).join(' and ')}; the RaySpec runtime ` +
      'image carries both.',
  ];
}
