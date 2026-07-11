/**
 * Typed capability outcomes (the record/audio-runtime pattern): the core returns DISCRIMINATED
 * results (never throws for a client-caused condition); the RaySpec binding maps each to the
 * proper HTTP status. A genuine fault (a DB failure the core cannot classify) still throws — the
 * binding lets it surface as a 500.
 *
 * The stable error codes (the capability's client taxonomy):
 *  - `file_id_invalid`        422 — the file id fails the safe-id shape (or carries `:`/path chars).
 *  - `file_length_required`   413 — the upload declared no finite Content-Length (absent/non-numeric/
 *                                   chunked — an unbounded body never starts draining).
 *  - `file_too_large`         413 — the declared OR actual byte count exceeds the cap.
 *  - `file_type_unsupported`  415 — the declared content type is absent or not allowlisted.
 *  - `file_name_invalid`      422 — the optional client filename fails the DATA-shape bound.
 *  - `invalid_submit_body`    422 — the submit body is not the closed `{ sha256? }` shape.
 *  - `file_conflict`          409 — divergent bytes/assertion against a stored (esp. sealed) file.
 *  - `file_not_uploaded`      409 — submit with nothing staged to seal (also the non-disclosing
 *                                   shape a foreign tenant's file id yields — tenant-scoped reads).
 */

/** A client-caused capability error with the HTTP status the binding should use. */
export interface FileCapabilityError {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail: string;
}

/** A successful capability outcome carrying its value. */
export interface FileCapabilityOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type FileCapabilityResult<T> = FileCapabilityOk<T> | FileCapabilityError;

export function ok<T>(value: T): FileCapabilityOk<T> {
  return { ok: true, value };
}

export function err(status: number, error: string, detail: string): FileCapabilityError {
  return { ok: false, status, error, detail };
}
