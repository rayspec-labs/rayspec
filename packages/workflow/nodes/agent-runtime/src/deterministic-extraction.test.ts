import { describe, expect, it } from 'vitest';
import {
  type DeterministicExtractionSchema,
  DeterministicExtractionSchemaError,
  deterministicExtractionHandler,
  extractLabelledRecord,
  normalizeLabel,
  parseDeterministicExtractionSchema,
} from './deterministic-extraction.js';
import type { AgentRuntimeExecutionInput } from './types.js';

const SCHEMA = parseDeterministicExtractionSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    quantity: { type: 'integer' },
    weight: { type: ['number', 'null'] },
    urgent: { type: ['boolean', 'null'] },
    issued_on: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          count: { type: ['integer', 'null'] },
        },
      },
    },
    nested: { type: ['object', 'null'] },
  },
  required: ['title', 'quantity', 'tags', 'lines'],
});

function input(
  values: unknown[],
  outputs = [{ name: 'record', ref: 'doc.record', kind: 'record', schema_ref: 'doc.record' }],
): AgentRuntimeExecutionInput {
  return {
    operation: 'agent.doc_extractor',
    intent: 'record',
    artifact_inputs: values.map((value, i) => ({
      name: `in${i}`,
      ref: `doc.in${i}`,
      kind: 'text',
      required: true,
      value,
    })),
    artifact_outputs: outputs,
    required_output_shape: { schema_ref: 'doc.record' },
    acceptance_boundary: { type: 'validation_node', requires: ['validation.check'] },
  };
}

describe('the deterministic extraction provider', () => {
  it('reads labelled lines into the declared properties, converting each to its type', () => {
    const text = [
      'Title: Quarterly stock count',
      'Quantity: 42',
      'Weight: 12.5',
      'Urgent: yes',
      'Issued on: 2026-05-01',
      'Tags: storage',
      'Tags: north wing',
      'Lines: shelving units | 4',
      'Lines: ladders | ',
      'A line without a colon is ignored',
    ].join('\n');
    expect(extractLabelledRecord(text, SCHEMA)).toEqual({
      title: 'Quarterly stock count',
      quantity: 42,
      weight: 12.5,
      urgent: true,
      issued_on: '2026-05-01',
      tags: ['storage', 'north wing'],
      lines: [
        { description: 'shelving units', count: 4 },
        { description: 'ladders', count: null },
      ],
      nested: null,
    });
  });

  it('keeps non-ASCII text as it is', () => {
    const record = extractLabelledRecord('Title: Größe – 東京 ✓\nQuantity: 1', SCHEMA);
    expect(record.title).toBe('Größe – 東京 ✓');
  });

  it('takes the first value that converts, and nulls or leaves out what none gives', () => {
    const text = ['Quantity: twelve', 'Quantity: 12', 'Weight: 1,5', 'Urgent: maybe'].join('\n');
    const record = extractLabelledRecord(text, SCHEMA);
    expect(record.quantity).toBe(12);
    // Nullable and unconvertible: null. Not nullable and absent: left out.
    expect(record.weight).toBeNull();
    expect(record.urgent).toBeNull();
    expect('title' in record).toBe(false);
    expect(record.tags).toEqual([]);
    expect(record.lines).toEqual([]);
  });

  it('accepts no thousands separators, no symbols and no integer outside the safe range', () => {
    const big = String(Number.MAX_SAFE_INTEGER + 2);
    expect(Number.isSafeInteger(Number(big))).toBe(false);
    for (const raw of ['1,000', '€12', '12.0', '0x10', '1e3', big]) {
      const record = extractLabelledRecord(`Title: t\nQuantity: ${raw}`, SCHEMA);
      expect('quantity' in record, raw).toBe(false);
    }
  });

  it('takes the first of several values that convert, for every scalar type', () => {
    const text = [
      'Title: first title',
      'Title: second title',
      'Quantity: 7',
      'Quantity: 9',
      'Weight: 1.5',
      'Weight: 2.5',
      'Urgent: no',
      'Urgent: yes',
    ].join('\n');
    expect(extractLabelledRecord(text, SCHEMA)).toMatchObject({
      title: 'first title',
      quantity: 7,
      weight: 1.5,
      urgent: false,
    });
  });

  it('accepts no exponent and no bare fraction for a number', () => {
    for (const raw of ['1e3', '1.5e2', '2E-1', '.5', '5.', '+.5']) {
      // Number() would read each of these; the provider must not.
      expect(Number.isFinite(Number(raw)), raw).toBe(true);
      expect(extractLabelledRecord(`Weight: ${raw}`, SCHEMA).weight, raw).toBeNull();
    }
    expect(extractLabelledRecord('Weight: -0.25', SCHEMA).weight).toBe(-0.25);
    expect(extractLabelledRecord('Weight: 3', SCHEMA).weight).toBe(3);
  });

  it('accepts only true, false, yes and no for a boolean, in any letter case', () => {
    for (const raw of ['1', '0', 'y', 'n', 'on', 'off', 'ja', 'truthy']) {
      expect(extractLabelledRecord(`Urgent: ${raw}`, SCHEMA).urgent, raw).toBeNull();
    }
    expect(extractLabelledRecord('Urgent: TRUE', SCHEMA).urgent).toBe(true);
    expect(extractLabelledRecord('Urgent: Yes', SCHEMA).urgent).toBe(true);
    expect(extractLabelledRecord('Urgent: False', SCHEMA).urgent).toBe(false);
    expect(extractLabelledRecord('Urgent: NO', SCHEMA).urgent).toBe(false);
  });

  it('drops an object line whose required part is missing or does not convert', () => {
    const record = extractLabelledRecord('Lines:  | 3\nLines: bolts | x\nLines: nuts | 7', SCHEMA);
    expect(record.lines).toEqual([
      { description: 'bolts', count: null },
      { description: 'nuts', count: 7 },
    ]);
  });

  it('matches labels by their normalized form', () => {
    expect(normalizeLabel('  Issued  On ')).toBe('issued_on');
    expect(normalizeLabel('ISSUED-on')).toBe('issued_on');
    expect(normalizeLabel('__x__')).toBe('x');
    expect(normalizeLabel('---')).toBe('');
    expect(extractLabelledRecord('ISSUED-ON: 2026-01-02', SCHEMA).issued_on).toBe('2026-01-02');
  });

  it('gives the same record for the same input, every time', () => {
    const text = 'Title: same\nQuantity: 3\nTags: a\nLines: b | 1';
    const first = JSON.stringify(extractLabelledRecord(text, SCHEMA));
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(extractLabelledRecord(text, SCHEMA))).toBe(first);
    }
  });

  it('reads string inputs and parse envelopes in declared order, and ignores other inputs', async () => {
    const handler = deterministicExtractionHandler(SCHEMA);
    const out = await handler(
      input([
        { ref: 'doc.text', kind: 'extracted_text', content: 'Title: from the envelope' },
        [{ title: 'a row is not text' }],
        'Quantity: 5',
      ]),
      {} as never,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ref: 'doc.record', schema_ref: 'doc.record' });
    expect(out[0]?.value).toMatchObject({ title: 'from the envelope', quantity: 5 });
  });

  it("writes onto the output the step's required shape names, else the first", async () => {
    const handler = deterministicExtractionHandler(SCHEMA);
    const outputs = [
      { name: 'other', ref: 'doc.other', kind: 'x', schema_ref: 'doc.other' },
      { name: 'record', ref: 'doc.record', kind: 'record', schema_ref: 'doc.record' },
    ];
    const named = await handler(input(['Title: x'], outputs), {} as never);
    expect(named[0]?.ref).toBe('doc.record');
    const first = await handler(input(['Title: x'], [outputs[0]!]), {} as never);
    expect(first[0]?.ref).toBe('doc.other');
    expect(await handler(input(['Title: x'], []), {} as never)).toEqual([]);
  });

  it('refuses a schema it cannot shape an output by', () => {
    const bad: unknown[] = [
      null,
      [],
      { type: 'array', items: {} },
      { type: 'object' },
      { type: 'object', properties: {} },
      { type: 'object', properties: { a: 'string' } },
    ];
    for (const schema of bad) {
      expect(() => parseDeterministicExtractionSchema(schema), JSON.stringify(schema)).toThrow(
        DeterministicExtractionSchemaError,
      );
    }
    const ok: DeterministicExtractionSchema = parseDeterministicExtractionSchema({
      type: ['object'],
      properties: { a: { type: 'string' } },
    });
    expect(Object.keys(ok.properties)).toEqual(['a']);
  });
});
