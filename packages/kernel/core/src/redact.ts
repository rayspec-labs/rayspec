/**
 * The one redaction path: every log line, error envelope, receipt and trace the platform writes goes
 * through `redactText` (a string) or `redactValue` (a JSON value) before it leaves the process or
 * reaches the database.
 *
 * TWO KINDS OF MATCH.
 *  1. VALUES THIS PROCESS HOLDS. The boot registers every secret it resolves — the boot secrets, the
 *     provider credentials, the binding values a deploy supplied — with `registerSecretValues`, and
 *     every occurrence of one is replaced, wherever it appears. A value shorter than
 *     {@link MIN_REGISTERED_LENGTH} characters is not registered: a short value (`1`, `true`, a
 *     region name) occurs in ordinary text, and replacing it would corrupt every line that contains
 *     it without protecting anything.
 *  2. SHAPES OF A CREDENTIAL, whoever holds it: a bearer token, the value of an `authorization`,
 *     `proxy-authorization`, `cookie`, `set-cookie` or `x-api-key` header (in header or JSON form),
 *     the password of a URL, a PEM private key, a JSON web token, a RaySpec API key, and a
 *     provider key of the `sk-…` form.
 *
 * WHAT IT DOES NOT DO. It is a last line, not a licence to log secrets: a value split across two
 * writes, encoded (base64, URL-encoded) or transformed before it is written is not recognised, and a
 * short value is not registered at all. Code still names a credential, never prints it.
 */

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** The shortest value `registerSecretValues` records; see the module comment. */
export const MIN_REGISTERED_LENGTH = 8;

const registered = new Set<string>();
/** The registered values, longest first, so a value that contains another is replaced whole. */
let ordered: string[] = [];

/**
 * Record secret values this process holds, so every later occurrence is redacted. Blank, missing and
 * too-short values are ignored. Values are compared exactly, after the surrounding whitespace is
 * trimmed, as every reader of a secret trims it.
 */
export function registerSecretValues(values: Iterable<string | undefined | null>): void {
  let changed = false;
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length < MIN_REGISTERED_LENGTH || registered.has(value)) continue;
    registered.add(value);
    changed = true;
    // A multi-line value (a PEM) is also matched line by line: a logger may print one line of it.
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_REGISTERED_LENGTH && !trimmed.startsWith('-----')) {
        registered.add(trimmed);
      }
    }
  }
  if (changed) ordered = [...registered].sort((a, b) => b.length - a.length);
}

/** TEST-ONLY. Forget every registered value. */
export function resetRegisteredSecretsForTests(): void {
  registered.clear();
  ordered = [];
}

/** The credential shapes, each with its replacement. Every pattern is linear: no nested repetition. */
const SHAPES: readonly [RegExp, string][] = [
  // A PEM private key block, whatever its type.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  ],
  // A credential header in header form: `Authorization: …` up to the end of the line.
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)[^\r\n]+/gi,
    `$1$2${REDACTED}`,
  ],
  // The same header in JSON form: `"authorization": "…"`.
  [
    /("(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${REDACTED}"`,
  ],
  // A bearer token anywhere.
  [/\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`],
  // The password of a URL: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // A JSON web token: three base64url parts, the first two of which encode JSON objects.
  [/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, REDACTED],
  // A RaySpec API key plaintext: `rk_<prefix>.<secret>`.
  [/\brk_[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  // A provider key of the `sk-…` form (OpenAI, Anthropic).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
];

/** Redact one string: every registered value, then every credential shape. */
export function redactText(text: string): string {
  let out = text;
  for (const value of ordered) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  for (const [pattern, replacement] of SHAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact a JSON value: every string in it, at any depth, and the value of a property whose NAME is a
 * credential header or a secret-like name. Returns a new value; the input is not changed. A cycle or
 * a depth past 32 is replaced, never followed.
 */
export function redactValue<T>(value: T): T {
  return redactAt(value, 0, new WeakSet()) as T;
}

const SECRET_PROPERTY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key)$/i;

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32 || seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactAt(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SECRET_PROPERTY.test(key) && item !== null && item !== undefined && item !== ''
        ? REDACTED
        : redactAt(item, depth + 1, seen);
  }
  return out;
}

/** A stream whose `write` the redaction wraps (`process.stdout`, `process.stderr`). */
interface WritableLike {
  write: (...args: never[]) => boolean;
}

const wrappedStreams = new WeakSet<object>();

/**
 * Route every write to these streams through `redactText`: the log lines of this process, whoever
 * prints them (`console.*`, a library's logger, a handler). A string chunk is redacted as is; a byte
 * chunk is decoded as UTF-8, and replaced only when redaction changed it. Idempotent per stream.
 *
 * A secret split across two writes is not recognised; `console.*` writes a whole line at once.
 */
export function installOutputRedaction(
  streams: readonly WritableLike[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (wrappedStreams.has(stream)) continue;
    wrappedStreams.add(stream);
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    const redacting = (chunk: unknown, ...rest: unknown[]): boolean => {
      let out = chunk;
      if (typeof chunk === 'string') {
        out = redactText(chunk);
      } else if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
        const redacted = redactText(text);
        if (redacted !== text) out = Buffer.from(redacted, 'utf8');
      }
      return original(out, ...rest);
    };
    (stream as { write: unknown }).write = redacting;
  }
}
