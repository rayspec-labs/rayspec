/**
 * A refusal carried up through the resolver's steps. It never leaves the package: `resolveClosure`
 * catches it and returns its errors in the result, so a caller sees `{ ok: false, errors }` and
 * never an exception for anything the application tree contains.
 */
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  type ErrorReason,
} from '@rayspec/bundle-contract';

export class ClosureRefusal extends Error {
  readonly errors: BundleError[];
  constructor(errors: BundleError[]) {
    super(errors[0]?.message ?? 'the closure was refused');
    this.name = 'ClosureRefusal';
    this.errors = errors;
  }
}

/** Throw one refusal. */
export function refuse<C extends BundleErrorCode>(
  code: C,
  message: string,
  detail: { reason?: ErrorReason<C>; path?: string } = {},
): never {
  throw new ClosureRefusal([bundleError(code, message, detail)]);
}
