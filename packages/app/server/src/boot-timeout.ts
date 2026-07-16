/**
 * Boot-timeout guard for the local serve entrypoint.
 *
 * The server's first visible output today is the boot banner, printed only AFTER the whole assemble
 * step (config load → database connect → committed migration chain → product boot) completes. If that
 * step hangs — an unreachable database, a wrong DATABASE_URL, a stuck migration — the operator sees
 * only silence. This wraps the assemble await in a timeout so a hang is DIAGNOSED (which phases were in
 * flight, and the likely causes) instead of hanging indefinitely.
 *
 * It never changes the happy path: a normal boot resolves well under the timeout, the timer is cleared,
 * and — because the timer is unref'd — it can never by itself keep the process alive.
 */

/** The default boot timeout: generous enough that a real local boot never trips it. */
export const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** Raised when the boot exceeds its timeout — carries the operator-facing diagnostic as its message. */
export class BootTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootTimeoutError';
  }
}

/**
 * Resolve the boot timeout in milliseconds from the environment. `RAYSPEC_BOOT_TIMEOUT_MS` overrides
 * the default; an absent, non-numeric, or non-positive value falls back to the default (a malformed
 * override never disables the guard).
 */
export function resolveBootTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RAYSPEC_BOOT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_BOOT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BOOT_TIMEOUT_MS;
  return Math.floor(n);
}

/** Build the diagnostic printed (to stderr, at the entrypoint) when the boot exceeds its timeout. */
export function bootTimeoutMessage(timeoutMs: number): string {
  return (
    `boot timed out after ${timeoutMs}ms while assembling the server — the phases in flight are ` +
    'connecting to the database, applying the committed migration chain, and materializing the ' +
    'declared product. Likely causes: the database is unreachable, DATABASE_URL points at the wrong ' +
    'host/port, or a migration is stuck. Verify the database is up and DATABASE_URL is correct; if the ' +
    'boot is legitimately slow, raise RAYSPEC_BOOT_TIMEOUT_MS.'
  );
}

/**
 * Race `boot` against a `timeoutMs` deadline. Resolves with `boot`'s value on success; rejects with a
 * {@link BootTimeoutError} carrying the diagnostic if the deadline fires first. The timer is always
 * cleared once the race settles (so the process does not linger on it) and is unref'd so it can never
 * on its own keep the event loop alive.
 */
export async function withBootTimeout<T>(boot: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BootTimeoutError(bootTimeoutMessage(timeoutMs))),
      timeoutMs,
    );
    // Never let the deadline timer alone hold the process open (belt-and-braces with the clear below).
    timer.unref?.();
  });
  try {
    return await Promise.race([boot, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
