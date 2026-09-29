/**
 * The result envelope and its exit code — the one output shape of the bundle verbs, and of every
 * existing verb run with `--json`.
 *
 *   { contractVersion, ok, operation, operationId, data, errors: [...], warnings: [...] }
 *
 * `ok` is true exactly when `errors` is empty, and `errors[0]` is the first failing check in the
 * verb's pipeline order. The process exit is derived from the errors alone (`exitCodeFor` in
 * `@rayspec/bundle-contract`): 0 with no errors, otherwise the class that comes first in the
 * precedence 7, 6, 4, 3, 2, 1, 5 among them.
 *
 * Every verb that writes an envelope takes a fresh random UUID v4 as its `operationId` and prints
 * it on stderr, so a report and the stderr log of one run can be matched. Messages and paths are
 * clipped to the lengths the envelope schema allows, and lists to its item limit, so a verb cannot
 * emit an envelope the contract refuses.
 *
 * An existing verb with `--json` keeps its own result object unchanged in `data`, adds the warning
 * `RAY_W_LEGACY_OUTPUT`, and lists its errors: a spec error as its `SPEC_` code, anything else as
 * `RAY_CHECK_FAILED` with the error's message. Its exit code stays the one it has without `--json`.
 */
import { randomUUID } from 'node:crypto';
import {
  type BundleError,
  type BundleWarning,
  bundleError,
  CONTRACT_VERSION,
  type ExitCode,
  exitCodeFor,
  type ResultOperation,
  specEnvelopeCode,
} from '@rayspec/bundle-contract';
import { SpecErrorCode } from '@rayspec/spec';

export interface Envelope<T = unknown> {
  contractVersion: typeof CONTRACT_VERSION;
  ok: boolean;
  operation: ResultOperation;
  operationId: string;
  data: T | null;
  errors: BundleError[];
  warnings: BundleWarning[];
}

/** The envelope schema's limits on a message, a path and the length of each list. */
const MAX_MESSAGE = 2048;
const MAX_PATH = 4096;
const MAX_ITEMS = 1000;

/** A fresh operation id: a random UUID v4. */
export function newOperationId(): string {
  return randomUUID();
}

/** Build an envelope; `ok` follows from `errors`. */
export function envelope<T>(
  operation: ResultOperation,
  operationId: string,
  data: T | null,
  errors: readonly BundleError[] = [],
  warnings: readonly BundleWarning[] = [],
): Envelope<T> {
  const clippedErrors = errors.slice(0, MAX_ITEMS).map((e) => {
    const out: BundleError = {
      code: e.code,
      message: clip(e.message, MAX_MESSAGE),
      retryable: e.retryable,
    };
    if (e.reason !== undefined) out.reason = e.reason;
    if (e.path !== undefined) out.path = clip(e.path, MAX_PATH);
    return out;
  });
  const clippedWarnings = warnings.slice(0, MAX_ITEMS).map((w) => {
    const out: BundleWarning = { code: w.code, message: clip(w.message, MAX_MESSAGE) };
    if (w.path !== undefined) out.path = clip(w.path, MAX_PATH);
    return out;
  });
  return {
    contractVersion: CONTRACT_VERSION,
    ok: clippedErrors.length === 0,
    operation,
    operationId,
    data,
    errors: clippedErrors,
    warnings: clippedWarnings,
  };
}

/** The process exit an envelope maps to. */
export function envelopeExitCode(result: Envelope): ExitCode {
  return exitCodeFor(result.errors);
}

/** The envelope of a usage error: `RAY_USAGE`, exit 2, no data. */
export function usageEnvelope(
  operation: ResultOperation,
  operationId: string,
  message: string,
): Envelope<never> {
  return envelope<never>(operation, operationId, null, [bundleError('RAY_USAGE', message)]);
}

/** The envelope of an unexpected failure: `RAY_INTERNAL`, exit 7, with a secret-free message. */
export function internalEnvelope(operation: ResultOperation, operationId: string): Envelope<never> {
  return envelope<never>(operation, operationId, null, [
    bundleError('RAY_INTERNAL', 'the command failed unexpectedly'),
  ]);
}

/** The envelope of a verb stopped by SIGINT or SIGTERM: `RAY_INTERRUPTED`, exit 6. */
export function interruptedEnvelope(
  operation: ResultOperation,
  operationId: string,
  recovery: string,
): Envelope<never> {
  return envelope<never>(operation, operationId, null, [
    bundleError('RAY_INTERRUPTED', `interrupted before the command finished; ${recovery}`),
  ]);
}

const SPEC_CODES: ReadonlySet<string> = new Set(SpecErrorCode.options);

/**
 * The envelope of an existing verb run with `--json`. `result` is the verb's own result object,
 * carried unchanged in `data`; `ok` is the verdict the verb reported. Errors are listed only for a
 * negative verdict, so an `ok: true` result never produces an envelope with errors.
 */
export function legacyEnvelope(
  operation: ResultOperation,
  operationId: string,
  result: unknown,
  ok: boolean,
): Envelope {
  const warnings: BundleWarning[] = [
    {
      code: 'RAY_W_LEGACY_OUTPUT',
      message: 'this command reports its own result object in data',
    },
  ];
  if (ok) return envelope(operation, operationId, result, [], warnings);
  const errors = legacyErrors(result);
  if (errors.length === 0) {
    errors.push(bundleError('RAY_CHECK_FAILED', 'the command reported a negative verdict'));
  }
  return envelope(operation, operationId, result, errors, warnings);
}

function legacyErrors(result: unknown): BundleError[] {
  const listed =
    typeof result === 'object' && result !== null
      ? (result as { errors?: unknown }).errors
      : undefined;
  if (!Array.isArray(listed)) return [];
  const out: BundleError[] = [];
  for (const item of listed) {
    if (typeof item === 'string') {
      out.push(bundleError('RAY_CHECK_FAILED', item));
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const { code, message, path } = item as { code?: unknown; message?: unknown; path?: unknown };
    const text = typeof message === 'string' ? message : 'the command reported an error';
    const error: BundleError =
      typeof code === 'string' && SPEC_CODES.has(code)
        ? { code: specEnvelopeCode(code), message: text, retryable: false }
        : bundleError('RAY_CHECK_FAILED', text);
    if (typeof path === 'string' && path !== '') error.path = path;
    out.push(error);
  }
  return out;
}

/** Write an envelope as the one JSON object on a stream, resolving once it has drained. */
export function writeEnvelope(stream: NodeJS.WritableStream, result: Envelope): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(result, null, 2)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

// ─── interruption ──────────────────────────────────────────────────────────────────────────────

/** The signals a verb answers with `RAY_INTERRUPTED`. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** What `interruptible` listens on: `process` in the CLI, an emitter in a test. */
export interface SignalSource {
  on(signal: (typeof INTERRUPT_SIGNALS)[number], listener: () => void): unknown;
  off(signal: (typeof INTERRUPT_SIGNALS)[number], listener: () => void): unknown;
}

let abandoned = false;

/**
 * Whether an interrupted verb left work running that the process must not wait for. The entry
 * point exits once the envelope is written instead of letting that work finish.
 */
export function workAbandoned(): boolean {
  return abandoned;
}

/**
 * Run `work` until it settles or SIGINT/SIGTERM arrives, whichever comes first. On a signal the
 * result is `{ interrupted: true }` and the work is abandoned: only a verb that has nothing to undo
 * at any point may use this, which holds for the passive bundle verbs. The listeners are removed
 * either way.
 */
export async function interruptible<T>(
  work: Promise<T>,
  signals: SignalSource = process,
): Promise<{ interrupted: false; value: T } | { interrupted: true }> {
  let onSignal: () => void = () => {};
  const interrupted = new Promise<{ interrupted: true }>((resolve) => {
    onSignal = () => resolve({ interrupted: true });
  });
  for (const signal of INTERRUPT_SIGNALS) signals.on(signal, onSignal);
  try {
    const outcome = await Promise.race([
      work.then((value) => ({ interrupted: false as const, value })),
      interrupted,
    ]);
    if (outcome.interrupted) {
      abandoned = true;
      // The abandoned work may still settle; a late rejection must not surface as unhandled.
      work.catch(() => {});
    }
    return outcome;
  } finally {
    for (const signal of INTERRUPT_SIGNALS) signals.off(signal, onSignal);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
