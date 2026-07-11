/**
 * `remuxChunks` — REAL ffmpeg proofs (the concat-demuxer stitch + the structural ffprobe sanity).
 * Generates a few self-contained Ogg-Opus chunks with ffmpeg (each its own OpusHead — the real
 * per-chunk shape), stitches them, and asserts ONE stream + a finite non-zero duration. Fail-closed
 * proofs: an empty list and a garbage chunk both throw RemuxError.
 *
 * Skips when ffmpeg/ffprobe (with libopus) is unavailable, but HARD-FAILS a required run
 * (RAYSPEC_REQUIRE_MEDIA_TESTS) that lost ffmpeg — the un-skippable ran-guard.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RemuxError, remuxChunks } from './remux.js';

/** Generate ONE self-contained Ogg-Opus chunk (a short sine tone) via ffmpeg; null if it cannot. */
function makeOpusChunk(dir: string, i: number): Uint8Array | null {
  const out = join(dir, `gen_${i}.opus`);
  const res = spawnSync(
    process.env.RAYSPEC_FFMPEG_BIN?.trim() || 'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${330 + i * 110}:duration=0.3`,
      '-c:a',
      'libopus',
      '-f',
      'ogg',
      '-y',
      out,
    ],
    { encoding: 'buffer' },
  );
  if (res.status !== 0) return null;
  try {
    return new Uint8Array(readFileSync(out));
  } catch {
    return null;
  }
}

const genDir = mkdtempSync(join(tmpdir(), 'remux-gen-'));
const chunks: Uint8Array[] = [];
for (let i = 0; i < 3; i += 1) {
  const c = makeOpusChunk(genDir, i);
  if (c) chunks.push(c);
}
const hasFfmpeg = chunks.length === 3;
const requireMedia = process.env.RAYSPEC_REQUIRE_MEDIA_TESTS === 'true';
if (requireMedia && !hasFfmpeg) {
  throw new Error(
    'remux.test: RAYSPEC_REQUIRE_MEDIA_TESTS is set but ffmpeg/libopus is unavailable — refusing to ' +
      'silently skip the real remux proof.',
  );
}

afterAll(() => rmSync(genDir, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)('remuxChunks (real ffmpeg)', () => {
  it('stitches self-contained Ogg-Opus chunks into ONE stream with a finite non-zero duration', async () => {
    const result = await remuxChunks(chunks);
    try {
      expect(result.bytes.length).toBeGreaterThan(0);
      expect(result.durationS).toBeGreaterThan(0);
      // The concat of 3 × ~0.3s tones is meaningfully longer than a single chunk (timeline preserved).
      expect(result.durationS).toBeGreaterThan(0.5);
    } finally {
      await result.cleanup();
    }
  });

  it('throws RemuxError on an empty chunk list (fail-closed)', async () => {
    await expect(remuxChunks([])).rejects.toBeInstanceOf(RemuxError);
  });

  it('throws RemuxError on a garbage (non-Opus) chunk (ffmpeg fails — never a partial stream)', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(remuxChunks([garbage])).rejects.toBeInstanceOf(RemuxError);
  });
});

/**
 * MP-3: a HANGING ffmpeg must NOT stall the run forever — the bounded timeout SIGKILLs it and surfaces a
 * fail-closed RemuxError. Points RAYSPEC_FFMPEG_BIN at a stub that ignores its args and sleeps 30s, with a
 * tiny RAYSPEC_FFMPEG_TIMEOUT_MS. Needs NO real ffmpeg (the stub is `/bin/sh`). RED-first: without the
 * timeout the stub sleeps 30s and this test blows its own 10s cap (an indefinite stall); with the timeout
 * the remux rejects in well under a second.
 */
describe('remuxChunks — ffmpeg hang timeout (MP-3)', () => {
  const savedBin = process.env.RAYSPEC_FFMPEG_BIN;
  const savedTimeout = process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
  const stubDir = mkdtempSync(join(tmpdir(), 'remux-hang-'));

  afterEach(() => {
    if (savedBin === undefined) delete process.env.RAYSPEC_FFMPEG_BIN;
    else process.env.RAYSPEC_FFMPEG_BIN = savedBin;
    if (savedTimeout === undefined) delete process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
    else process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = savedTimeout;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('a hung ffmpeg is killed at the timeout and surfaces a RemuxError (never an indefinite stall)', async () => {
    const stub = join(stubDir, 'ffmpeg-hang.sh');
    // Ignore every arg and just sleep far longer than the timeout — the hang the guard must break.
    // `exec sleep` replaces the shell (no orphaned grandchild holding the stderr pipe after the kill).
    writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(stub, 0o755);
    process.env.RAYSPEC_FFMPEG_BIN = stub;
    process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = '400';

    const start = Date.now();
    await expect(remuxChunks([new Uint8Array([1, 2, 3])])).rejects.toBeInstanceOf(RemuxError);
    // The reject must arrive shortly after the 400ms timeout — proving the guard fired, not the 30s sleep.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);
});
