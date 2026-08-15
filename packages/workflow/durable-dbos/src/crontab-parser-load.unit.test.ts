/**
 * The crontab seam's FAILURE ATTRIBUTION — a parser LOAD fault is not the operator's parse fault.
 *
 * `crontabParseError` answers one boot question: can the scheduler parse this operator value? The
 * composition root interpolates its answer into
 * `RAYSPEC_CLEANUP_SCHEDULE='<value>' is not a crontab the scheduler can parse (<detail>)`. The
 * parser itself is loaded lazily out of the installed SDK by ABSOLUTE path (the SDK's `exports` map
 * gives its crontab module no bare specifier), so an SDK layout change is a way that load can fail —
 * and a load failure returned as `<detail>` would refuse a perfectly VALID crontab with text blaming
 * the operator's value. This pins that it THROWS, naming the loader, instead.
 *
 * Its OWN file because the loader memoizes on first success: any successful parse elsewhere in a file
 * makes the load arm unreachable for the rest of it.
 */
import { describe, expect, it, vi } from 'vitest';

/** What a moved/renamed SDK layout looks like at the resolve call. */
const LOAD_FAULT = "Cannot find module '@dbos-inc/dbos-sdk' (stubbed SDK layout change)";

// Only the transformed source under test reads this mock: `@dbos-inc/dbos-sdk` itself is an
// externalized dependency loaded natively, so its own internals keep the real `node:module`.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      const stub = ((id: string) => real(id)) as unknown as NodeJS.Require;
      Object.assign(stub, real);
      stub.resolve = (() => {
        throw new Error(LOAD_FAULT);
      }) as NodeJS.RequireResolve;
      return stub;
    },
  };
});

/** What the seam did with a value — a returned parse detail, or a throw. */
type SeamOutcome =
  | { readonly kind: 'returned'; readonly detail: string | undefined }
  | { readonly kind: 'threw'; readonly error: unknown };

describe('crontabParseError — a parser LOAD failure is never reported as a parse failure', () => {
  it('THROWS, naming the loader, for a VALID crontab the parser could not be loaded to check', async () => {
    const { crontabParseError, DEFAULT_CLEANUP_SCHEDULE } = await import(
      './system-cleanup-scheduler.js'
    );
    // The value is the shipped default — indisputably parseable. The only thing wrong is the load.
    let outcome: SeamOutcome;
    try {
      outcome = { kind: 'returned', detail: crontabParseError(DEFAULT_CLEANUP_SCHEDULE) };
    } catch (error) {
      outcome = { kind: 'threw', error };
    }

    // A RETURNED string is what the composition root interpolates into "…'0 3 * * *' is not a
    // crontab the scheduler can parse (<detail>)" — a valid value refused with a misleading reason.
    expect(outcome).toEqual({ kind: 'threw', error: expect.any(Error) });

    const message = ((outcome as { error: unknown }).error as Error).message;
    // The refusal names the LOADER as the fault and carries the underlying cause for diagnosis.
    expect(message).toContain("the scheduler's crontab parser could not be loaded");
    expect(message).toContain('@dbos-inc/dbos-sdk');
    expect(message).toContain(LOAD_FAULT);
  });
});
