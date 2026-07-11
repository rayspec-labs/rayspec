/**
 * Typed capability outcomes (the audio-runtime pattern): the core returns DISCRIMINATED results
 * (never throws for a client-caused condition); the RaySpec binding maps each to the proper HTTP
 * status. A genuine fault (a DB failure the core cannot classify) still throws — the binding lets
 * it surface as a 500.
 */

/** A client-caused capability error with the HTTP status the binding should use. */
export interface RecordCapabilityError {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail: string;
}

/** A successful capability outcome carrying its value. */
export interface RecordCapabilityOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type RecordCapabilityResult<T> = RecordCapabilityOk<T> | RecordCapabilityError;

export function ok<T>(value: T): RecordCapabilityOk<T> {
  return { ok: true, value };
}

export function err(status: number, error: string, detail: string): RecordCapabilityError {
  return { ok: false, status, error, detail };
}
