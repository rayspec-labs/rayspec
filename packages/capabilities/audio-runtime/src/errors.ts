/**
 * Typed capability outcomes. The core logic returns these DISCRIMINATED results (never throws for a
 * client-caused condition); the RaySpec binding maps each to the proper HTTP status. A genuine fault
 * (a DB/blob failure the core cannot classify) still throws — the binding lets it surface as a 500.
 */

/** A client-caused capability error with the HTTP status the binding should use. */
export interface AudioCapabilityError {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail: string;
  /** The resume watermark for a `gap` / `chunk_count_mismatch` (optional). */
  readonly next_expected_index?: number;
}

/** A successful capability outcome carrying its value. */
export interface AudioCapabilityOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type AudioCapabilityResult<T> = AudioCapabilityOk<T> | AudioCapabilityError;

export function ok<T>(value: T): AudioCapabilityOk<T> {
  return { ok: true, value };
}

export function err(
  status: number,
  error: string,
  detail: string,
  extra?: { next_expected_index?: number },
): AudioCapabilityError {
  return {
    ok: false,
    status,
    error,
    detail,
    ...(extra?.next_expected_index !== undefined
      ? { next_expected_index: extra.next_expected_index }
      : {}),
  };
}

/** Raised when a capability operation is invoked without a required injected dependency (fail-closed). */
export class AudioCapabilityWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioCapabilityWiringError';
  }
}
