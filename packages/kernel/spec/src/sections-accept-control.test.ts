/**
 * THE ACCEPT CONTROL for the two-phase parse: a document on a deployment with NO packs must come out
 * of the section-aware path exactly as it comes out of `parseSpec` — the VALUE when it parses, and
 * the full error list (code, message, path, ORDER) when it does not.
 *
 * A guard that only ever rejects proves nothing, so the corpus deliberately carries both halves:
 *   • every backend and product document checked into `examples/` plus the frozen golden corpus —
 *     the accepting half, and the one that would catch a value that quietly changed shape;
 *   • a rejecting half built here, one defect per document, covering every stage of the pipeline
 *     (YAML syntax, a non-object root, the version check, the reserved document key, the strict
 *     top level, a schema violation, the semantic lint) plus the two unknown-key shapes an
 *     over-broad lift swallows without a trace: an unknown key beside a schema violation, and
 *     several unknown keys at once (one issue, keys in document order).
 *
 * Both halves run through `parseSpec` and through `parseSpecWithSections(text, [])` and are compared
 * after a JSON round-trip, so a difference in key order inside the value fails too.
 *
 * MEASURED TO BITE, not assumed: lifting every non-core key instead of only the claimed ones reds 12
 * cases here (7 of them checked-in documents), and dropping the lint stage from the section path reds
 * the dangling-cross-reference case.
 *
 * The two paths share phase A (`loadSpecDocument`) by construction — this control covers the half
 * that can drift: the strict-shape parse, the error mapping and the lint.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';
import { parseSpecWithSections } from './sections.js';

const goldenDir = fileURLToPath(new URL('./__fixtures__/golden/', import.meta.url));
const examplesDir = fileURLToPath(new URL('../../../../examples/', import.meta.url));

/** Every `*.yaml` under `dir`, recursively, sorted — `node_modules` and build output excluded. */
function yamlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFilesUnder(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }
  return out;
}

/** The accepting half: real checked-in documents (both profiles — a product doc exercises the reject path). */
const corpusFiles = [...yamlFilesUnder(goldenDir), ...yamlFilesUnder(examplesDir)];

/** A stable test name for a corpus file (the last two path segments). */
function label(file: string): string {
  return file.split('/').slice(-2).join('/');
}

/** The rejecting half: one defect per document, one stage of the pipeline per case. */
const BASE = `
version: '1.0'
metadata:
  name: base
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
`;

const brokenDocs: ReadonlyArray<readonly [string, string]> = [
  ['yaml syntax error', 'version: "1.0"\nmetadata: [unclosed\n'],
  ['a non-object root', '- version: "1.0"\n'],
  ['an empty document', ''],
  ['a missing version', 'metadata:\n  name: base\n'],
  ['an unsupported version', BASE.replace("version: '1.0'", "version: '2.0'")],
  ['an unquoted version (the YAML number)', BASE.replace("version: '1.0'", 'version: 1.0')],
  ['a reserved document key', `${BASE}\nmanaged:\n  __proto__: 1\n`],
  ['one unknown top-level key', `${BASE}acme_notes:\n  retentionDays: 30\n`],
  [
    'several unknown top-level keys (order inside the one issue)',
    `${BASE}zzz: 1\naaa: 2\nmmm: 3\n`,
  ],
  [
    'an unknown key AND a schema violation (the issue ORDER)',
    `${BASE.replace('- name: widgets', '- name: WIDGETS')}acme_notes: 1\n`,
  ],
  ['a schema violation', BASE.replace('type: text', 'type: nosuchtype')],
  [
    'a lint failure (a dangling cross-reference)',
    `${BASE}api:\n  - { method: GET, path: '/x', action: { kind: store, store: nope, op: list } }\n`,
  ],
  [
    'an unknown key on a nested strict level',
    `${BASE.replace('name: base', 'name: base\n  nope: 1')}`,
  ],
];

/** Compare the two paths for one document — the whole result, after a JSON round-trip. */
function expectIdentical(raw: string): void {
  const before = parseSpec(raw);
  const after = parseSpecWithSections(raw, []);
  expect(after.ok).toBe(before.ok);
  if (!before.ok) {
    if (after.ok) return;
    expect(JSON.parse(JSON.stringify(after.errors))).toEqual(
      JSON.parse(JSON.stringify(before.errors)),
    );
    return;
  }
  if (!after.ok) return;
  expect(JSON.parse(JSON.stringify(after.value.spec))).toEqual(
    JSON.parse(JSON.stringify(before.value)),
  );
  // No packs ⇒ no claims ⇒ nothing was lifted out of the document.
  expect(after.value.sections).toEqual({});
}

describe('accept control — with no claims the section-aware path IS `parseSpec`', () => {
  it('the corpus carries both halves and is not empty', () => {
    expect(corpusFiles.length).toBeGreaterThanOrEqual(15);
    // At least one checked-in document must PARSE, or the whole corpus proves only that rejection agrees.
    expect(corpusFiles.some((f) => parseSpec(readFileSync(f, 'utf8')).ok)).toBe(true);
    // …and at least one must be refused, or the error path is untested by the file half.
    expect(corpusFiles.some((f) => !parseSpec(readFileSync(f, 'utf8')).ok)).toBe(true);
  });

  for (const file of corpusFiles) {
    it(`${label(file)} parses identically`, () => {
      expectIdentical(readFileSync(file, 'utf8'));
    });
  }

  for (const [name, raw] of brokenDocs) {
    it(`is refused identically: ${name}`, () => {
      // Guard the guard: every case here must really be a rejection.
      expect(parseSpec(raw).ok).toBe(false);
      expectIdentical(raw);
    });
  }
});
