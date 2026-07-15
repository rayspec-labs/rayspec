/**
 * errorEnvelope unit tests — the structural details-strip at the single envelope chokepoint.
 *
 * A `details` payload is only allowed to ride out on the codes that legitimately echo caller-supplied
 * context (an input-validation issue set, a named missing permission, a retry hint, a run error class).
 * For every other code — notably the existence-leak-sensitive UNAUTHENTICATED (401) and NOT_FOUND (404)
 * — the envelope MUST drop `details` structurally, regardless of what a caller passes in.
 */
import { describe, expect, it } from 'vitest';
import { DETAILS_ALLOWED, type ErrorCode, errorEnvelope, STATUS_BY_CODE } from './errors.js';

const ALL_CODES: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL',
  'UPSTREAM_ERROR',
  'NOT_IMPLEMENTED',
  'GATEWAY_TIMEOUT',
];

describe('errorEnvelope details-strip', () => {
  it('strips details for the existence-leak-sensitive codes', () => {
    const nf = errorEnvelope('NOT_FOUND', 'Not found.', 'rid-1', {
      leaked: 'other-tenant-resource',
    });
    expect('details' in nf.error).toBe(false);

    const un = errorEnvelope('UNAUTHENTICATED', 'Authentication failed.', 'rid-2', {
      leaked: 'why',
    });
    expect('details' in un.error).toBe(false);
  });

  it('retains details for the allowlisted codes', () => {
    const allowlisted: { code: ErrorCode; details: unknown }[] = [
      { code: 'VALIDATION_ERROR', details: { issues: [{ path: 'name', message: 'required' }] } },
      { code: 'FORBIDDEN', details: { missing_permission: 'store:write' } },
      { code: 'RATE_LIMITED', details: { retryAfterMs: 1000 } },
      { code: 'GATEWAY_TIMEOUT', details: { errorClass: 'timeout' } },
    ];
    for (const { code, details } of allowlisted) {
      const env = errorEnvelope(code, 'msg', 'rid', details);
      expect(env.error.details).toEqual(details);
    }
  });

  it('strips details for every code NOT in the allowlist', () => {
    for (const code of ALL_CODES) {
      const env = errorEnvelope(code, 'msg', 'rid', { leaked: true });
      if (DETAILS_ALLOWED.has(code)) {
        expect(env.error.details).toEqual({ leaked: true });
      } else {
        expect('details' in env.error).toBe(false);
      }
    }
  });

  it('never adds a details key when none was supplied (allowlisted or not)', () => {
    for (const code of ALL_CODES) {
      const env = errorEnvelope(code, 'msg', 'rid');
      expect('details' in env.error).toBe(false);
    }
  });

  it('exposes an allowlist of exactly the input-echo codes', () => {
    expect([...DETAILS_ALLOWED].sort()).toEqual(
      ['FORBIDDEN', 'GATEWAY_TIMEOUT', 'RATE_LIMITED', 'VALIDATION_ERROR'].sort(),
    );
  });

  it('maps PAYLOAD_TOO_LARGE to HTTP 413 (an over-cap request body, bare — not an input echo)', () => {
    expect(STATUS_BY_CODE.PAYLOAD_TOO_LARGE).toBe(413);
    // It carries no details out (a too-large body reveals nothing about the caller's input).
    expect(DETAILS_ALLOWED.has('PAYLOAD_TOO_LARGE')).toBe(false);
    const env = errorEnvelope('PAYLOAD_TOO_LARGE', 'Request body is too large.', 'rid', {
      leaked: true,
    });
    expect('details' in env.error).toBe(false);
  });
});
