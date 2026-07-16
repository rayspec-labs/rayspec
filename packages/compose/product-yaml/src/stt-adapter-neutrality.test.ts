/**
 * The STT port's provider-neutral boundary — three source-scan invariants that used to live in the
 * (now-removed) STT-runtime harness and are salvaged here. The compose layer is the correct non-adapter
 * home: `composeProductDeploy` wires the STT adapter (`@rayspec/adapter-deepgram`) into the deploy over
 * the neutral `@rayspec/stt-port` contract, and a compose-layer test may READ the port + adapter source
 * (it never mutates them). The three invariants:
 *
 *   • the neutral STT port (`packages/kernel/stt-port/src`) contains ZERO provider-named symbols —
 *         its shipped modules (the `SttAdapter` contract, transcript types, registry, media-resolver,
 *         normalizer, and fake adapter) must never name a concrete provider. (A source scan — it catches
 *         a provider-named TYPE or id a runtime `Object.keys` check would miss. Test files are excluded:
 *         a test that asserts a provider name is ABSENT legitimately spells it in a negative assertion.)
 *   • the provider-neutral public surface (`types.ts` + the exported `NormalizeTranscriptInput`)
 *         declares ONLY allowlisted field names — a structural oracle (exact set equality), not a
 *         3-token denylist, so a provider-native field leaking into the public contract fails until
 *         the allowlist is deliberately edited (and the addition reviewed as provider-neutral).
 *   • live provider access (a network call OR reading the provider key) is CONFINED to the
 *         manifest-declared provider adapter file(s) plus the one env-gated live integration test.
 *         BOTH the provider adapter package AND the neutral port are scanned; anything else with
 *         network/key access fails closed (the neutral port must be entirely network- and key-free).
 *
 * The adapter source is byte-frozen, so a fail-the-fix that would need to MUTATE it is proven instead
 * on a SYNTHETIC leaky sample (as the port-scan matcher self-test already is). Where a real assertion can go
 * red without mutating the frozen source (the extractor self-test; the real-access detection on the
 * frozen adapter), it does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sttAdapterPackageRoot = join(repoRoot, 'packages/adapters/deepgram');
const sttPortPackageRoot = join(repoRoot, 'packages/kernel/stt-port');
const sttPortSrcRoot = join(sttPortPackageRoot, 'src');
const sttTypesPath = join(sttPortSrcRoot, 'types.ts');
const sttNormalizerPath = join(sttPortSrcRoot, 'normalizer.ts');

/**
 * The manifest-declared confined provider files (the STT-runtime manifest's
 * `provider_adapter_files` + the deepgram adapter's `live_integration_test`): the ONLY files
 * permitted to make a live provider call / read the provider key. Everything else in the package
 * must be network- and key-free (the confinement invariant).
 */
const CONFINED_PROVIDER_FILES = [
  join(sttAdapterPackageRoot, 'src/deepgram-adapter.ts'),
  join(sttAdapterPackageRoot, 'src/deepgram-adapter.live.test.ts'),
];

// ── Confinement scan config — the same constants the removed harness used ─────────
/** Executable source extensions scanned for network/key access (README/manifest can name the strings
 *  legitimately, so non-code files are not scanned). */
const CODE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
]);
/** Directories the whole-package scan never descends into. */
const SCAN_EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'fixtures']);
/** Network-capable module specifiers — importing/requiring any outside the confined set is a breach.
 *  Not exhaustive (a determined evasion can beat a static scan): a loud drift-catcher, not a sandbox. */
const NETWORK_MODULES = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'superagent',
  'ky',
  'phin',
  'needle',
  'request',
  'ws',
  'socket.io-client',
  'eventsource',
]);
/** An env-var name matching this is key-like — reading it outside the confined set is a breach. */
const KEY_LIKE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|DEEPGRAM)/i;

// ── Neutral-surface allowlist ──────────────────────────────────────────────────────────────
/** The COMPLETE set of field names permitted on the provider-neutral public surface (`types.ts` +
 *  the exported `NormalizeTranscriptInput`). The gate diffs the field names extracted by
 *  `extractTypeFieldNames` against this golden list with EXACT set equality, so any new/removed
 *  neutral field forces a deliberate edit here (and, for an addition, a provider-neutrality review)
 *  rather than silently leaking a provider-native field into the public contract. Keep sorted. */
const NEUTRAL_SURFACE_FIELD_ALLOWLIST = new Set<string>([
  'adapter_id',
  'code',
  'confidence',
  'created_at',
  'detect_language',
  'diarization',
  'duration_seconds',
  'end',
  'error',
  'full_text',
  'id',
  'idempotency_key',
  'kind',
  'language',
  'language_hint',
  'language_policy',
  'media_artifact_ref',
  'message',
  'model',
  'model_label',
  'model_policy',
  'now',
  'provider',
  'provider_run_id',
  'punctuated_text',
  'retryable',
  'segment_id',
  'segment_ids',
  'segments',
  'session_id',
  'span_id',
  'spans',
  'speaker',
  'speaker_role',
  'start',
  'status',
  'text',
  'track',
  'tracks',
  'transcript',
  'transcript_id',
  'updated_at',
  'word_ids',
  'words',
]);

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function rel(path: string): string {
  return relative(repoRoot, path).split('\\').join('/');
}

/** Strip `//` line comments and block comments (the port-neutrality scan — a name in prose must not trip). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Blank out `//` line and block comments (string-literal aware, newlines + offsets PRESERVED), so the
 * confinement scan flags actual CODE access — including computed access a literal match misses — but
 * not a comment that merely NAMES a key or `fetch`. Layout is preserved so a breach reports its real
 * line number. Heuristic (not regex-literal aware) — good enough for a drift-catcher.
 */
function blankComments(text: string): string {
  let out = '';
  const n = text.length;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  while (i < n) {
    const c = text[i] ?? '';
    const c2 = text[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i += 2;
      } else if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i += 2;
      } else if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        out += c;
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    // String states: copy through, honour escapes, close on the matching unescaped quote.
    if (c === '\\') {
      out += c + c2;
      i += 2;
      continue;
    }
    out += c;
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }
  return out;
}

/** Extract the module specifiers of every `from '…'` / `require('…')` / `import('…')` / `import '…'`. */
function extractModuleSpecifiers(line: string): string[] {
  const specs: string[] = [];
  const pattern = /\b(?:from|require|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const match of line.matchAll(pattern)) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

/** Scan one file's text for confinement breaches (network access / key read); return {line, signal}. */
function scanForConfinementBreaches(rawText: string): Array<{ line: number; signal: string }> {
  const hits: Array<{ line: number; signal: string }> = [];
  const lines = blankComments(rawText).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    // (1) Network-capable module import/require/dynamic-import.
    for (const spec of extractModuleSpecifiers(line)) {
      const bare = spec.replace(/^node:/, '');
      const head = bare.split('/')[0] ?? bare;
      if (NETWORK_MODULES.has(bare) || NETWORK_MODULES.has(head)) {
        hits.push({ line: lineNo, signal: `network-capable module import '${spec}'` });
      }
    }
    // (2) Global network invocation / alias (a `typeof fetch` TYPE annotation is not an invocation).
    if (/\bfetch\s*\(/.test(line)) {
      hits.push({ line: lineNo, signal: 'global fetch(...) invocation' });
    }
    if (/\b(?:globalThis|global|window|self)\s*\.\s*fetch\b/.test(line)) {
      hits.push({ line: lineNo, signal: 'global object .fetch access' });
    }
    if (/(?:=|\?\?|\(|,)\s*fetch\b/.test(line) && !/typeof\s+fetch/.test(line)) {
      hits.push({ line: lineNo, signal: 'fetch alias / pass-through of the global fetch' });
    }
    if (/\bnew\s+WebSocket\b|\bWebSocket\s*\(/.test(line)) {
      hits.push({ line: lineNo, signal: 'WebSocket' });
    }
    if (/\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/.test(line)) {
      hits.push({ line: lineNo, signal: 'XMLHttpRequest' });
    }
    if (/\bnew\s+EventSource\b|\bEventSource\s*\(/.test(line)) {
      hits.push({ line: lineNo, signal: 'EventSource' });
    }
    if (/\.sendBeacon\s*\(/.test(line)) {
      hits.push({ line: lineNo, signal: 'navigator.sendBeacon' });
    }
    // (3) Key-like env access: literal name, computed `.env[...]`, or a key-like `.env.<NAME>`.
    if (/DEEPGRAM_API_KEY/.test(line)) {
      hits.push({ line: lineNo, signal: 'DEEPGRAM_API_KEY reference' });
    }
    if (/\.env\s*\[/.test(line)) {
      hits.push({ line: lineNo, signal: 'computed .env[...] access (evades a literal key match)' });
    }
    for (const match of line.matchAll(/\.env\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = match[1] ?? '';
      if (KEY_LIKE_ENV.test(name)) {
        hits.push({ line: lineNo, signal: `key-like env access '.env.${name}'` });
      }
    }
  }
  return hits;
}

/** Recursively list executable source files in a package tree, skipping SCAN_EXCLUDED_DIRS. */
function walkCodeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (CODE_FILE_EXTENSIONS.has(extname(entry.name))) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Extract the field names declared on a TypeScript surface — the load-bearing half of the neutral-surface
 * structural allowlist, so it is deliberately more than a line-anchored regex. What it catches:
 *  - FORMATTED one-property-per-line signatures (the common case the biome/lint layer keeps the
 *    surface in);
 *  - COMMENT-SAFE: comments are blanked first (via blankComments), so a field-name-shaped line inside
 *    a `//` or block comment is documentation, not a declared field, and cannot pollute the set;
 *  - PACKED-INLINE: a property is matched at every member boundary — the start of the surface, or
 *    after a `{`, `;`, `,`, or newline — so a property packed after a separator on a shared line
 *    (`{ a: string; leaked_native: string }`), or the first field of an inline object type, is
 *    extracted too, not just the first-on-the-line property a line-anchored `^` would have seen.
 * It stays a heuristic (no full TS parse); a `(param: T)` function-signature parameter is deliberately
 * NOT a boundary (we do not split on `(`), so it stays part of its method signature and is skipped.
 */
function extractTypeFieldNames(text: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:^|[{;,\n])\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/g;
  for (const match of blankComments(text).matchAll(pattern)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/** Return the `{ ... }` body of `interface <name>` (brace-matched), or '' if it is absent. */
function sliceInterfaceBlock(text: string, name: string): string {
  const start = text.indexOf(`interface ${name}`);
  if (start < 0) return '';
  const braceStart = text.indexOf('{', start);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return text.slice(braceStart);
}

describe('STT port neutrality', () => {
  it('the neutral STT port contains zero provider-named symbols in any shipped (non-test) source', () => {
    const offenders: string[] = [];
    for (const path of walkCodeFiles(sttPortSrcRoot)) {
      // A test may assert a provider name is ABSENT, so it legitimately spells it in a negative
      // assertion — the invariant is about the port's SHIPPED modules, not its test harness.
      if (/\.test\.ts$/.test(path)) continue;
      stripComments(readText(path))
        .split('\n')
        .forEach((line, i) => {
          if (/deepgram/i.test(line)) offenders.push(`${rel(path)}:${i + 1}`);
        });
    }
    expect(
      offenders,
      'the neutral STT port (packages/kernel/stt-port/src) must contain NO provider-named symbol in its ' +
        'shipped modules — a concrete provider name here means the port stopped being provider-neutral. ' +
        `Offending site(s): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the scan has teeth: a provider-named symbol in a port source trips it', () => {
    const leaky = stripComments(
      "// neutral header\nexport const ADAPTER_ID = 'deepgram-native';\n",
    );
    expect(/deepgram/i.test(leaky)).toBe(true);
  });
});

describe('STT provider-neutral public surface (structural allowlist)', () => {
  it('the neutral surface (types.ts + NormalizeTranscriptInput) exposes ONLY allowlisted field names', () => {
    const extracted = new Set<string>([
      ...extractTypeFieldNames(readText(sttTypesPath)),
      ...extractTypeFieldNames(
        sliceInterfaceBlock(readText(sttNormalizerPath), 'NormalizeTranscriptInput'),
      ),
    ]);
    const extra = [...extracted]
      .filter((field) => !NEUTRAL_SURFACE_FIELD_ALLOWLIST.has(field))
      .sort();
    const missing = [...NEUTRAL_SURFACE_FIELD_ALLOWLIST]
      .filter((field) => !extracted.has(field))
      .sort();
    expect(
      extra,
      `Neutral surface exposes NON-allowlisted field(s): ${extra.join(', ')}. Any new neutral field ` +
        'must be added to NEUTRAL_SURFACE_FIELD_ALLOWLIST deliberately (and reviewed as provider-neutral) ' +
        '— this guards against a provider-native field leaking in.',
    ).toEqual([]);
    expect(
      missing,
      `NEUTRAL_SURFACE_FIELD_ALLOWLIST is stale — allowlisted field(s) no longer on the surface: ${missing.join(', ')}.`,
    ).toEqual([]);
  });

  it('the field extractor has teeth (self-test): packed-inline fields extracted, commented fields NOT', () => {
    // (1) A property PACKED INLINE after a `;`/`,` separator (or as the first field of an inline
    // `{ ... }` object type) MUST be extracted — a line-anchored regex saw only the first property on
    // the line and let the rest slip past the exact-set diff.
    const packed = [
      'export interface Probe {',
      '  a: string; leaked_native: string;',
      '  nested: { first_native: string; second: number };',
      '}',
    ].join('\n');
    const packedFields = extractTypeFieldNames(packed);
    for (const field of ['a', 'leaked_native', 'nested', 'first_native', 'second']) {
      expect(
        packedFields.has(field),
        `packed-inline field '${field}' was not extracted — a property after a ';'/',' separator or as ` +
          'the first field of an inline object type must not slip past the neutral-surface allowlist diff.',
      ).toBe(true);
    }

    // (2) A field-name-shaped line inside a comment MUST NOT be extracted — documentation naming a
    // field is not a declared field, so the extractor blanks comments before matching.
    const commented = [
      'export interface Probe2 {',
      '  /*',
      '  phantom_field: string',
      '  */',
      '  // ghost_field: string',
      '  real_field: string;',
      '}',
    ].join('\n');
    const commentedFields = extractTypeFieldNames(commented);
    expect(commentedFields.has('real_field')).toBe(true);
    for (const phantom of ['phantom_field', 'ghost_field']) {
      expect(
        commentedFields.has(phantom),
        `comment-only field '${phantom}' must NOT be extracted — a field-name-shaped line inside a ` +
          'comment is documentation, not a declared field.',
      ).toBe(false);
    }
  });

  it('the allowlist has teeth: a synthetic leaked provider-native field is caught by the exact-set diff', () => {
    // Cannot mutate the byte-frozen adapter surface, so prove the diff on a SYNTHETIC leaky surface.
    const leakySurface = [
      'export interface SttTranscript {',
      '  transcript_id: string;',
      '  utterance_channel_index: number; // <- provider-native leak, NOT allowlisted',
      '}',
    ].join('\n');
    const extracted = extractTypeFieldNames(leakySurface);
    const extra = [...extracted].filter((field) => !NEUTRAL_SURFACE_FIELD_ALLOWLIST.has(field));
    expect(extra).toContain('utterance_channel_index');
  });
});

describe('STT live-provider confinement', () => {
  it('confines ALL live provider access to the manifest-declared provider adapter file(s)', () => {
    const declared = new Set(CONFINED_PROVIDER_FILES.map((path) => resolve(path)));
    for (const path of declared) {
      expect(existsSync(path), `declared confined provider file is missing: ${rel(path)}`).toBe(
        true,
      );
    }

    const breaches: string[] = [];
    let confinedFilesWithAccess = 0;
    for (const path of [
      ...walkCodeFiles(sttAdapterPackageRoot),
      ...walkCodeFiles(sttPortPackageRoot),
    ]) {
      const resolved = resolve(path);
      const hits = scanForConfinementBreaches(readText(resolved));
      if (declared.has(resolved)) {
        if (hits.length > 0) confinedFilesWithAccess += 1;
        continue;
      }
      for (const hit of hits) breaches.push(`  - ${rel(resolved)}:${hit.line}: ${hit.signal}`);
    }
    expect(
      breaches,
      'STT confinement breach — network/key access OUTSIDE the declared provider adapter file(s):\n' +
        `${breaches.join('\n')}\n(Static scanning catches honest drift, not a determined evasion; ` +
        'the real confinement is the OS-level sandbox.)',
    ).toEqual([]);
    // Real teeth on the frozen source: the confined adapter MUST actually contain the live access —
    // otherwise the scan is vacuous (it would pass even if the real access moved elsewhere undetected).
    expect(
      confinedFilesWithAccess,
      'Expected the confined provider adapter to actually contain the live network/key access.',
    ).toBeGreaterThanOrEqual(1);
  });

  it('the confinement scanner has teeth: it flags network + key access in a synthetic leaky sample', () => {
    const leaky = [
      "import { request } from 'node:https';",
      'const a = await fetch(url);',
      'const b = globalThis.fetch;',
      'const c = init ?? fetch;',
      'const s = new WebSocket(url);',
      'const k = process.env.DEEPGRAM_API_KEY;',
      'const d = process.env[name];',
    ].join('\n');
    const signals = scanForConfinementBreaches(leaky).map((h) => h.signal);
    expect(signals.some((s) => s.includes("module import 'node:https'"))).toBe(true);
    expect(signals).toContain('global fetch(...) invocation');
    expect(signals).toContain('global object .fetch access');
    expect(signals).toContain('fetch alias / pass-through of the global fetch');
    expect(signals).toContain('WebSocket');
    expect(signals).toContain('DEEPGRAM_API_KEY reference');
    expect(signals.some((s) => s.includes('computed .env[...] access'))).toBe(true);

    // …and a comment that merely NAMES fetch/the key is NOT a breach (blanked before scanning).
    const commentOnly =
      '// this file must never call fetch(...) or read DEEPGRAM_API_KEY\nconst x = 1;';
    expect(scanForConfinementBreaches(commentOnly)).toEqual([]);
  });
});
