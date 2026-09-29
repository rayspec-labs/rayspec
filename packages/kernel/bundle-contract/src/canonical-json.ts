/**
 * Canonical JSON for bundle artifacts: `ray.json`, `snapshot.json`, the object index, signature
 * files and every digest input of the runtime-control operations.
 *
 * The form:
 *   - UTF-8 without a byte order mark; every string, key included, is Unicode NFC and well formed
 *     (no lone surrogates);
 *   - object keys sorted by Unicode code point, which equals sorting their UTF-8 bytes. This is
 *     not RFC 8785, which sorts by UTF-16 code units; the two disagree only for keys mixing
 *     characters above U+FFFF with characters from U+E000 to U+FFFF. Integer-like keys sort as
 *     strings, never in JavaScript enumeration order;
 *   - no duplicate keys and no insignificant whitespace;
 *   - numbers are safe integers written in shortest form; `-0`, fractions and exponents are
 *     refused;
 *   - strings escape exactly what `JSON.stringify` escapes for a well-formed string;
 *   - at most 64 nested containers;
 *   - a canonical file is the canonical text plus one LF; a digest input is the text alone.
 *
 * This is a new serializer on purpose. The three older ones in the repository
 * (`packages/kernel/core/src/hash.ts`, `packages/capabilities/record-runtime/src/canonical-json.ts`,
 * `packages/workflow/nodes/grounding-runtime/src/hash.ts`) sort differently or accept floats, and
 * stored hashes depend on their output, so they stay as they are.
 */

/** The deepest container nesting the form allows; the outermost container counts as one. */
export const MAX_JSON_DEPTH = 64;

/** A value the canonical form cannot represent. `path` is a JSON pointer to the offending member. */
export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message} at ${path === '' ? '/' : path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/**
 * Order two strings by Unicode code point. At the first differing UTF-16 unit, a surrogate
 * (0xD800 to 0xDFFF) is moved above the units 0xE000 to 0xFFFF, which turns code-unit order into
 * code-point order.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rankUnit(x) - rankUnit(y);
  }
  return a.length - b.length;
}

function rankUnit(unit: number): number {
  if (unit >= 0xd800 && unit <= 0xdfff) return unit + 0x2000;
  if (unit >= 0xe000) return unit - 0x800;
  return unit;
}

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Whether a string is well formed (no lone surrogate) and in Unicode NFC. */
export function isCanonicalString(value: string): boolean {
  return !LONE_SURROGATE.test(value) && value.normalize('NFC') === value;
}

/** The canonical text of a value (the digest input form, without the trailing LF). */
export function canonicalJson(value: unknown): string {
  return write(value, '', 0);
}

/** The canonical file form of a value: the canonical text plus one LF. */
export function canonicalJsonFile(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function write(value: unknown, path: string, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new CanonicalJsonError(path, 'number is not a safe integer other than -0');
      }
      return String(value);
    case 'string':
      if (!isCanonicalString(value)) {
        throw new CanonicalJsonError(path, 'string is not well-formed Unicode NFC');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `a ${typeof value} has no JSON form`);
  }
  if (depth + 1 > MAX_JSON_DEPTH) {
    throw new CanonicalJsonError(path, `nesting exceeds ${MAX_JSON_DEPTH} containers`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new CanonicalJsonError(`${path}/${i}`, 'array hole');
      parts.push(write(value[i], `${path}/${i}`, depth + 1));
    }
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(path, 'only plain objects have a JSON form');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  const parts: string[] = [];
  for (const key of keys) {
    const member = `${path}/${escapePointer(key)}`;
    if (!isCanonicalString(key)) {
      throw new CanonicalJsonError(member, 'key is not well-formed Unicode NFC');
    }
    parts.push(`${JSON.stringify(key)}:${write(record[key], member, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Escape one JSON pointer token (RFC 6901). */
export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

// ─── strict parsing ────────────────────────────────────────────────────────────────────────────

/** Why a JSON document was refused, in the reasons of the closed vocabulary. */
export type JsonDocumentFailure =
  | { code: 'RAY_LIMIT_EXCEEDED'; reason: 'manifest-size' | 'json-depth' }
  | {
      code: 'RAY_MANIFEST_INVALID';
      reason:
        | 'bom'
        | 'invalid-utf8'
        | 'invalid-json'
        | 'duplicate-key'
        | 'float'
        | 'non-nfc'
        | 'not-canonical';
    };

export type JsonDocumentResult =
  | { ok: true; value: unknown }
  | { ok: false; failure: JsonDocumentFailure };

export interface JsonDocumentOptions {
  /** Refuse a document longer than this many bytes (`manifest-size`). */
  maxBytes: number;
  /** Refuse nesting deeper than this many containers (`json-depth`). */
  maxDepth: number;
  /** Also require the exact canonical file bytes (canonical text plus one LF). */
  canonical: boolean;
}

/**
 * Parse a JSON document under the canonical rules, checking in the order the reader pipeline
 * fixes: size, byte order mark, UTF-8, nesting depth, JSON syntax, duplicate keys, fractions and
 * exponents, NFC, and finally integer range, `-0` and (when `canonical`) the exact bytes.
 *
 * Never throws. Objects are built with own data properties only, so a `__proto__` key is an
 * ordinary member and never reaches a prototype.
 */
export function parseJsonDocument(
  input: Uint8Array,
  options: JsonDocumentOptions,
): JsonDocumentResult {
  if (input.length > options.maxBytes)
    return fail({ code: 'RAY_LIMIT_EXCEEDED', reason: 'manifest-size' });
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'bom' });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'invalid-utf8' });
  }
  if (lexicalDepth(text) > options.maxDepth)
    return fail({ code: 'RAY_LIMIT_EXCEEDED', reason: 'json-depth' });

  const parser = new StrictParser(text, options.maxDepth);
  let value: unknown;
  try {
    value = parser.parseDocument();
  } catch (err) {
    if (err instanceof DepthExceeded)
      return fail({ code: 'RAY_LIMIT_EXCEEDED', reason: 'json-depth' });
    if (err instanceof SyntaxFault)
      return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'invalid-json' });
    throw err;
  }
  if (parser.duplicateKey) return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'duplicate-key' });
  if (parser.fraction) return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'float' });
  if (parser.nonNfc) return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'non-nfc' });
  if (parser.unsafeNumber || parser.loneSurrogate) {
    return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'not-canonical' });
  }
  if (options.canonical && !reproducesCanonically(value, text)) {
    return fail({ code: 'RAY_MANIFEST_INVALID', reason: 'not-canonical' });
  }
  return { ok: true, value };
}

function fail(failure: JsonDocumentFailure): JsonDocumentResult {
  return { ok: false, failure };
}

function reproducesCanonically(value: unknown, text: string): boolean {
  try {
    return canonicalJsonFile(value) === text;
  } catch (err) {
    if (err instanceof CanonicalJsonError) return false;
    throw err;
  }
}

/** The deepest bracket nesting outside strings, measured before any parse. */
function lexicalDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

class SyntaxFault extends Error {}
class DepthExceeded extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/** A recursive-descent parser for RFC 8259 JSON that records every non-canonical feature it sees. */
class StrictParser {
  private pos = 0;
  duplicateKey = false;
  fraction = false;
  nonNfc = false;
  unsafeNumber = false;
  loneSurrogate = false;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) throw new SyntaxFault();
    return value;
  }

  private parseValue(depth: number): unknown {
    const c = this.text[this.pos];
    if (c === '{') return this.parseObject(depth + 1);
    if (c === '[') return this.parseArray(depth + 1);
    if (c === '"') return this.parseString();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.pos)) return this.literal(4, true);
    if (this.text.startsWith('false', this.pos)) return this.literal(5, false);
    if (this.text.startsWith('null', this.pos)) return this.literal(4, null);
    throw new SyntaxFault();
  }

  private literal<T>(length: number, value: T): T {
    this.pos += length;
    return value;
  }

  private parseObject(depth: number): Record<string, unknown> {
    if (depth > this.maxDepth) throw new DepthExceeded();
    this.pos++;
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      if (this.text[this.pos] !== '"') throw new SyntaxFault();
      const key = this.parseString();
      if (seen.has(key)) this.duplicateKey = true;
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') throw new SyntaxFault();
      this.pos++;
      this.skipWhitespace();
      const value = this.parseValue(depth);
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos++;
      if (next === '}') return out;
      if (next !== ',') throw new SyntaxFault();
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    if (depth > this.maxDepth) throw new DepthExceeded();
    this.pos++;
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue(depth));
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos++;
      if (next === ']') return out;
      if (next !== ',') throw new SyntaxFault();
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.pos++;
    let out = '';
    let run = this.pos;
    for (;;) {
      const code = this.text.charCodeAt(this.pos);
      if (Number.isNaN(code) || code < 0x20) throw new SyntaxFault();
      if (code === 0x22) {
        out += this.text.slice(run, this.pos);
        this.pos++;
        break;
      }
      if (code === 0x5c) {
        out += this.text.slice(run, this.pos);
        out += this.parseEscape();
        run = this.pos;
        continue;
      }
      this.pos++;
    }
    if (LONE_SURROGATE.test(out)) this.loneSurrogate = true;
    else if (out.normalize('NFC') !== out) this.nonNfc = true;
    return out;
  }

  private parseEscape(): string {
    const c = this.text[this.pos + 1];
    this.pos += 2;
    switch (c) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxFault();
        this.pos += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new SyntaxFault();
    }
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new SyntaxFault();
    const token = match[0];
    this.pos += token.length;
    if (match[1] !== undefined || match[2] !== undefined) {
      this.fraction = true;
      return 0;
    }
    const value = Number(token);
    // The explicit range and -0 checks matter: a re-serialization reproduces some out-of-range
    // integers, such as 2^60, byte for byte.
    if (!Number.isSafeInteger(value) || token === '-0') this.unsafeNumber = true;
    return value;
  }

  private skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }
}
