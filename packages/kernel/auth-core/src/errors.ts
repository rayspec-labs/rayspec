/**
 * Error envelope + the CLOSED ErrorCode enum.
 *
 * Every non-2xx response is `{ error: { code, message, requestId, details? } }` with a code from
 * the closed enum below. A 404 for a cross-tenant/missing resource carries NO existence leak (the
 * message is uniform). The HTTP status for each code is fixed by STATUS_BY_CODE.
 */
import { z } from 'zod';

/** The CLOSED set of error codes the API can return. */
export const ErrorCode = z.enum([
  'VALIDATION_ERROR', // 400 — Zod / shape validation failed (defaultHook)
  'UNAUTHENTICATED', // 401 — missing/invalid credential (uniform, no enumeration)
  'FORBIDDEN', // 403 — authenticated but not permitted (live authz deny)
  'NOT_FOUND', // 404 — missing OR cross-tenant (no existence leak)
  'CONFLICT', // 409 — uniqueness / state conflict
  'IDEMPOTENCY_CONFLICT', // 409 — same Idempotency-Key, different body
  'RATE_LIMITED', // 429 — rate limit / anti-DoS lock
  'INTERNAL', // 500 — unexpected server error
  'UPSTREAM_ERROR', // 502 — an upstream provider 5xx surfaced on a live run
  'NOT_IMPLEMENTED', // 501 — reserved seam (WorkOS SSO stub)
  'GATEWAY_TIMEOUT', // 504 — a held in-request run exceeded its wall-clock timeout
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Fixed HTTP status per error code. */
export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_ERROR: 502,
  NOT_IMPLEMENTED: 501,
  GATEWAY_TIMEOUT: 504,
};

/** The wire error envelope. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/**
 * A typed application error carrying an ErrorCode. Handlers/services throw this; the app's error
 * handler maps it to the envelope + the fixed status. A generic 401/404 deliberately uses a
 * uniform message so neither credential validity nor cross-tenant existence leaks.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/** Uniform 401 — never reveals whether the user/credential existed. */
export function unauthenticated(): ApiError {
  return new ApiError('UNAUTHENTICATED', 'Authentication failed.');
}

/** Uniform 404 — never reveals whether the resource exists in another tenant. */
export function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 'Not found.');
}

/** 403 — authenticated but not permitted. */
export function forbidden(message = 'Forbidden.'): ApiError {
  return new ApiError('FORBIDDEN', message);
}

/** Build the wire envelope for a code + message + requestId. */
export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return { error: { code, message, requestId, ...(details !== undefined ? { details } : {}) } };
}
