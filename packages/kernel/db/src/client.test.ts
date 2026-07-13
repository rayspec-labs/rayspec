/**
 * `logNotice` — the boot pool's postgres NOTICE handler (unit, console-capture; fail-the-fix).
 *
 * The benign NOTICE-class boot spam (`schema "…" already exists, skipping`) must be DROPPED, while a
 * WARNING / any non-NOTICE severity must still be SURFACED. Reverting the filter (log everything) turns
 * the "NOTICE is suppressed" assertion RED — the notice would then be console.log'd.
 *
 * We do NOT hit a DB here: `logNotice` is the exact closure wired into `makeDb`'s `onnotice`, so testing
 * it directly exercises the real boot code path. (Real query errors never reach `onnotice` — they arrive
 * on a separate ErrorResponse frame that rejects the query — so there is nothing DB-side to assert.)
 */
import type { Notice } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logNotice } from './client.js';

function notice(fields: Record<string, string>): Notice {
  return fields as unknown as Notice;
}

describe('logNotice — drop benign NOTICE-class frames, surface everything else', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('SUPPRESSES a NOTICE-class frame (idempotent-migration "already exists, skipping")', () => {
    logNotice(notice({ severity: 'NOTICE', message: 'relation "runs" already exists, skipping' }));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('SURFACES a WARNING frame (a real advisory is never hidden)', () => {
    const w = notice({ severity: 'WARNING', message: 'there is no transaction in progress' });
    logNotice(w);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(w);
  });

  it('SURFACES any other non-NOTICE severity (INFO / LOG / unknown)', () => {
    for (const severity of ['INFO', 'LOG', 'DEBUG', 'PANIC']) {
      logSpy.mockClear();
      logNotice(notice({ severity, message: `a ${severity} frame` }));
      expect(logSpy).toHaveBeenCalledTimes(1);
    }
  });
});
