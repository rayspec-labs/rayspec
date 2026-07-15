/**
 * the record input-normalize config resolve + schema build + builder (product-boot.ts), fail-closed
 * arms (no DB, no network — pure config/schema law; the wired end-to-end path is the
 * record-normalize e2e's normalize arm):
 *
 *  - the STRICT `record/<agent_id>.normalizer.json` convention: missing dir / a declared agent with no
 *    matching config file / an `agent_id` that does not match the declared id / a non-SafeIdentifier
 *    stem / missing instructions/model/backend / an unknown top-level key / an invalid
 *    structured_output_mode — each a named ProductBootError (never a silent default);
 *  - `buildNormalizeOutputSchema`: the declared `output_contract` → a faithful JSON Schema 2020-12
 *    (additional_properties→additionalProperties, nullable union, nested properties/items/required),
 *    inline ref resolution, cyclic/unresolved ref fail-closed;
 *  - `buildRecordNormalizer` mode law: RAYSPEC_NORMALIZE_MODE demanded; an unknown mode rejected;
 *    `deterministic` without the injected Backend rejected; `live` with an unknown backend id rejected
 *    NAMING the normalizer; a native demand on an emulating backend (pi) rejected at boot; a valid
 *    deterministic build yields a factory whose instances carry the config agent id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import type { ProductSpec } from '@rayspec/spec';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNormalizeOutputSchema,
  buildRecordNormalizer,
  resolveRecordNormalizerConfig,
} from './product-boot.js';

const DB = {} as Db;
const FAKE_BACKEND = { id: 'openai' } as unknown as Backend;
const PI_BACKEND = { id: 'pi' } as unknown as Backend;
const OUTPUT_CONTRACT = 'intake.normalized';
const DECL = { agent: 'field_normalizer', output_contract: OUTPUT_CONTRACT };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Build a throwaway product dir with a spec path + optional record/ files. */
function productDir(files: Record<string, unknown> | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'record-normalizer-'));
  dirs.push(root);
  if (files !== undefined) {
    mkdirSync(join(root, 'record'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(root, 'record', name),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
  }
  return join(root, 'product.yaml');
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'field_normalizer',
    instructions: 'Normalize the submitted fields.',
    model: 'test-model',
    backend: 'openai',
    ...overrides,
  };
}

const OBJECT_CONTRACT = {
  type: 'object',
  additional_properties: false,
  properties: { title: { type: 'string' }, priority: { type: 'string' } },
  required: ['title', 'priority'],
};
function specWith(contracts: Record<string, unknown>): ProductSpec {
  return { contracts } as unknown as ProductSpec;
}

describe('resolveRecordNormalizerConfig — the strict <agent_id>.normalizer.json convention', () => {
  it('resolves a valid config keyed by the DECLARED agent id (stem = agent id)', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': validConfig() });
    const cfg = resolveRecordNormalizerConfig(specPath, 'field_normalizer');
    expect(cfg.agentId).toBe('field_normalizer');
    expect(cfg.model).toBe('test-model');
  });

  it('fail-closes on a MISSING record/ dir', () => {
    const specPath = productDir(undefined);
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /does not exist/,
    );
  });

  it('fail-closes when the DECLARED agent has no matching config file', () => {
    const specPath = productDir({ 'other.normalizer.json': validConfig({ agent_id: 'other' }) });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /needs its config at .* which does not/,
    );
  });

  it('fail-closes on an agent_id that does not match the DECLARED id (the extractor law)', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ agent_id: 'other' }),
    });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /names agent 'other'/,
    );
  });

  it('fail-closes on missing/empty instructions, model, and backend (each named)', () => {
    for (const [field, pattern] of [
      ['instructions', /'instructions' must be a non-empty string/],
      ['model', /'model' must be a non-empty string/],
      ['backend', /'backend' must name one of the wired backends/],
    ] as const) {
      const specPath = productDir({
        'field_normalizer.normalizer.json': validConfig({ [field]: '' }),
      });
      expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(pattern);
    }
  });

  it('an UNKNOWN backend id fail-closes NAMING the id AND the wired set', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ backend: 'skynet' }),
    });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /'skynet' is not wired.*openai \| anthropic \| pi \| codex/s,
    );
  });

  it('an unknown TOP-LEVEL key is a loud boot reject (strict parsing)', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ modle: 'gpt' }),
    });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /unknown key\(s\).*modle/s,
    );
  });

  it('an invalid structured_output_mode is a loud boot reject', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ structured_output_mode: 'strict' }),
    });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /structured_output_mode 'strict' is invalid/,
    );
  });

  it('fail-closes on unparseable JSON', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': '{ not json' });
    expect(() => resolveRecordNormalizerConfig(specPath, 'field_normalizer')).toThrow(
      /could not read\/parse/,
    );
  });
});

describe('buildNormalizeOutputSchema — the declared output_contract → native JSON schema', () => {
  it('translates the closed contract vocabulary faithfully (additional_properties→additionalProperties, nullable union, nested items, required)', () => {
    const schema = buildNormalizeOutputSchema(OUTPUT_CONTRACT, {
      [OUTPUT_CONTRACT]: {
        type: 'object',
        additional_properties: false,
        properties: {
          title: { type: 'string' },
          note: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'note', 'tags'],
      },
    } as unknown as ProductSpec['contracts']);
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        note: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'note', 'tags'],
    });
  });

  it('INLINE-resolves a ref against the same contracts map (a self-contained schema, never an external $ref)', () => {
    const schema = buildNormalizeOutputSchema('root', {
      root: {
        type: 'object',
        additional_properties: false,
        properties: { inner: { ref: 'leaf' } },
        required: ['inner'],
      },
      leaf: {
        type: 'object',
        additional_properties: false,
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
    } as unknown as ProductSpec['contracts']);
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        inner: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' } },
          required: ['x'],
        },
      },
      required: ['inner'],
    });
  });

  it('fail-closes on a CYCLIC ref (a bounded structured-output schema cannot be self-referential)', () => {
    expect(() =>
      buildNormalizeOutputSchema('a', {
        a: { type: 'object', properties: { self: { ref: 'a' } } },
      } as unknown as ProductSpec['contracts']),
    ).toThrow(/CYCLIC/);
  });

  it('fail-closes on an unresolved output_contract', () => {
    expect(() =>
      buildNormalizeOutputSchema('missing', {} as unknown as ProductSpec['contracts']),
    ).toThrow(/does not resolve/);
  });
});

describe('buildRecordNormalizer — the mode law + config/schema threading', () => {
  const spec = specWith({ [OUTPUT_CONTRACT]: OBJECT_CONTRACT });

  it('demands RAYSPEC_NORMALIZE_MODE (fail-closed absent)', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': validConfig() });
    expect(() => buildRecordNormalizer({}, specPath, spec, DB, {}, DECL)).toThrow(
      /RAYSPEC_NORMALIZE_MODE is required/,
    );
  });

  it('rejects an unknown mode (wired: live | deterministic)', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': validConfig() });
    expect(() =>
      buildRecordNormalizer({ RAYSPEC_NORMALIZE_MODE: 'yolo' }, specPath, spec, DB, {}, DECL),
    ).toThrow(/'yolo' is not supported/);
  });

  it('deterministic mode REQUIRES the injected Backend (the proof seam)', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': validConfig() });
    expect(() =>
      buildRecordNormalizer(
        { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
        specPath,
        spec,
        DB,
        {},
        DECL,
      ),
    ).toThrow(/requires an injected deterministic normalize Backend/);
  });

  it('live mode with an UNKNOWN backend id fail-closes NAMING the normalizer', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ backend: 'skynet' }),
    });
    expect(() =>
      buildRecordNormalizer({ RAYSPEC_NORMALIZE_MODE: 'live' }, specPath, spec, DB, {}, DECL),
    ).toThrow(/normalizer 'field_normalizer'.*'skynet' is not wired/s);
  });

  it('a NATIVE demand on an emulating backend (pi) fail-closes AT BOOT (the extractor mirror)', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({ backend: 'pi' }),
    });
    expect(() =>
      buildRecordNormalizer(
        { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
        specPath,
        spec,
        DB,
        {
          deterministicNormalizerBackend: PI_BACKEND,
        },
        DECL,
      ),
    ).toThrow(/only EMULATES it/);
  });

  it('a VALID deterministic build yields a factory whose instances carry the config agent id', () => {
    const specPath = productDir({ 'field_normalizer.normalizer.json': validConfig() });
    const factory = buildRecordNormalizer(
      { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
      specPath,
      spec,
      DB,
      { deterministicNormalizerBackend: FAKE_BACKEND },
      DECL,
    );
    expect(factory('tenant-x').agentId).toBe('field_normalizer');
  });

  it('structured_output_mode: validated ALLOWS an emulating backend (pi) — no native demand', () => {
    const specPath = productDir({
      'field_normalizer.normalizer.json': validConfig({
        backend: 'pi',
        structured_output_mode: 'validated',
      }),
    });
    const factory = buildRecordNormalizer(
      { RAYSPEC_NORMALIZE_MODE: 'deterministic' },
      specPath,
      spec,
      DB,
      { deterministicNormalizerBackend: PI_BACKEND },
      DECL,
    );
    expect(factory('t').agentId).toBe('field_normalizer');
  });
});
