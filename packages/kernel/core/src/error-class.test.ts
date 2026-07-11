/**
 * classifyUpstreamError unit tests.
 *
 * Feeds REPRESENTATIVE shapes from each SDK's real error surface (verified doc-first against
 * @openai/agents-core@0.11.8 + openai@6.x + the Anthropic child + Pi) and asserts the neutral class,
 * the PRESERVED cause message, and Retry-After extraction. These are fail-the-fix tests: each pins a
 * SPECIFIC classification path, so weakening the classifier (e.g. dropping the structural-status path
 * or mis-tagging a refusal as a throttle) turns one red.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUpstreamError,
  ERROR_CLASSES,
  type ErrorClass,
  errorToMessage,
  isErrorClass,
} from './error-class.js';

/** A fake openai-SDK-style APIError: a numeric `status` + a `headers` Headers carrying Retry-After. */
function fakeApiError(status: number, message: string, retryAfter?: string): Error {
  const err = new Error(message) as Error & {
    status: number;
    headers: { get: (k: string) => string | null };
  };
  err.name = status === 429 ? 'RateLimitError' : 'APIError';
  err.status = status;
  err.headers = {
    get: (k: string) => (k.toLowerCase() === 'retry-after' && retryAfter ? retryAfter : null),
  };
  return err;
}

describe('classifyUpstreamError — STRUCTURAL HTTP status (OpenAI/Pi APIError)', () => {
  it('429 → rate_limited + captures the Retry-After header (seconds)', () => {
    const c = classifyUpstreamError(fakeApiError(429, '429 Too Many Requests', '30'));
    expect(c.errorClass).toBe('rate_limited');
    expect(c.retryAfter).toBe(30);
    // The upstream cause is preserved verbatim (never discarded).
    expect(c.message).toContain('429 Too Many Requests');
  });

  it('a 5xx → upstream_5xx', () => {
    expect(classifyUpstreamError(fakeApiError(503, '503 Service Unavailable')).errorClass).toBe(
      'upstream_5xx',
    );
    expect(classifyUpstreamError(fakeApiError(500, 'boom')).errorClass).toBe('upstream_5xx');
  });

  it('a non-429 4xx → upstream_4xx (the real OpenAI bad-model error shape)', () => {
    const c = classifyUpstreamError(
      fakeApiError(400, "Error: 400 The requested model '__nonexistent-model__' does not exist."),
    );
    expect(c.errorClass).toBe('upstream_4xx');
    expect(c.message).toContain('does not exist');
  });

  it('a status nested under `cause` is found (agents-SDK wraps the openai APIError)', () => {
    const wrapper = new Error('ToolCallError: model call failed') as Error & { cause: unknown };
    wrapper.cause = fakeApiError(429, 'rate limited downstream', '12');
    const c = classifyUpstreamError(wrapper);
    expect(c.errorClass).toBe('rate_limited');
    expect(c.retryAfter).toBe(12);
  });

  it('the STRUCTURAL status takes precedence over a misleading message', () => {
    // A 503 whose message happens to contain "timeout" is still an upstream_5xx (status wins).
    expect(classifyUpstreamError(fakeApiError(503, 'gateway timeout-ish text')).errorClass).toBe(
      'upstream_5xx',
    );
  });
});

describe('classifyUpstreamError — SDK class NAME (OpenAI agents-core, no status)', () => {
  it('ModelRefusalError → model_refusal', () => {
    const err = new Error('the model refused to produce output');
    err.name = 'ModelRefusalError';
    expect(classifyUpstreamError(err).errorClass).toBe('model_refusal');
  });

  it('MaxTurnsExceededError → timeout (a loop/turn-budget exhaustion)', () => {
    const err = new Error('max turns (8) exceeded');
    err.name = 'MaxTurnsExceededError';
    expect(classifyUpstreamError(err).errorClass).toBe('timeout');
  });

  it('ToolTimeoutError → timeout', () => {
    const err = new Error('tool exceeded its timeout');
    err.name = 'ToolTimeoutError';
    expect(classifyUpstreamError(err).errorClass).toBe('timeout');
  });
});

describe('classifyUpstreamError — MESSAGE heuristics (Anthropic child / stringified, no status)', () => {
  it('a rate-limit message (no status) → rate_limited', () => {
    expect(classifyUpstreamError(new Error('Error: 429 rate limit exceeded')).errorClass).toBe(
      'rate_limited',
    );
    expect(classifyUpstreamError(new Error('quota exceeded for this org')).errorClass).toBe(
      'rate_limited',
    );
  });

  it('an overloaded / 5xx-ish message → upstream_5xx', () => {
    expect(
      classifyUpstreamError(new Error('the service is overloaded, try later')).errorClass,
    ).toBe('upstream_5xx');
    expect(classifyUpstreamError(new Error('502 Bad Gateway')).errorClass).toBe('upstream_5xx');
  });

  it('a timeout message → timeout', () => {
    expect(classifyUpstreamError(new Error('request timed out after 120s')).errorClass).toBe(
      'timeout',
    );
    expect(classifyUpstreamError(new Error('deadline exceeded')).errorClass).toBe('timeout');
  });

  it('a refusal message → model_refusal (matched narrowly, LAST)', () => {
    expect(classifyUpstreamError(new Error('the model refused this request')).errorClass).toBe(
      'model_refusal',
    );
  });
});

describe('classifyUpstreamError — fail-closed default + cause preservation', () => {
  it('a generic / unclassifiable error → internal (never a mis-tag)', () => {
    // The real Pi unknown-model error + the real Anthropic bad-model child message both land here.
    expect(
      classifyUpstreamError(new Error("PiAdapter: unknown OpenAI model '__nonexistent-model__'"))
        .errorClass,
    ).toBe('internal');
    expect(
      classifyUpstreamError(
        new Error(
          'Error: Claude Code returned an error result: There is an issue with the selected model.',
        ),
      ).errorClass,
    ).toBe('internal');
  });

  it('does NOT mis-tag a generic error message as a refusal/throttle', () => {
    // "declined" is NOT the refusal keyword (only refus(e|ed|al) is) — stays internal.
    expect(
      classifyUpstreamError(new Error('the request was declined for reasons')).errorClass,
    ).toBe('internal');
  });

  it('preserves the cause message for a non-Error value, and never throws', () => {
    expect(classifyUpstreamError('plain string failure').message).toBe('plain string failure');
    expect(classifyUpstreamError({ message: 'object with message' }).message).toBe(
      'object with message',
    );
    expect(classifyUpstreamError(null).errorClass).toBe('internal');
  });

  it('every classification result is a member of the neutral ERROR_CLASSES vocabulary', () => {
    const samples: unknown[] = [
      fakeApiError(429, 'x'),
      fakeApiError(503, 'x'),
      fakeApiError(404, 'x'),
      new Error('timed out'),
      (() => {
        const e = new Error('refused');
        e.name = 'ModelRefusalError';
        return e;
      })(),
      new Error('mystery'),
    ];
    for (const s of samples) {
      const cls: ErrorClass = classifyUpstreamError(s).errorClass;
      expect(ERROR_CLASSES).toContain(cls);
      expect(isErrorClass(cls)).toBe(true);
    }
  });
});

describe('classifyUpstreamError — CLS-1: numeric over-breadth (a bare 3-digit number is NOT a status)', () => {
  it('a token count "530 output tokens" → internal (NOT upstream_5xx)', () => {
    // FAIL-THE-FIX: the old `/\b5\d\d\b/` matched any 500–599 number → mis-tagged upstream_5xx.
    expect(
      classifyUpstreamError(new Error('The model produced 530 output tokens')).errorClass,
    ).toBe('internal');
  });

  it('a duration "took 502 ms" → internal (NOT upstream_5xx)', () => {
    expect(classifyUpstreamError(new Error('the call took 502 ms to return')).errorClass).toBe(
      'internal',
    );
  });

  it('a bare "429" in a non-rate-limit sentence → internal (NOT rate_limited)', () => {
    // FAIL-THE-FIX: the old `/\b429\b/` matched a bare 429 anywhere.
    expect(
      classifyUpstreamError(new Error('item 429 of the batch failed to parse')).errorClass,
    ).toBe('internal');
  });

  it('a real server-error CONTEXT phrase still → upstream_5xx (no regression)', () => {
    expect(
      classifyUpstreamError(new Error('the service is overloaded, try later')).errorClass,
    ).toBe('upstream_5xx');
    expect(classifyUpstreamError(new Error('502 Bad Gateway from the proxy')).errorClass).toBe(
      'upstream_5xx',
    );
    expect(
      classifyUpstreamError(new Error('upstream returned an internal server error')).errorClass,
    ).toBe('upstream_5xx');
  });

  it('a "429" ADJACENT to rate-limit wording still → rate_limited (no regression)', () => {
    expect(classifyUpstreamError(new Error('HTTP 429: rate limit exceeded')).errorClass).toBe(
      'rate_limited',
    );
    expect(classifyUpstreamError(new Error('too many requests (code 429)')).errorClass).toBe(
      'rate_limited',
    );
  });

  it('the STRUCTURAL status path is UNCHANGED — a real APIError.status still classifies', () => {
    // CLS-1 only tightens the message-heuristic path; a structural status remains authoritative.
    expect(classifyUpstreamError(fakeApiError(503, 'boom')).errorClass).toBe('upstream_5xx');
    expect(classifyUpstreamError(fakeApiError(429, 'boom')).errorClass).toBe('rate_limited');
    expect(classifyUpstreamError(fakeApiError(400, 'boom')).errorClass).toBe('upstream_4xx');
  });
});

describe('classifyUpstreamError — an UNAMBIGUOUS status indicator (leading / "status code") re-classifies', () => {
  // The Pi no-throw path re-wraps the upstream openai error.message as a bare `new Error(msg)`,
  // STRIPPING `.status` — so a genuinely-transient openai 5xx/429 reaches the MESSAGE path with no
  // structural status. The two real openai SDK APIError.makeMessage forms (doc-first, openai@6.44
  // core/error.js) are `"<status> <body>"` and `"<status> status code (no body)"`. This re-catches
  // these unambiguous status indicators WITHOUT re-introducing the over-broad bare-number match.
  it('the literal openai 500 body "500 The server had an error…" → upstream_5xx', () => {
    // FAIL-THE-FIX: after the CLS-1 context-word tightening this under-classified to internal → an HTTP-1
    // transient 5xx was treated as non-transient (reservation kept, mapped 200 not 502).
    expect(
      classifyUpstreamError(
        new Error('500 The server had an error while processing your request. Sorry about that!'),
      ).errorClass,
    ).toBe('upstream_5xx');
  });

  it('the openai no-body branch "503 status code (no body)" → upstream_5xx', () => {
    // FAIL-THE-FIX: this exact string (APIError.makeMessage no-body branch) under-classified to internal.
    expect(classifyUpstreamError(new Error('503 status code (no body)')).errorClass).toBe(
      'upstream_5xx',
    );
  });

  it('the openai no-body branch "429 status code (no body)" → rate_limited', () => {
    expect(classifyUpstreamError(new Error('429 status code (no body)')).errorClass).toBe(
      'rate_limited',
    );
  });

  it('a leading 429 ("429 Too Many Requests") → rate_limited', () => {
    expect(classifyUpstreamError(new Error('429 Too Many Requests')).errorClass).toBe(
      'rate_limited',
    );
  });

  it('KEEP-GREEN: a mid-sentence number is STILL internal (the CLS-1 guards hold)', () => {
    // The status indicator is leading-or-"status code" ONLY — a mid-sentence 5xx/429 stays internal.
    expect(
      classifyUpstreamError(new Error('The model produced 530 output tokens')).errorClass,
    ).toBe('internal');
    expect(classifyUpstreamError(new Error('the call took 502 ms to return')).errorClass).toBe(
      'internal',
    );
    expect(
      classifyUpstreamError(new Error('item 429 of the batch failed to parse')).errorClass,
    ).toBe('internal');
  });
});

describe('classifyUpstreamError — CLS-2: refusal over-match (a benign field label is NOT a refusal)', () => {
  it('"safety refusal: none" → internal (NOT model_refusal)', () => {
    // FAIL-THE-FIX: the old `/\brefus(?:e|ed|al)\b/` matched the bare noun in a passed field label.
    expect(classifyUpstreamError(new Error('safety refusal: none')).errorClass).toBe('internal');
  });

  it('"refusal: passed" / "refusal: false" → internal', () => {
    expect(classifyUpstreamError(new Error('checks => refusal: passed')).errorClass).toBe(
      'internal',
    );
    expect(classifyUpstreamError(new Error('moderation refusal=false')).errorClass).toBe(
      'internal',
    );
  });

  it('"declined for reasons" (generic) → internal (only "declined TO …" counts)', () => {
    expect(
      classifyUpstreamError(new Error('the request was declined for reasons')).errorClass,
    ).toBe('internal');
  });

  it('a genuine refusal still → model_refusal (no regression)', () => {
    expect(classifyUpstreamError(new Error('the model refused this request')).errorClass).toBe(
      'model_refusal',
    );
    expect(classifyUpstreamError(new Error('the model declined to answer')).errorClass).toBe(
      'model_refusal',
    );
    expect(classifyUpstreamError(new Error('stop_reason: refusal')).errorClass).toBe(
      'model_refusal',
    );
  });
});

describe('classifyUpstreamError — CLS-3/CLS-4/CLS-5: throw-safety, status preference, header parse', () => {
  it('CLS-3: a hostile error with a throwing getter never crashes the classifier → internal', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom in getter');
      },
    };
    // Must not throw; falls back to internal + a safe stringification.
    const c = classifyUpstreamError(hostile);
    expect(c.errorClass).toBe('internal');
    expect(typeof c.message).toBe('string');
  });

  it('CLS-4: an error-range nested cause.status wins over a benign shallow response.status:200', () => {
    // FAIL-THE-FIX: shallowest-wins would have returned 200 (no classification) and fallen through to
    // internal; the error-range preference surfaces the real 500.
    const err = {
      response: { status: 200 },
      cause: { status: 500, message: 'downstream blew up' },
    };
    expect(classifyUpstreamError(err).errorClass).toBe('upstream_5xx');
  });

  it('CLS-5: a number-leading HTTP-date Retry-After is NOT misparsed to a wrong seconds value', () => {
    // A 429 whose Retry-After header is an HTTP-date (RFC 7231) — must NOT parse "21" out of it.
    const err = fakeApiError(429, 'rate limited', 'Wed, 21 Oct 2015 07:28:00 GMT');
    const c = classifyUpstreamError(err);
    expect(c.errorClass).toBe('rate_limited');
    expect(c.retryAfter).toBeUndefined(); // an HTTP-date is not a delta-seconds integer → undefined
  });

  it('CLS-5: a pure-integer Retry-After header is still captured (no regression)', () => {
    const c = classifyUpstreamError(fakeApiError(429, 'rate limited', '  45  '));
    expect(c.retryAfter).toBe(45);
  });
});

describe('errorToMessage + isErrorClass', () => {
  it('errorToMessage preserves an Error string (matches the historical String(err))', () => {
    expect(errorToMessage(new Error('boom'))).toBe('Error: boom');
  });

  it('isErrorClass accepts only the neutral enum values', () => {
    expect(isErrorClass('rate_limited')).toBe(true);
    expect(isErrorClass('internal')).toBe(true);
    expect(isErrorClass('not_a_class')).toBe(false);
    expect(isErrorClass(null)).toBe(false);
    expect(isErrorClass(undefined)).toBe(false);
  });
});
