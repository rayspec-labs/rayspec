/**
 * `runPgTool` feeds a tool its input on stdin. A tool that stops reading early and exits leaves the
 * write pending; it fails with EPIPE, which must reach the helper, never the process as an uncaught
 * exception. More than any pipe buffers (1 MiB) makes the pending write certain.
 */
import { describe, expect, it } from 'vitest';
import { runPgTool } from './pg-tools.js';

const URL_ = 'postgresql://user:secret@127.0.0.1:5432/db';
const INPUT = Buffer.alloc(1024 * 1024, 0x61);

describe('runPgTool', () => {
  it('resolves when the tool succeeds without reading all of its input', async () => {
    const run = await runPgTool('sh', URL_, ['-c', 'head -c 100 >/dev/null'], INPUT);
    expect(run.code).toBe(0);
  });

  it('reports a tool that fails without reading its input as failed', async () => {
    // Whether the broken pipe is seen before the exit is a race: either way the failure shows.
    const outcome = await runPgTool('sh', URL_, ['-c', 'echo refused >&2; exit 3'], INPUT).then(
      (r) => `exit ${r.code}\n${r.stderr}`,
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/exit 3\)?\nrefused/);
  });

  it('passes the whole input to a tool that reads it', async () => {
    const run = await runPgTool('sh', URL_, ['-c', 'wc -c'], INPUT);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(String(INPUT.length));
  });
});
