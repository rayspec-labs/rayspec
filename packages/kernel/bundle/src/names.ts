/**
 * The rules an entry name must pass on its own, and the rules a set of names must pass together,
 * in the order the reader pipeline fixes. The reader applies them to every central record; the
 * writer applies the same functions to the paths it is given, so the two cannot disagree.
 */
import type { ErrorReason } from '@rayspec/bundle-contract';
import { PAYLOAD_PREFIX } from './profile.js';

/** Why a single name is refused. `path-length` is a limit; every other reason is archive-level. */
export type NameRefusal =
  | { code: 'RAY_LIMIT_EXCEEDED'; reason: 'path-length' }
  | { code: 'RAY_INVALID_ARCHIVE'; reason: ErrorReason<'RAY_INVALID_ARCHIVE'> };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const archive = (reason: ErrorReason<'RAY_INVALID_ARCHIVE'>): NameRefusal => ({
  code: 'RAY_INVALID_ARCHIVE',
  reason,
});

/**
 * Check one entry name: length, UTF-8, NUL, backslash, drive or UNC prefix, absolute path, ASCII,
 * empty and dot segments, and the root (`rootDocument` itself or a name under `payload/`).
 * Returns the decoded name, or the first rule it breaks.
 */
export function checkEntryName(
  bytes: Uint8Array,
  maxBytes: number,
  rootDocument: string,
): { ok: true; name: string } | { ok: false; refusal: NameRefusal } {
  if (bytes.length > maxBytes) {
    return { ok: false, refusal: { code: 'RAY_LIMIT_EXCEEDED', reason: 'path-length' } };
  }
  let name: string;
  try {
    name = utf8.decode(bytes);
  } catch {
    return { ok: false, refusal: archive('invalid-name-encoding') };
  }
  if (name.includes('\0')) return { ok: false, refusal: archive('nul-in-name') };
  if (name.includes('\\')) return { ok: false, refusal: archive('backslash') };
  if (/^[A-Za-z]:/.test(name) || name.startsWith('//')) {
    return { ok: false, refusal: archive('drive-or-unc-path') };
  }
  if (name.startsWith('/')) return { ok: false, refusal: archive('absolute-path') };
  if (!isAscii(name)) return { ok: false, refusal: archive('non-ascii-name') };
  const segments = name.split('/');
  if (segments.some((s) => s === '')) return { ok: false, refusal: archive('empty-segment') };
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, refusal: archive('dot-segment') };
  }
  if (name !== rootDocument && !name.startsWith(PAYLOAD_PREFIX)) {
    return { ok: false, refusal: archive('outside-payload') };
  }
  return { ok: true, name };
}

/**
 * Check a list of names that each passed `checkEntryName`, in archive order: exact duplicates,
 * names equal after ASCII lowercasing, names equal after NFC, a name that is the directory of
 * another after lowercasing, and strictly increasing byte order. Returns the first reason found.
 */
export function checkNameSet(names: readonly string[]): ErrorReason<'RAY_INVALID_ARCHIVE'> | null {
  const exact = new Set<string>();
  for (const name of names) {
    if (exact.has(name)) return 'duplicate-name';
    exact.add(name);
  }
  const folded = new Set<string>();
  for (const name of names) {
    const lower = asciiLower(name);
    if (folded.has(lower)) return 'case-fold-collision';
    folded.add(lower);
  }
  const normalized = new Set<string>();
  for (const name of names) {
    const nfc = name.normalize('NFC');
    if (normalized.has(nfc)) return 'normalization-collision';
    normalized.add(nfc);
  }
  for (const name of names) {
    const lower = asciiLower(name);
    for (let i = lower.indexOf('/'); i >= 0; i = lower.indexOf('/', i + 1)) {
      if (folded.has(lower.slice(0, i))) return 'path-prefix-collision';
    }
  }
  for (let i = 1; i < names.length; i++) {
    if (compareBytes(names[i - 1]!, names[i]!) >= 0) return 'entry-order';
  }
  return null;
}

function isAscii(name: string): boolean {
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Lowercase A to Z only; every other character is left as it is. */
export function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Order two names by their UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
