/**
 * The application identity fields: backend `metadata.id` / `metadata.version` and product
 * `product.metadata.id` / `product.metadata.version`.
 *
 * Both are optional. When present they must match the patterns the bundle manifest uses for
 * `application.id` and `application.version`, so a document the grammar accepts carries an identity
 * `rayspec pack` can write. A document without them parses exactly as it did before they existed, and
 * the product profile's other metadata keys stay free-form strings. The exported JSON Schema enforces
 * the same patterns as the parser.
 */
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { exportJsonSchema, exportProductJsonSchema } from './export.js';
import {
  APPLICATION_ID_PATTERN,
  APPLICATION_VERSION_MAX_LENGTH,
  APPLICATION_VERSION_PATTERN,
  Metadata,
} from './grammar.js';
import { parseSpec } from './parse.js';
import { parseProductSpec } from './product-parse.js';

const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => Ajv2020Class;

function backend(metadata: string): string {
  return `version: '1.0'\nmetadata:\n${metadata}\n`;
}

function product(metadata: string | undefined): string {
  return [
    "version: '1.0'",
    'product:',
    '  id: notes_app',
    '  name: Notes',
    ...(metadata === undefined ? [] : ['  metadata:', metadata]),
    '',
  ].join('\n');
}

const GOOD_IDS = ['a', 'notes', 'acme-notes-2', `a${'b'.repeat(62)}`];
const BAD_IDS = ['Notes', '2notes', '-notes', 'notes_app', 'no tes', `a${'b'.repeat(63)}`, ''];
const GOOD_VERSIONS = ['0.0.0', '1.2.3', '10.20.30', '1.0.0-rc.1', '1.0.0-0', '1.0.0-alpha-1.x'];
const BAD_VERSIONS = [
  '1',
  '1.2',
  'v1.2.3',
  '01.2.3',
  '1.2.3+build.5',
  '^1.2.3',
  '1.2.x',
  'latest',
  '1.0.0-',
  '1.0.0-01',
  '1.0.0-..',
  `1.0.0-${'a'.repeat(APPLICATION_VERSION_MAX_LENGTH)}`,
];

describe('backend metadata.id and metadata.version', () => {
  it('pins the metadata keys, so another identity field is a deliberate change', () => {
    expect(Object.keys(Metadata.shape).sort()).toEqual(['description', 'id', 'name', 'version']);
  });

  it.each(GOOD_IDS)('accepts the id %j', (id) => {
    const parsed = parseSpec(backend(`  name: n\n  id: '${id}'`));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.metadata.id).toBe(id);
  });

  it.each(BAD_IDS)('refuses the id %j at metadata.id', (id) => {
    const parsed = parseSpec(backend(`  name: n\n  id: '${id}'`));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.path)).toContain('metadata.id');
  });

  it.each(GOOD_VERSIONS)('accepts the version %j', (version) => {
    const parsed = parseSpec(backend(`  name: n\n  version: '${version}'`));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.metadata.version).toBe(version);
  });

  it.each(BAD_VERSIONS)('refuses the version %j at metadata.version', (version) => {
    const parsed = parseSpec(backend(`  name: n\n  version: '${version}'`));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.path)).toContain('metadata.version');
  });

  it('refuses a non-string version rather than coercing it', () => {
    const parsed = parseSpec(backend('  name: n\n  version: 1.0'));
    expect(parsed.ok).toBe(false);
  });

  it('still refuses an unknown metadata key', () => {
    const parsed = parseSpec(backend('  name: n\n  appId: notes'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.code)).toContain('unknown_field');
  });

  it('parses a document without the fields to the same metadata object as before', () => {
    const parsed = parseSpec(backend('  name: n\n  description: d'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(JSON.stringify(parsed.value.metadata)).toBe('{"name":"n","description":"d"}');
  });

  it('never fills the identity from the name', () => {
    const parsed = parseSpec(backend('  name: notes'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.metadata.id).toBeUndefined();
      expect(parsed.value.metadata.version).toBeUndefined();
    }
  });
});

describe('product metadata.id and metadata.version', () => {
  it('accepts both keys next to free-form metadata', () => {
    const parsed = parseProductSpec(
      product("    id: notes-app\n    version: '2.1.0'\n    team: platform"),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.product.metadata).toEqual({
        id: 'notes-app',
        version: '2.1.0',
        team: 'platform',
      });
    }
  });

  it.each(BAD_IDS)('refuses the id %j at product.metadata.id', (id) => {
    const parsed = parseProductSpec(product(`    id: '${id}'`));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.path)).toContain('product.metadata.id');
  });

  it.each(BAD_VERSIONS)('refuses the version %j at product.metadata.version', (version) => {
    const parsed = parseProductSpec(product(`    version: '${version}'`));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.path)).toContain('product.metadata.version');
  });

  it('keeps every other key a string', () => {
    const parsed = parseProductSpec(product('    team: 3'));
    expect(parsed.ok).toBe(false);
  });

  it('parses a document without the keys to the same metadata object as before', () => {
    const parsed = parseProductSpec(product('    team: platform\n    tier: gold'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(JSON.stringify(parsed.value.product.metadata)).toBe(
        '{"team":"platform","tier":"gold"}',
      );
    }
    const bare = parseProductSpec(product(undefined));
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(Object.hasOwn(bare.value.product, 'metadata')).toBe(false);
  });
});

describe('the exported schemas enforce the identity patterns', () => {
  const ajv = new Ajv2020Ctor({ strict: false, allErrors: true });
  const backendSchema = ajv.compile(exportJsonSchema());
  const productSchema = ajv.compile(exportProductJsonSchema());

  it('backend: accepts a good identity and refuses a bad one', () => {
    const doc = (metadata: Record<string, unknown>) => ({ version: '1.0', metadata });
    expect(backendSchema(doc({ name: 'n', id: 'notes', version: '1.0.0' }))).toBe(true);
    expect(backendSchema(doc({ name: 'n', id: 'Notes' }))).toBe(false);
    expect(backendSchema(doc({ name: 'n', version: '1.0.0+b' }))).toBe(false);
  });

  it('product: accepts a good identity and refuses a bad one', () => {
    const doc = (metadata: Record<string, unknown>) => ({
      version: '1.0',
      product: { id: 'notes_app', name: 'Notes', metadata },
    });
    expect(productSchema(doc({ id: 'notes', version: '1.0.0', team: 'x' }))).toBe(true);
    expect(productSchema(doc({ id: 'Notes' }))).toBe(false);
    expect(productSchema(doc({ version: '1' }))).toBe(false);
  });

  it('carries the same pattern text as the grammar', () => {
    const text = JSON.stringify(exportJsonSchema());
    expect(text).toContain(JSON.stringify(APPLICATION_ID_PATTERN.source));
    expect(text).toContain(JSON.stringify(APPLICATION_VERSION_PATTERN.source));
  });
});
