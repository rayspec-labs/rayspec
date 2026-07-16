/**
 * Config resolution invariants — the record capability's delimiter belt, WIDENED for bytes: `fileRef`/event-id join
 * on ':' AND the blob key embeds the file id as a PATH component (`files/${fileId}`), so a file id
 * that can carry ':' corrupts refs/keys and one that can carry path chars ('/', '\', a '..'/'.'
 * dot-segment) could steer the blob key. The DEFAULT pattern excludes the delimiters by
 * construction; an OVERRIDE that admits any of them is rejected fail-closed at construction
 * (deploy-time loud), and upload/submit carry a point-of-use belt for a hand-built config. The
 * byte cap and the content-type allowlist are ALSO construction-validated (a NaN cap would break
 * the drain bound OPEN — the one override this capability can never accept silently).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_FILE_CONTENT_TYPES,
  DEFAULT_FILE_ID_RE,
  DEFAULT_MAX_FILE_BYTES,
  resolveFileConfig,
} from './config.js';

describe('resolveFileConfig — the file_ref delimiter + blob-path law', () => {
  it("the DEFAULT file-id pattern excludes ':' and path chars (the ref delimiter + blob-key components)", () => {
    for (const probe of [':', 'a:b', ':a', 'a:', '/', 'a/b', '/a', 'a/', '\\', 'a\\b']) {
      expect(DEFAULT_FILE_ID_RE.test(probe), `probe '${probe}'`).toBe(false);
    }
  });

  it("REJECTS at construction a fileIdPattern override that admits ':' — fail-closed, never a corrupt ref", () => {
    for (const pattern of [/^[a-z:]{1,64}$/, /^.{1,64}$/, /^[\x20-\x7e]{1,64}$/]) {
      expect(() => resolveFileConfig({ fileIdPattern: pattern }), String(pattern)).toThrow(/':'/);
    }
  });

  it('REJECTS at construction a fileIdPattern override that admits path chars — the blob key embeds the id', () => {
    for (const pattern of [/^[a-z/]{1,64}$/, /^[a-z\\.]{1,64}$/]) {
      expect(() => resolveFileConfig({ fileIdPattern: pattern }), String(pattern)).toThrow();
    }
  });

  it('accepts a narrowing override that cannot admit any delimiter', () => {
    const resolved = resolveFileConfig({ fileIdPattern: /^[a-z0-9-]{1,32}$/ });
    expect(resolved.fileIdPattern.test('abc-1')).toBe(true);
    expect(resolved.fileIdPattern.test('a:b')).toBe(false);
    expect(resolved.fileIdPattern.test('a/b')).toBe(false);
  });

  it('the defaults resolve as documented (cap + allowlist)', () => {
    const resolved = resolveFileConfig();
    expect(resolved.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect([...resolved.allowedContentTypes].sort()).toEqual(
      [...DEFAULT_ALLOWED_FILE_CONTENT_TYPES].sort(),
    );
  });

  it('REJECTS at construction a maxFileBytes override that would break the drain bound open (NaN/0/negative/fraction)', () => {
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => resolveFileConfig({ maxFileBytes: bad }), String(bad)).toThrow();
    }
    expect(resolveFileConfig({ maxFileBytes: 1024 }).maxFileBytes).toBe(1024);
  });

  it('normalizes allowlist entries (case) and REJECTS malformed entries fail-closed', () => {
    const resolved = resolveFileConfig({ allowedContentTypes: ['Text/Plain'] });
    expect(resolved.allowedContentTypes.has('text/plain')).toBe(true);
    for (const bad of [
      ['text/plain; charset=utf-8'], // parameters are per-request, not allowlist entries
      ['textplain'], // no type/subtype split
      [''],
      ['text/*'], // no wildcards — the allowlist is closed
    ]) {
      expect(() => resolveFileConfig({ allowedContentTypes: bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
