/**
 * Ogg-Opus chunk REMUX. The canonical repo copy of the Ogg-Opus remux (NOT imported from any product
 * pack — the no-pack invariant is about imports). Stitches a track's per-chunk Ogg-Opus files into ONE
 * continuous, seekable Opus file the playback stream can serve.
 *
 * THE DE-RISKED PATH (the invariant): the per-chunk Ogg-Opus files (each a SELF-CONTAINED stream,
 * OpusHead per chunk — the Tauri-client / fresh-encoder-per-chunk shape) are concatenated with
 * ffmpeg's concat DEMUXER under `-c copy` (NO re-encode/decode; packet count preserved):
 *
 *   ffmpeg -nostdin -f concat -safe 0 -i list.txt -c copy out.opus
 *
 * The concat DEMUXER produces ONE OpusHead + ONE stream + the WHOLE timeline — UNLIKE the concat
 * PROTOCOL / a naive byte-append, which carry every chunk's OpusHead and yield a multi-OpusHead
 * container Deepgram/players choke on. The list MUST be in EXACT index order — a gap/reorder corrupts
 * the granulepos timeline.
 *
 * FAIL-CLOSED LOUDLY on a non-zero ffmpeg exit (a missing/failed ffmpeg must NEVER produce a
 * truncated/partial stream downstream would mistake for a complete recording). After the remux a
 * RUNTIME ffprobe assertion verifies the output is STRUCTURALLY SOUND: exactly ONE audio stream
 * (`nb_streams == 1` — not the multi-OpusHead chained NO-GO, not a dropped stream) and a FINITE,
 * NON-ZERO duration (the concat did not collapse the timeline). Both throw `RemuxError`. ffmpeg/
 * ffprobe run via `node:child_process` — the sanctioned trusted-author runtime side-channel
 * (before the external-exposure hardening; the real confinement is the per-tenant sandbox isolate).
 *
 * ⚠ WHY THE REMUX ALONE CANNOT CATCH A SHORT *INPUT* (honest, empirically validated): a byte-truncated
 * Ogg-Opus chunk is still INTERNALLY VALID (Ogg is page-structured), so ffprobe reports the chunk's
 * own shorter duration with NO error and the concat faithfully copies those pages — the remux has no
 * independent notion of "how long the recording SHOULD be". The independent full-length expectation
 * is the caller's byte-count cross-check against the track's `committed_byte_len` watermark; this
 * module's assertion is the STRUCTURAL half (one stream, sane timeline).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The ffmpeg binary (overridable for a non-PATH install; defaults to `ffmpeg` on PATH). Read at CALL
 * time so a deployment/test can set the env after module load. */
function ffmpegBin(): string {
  return process.env.RAYSPEC_FFMPEG_BIN?.trim() || 'ffmpeg';
}

/** The ffprobe binary (overridable; defaults to `ffprobe` on PATH). Used for the remux sanity assertion. */
function ffprobeBin(): string {
  return process.env.RAYSPEC_FFPROBE_BIN?.trim() || 'ffprobe';
}

/**
 * The bounded wall-clock cap (ms) for a single ffmpeg/ffprobe child (MP-3). A HANGING ffmpeg/ffprobe
 * (e.g. a wedged decode, a stuck pipe) would otherwise stall the durable STT node INDEFINITELY —
 * violating never-poison-the-run. On timeout the child is SIGKILLed and the run turns into a fail-closed
 * `RemuxError` (the media-prep caller's fail-soft path), never an indefinite stall. `-c copy` is a cheap
 * container rewrite, so 120s is generous even for a long recording; overridable via `RAYSPEC_FFMPEG_TIMEOUT_MS`.
 */
function remuxTimeoutMs(): number {
  const raw = Number(process.env.RAYSPEC_FFMPEG_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/** A remux failure (ffmpeg missing, a non-zero exit, no chunks) — fail-closed, never a partial result. */
export class RemuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemuxError';
  }
}

/** The result of a remux: the stitched Opus bytes + the temp path + the ffprobe-measured duration. */
export interface RemuxResult {
  /** The stitched single-stream Ogg-Opus bytes (ffprobe-asserted: one stream, finite non-zero duration). */
  readonly bytes: Uint8Array;
  /** The on-disk path of the stitched file (in a temp dir the caller must clean via `cleanup`). */
  readonly outPath: string;
  /** The ffprobe-measured output duration in seconds (finite, > 0 — asserted before return). */
  readonly durationS: number;
  /** Remove the temp working dir (call in a finally). */
  cleanup(): Promise<void>;
}

/**
 * Remux an ORDERED list of Ogg-Opus chunk byte arrays (index 0..N-1) into ONE continuous Opus file via
 * the concat DEMUXER + `-c copy`. `chunks[i]` MUST be chunk i's bytes (the caller fetches them in exact
 * index order). Returns the stitched bytes + the temp out-path + the probed duration + a cleanup.
 * FAIL-CLOSED: an empty chunk list, a missing ffmpeg/ffprobe, or a non-zero ffmpeg exit throws `RemuxError`.
 */
export async function remuxChunks(chunks: readonly Uint8Array[]): Promise<RemuxResult> {
  if (chunks.length === 0) {
    throw new RemuxError('remux: no chunks to stitch (fail-closed).');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'remux-'));
  const cleanup = async (): Promise<void> => {
    await rm(workDir, { recursive: true, force: true });
  };

  try {
    // Write each chunk to `chunk_<i>.opus` in index order, build the concat list file. The list paths
    // are BASENAMES (relative to `-i list.txt`'s dir) — `-safe 0` permits arbitrary paths; we keep them
    // basenames in the work dir so no `..`/absolute path is in the list at all.
    const listLines: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const name = `chunk_${i}.opus`;
      await writeFile(join(workDir, name), Buffer.from(chunks[i] as Uint8Array));
      // The concat demuxer list syntax: `file '<path>'` per line, in EXACT order.
      listLines.push(`file '${name}'`);
    }
    const listPath = join(workDir, 'list.txt');
    await writeFile(listPath, `${listLines.join('\n')}\n`, 'utf8');

    const outPath = join(workDir, 'out.opus');
    await runFfmpeg([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      outPath,
    ]);

    const bytes = new Uint8Array(await readFile(outPath));
    if (bytes.length === 0) {
      throw new RemuxError('remux: ffmpeg produced an empty output (fail-closed).');
    }

    // RUNTIME ffprobe SANITY — STRUCTURAL: exactly one audio stream + a finite, non-zero duration.
    const { nbStreams } = await probeStreams(outPath);
    if (nbStreams !== 1) {
      throw new RemuxError(
        `remux: ffprobe found ${nbStreams} audio stream(s) in the remuxed output, expected exactly 1 ` +
          '(a multi-OpusHead chained stream or a dropped stream — fail-closed).',
      );
    }
    const durationS = await probeDurationS(outPath);
    if (!(durationS > 0)) {
      throw new RemuxError(
        `remux: ffprobe output duration is ${durationS}s (not finite / not > 0) — a collapsed timeline ` +
          '(fail-closed).',
      );
    }

    return { bytes, outPath, durationS, cleanup };
  } catch (err) {
    // On ANY failure, clean the temp dir before rethrowing (the caller never gets an outPath to clean).
    await cleanup();
    throw err;
  }
}

/** Spawn ffmpeg with `args`, resolving on exit 0, rejecting `RemuxError` on a non-zero exit / spawn error
 * / TIMEOUT. The timeout is an EXPLICIT timer (not spawn's `timeout` option, which waits on the stdio
 * streams to close — an orphaned child holding an inherited pipe can defeat it): on expiry we SIGKILL and
 * reject IMMEDIATELY, so a hung ffmpeg can never stall the durable run (MP-3). A `settled` guard prevents
 * a double-settle from a late close after the timeout fired. */
function runFfmpeg(args: readonly string[]): Promise<void> {
  const bin = ffmpegBin();
  const timeoutMs = remuxTimeoutMs();
  return new Promise<void>((resolveP, rejectP) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectP(
        new RemuxError(
          `remux: ffmpeg exceeded the ${timeoutMs}ms timeout (RAYSPEC_FFMPEG_TIMEOUT_MS) and was killed ` +
            '— a hung remux, fail-closed rather than stalling the run.',
        ),
      );
    }, timeoutMs);
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(
        new RemuxError(
          `remux: ffmpeg failed to start ('${bin}' — ${(err as { code?: string })?.code ?? err.message}). ` +
            'Is ffmpeg installed and on PATH? (fail-closed).',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveP();
        return;
      }
      rejectP(
        new RemuxError(
          `remux: ffmpeg exited ${code} (concat-demuxer -c copy). stderr: ${stderr.trim().slice(0, 500)} ` +
            '(fail-closed — refusing a truncated/partial stream).',
        ),
      );
    });
  });
}

/** Spawn ffprobe with `args`, resolving captured stdout on exit 0, rejecting `RemuxError` otherwise
 * (incl. a TIMEOUT: an explicit timer SIGKILLs a hung ffprobe and rejects immediately — see runFfmpeg). */
function runFfprobe(args: readonly string[]): Promise<string> {
  const bin = ffprobeBin();
  const timeoutMs = remuxTimeoutMs();
  return new Promise<string>((resolveP, rejectP) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectP(
        new RemuxError(
          `remux: ffprobe exceeded the ${timeoutMs}ms timeout (RAYSPEC_FFMPEG_TIMEOUT_MS) and was killed ` +
            '— a hung probe, fail-closed rather than stalling the run.',
        ),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 4000) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(
        new RemuxError(
          `remux: ffprobe failed to start ('${bin}' — ${(err as { code?: string })?.code ?? err.message}). ` +
            'Is ffprobe installed and on PATH? (fail-closed).',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveP(stdout);
        return;
      }
      rejectP(
        new RemuxError(
          `remux: ffprobe exited ${code}. stderr: ${stderr.trim().slice(0, 500)} (fail-closed).`,
        ),
      );
    });
  });
}

/** ffprobe a media file → its container duration in seconds. Fail-closed on an unparseable value. */
async function probeDurationS(path: string): Promise<number> {
  const out = await runFfprobe([
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const d = Number(out.trim());
  if (!Number.isFinite(d)) {
    throw new RemuxError(
      `remux: ffprobe returned an unparseable duration ('${out.trim()}') — fail-closed.`,
    );
  }
  return d;
}

/** ffprobe a media file → its audio stream codec + count (the remux-fidelity one-stream assertion). */
async function probeStreams(path: string): Promise<{ codec: string; nbStreams: number }> {
  const out = await runFfprobe([
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const codecs = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { codec: codecs[0] ?? '', nbStreams: codecs.length };
}
