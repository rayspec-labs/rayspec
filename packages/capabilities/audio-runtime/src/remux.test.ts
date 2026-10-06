/**
 * `remuxChunks` — REAL ffmpeg proofs (the concat-demuxer stitch + the structural ffprobe sanity).
 * Generates a few self-contained Ogg-Opus chunks with ffmpeg (each its own OpusHead — the real
 * per-chunk shape), stitches them, and asserts ONE stream + a finite non-zero duration. Fail-closed
 * proofs: an empty list, a garbage chunk, a chunk that is not Ogg (text, a concat script, another
 * container) and a chunk ffmpeg cannot open all throw RemuxError.
 *
 * Skips when ffmpeg/ffprobe (with libopus) is unavailable, but HARD-FAILS a required run
 * (RAYSPEC_REQUIRE_MEDIA_TESTS) that lost ffmpeg — the un-skippable ran-guard.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RemuxError, remuxChunks, remuxTimeoutMs } from './remux.js';

/** Generate a short sine tone into `dir/name` with the given codec and container arguments; null if ffmpeg cannot. */
function makeChunk(
  dir: string,
  name: string,
  encode: readonly string[],
  frequency = 330,
): Uint8Array | null {
  const out = join(dir, name);
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
      `sine=frequency=${frequency}:duration=0.3`,
      ...encode,
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

/** Generate ONE self-contained Ogg-Opus chunk (a short sine tone) via ffmpeg; null if it cannot. */
function makeOpusChunk(dir: string, i: number): Uint8Array | null {
  return makeChunk(dir, `gen_${i}.opus`, ['-c:a', 'libopus', '-f', 'ogg'], 330 + i * 110);
}

/** Bytes that pass for an Ogg chunk up to the point ffmpeg reads them, for the stubbed-ffmpeg tests. */
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]);

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

  // ffmpeg's concat demuxer logs "Impossible to open" for a file it cannot read, ends the input
  // there and exits 0. Each case below was a stitched file that passed both structural checks.
  it('refuses a chunk of plain text behind a good one instead of returning the first chunk alone', async () => {
    const text = new TextEncoder().encode('this chunk is a text file, not a recording\n'.repeat(8));
    const refused = remuxChunks([chunks[0] as Uint8Array, text]);
    await expect(refused).rejects.toBeInstanceOf(RemuxError);
    await expect(refused).rejects.toThrow(/chunk 1 .*not an Ogg stream/);
  });

  it('refuses a chunk that is a concat script, which ffmpeg would follow', async () => {
    // Three lines naming chunk 0 again: followed, the result is four chunks long from two uploads.
    const script = new TextEncoder().encode(
      "ffconcat version 1.0\nfile 'chunk_0.opus'\nfile 'chunk_0.opus'\nfile 'chunk_0.opus'\n",
    );
    const refused = remuxChunks([chunks[0] as Uint8Array, script]);
    await expect(refused).rejects.toBeInstanceOf(RemuxError);
    await expect(refused).rejects.toThrow(/chunk 1 .*not an Ogg stream/);
  });

  it('refuses a chunk in another container (Matroska)', async () => {
    const matroska = makeChunk(genDir, 'other.mkv', ['-c:a', 'libopus', '-f', 'matroska']);
    expect(matroska).not.toBeNull();
    await expect(remuxChunks([chunks[0] as Uint8Array, matroska as Uint8Array])).rejects.toThrow(
      /chunk 1 .*not an Ogg stream/,
    );
  });

  it('refuses a chunk shorter than the Ogg capture pattern, an empty one included', async () => {
    for (const short of [new Uint8Array(0), new Uint8Array([0x4f, 0x67, 0x67])]) {
      await expect(remuxChunks([chunks[0] as Uint8Array, short])).rejects.toThrow(
        /chunk 1 .*not an Ogg stream/,
      );
    }
  });

  it('refuses a chunk that starts like Ogg but is no stream ffmpeg can open', async () => {
    // The capture pattern and then bytes that are no Ogg page: only ffmpeg can tell.
    const junk = new Uint8Array(4000).fill(0x5a);
    junk.set([0x4f, 0x67, 0x67, 0x53]);
    const refused = remuxChunks([chunks[0] as Uint8Array, junk, chunks[1] as Uint8Array]);
    await expect(refused).rejects.toBeInstanceOf(RemuxError);
    await expect(refused).rejects.toThrow(/ffmpeg/);
  });

  it('refuses a chunk cut off inside its headers, which ffmpeg skips with exit 0', async () => {
    // The first Ogg page alone (the OpusHead page, 47 bytes): a stream with no comment header.
    const first = chunks[1] as Uint8Array;
    const headOnly = first.slice(0, 47);
    const refused = remuxChunks([chunks[0] as Uint8Array, headOnly, chunks[2] as Uint8Array]);
    await expect(refused).rejects.toBeInstanceOf(RemuxError);
  });
});

/**
 * The command line the stitch runs, read back from a stub that records its arguments. The input is
 * probed from uploaded bytes, so the demuxers and protocols ffmpeg may use are named on it, and an
 * error ends the run instead of being logged and skipped. Needs no real ffmpeg.
 */
describe('remuxChunks — the ffmpeg command line', () => {
  const savedBin = process.env.RAYSPEC_FFMPEG_BIN;
  const stubDir = mkdtempSync(join(tmpdir(), 'remux-args-'));

  afterEach(() => {
    if (savedBin === undefined) delete process.env.RAYSPEC_FFMPEG_BIN;
    else process.env.RAYSPEC_FFMPEG_BIN = savedBin;
  });
  afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

  it('restricts the input formats and protocols and stops on the first error', async () => {
    const stub = join(stubDir, 'ffmpeg-args.sh');
    const record = join(stubDir, 'args.txt');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nexit 1\n`);
    chmodSync(stub, 0o755);
    process.env.RAYSPEC_FFMPEG_BIN = stub;

    await expect(remuxChunks([OGG_BYTES])).rejects.toThrow(/ffmpeg exited 1/);
    const args = readFileSync(record, 'utf8').trimEnd().split('\n');
    const input = args.indexOf('-i');
    expect(input).toBeGreaterThan(0);
    // Input options only take effect in front of the input they belong to.
    const before = args.slice(0, input);
    expect(before).toContain('-xerror');
    expect(before[before.indexOf('-format_whitelist') + 1]).toBe('concat,ogg');
    expect(before[before.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(before[before.indexOf('-f') + 1]).toBe('concat');
    expect(args.slice(input + 2, input + 4)).toEqual(['-c', 'copy']);
  });

  it('refuses a run in which ffmpeg could not open a chunk, even when it exits 0', async () => {
    const stub = join(stubDir, 'ffmpeg-skip.sh');
    // What ffmpeg does for a chunk that ends inside its headers: one line on stderr, exit 0, and
    // an output file holding the chunks before it.
    writeFileSync(
      stub,
      `#!/bin/sh\nfor last; do :; done\nprintf 'OggS-partial' > "$last"\n` +
        `echo "[in#0/concat @ 0x1] Impossible to open 'chunk_1.opus'" >&2\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
    process.env.RAYSPEC_FFMPEG_BIN = stub;

    const refused = remuxChunks([OGG_BYTES, OGG_BYTES]);
    await expect(refused).rejects.toBeInstanceOf(RemuxError);
    await expect(refused).rejects.toThrow(/could not open a chunk/);
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
    await expect(remuxChunks([OGG_BYTES])).rejects.toBeInstanceOf(RemuxError);
    // The reject must arrive shortly after the 400ms timeout — proving the guard fired, not the 30s sleep.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);
});

/**
 * The RAYSPEC_FFMPEG_TIMEOUT_MS parsing contract, as `.env.example` states it: a 120000 default, and
 * an unusable value uses that default rather than a cap of its own. "Unusable" includes both ends a
 * timer cannot hold — a value that floors below 1, and one above 2147483647.
 */
describe('remuxTimeoutMs (RAYSPEC_FFMPEG_TIMEOUT_MS)', () => {
  const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

  it('is 120000 when the variable is unset', () => {
    expect(remuxTimeoutMs(env({}))).toBe(120_000);
  });

  it('reads a usable value back as itself', () => {
    expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: '30000' }))).toBe(30_000);
  });

  // Deliberately NOT named for the resolver's `.trim()`, which nothing here can pin: `Number()`
  // already ignores surrounding whitespace, and a whitespace-only value reaches the default down
  // either path (trimmed it is falsy; untrimmed `Number('   ')` is 0, which `n <= 0` rejects).
  // Deleting `.trim()` reds no case in this file, so a case named for it would be claiming a guard it
  // does not have. The call stays for parity with `positiveInt`, whose contract this resolver mirrors.
  it('reads a whitespace-padded value back as the number it pads', () => {
    expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: ' 250 ' }))).toBe(250);
  });

  it('floors a fractional value, so the cap the timer gets is the one the refusal names', () => {
    expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: '1500.9' }))).toBe(1_500);
  });

  it('uses the default for an empty, non-numeric, zero, sub-1 or negative value', () => {
    for (const v of ['', '   ', 'banana', '10s', 'NaN', 'Infinity', '0', '0.5', '0.001', '-1']) {
      expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: v }))).toBe(120_000);
    }
  });

  it('never resolves above 2147483647 — a larger value is unusable, not a longer cap', () => {
    // 2147483647 is the largest delay a timer can hold; a larger one fires after 1ms instead of
    // waiting, so accepting it would turn a deliberately generous cap into the shortest one there is.
    // Out of range therefore falls back to the default, exactly like a value that is not a number.
    expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: '2147483647' }))).toBe(2_147_483_647);
    for (const v of ['2147483648', '3000000000', '1e12']) {
      expect(remuxTimeoutMs(env({ RAYSPEC_FFMPEG_TIMEOUT_MS: v }))).toBe(120_000);
    }
  });

  it('reads process.env when no environment is passed', () => {
    const saved = process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
    try {
      delete process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
      expect(remuxTimeoutMs()).toBe(120_000);
      process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = '4321';
      expect(remuxTimeoutMs()).toBe(4_321);
    } finally {
      if (saved === undefined) delete process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
      else process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = saved;
    }
  });
});

/**
 * The same contract through the REAL child path, which is where an out-of-range cap used to do its
 * damage: the resolved number goes straight into `setTimeout`, so a value above 2147483647 fired
 * after 1ms and SIGKILLed a healthy ffmpeg while reporting a timeout that had never applied. Points
 * RAYSPEC_FFMPEG_BIN at a stub that outlives any plausible timer test but not the 120000 default, so
 * both arms are expected to end on the CHILD's own exit; needs no real ffmpeg (the stub is `/bin/sh`).
 */
describe('remuxChunks — an out-of-range RAYSPEC_FFMPEG_TIMEOUT_MS does not invert the cap', () => {
  const savedBin = process.env.RAYSPEC_FFMPEG_BIN;
  const savedTimeout = process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
  const stubDir = mkdtempSync(join(tmpdir(), 'remux-overflow-'));

  afterEach(() => {
    if (savedBin === undefined) delete process.env.RAYSPEC_FFMPEG_BIN;
    else process.env.RAYSPEC_FFMPEG_BIN = savedBin;
    if (savedTimeout === undefined) delete process.env.RAYSPEC_FFMPEG_TIMEOUT_MS;
    else process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = savedTimeout;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('one millisecond either side of the timer ceiling behaves the same way', async () => {
    const stub = join(stubDir, 'ffmpeg-slow.sh');
    // Ignore every arg, work for ~2s, then fail: long enough that a 1ms timer wins the race by a
    // wide margin, short enough that the 120000 default cannot.
    writeFileSync(stub, '#!/bin/sh\nsleep 2\nexit 1\n');
    chmodSync(stub, 0o755);
    process.env.RAYSPEC_FFMPEG_BIN = stub;

    const arms: { value: string; elapsedMs: number; message: string }[] = [];
    for (const value of ['2147483647', '2147483648']) {
      process.env.RAYSPEC_FFMPEG_TIMEOUT_MS = value;
      const start = Date.now();
      let message = '(resolved — the stub was supposed to fail)';
      try {
        await remuxChunks([OGG_BYTES]);
      } catch (err) {
        message = (err as Error).message;
      }
      arms.push({ value, elapsedMs: Date.now() - start, message });
    }

    // Both arms ran: without this the per-arm loop below asserts nothing if `arms` is ever empty,
    // and the final equality would compare undefined to undefined.
    expect(arms).toHaveLength(2);
    for (const arm of arms) {
      // The child's own non-zero exit, after the child's own ~2s — not a kill in single-digit ms.
      expect(`${arm.value}: ${arm.message}`).toContain('ffmpeg exited 1');
      expect(`${arm.value}: ${arm.message}`).not.toContain('exceeded the');
      expect(arm.elapsedMs).toBeGreaterThan(1_000);
    }
    // Same way, not merely each acceptable on its own: the two caps are indistinguishable.
    expect(arms[1]?.message).toBe(arms[0]?.message);
  }, 20_000);
});
