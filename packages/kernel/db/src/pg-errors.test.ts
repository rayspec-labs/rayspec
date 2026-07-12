/**
 * Unit tests for the shared Postgres-error-shape detectors.
 *
 * Fail-the-fix: each asserts the REAL structural property (the SQLSTATE on the `.code`, walked down
 * the `.cause` chain), not just that a boolean flips — the raw driver shape AND the drizzle wrapper
 * shape are both exercised, and the constraint-name reader is proven to read the SCHEMA identifier and
 * never a row value.
 */
import { describe, expect, it } from 'vitest';
import { isUniqueViolation, uniqueViolationConstraintName } from './pg-errors.js';

/** The raw postgres.js PostgresError shape (SQLSTATE + fields on the error itself). */
function rawPgError(overrides: Record<string, unknown> = {}): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "catalog_sku_unique"'),
    {
      code: '23505',
      constraint_name: 'catalog_sku_unique',
      // The offending VALUE lives on `detail` — the reader must NEVER surface it.
      detail: 'Key (sku)=(ORBIT-CRM-SECRET) already exists.',
      ...overrides,
    },
  );
}

/** The drizzle-orm DrizzleQueryError wrapper: message `Failed query: …`, no `code`, `.cause` = raw. */
function drizzleWrapped(cause: unknown): Error {
  return Object.assign(new Error('Failed query: insert into "catalog" ...'), { cause });
}

describe('isUniqueViolation', () => {
  it('is TRUE for the raw driver 23505 error', () => {
    expect(isUniqueViolation(rawPgError())).toBe(true);
  });

  it('is TRUE for a drizzle wrapper whose .cause is the raw 23505 (the wrapper carries no code)', () => {
    const wrapped = drizzleWrapped(rawPgError());
    // The wrapper itself has no `.code` — detection MUST walk the cause chain (fail-the-fix: a
    // top-level-only check would return false here).
    expect((wrapped as { code?: unknown }).code).toBeUndefined();
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('is FALSE for a different SQLSTATE (e.g. 23503 FK violation) and for non-errors', () => {
    expect(isUniqueViolation(rawPgError({ code: '23503', constraint_name: 'x' }))).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });

  it('is cycle-safe and bounded (a self-referential cause chain does not hang)', () => {
    const a: { code?: string; cause?: unknown } = { code: 'XXXXX' };
    a.cause = a; // cycle
    expect(isUniqueViolation(a)).toBe(false);
  });

  it('does not walk past the bounded depth (a 23505 buried deeper than 5 is not matched)', () => {
    // 6 nested wrappers before the 23505 — beyond MAX_CAUSE_DEPTH, so it is NOT detected (the bound
    // exists so a pathological chain cannot spin; real driver→drizzle nesting is depth 1–2).
    let deep: unknown = rawPgError();
    for (let i = 0; i < 6; i++) deep = drizzleWrapped(deep);
    expect(isUniqueViolation(deep)).toBe(false);
  });
});

describe('uniqueViolationConstraintName', () => {
  it('reads the SCHEMA constraint name from the raw error (never the offending value)', () => {
    const name = uniqueViolationConstraintName(rawPgError());
    expect(name).toBe('catalog_sku_unique');
    // The value ("ORBIT-CRM-SECRET") lives on `detail` and must never leak through this reader.
    expect(name).not.toContain('ORBIT');
  });

  it('reads the constraint name down the drizzle .cause chain', () => {
    expect(uniqueViolationConstraintName(drizzleWrapped(rawPgError()))).toBe('catalog_sku_unique');
  });

  it('is undefined when the 23505 carries no constraint name, or the error is not a 23505', () => {
    expect(
      uniqueViolationConstraintName(rawPgError({ constraint_name: undefined })),
    ).toBeUndefined();
    expect(uniqueViolationConstraintName(new Error('plain'))).toBeUndefined();
    expect(uniqueViolationConstraintName(rawPgError({ code: '23503' }))).toBeUndefined();
  });
});
