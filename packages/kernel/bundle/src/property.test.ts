/**
 * Property-style tests with generated hostile input, from a fixed seed so every run sees the same
 * cases: entry names built from dangerous fragments, header fields set to hostile values in the
 * local header, the central record or both, end-record fields, single-byte flips at every offset,
 * and every truncation. The reader must answer each with a code and reason from the closed
 * vocabulary, never throw, never repeat a name in its answer, and leave nothing behind when it
 * extracts.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BundleError, ERROR_CODES, isBundleErrorCode } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { extractBundle, inspectBundle } from './index.js';
import { loadExpectations } from './test-support/contract.js';
import {
  bundleEntries,
  type EndFields,
  type HeaderFields,
  type RawEntry,
  rawZip,
} from './test-support/raw-zip.js';

const expectations = loadExpectations();
const baseEntries = bundleEntries(expectations);
const base = rawZip(baseEntries);

/** A small deterministic generator (mulberry32). */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { next, int, pick };
}

type Result = { ok: true } | { ok: false; errors: BundleError[] };

/** The answer is a single error from the closed vocabulary, with a reason the code accepts. */
function expectVocabularyRefusal(r: Result, label: string): void {
  expect(r.ok, label).toBe(false);
  if (r.ok) return;
  expect(r.errors, label).toHaveLength(1);
  const [error] = r.errors;
  expect(isBundleErrorCode(error!.code), `${label}: ${error!.code}`).toBe(true);
  const reasons = ERROR_CODES[error!.code as keyof typeof ERROR_CODES].reasons as readonly string[];
  if (reasons.length > 0) expect(reasons, label).toContain(error!.reason);
  else expect(error!.reason, label).toBeUndefined();
  expect(error!.code, label).not.toBe('RAY_INTERNAL');
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const s of sandboxes) rmSync(s, { recursive: true, force: true });
});

async function expectRefusedAndClean(bytes: Buffer, label: string): Promise<Result> {
  const inspected = await inspectBundle(bytes);
  expectVocabularyRefusal(inspected, label);
  const sandbox = mkdtempSync(join(tmpdir(), 'rayspec-bundle-prop-'));
  sandboxes.push(sandbox);
  const extracted = await extractBundle(bytes, join(sandbox, 'out'));
  expect(extracted, label).toEqual(inspected);
  expect(readdirSync(sandbox), label).toEqual([]);
  return inspected;
}

// ─── hostile names ─────────────────────────────────────────────────────────────────────────────

const FRAGMENTS = [
  'payload/',
  'payload/',
  'PAYLOAD/',
  'ray.json',
  '..',
  '.',
  '/',
  '//',
  '\\',
  'C:',
  'z:',
  '\0',
  'é',
  'é',
  'x',
  'X',
  'a.txt',
  ' ',
  '\n',
  '\x1b[31m',
  '‮',
  '%2e%2e',
  '@scope',
  '+',
  '~',
  'rayspec.yaml',
  'assets',
  'Assets',
];

/** An independent statement of the name rules, in pipeline order, for one extra entry. */
function expectedNameReason(name: Buffer, others: readonly string[]): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(name);
  } catch {
    return name[name.length - 1] === 0x2f ? 'directory-entry' : 'invalid-name-encoding';
  }
  if (text.endsWith('/')) return 'directory-entry';
  if (text.includes('\0')) return 'nul-in-name';
  if (text.includes('\\')) return 'backslash';
  if (/^[A-Za-z]:/.test(text) || text.startsWith('//')) return 'drive-or-unc-path';
  if (text.startsWith('/')) return 'absolute-path';
  if ([...text].some((c) => c.codePointAt(0)! > 0x7f)) return 'non-ascii-name';
  const segments = text.split('/');
  if (segments.includes('')) return 'empty-segment';
  if (segments.some((s) => s === '.' || s === '..')) return 'dot-segment';
  if (text !== 'ray.json' && !text.startsWith('payload/')) return 'outside-payload';
  if (others.includes(text)) return 'duplicate-name';
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (others.some((o) => lower(o) === lower(text))) return 'case-fold-collision';
  const isDirOf = (a: string, b: string) => lower(b).startsWith(`${lower(a)}/`);
  if (others.some((o) => isDirOf(o, text) || isDirOf(text, o))) return 'path-prefix-collision';
  return 'undeclared-entry';
}

describe('generated hostile names', () => {
  const rng = generator(0x5eed_0001);
  const cases: { label: string; name: Buffer }[] = [];
  for (let i = 0; i < 400; i++) {
    const parts = Array.from({ length: 1 + rng.int(6) }, () => rng.pick(FRAGMENTS));
    // A marker that must never appear in an answer.
    parts.splice(rng.int(parts.length + 1), 0, 'zQ9');
    let name = Buffer.from(parts.join(''), 'utf8');
    if (rng.int(8) === 0) name = Buffer.concat([name, Buffer.from([0xff, 0xfe])]);
    cases.push({ label: `name ${i}: ${JSON.stringify(name.toString('latin1'))}`, name });
  }
  const others = baseEntries.map((e) => e.name as string);

  it('each is refused with the reason of the first rule it breaks, and never echoed', async () => {
    const reasons = new Set<string>();
    for (const { label, name } of cases) {
      const entries: RawEntry[] = [...baseEntries, { name, data: 'x' }];
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const r = await expectRefusedAndClean(rawZip(entries), label);
      const want = expectedNameReason(name, others);
      if (!r.ok) {
        expect(r.errors[0]!.reason, label).toBe(want);
        expect(JSON.stringify(r), label).not.toContain('zQ9');
      }
      reasons.add(want);
    }
    // The generator reaches most of the name rules, not one of them over and over.
    expect(reasons.size).toBeGreaterThanOrEqual(10);
  });

  it('names derived from the entries clash as duplicates, by case or as a directory', async () => {
    const payload = others.filter((n) => n.startsWith('payload/'));
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const from = rng.pick(payload);
      let name: string;
      switch (rng.int(4)) {
        case 0:
          name = from;
          break;
        case 1:
          name = `payload/${from
            .slice(8)
            .replace(/[a-z]/g, (c) => (rng.int(2) === 0 ? c.toUpperCase() : c))}`;
          if (name === from)
            name = `payload/${from.slice(8).replace(/[a-z]/, (c) => c.toUpperCase())}`;
          break;
        case 2:
          name = `${from}/${rng.pick(['x', 'X', 'a.txt'])}`;
          break;
        default:
          name = from.slice(0, from.lastIndexOf('/'));
          if (name === 'payload') name = `${from}/x`;
      }
      const label = `derived ${i}: ${name}`;
      const entries: RawEntry[] = [...baseEntries, { name, data: 'x' }];
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const r = await expectRefusedAndClean(rawZip(entries), label);
      const want = expectedNameReason(Buffer.from(name), others);
      if (!r.ok) expect(r.errors[0]!.reason, label).toBe(want);
      reasons.add(want);
    }
    expect([...reasons].sort()).toEqual([
      'case-fold-collision',
      'duplicate-name',
      'path-prefix-collision',
    ]);
  });
});

// ─── hostile header fields ─────────────────────────────────────────────────────────────────────

type NumericField = Exclude<keyof HeaderFields, 'extra' | 'comment' | 'name'>;
const NUMERIC_FIELDS: readonly NumericField[] = [
  'signature',
  'madeBy',
  'needed',
  'flags',
  'method',
  'time',
  'date',
  'crc',
  'csize',
  'usize',
  'nameLength',
  'disk',
  'internal',
  'external',
  'offset',
];
const CENTRAL_ONLY = new Set(['madeBy', 'disk', 'internal', 'external', 'offset', 'comment']);

describe('generated hostile header fields', () => {
  const rng = generator(0x5eed_0002);
  const hostile = (bits: 16 | 32) => {
    const max = bits === 16 ? 0xffff : 0xffffffff;
    return rng.pick([
      0,
      1,
      2,
      8,
      0x800,
      0x801,
      max,
      max - 1,
      rng.int(max + 1),
      20,
      45,
      0x21,
      0x0314,
    ]);
  };
  const width = (f: NumericField): 16 | 32 =>
    ['signature', 'crc', 'csize', 'usize', 'external', 'offset'].includes(f) ? 32 : 16;

  it('every mutation is refused, except the UTF-8 name flag set in both headers', async () => {
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const entries = structuredClone(baseEntries).map((e) => ({
        ...e,
        name: Buffer.from(e.name as string),
        data: Buffer.from(e.data as string),
      })) as RawEntry[];
      const target = entries[rng.int(entries.length)]!;
      const where = rng.pick(['central', 'local', 'both'] as const);
      let label: string;
      let valid = false;
      if (rng.int(6) === 0) {
        const field = rng.pick(['extra', 'comment'] as const);
        const bytes = Buffer.from(Array.from({ length: 1 + rng.int(16) }, () => rng.int(256)));
        const side = field === 'comment' ? 'central' : where;
        if (side !== 'local') target.central = { ...target.central, [field]: bytes };
        if (side !== 'central') target.local = { ...target.local, [field]: bytes };
        label = `${i}: ${field} of ${bytes.length} bytes in ${side}`;
      } else {
        const field = rng.pick(NUMERIC_FIELDS);
        const value = hostile(width(field));
        const side = CENTRAL_ONLY.has(field) ? 'central' : where;
        const canonical = canonicalValue(field, target);
        if (value === canonical) continue;
        if (side !== 'local') target.central = { ...target.central, [field]: value };
        if (side !== 'central') target.local = { ...target.local, [field]: value };
        valid = field === 'flags' && value === 0x800 && side === 'both';
        label = `${i}: ${field}=${value} in ${side} of ${String(target.name)}`;
      }
      const bytes = rawZip(entries);
      if (valid) {
        expect((await inspectBundle(bytes)).ok, label).toBe(true);
        accepted++;
      } else {
        await expectRefusedAndClean(bytes, label);
      }
    }
    expect(accepted).toBeLessThan(40);
  });

  it('the UTF-8 name flag set in both headers of every entry is accepted', async () => {
    const entries = baseEntries.map((e) => ({
      ...e,
      central: { flags: 0x800 },
      local: { flags: 0x800 },
    }));
    expect((await inspectBundle(rawZip(entries))).ok).toBe(true);
  });

  it('every hostile end-record field is refused', async () => {
    const fields: (keyof EndFields)[] = [
      'disk',
      'directoryDisk',
      'onThisDisk',
      'total',
      'directorySize',
      'directoryOffset',
    ];
    for (let i = 0; i < 200; i++) {
      const field = rng.pick(fields);
      const value = hostile(field === 'directorySize' || field === 'directoryOffset' ? 32 : 16);
      const bytes = rawZip(baseEntries, { end: { [field]: value } });
      if (bytes.equals(base)) continue;
      await expectRefusedAndClean(bytes, `${i}: end ${field}=${value}`);
    }
  });
});

function canonicalValue(field: NumericField, entry: RawEntry): number | undefined {
  const fixed: Partial<Record<NumericField, number>> = {
    madeBy: 0x0314,
    needed: 20,
    flags: 0,
    method: 0,
    time: 0,
    date: 0x21,
    disk: 0,
    internal: 0,
    external: 0x81a40000,
    nameLength: (entry.name as Buffer).length,
    csize: (entry.data as Buffer).length,
    usize: (entry.data as Buffer).length,
  };
  return fixed[field];
}

// ─── every byte, every length ──────────────────────────────────────────────────────────────────

describe('single-byte flips and truncations of a valid archive', () => {
  it('a flip of any one byte is refused', async () => {
    const rng = generator(0x5eed_0003);
    for (let at = 0; at < base.length; at++) {
      const bytes = Buffer.from(base);
      bytes[at] = bytes[at]! ^ (1 + rng.int(255));
      const r = await inspectBundle(bytes);
      expectVocabularyRefusal(r, `flip at ${at}`);
    }
  });

  it('every truncation is refused', async () => {
    for (let length = 0; length < base.length; length++) {
      expectVocabularyRefusal(await inspectBundle(base.subarray(0, length)), `length ${length}`);
    }
  });

  it('random trailing and leading bytes are refused', async () => {
    const rng = generator(0x5eed_0004);
    for (let i = 0; i < 100; i++) {
      const extra = Buffer.from(Array.from({ length: 1 + rng.int(64) }, () => rng.int(256)));
      expectVocabularyRefusal(await inspectBundle(Buffer.concat([base, extra])), `trailing ${i}`);
      expectVocabularyRefusal(await inspectBundle(Buffer.concat([extra, base])), `leading ${i}`);
    }
  });
});
