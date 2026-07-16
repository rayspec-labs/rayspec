/**
 * Neutral upstream-error classification.
 *
 * When a model call fails, the three SDKs surface very different error shapes:
 *  - OpenAI (`@openai/agents` → the `openai` SDK): an `APIError` subclass carries a numeric `.status`
 *    (429 RateLimitError / ≥500 InternalServerError / 4xx Bad/NotFound/etc.) + a `.headers` Headers
 *    with `Retry-After`; the agents layer adds `ModelRefusalError` / `MaxTurnsExceededError` /
 *    `ToolTimeoutError` (verified doc-first against @openai/agents-core@0.11.8 errors.d.ts +
 *    openai@6.x core/error.d.ts).
 *  - Pi (`@earendil-works/pi-coding-agent`): wraps the OpenAI model under the hood, so a model-call
 *    HTTP failure surfaces the SAME `.status`-bearing shape; an adapter-internal validation error
 *    (e.g. unknown model) has no status.
 *  - Anthropic (the bundled `claude` child / Claude Agent SDK `query()`): errors arrive as a
 *    `result subtype=…` string or a stringified child error — there is NO HTTP status object, so it
 *    is classified by message heuristics, conservatively.
 *
 * This helper maps ANY caught error INTO the neutral `ErrorClass` vocabulary and ALWAYS preserves the
 * upstream cause message. It is neutral platform vocabulary: every adapter maps its own SDK error
 * shape into it — never the reverse, and never an LCD collapse.
 *
 * HONESTY: it classifies CONSERVATIVELY and is throw-safe. The STRUCTURAL HTTP status (extractStatus)
 * is the authoritative signal; the message-heuristic path is BEST-EFFORT and requires EITHER a
 * server-error / rate-limit / refusal CONTEXT word OR an UNAMBIGUOUS STATUS indicator — a status code
 * at the START of the message or the literal `"<NNN> status code"` form (the two real openai SDK
 * `APIError.makeMessage` shapes that reach this path with the `.status` stripped — the Pi
 * no-throw re-wrap; verified doc-first against openai@6.44 core/error.js). It is NEVER a bare 3-digit
 * number mid-sentence or a field label, so a token count like "530 output tokens", a duration "took
 * 502 ms", or a "refusal: none" field is NOT mis-tagged. When classification is genuinely ambiguous it
 * defaults to `internal` (the fail-closed default). The residual heuristic risk is low after the
 * tightening, but not provably zero — hence "best-effort", not "never wrong".
 */

/**
 * The neutral error class for a failed run. NEUTRAL platform vocabulary — adapters map their SDK
 * error shape into it (no LCD collapse). `internal` is the fail-closed default for a genuinely
 * unclassifiable error (never a mis-tag).
 */
export type ErrorClass =
  | 'rate_limited' // an upstream 429 / throttle (a Retry-After is captured when present)
  | 'upstream_5xx' // an upstream 5xx (server error / overloaded)
  | 'upstream_4xx' // an upstream 4xx other than 429 (bad request / not found / unauthorized)
  | 'timeout' // a request/loop timeout (in-request withTimeout, or an SDK tool/loop timeout)
  | 'model_refusal' // the model refused to produce output (a safety/content decline, not an error)
  | 'internal'; // unclassified / adapter-internal (the fail-closed default)

/** The closed set of neutral error-class values, for runtime validation (parity gate, etc.). */
export const ERROR_CLASSES: readonly ErrorClass[] = [
  'rate_limited',
  'upstream_5xx',
  'upstream_4xx',
  'timeout',
  'model_refusal',
  'internal',
] as const;

/** True iff `v` is one of the neutral ErrorClass values. */
export function isErrorClass(v: unknown): v is ErrorClass {
  return typeof v === 'string' && (ERROR_CLASSES as readonly string[]).includes(v);
}

/** The classified result: the neutral class + the PRESERVED upstream cause message (+ Retry-After). */
export interface ClassifiedError {
  errorClass: ErrorClass;
  /** The preserved upstream cause message — NEVER discarded (String(err) at minimum). */
  message: string;
  /** Retry-After in SECONDS, when the upstream surfaced one (rate-limit/5xx). Absent otherwise. */
  retryAfter?: number;
}

/** Read a finite non-negative integer-ish value from an unknown candidate (status / retry-after). */
function toFiniteNonNegative(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Extract a numeric HTTP status from an error, checking the shapes the three SDKs actually use:
 * `status` (openai APIError), `statusCode` (node-fetch-style), `response.status`, and one level of
 * `cause` / `error` nesting (an agents-SDK error often wraps the underlying API error).
 *
 * CLS-4: an ERROR-range status (>=400) anywhere in the shallow walk WINS over a benign non-error status
 * (e.g. a `response.status:200` on the wrapper shadowing a real `cause.status:500`). We collect the
 * candidates and prefer the first error-range one; only if none is in the error range do we fall back to
 * the first non-error status found. Returns undefined if no finite HTTP status is present at all.
 */
function extractStatus(err: unknown, depth = 0): number | undefined {
  const candidates: number[] = [];
  collectStatuses(err, depth, candidates);
  const errorRange = candidates.find((s) => s >= 400 && s < 600);
  if (errorRange !== undefined) return errorRange;
  return candidates[0];
}

/** Collect every finite HTTP status (100–599) in the shallow `cause`/`error` walk, in walk order. */
function collectStatuses(err: unknown, depth: number, out: number[]): void {
  if (err === null || typeof err !== 'object' || depth > 3) return;
  const e = err as Record<string, unknown>;
  for (const candidate of [
    toFiniteNonNegative(e.status),
    toFiniteNonNegative(e.statusCode),
    toFiniteNonNegative((e.response as Record<string, unknown> | undefined)?.status),
  ]) {
    if (candidate !== undefined && candidate >= 100 && candidate < 600) out.push(candidate);
  }
  // One step into the wrap chain (agents SDK wraps the openai APIError as `cause`/`error`).
  collectStatuses(e.cause, depth + 1, out);
  collectStatuses(e.error, depth + 1, out);
}

/**
 * Parse a `Retry-After` HEADER value to seconds. CLS-5: a `Retry-After` is EITHER a delta-seconds
 * integer OR an HTTP-date (RFC 7231) — and `Number.parseInt` would misparse a number-leading date
 * (e.g. "21 Oct 2015") to a wrong seconds value. So we accept the header ONLY when it is a PURE
 * integer (optionally surrounded by whitespace); an HTTP-date (which we do NOT parse) yields undefined.
 */
function retryAfterFromHeaderValue(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return toFiniteNonNegative(raw);
  if (!/^\s*\d+\s*$/.test(raw)) return undefined; // an HTTP-date (or junk) — not a delta-seconds int
  return toFiniteNonNegative(raw.trim());
}

/**
 * Extract a Retry-After (seconds) from an error: a `retryAfter`/`retry_after` field, or a
 * `headers.get('retry-after')` (openai APIError carries a Headers). A `Retry-After` may be a delta in
 * seconds (we keep it) or an HTTP-date (which we do NOT attempt to parse — undefined). Walks the same
 * shallow `cause`/`error` chain as extractStatus.
 */
function extractRetryAfter(err: unknown, depth = 0): number | undefined {
  if (err === null || typeof err !== 'object' || depth > 3) return undefined;
  const e = err as Record<string, unknown>;
  const direct = toFiniteNonNegative(e.retryAfter) ?? toFiniteNonNegative(e.retry_after);
  if (direct !== undefined) return direct;
  const headers = e.headers;
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const raw = (headers as { get: (k: string) => unknown }).get('retry-after');
    const fromHeader = retryAfterFromHeaderValue(raw);
    if (fromHeader !== undefined) return fromHeader;
  }
  return extractRetryAfter(e.cause, depth + 1) ?? extractRetryAfter(e.error, depth + 1);
}

/**
 * An UNAMBIGUOUS LEADING HTTP status indicator. The openai SDK's `APIError.makeMessage`
 * (doc-first, openai@6.44 core/error.js) stringifies a transient failure as `"<status> <body>"` or
 * `"<status> status code (no body)"`. On the Pi no-throw path that message is re-wrapped as a
 * bare `new Error(message)` (the `.status` object is stripped), so it reaches the MESSAGE heuristic
 * with the status only in the text. `errorToMessage` runs `String(err)` on an Error, which prepends the
 * conventional `"Error: "` (or `"<Name>: "`) prefix — so the status code is NOT at absolute position 0.
 * These anchors therefore accept an OPTIONAL leading single-token error-NAME prefix (`"<name>: "`,
 * where a JS error name is one whitespace-free identifier — never a sentence with spaces) + whitespace,
 * then the status code at the START of the actual message body. A mid-sentence number ("took 502 ms",
 * "item 429 of the batch", "produced 530 output tokens") is NOT matched — it is never at the leading
 * position; and requiring a SPACE-FREE name token before the colon keeps a benign "some phrase: 530 …"
 * from matching (that is not an error-name prefix). The STRUCTURAL extractStatus path stays the
 * authoritative first signal; this is the conservative message-path fallback for the status-stripped
 * re-wrap.
 */
const LEADING_5XX = /^(?:[a-z][a-z0-9_]*:\s*)?5\d\d\b/;
const LEADING_429 = /^(?:[a-z][a-z0-9_]*:\s*)?429\b/;

/** The error's constructor name (or '' if none) — used for the SDK class-name heuristic. */
function errorName(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const n = (err as { name?: unknown }).name;
    if (typeof n === 'string') return n;
    const ctor = (err as { constructor?: { name?: unknown } }).constructor;
    if (ctor && typeof ctor.name === 'string') return ctor.name;
  }
  return '';
}

/**
 * Classify a caught upstream/model-call error into the neutral ErrorClass, preserving the cause
 * message (and a Retry-After when present). Classification order (most → least specific):
 *  1. A numeric HTTP status (429 → rate_limited; 5xx → upstream_5xx; other 4xx → upstream_4xx).
 *     This is the STRUCTURAL signal (OpenAI/Pi APIError) and takes precedence.
 *  2. The error's class NAME (the OpenAI agents SDK: ModelRefusalError → model_refusal;
 *     a Timeout/MaxTurnsExceeded name → timeout; RateLimit → rate_limited; InternalServer → upstream_5xx).
 *  3. Conservative MESSAGE heuristics (the Anthropic child / the Pi no-throw re-wrap have no
 *     status object): a rate-limit / 5xx / refusal CONTEXT phrase, OR an unambiguous status indicator
 *     (a status code at the START or the `"<NNN> status code"` form) — NEVER a bare 3-digit number
 *     mid-sentence (a token count "530 output tokens" or a duration is not a 5xx) and NEVER a bare
 *     refusal noun in a field label ("refusal: none").
 *  4. Default: `internal` (genuinely unclassifiable — fail-closed, never a mis-tag).
 *
 * CLS-3: the whole body is throw-guarded — a hostile getter (e.g. a `message`/`headers` accessor that
 * throws) can never blow up the classifier; it falls back to `{ internal, <safe String(err)> }`.
 */
export function classifyUpstreamError(err: unknown): ClassifiedError {
  try {
    return classifyUpstreamErrorUnsafe(err);
  } catch {
    // A hostile error object (throwing getter) must never crash classification — fail closed.
    return { errorClass: 'internal', message: safeStringify(err) };
  }
}

/** The classification core (may throw if `err` has a hostile getter; wrapped by classifyUpstreamError). */
function classifyUpstreamErrorUnsafe(err: unknown): ClassifiedError {
  const message = errorToMessage(err);
  const retryAfter = extractRetryAfter(err);
  const withRetry = (errorClass: ErrorClass): ClassifiedError =>
    retryAfter !== undefined ? { errorClass, message, retryAfter } : { errorClass, message };

  // (1) STRUCTURAL: a real HTTP status from the SDK error (OpenAI/Pi APIError, or a nested cause).
  const status = extractStatus(err);
  if (status !== undefined) {
    if (status === 429) return withRetry('rate_limited');
    if (status >= 500 && status < 600) return withRetry('upstream_5xx');
    if (status >= 400 && status < 500) return withRetry('upstream_4xx');
    // A non-error status (1xx–3xx) is not a meaningful classification — fall through to heuristics.
  }

  // (2) SDK class NAME (OpenAI agents-core errors carry no status).
  const name = errorName(err);
  if (/ModelRefusal/i.test(name)) return { errorClass: 'model_refusal', message };
  if (/Timeout|MaxTurnsExceeded/i.test(name)) return { errorClass: 'timeout', message };
  if (/RateLimit/i.test(name)) return withRetry('rate_limited');
  if (/InternalServer/i.test(name)) return withRetry('upstream_5xx');

  // (3) Conservative MESSAGE heuristics (the Anthropic child / stringified errors have no status).
  // CLS-1/CLS-2: every branch requires a CONTEXT phrase, not a bare number or a field-label noun.
  const m = message.toLowerCase();
  // RATE LIMIT: an explicit rate-limit / throttle / quota CONTEXT phrase. CLS-1: NOT a bare "429" (it
  // could be any id/count) — "429" only counts when it sits ADJACENT to rate-limit/throttle wording,
  // OR when it is an UNAMBIGUOUS STATUS indicator: a status code at the START of the
  // message or the literal `"429 status code"` form. The openai SDK stringifies a thrown APIError that
  // reaches THIS path WITHOUT a `.status` object (the Pi no-throw path re-wraps the message as
  // a bare Error, stripping `.status`) as `"<status> <body>"` (APIError.makeMessage) or
  // `"<status> status code (no body)"` (the no-body branch) — verified doc-first against the installed
  // openai@6.44 core/error.js. These leading/"status code" forms are unambiguous (a mid-sentence
  // number like "item 429 of the batch" or "took 502 ms" is NOT).
  if (
    /rate[ _-]?limit|too many requests|quota exceeded|throttl/.test(m) ||
    /\b429\b[^.]{0,40}(?:rate[ _-]?limit|too many|throttl|quota)|(?:rate[ _-]?limit|too many|throttl|quota)[^.]{0,40}\b429\b/.test(
      m,
    ) ||
    LEADING_429.test(m) ||
    /\b429 status code\b/.test(m)
  ) {
    return withRetry('rate_limited');
  }
  // UPSTREAM 5xx: a server-error CONTEXT word — NOT a bare 3-digit number (CLS-1: "530 output tokens"
  // is a token count, not a 530 status; "took 502 ms" is a duration, not a 502) — OR an UNAMBIGUOUS
  // STATUS indicator: a 5xx code at the START of the message ("500 The server had an
  // error…") or the literal `"<5xx> status code"` form ("503 status code (no body)"). These are the
  // real openai SDK APIError.makeMessage forms (doc-first, openai@6.44) that reach this message path
  // with the `.status` stripped; a mid-sentence number stays internal (leading / "status code" only).
  if (
    /overloaded|service unavailable|internal server error|bad gateway|gateway timeout|server error/.test(
      m,
    ) ||
    LEADING_5XX.test(m) ||
    /\b5\d\d status code\b/.test(m)
  ) {
    // "gateway timeout" is a 504 → 5xx server-side (distinct from a client/loop timeout below).
    return withRetry('upstream_5xx');
  }
  if (/timed? ?out|timeout|deadline exceeded/.test(m)) {
    return { errorClass: 'timeout', message };
  }
  // REFUSAL (matched LAST, narrowly): a DECLINE context — the model "refused …", "declined to …", or
  // an explicit refusal stop-reason. CLS-2: NOT the bare NOUN `refusal` in a benign field LABEL
  // ("safety refusal: none" / "refusal: passed/false"), and NOT a generic "declined for X" (only
  // "declined TO …"), so an ordinary error string is never mis-tagged a refusal.
  // The `\s*(?:[:=]\s*)?` separator is the exact-same-language, backtracking-free form of `\s*[:=]?\s*`:
  // a whitespace run can only be consumed by one side of the mandatory `[:=]`, so a long whitespace pad
  // no longer causes super-linear scanning (the two adjacent `\s*` were the polynomial-ReDoS shape).
  if (
    /\brefused\b|\bdeclined\s+to\b|stop[ _-]?reason\s*(?:[:=]\s*)?refus/.test(m) ||
    (/\brefusal\b/.test(m) &&
      !/\brefusal\s*(?:[:=]\s*)?(?:none|passed|false|absent|n\/a|0)\b/.test(m))
  ) {
    return { errorClass: 'model_refusal', message };
  }

  // (4) Fail-closed default: unclassifiable → internal (never a mis-tag).
  return { errorClass: 'internal', message };
}

/** A String(err) that itself never throws (a hostile toString is swallowed) — for the CLS-3 fallback. */
function safeStringify(err: unknown): string {
  try {
    return String(err);
  } catch {
    return 'unclassifiable error';
  }
}

/**
 * The PRESERVED upstream cause message. Mirrors the adapters' historical `String(err)` so the wire
 * `error` string is unchanged for the common `Error` case, but prefers a real `.message` and falls
 * back to `String(err)` — the cause is NEVER discarded.
 */
export function errorToMessage(err: unknown): string {
  if (err instanceof Error) return String(err);
  if (err !== null && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return String(err);
}
