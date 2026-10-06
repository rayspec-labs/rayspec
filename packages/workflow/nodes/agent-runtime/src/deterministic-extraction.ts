import type {
  AgentRuntimeExecutionInput,
  AgentRuntimeOutputArtifact,
  FakeAgentHandler,
} from './types.js';

/**
 * The deterministic extraction provider: a development and test stand-in for a model, so a product
 * that declares extractors runs end to end without a provider credential. It is NOT an extraction
 * model and is unsuitable for production extraction: it reads labelled lines and nothing else.
 *
 * WHAT IT READS. The text of the step's input artifacts — each one whose value is a string, or an
 * object whose `content` is a string (the envelope `file_input.parse_text` emits) — in declared
 * order, joined by a newline. Other inputs (rows, objects) are ignored. Every line of the form
 * `<label>: <value>` is a labelled line; its label is normalized to lowercase with each run of
 * characters other than `a-z` and `0-9` turned into `_` and the edges trimmed, so `Issued on:` and
 * `issued_on:` are the same label. Lines without a colon are ignored.
 *
 * WHAT IT WRITES. One object, shaped by the output JSON Schema it was built with (`type: object`
 * with `properties`). For each property, in declared order:
 *   - a scalar (`string`, `integer`, `number`, `boolean`): the first line with that label whose
 *     value converts; `null` when none does and the type admits `null`; otherwise the property is
 *     left out;
 *   - an array of scalars: every line with that label whose value converts, in document order;
 *   - an array of objects with `properties`: every line with that label, its value split on `|`
 *     into the item's properties in their declared order, each part converted; a part that is
 *     missing or does not convert is `null` when its type admits `null`, and drops the line
 *     otherwise;
 *   - any other shape: `null` when the type admits it; otherwise left out.
 * A left-out required field is then refused by the step's declared output shape, exactly as a
 * model's incomplete answer would be.
 *
 * CONVERSIONS. `string` takes the trimmed value. `integer` takes an optional sign and decimal
 * digits within the safe-integer range; `number` also admits one decimal fraction; `boolean`
 * takes `true`/`false`/`yes`/`no` in any letter case. Nothing else is accepted: no thousands
 * separators, no currency symbols, no dates parsed or normalized.
 *
 * TRANSCRIPT SPANS — only for a handler built with `spanSets`. It then also reads an input artifact
 * whose value is a non-empty array of objects that each carry a string `id` and a string `text`: a
 * span set. Each span contributes the lines of its `text`, in array order, and a labelled line found
 * there remembers the `id` of its span. Inside an array-of-objects property, an item property that
 * is named in `spanSets.idFields` and is an array of strings takes no `|` part: it receives the id
 * of the span its line was read from, as a one-element array, or `[]` for a line that came from a
 * text input. A claim so cites exactly the span it was read from. Without `spanSets` a span array
 * is one of the ignored inputs and such an item property drops its line, as any other shape does.
 *
 * DETERMINISTIC. The same inputs give the same output: no clock, no randomness, no network.
 */

/** The backend id an extraction config names to select this provider. */
export const DETERMINISTIC_EXTRACTION_BACKEND = 'deterministic';

/** The JSON Schema subset the provider shapes its output by. */
export interface DeterministicExtractionSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Why a schema cannot drive the provider. */
export class DeterministicExtractionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeterministicExtractionSchemaError';
  }
}

type Scalar = 'string' | 'integer' | 'number' | 'boolean';
const SCALARS: readonly string[] = ['string', 'integer', 'number', 'boolean'];

/** The declared types of a schema node (`type` as a string or a list), or [] when it has none. */
function typesOf(node: Readonly<Record<string, unknown>>): string[] {
  const t = node.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function nullable(node: Readonly<Record<string, unknown>>): boolean {
  return typesOf(node).includes('null');
}

/** The one scalar type of a node, ignoring `null`; undefined for anything else. */
function scalarOf(node: Readonly<Record<string, unknown>>): Scalar | undefined {
  const types = typesOf(node).filter((t) => t !== 'null');
  if (types.length !== 1) return undefined;
  const only = types[0] as string;
  return SCALARS.includes(only) ? (only as Scalar) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check that `schema` is an object schema with properties, and return it typed. Fail-closed: a
 * schema the provider cannot shape an output by is refused rather than answered with `{}`.
 */
export function parseDeterministicExtractionSchema(schema: unknown): DeterministicExtractionSchema {
  if (!isRecord(schema)) {
    throw new DeterministicExtractionSchemaError('the output schema is not a JSON object');
  }
  if (!typesOf(schema).includes('object')) {
    throw new DeterministicExtractionSchemaError("the output schema's type is not 'object'");
  }
  const properties = schema.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    throw new DeterministicExtractionSchemaError('the output schema declares no properties');
  }
  for (const [name, node] of Object.entries(properties)) {
    if (!isRecord(node)) {
      throw new DeterministicExtractionSchemaError(`property '${name}' is not a schema object`);
    }
  }
  return {
    type: 'object',
    properties: properties as Record<string, Readonly<Record<string, unknown>>>,
  };
}

/** Normalize a label: lowercase, each run of other characters to `_`, edges trimmed. */
export function normalizeLabel(label: string): string {
  const joined = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = joined.length;
  while (start < end && joined[start] === '_') start += 1;
  while (end > start && joined[end - 1] === '_') end -= 1;
  return joined.slice(start, end);
}

/** One labelled line: its normalized label, its trimmed value, and the span it was read from. */
interface LabelledLine {
  readonly label: string;
  readonly value: string;
  /** The id of the transcript span the line came from; undefined for a line of a text input. */
  readonly spanId?: string;
}

/** The labelled lines of `text` in document order, each remembering `spanId` when one is given. */
function labelledLines(text: string, spanId?: string): LabelledLine[] {
  const out: LabelledLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const label = normalizeLabel(line.slice(0, colon));
    if (label === '') continue;
    out.push({
      label,
      value: line.slice(colon + 1).trim(),
      ...(spanId === undefined ? {} : { spanId }),
    });
  }
  return out;
}

/** Which item properties receive the id of the span a line was read from. */
export interface DeterministicExtractionSpanSets {
  /** The names of the item properties that cite spans (a product's evidence fields). */
  readonly idFields: readonly string[];
}

/** What a handler is built with beyond its output schema. */
export interface DeterministicExtractionOptions {
  /** Present ⇒ the handler reads transcript span sets and fills the named id fields. */
  readonly spanSets?: DeterministicExtractionSpanSets;
}

/** Whether a schema node is an array of strings: the shape of a field that cites span ids. */
function isStringArray(node: Readonly<Record<string, unknown>>): boolean {
  return (
    typesOf(node).includes('array') && isRecord(node.items) && scalarOf(node.items) === 'string'
  );
}

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/** Convert `raw` to `type`; undefined when it does not convert. */
function convert(raw: string, type: Scalar): unknown {
  const value = raw.trim();
  switch (type) {
    case 'string':
      return value;
    case 'integer': {
      if (!INTEGER.test(value)) return undefined;
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case 'number': {
      if (!NUMBER.test(value)) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === 'yes') return true;
      if (lower === 'false' || lower === 'no') return false;
      return undefined;
    }
  }
}

/**
 * One array item of object shape from a `|`-separated value; undefined when the line is dropped.
 * With `idFields`, a property named there that is an array of strings consumes no part and cites
 * the line's span.
 */
function objectItem(
  line: LabelledLine,
  itemProperties: Readonly<Record<string, unknown>>,
  idFields: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  const parts = line.value.split('|');
  const item: Record<string, unknown> = {};
  let index = 0;
  for (const [name, node] of Object.entries(itemProperties)) {
    const schemaNode = isRecord(node) ? node : {};
    if (idFields?.includes(name) && isStringArray(schemaNode)) {
      item[name] = line.spanId === undefined ? [] : [line.spanId];
      continue;
    }
    const part = parts[index];
    index += 1;
    const type = scalarOf(schemaNode);
    const converted =
      part === undefined || type === undefined || part.trim() === ''
        ? undefined
        : convert(part, type);
    if (converted !== undefined) item[name] = converted;
    else if (nullable(schemaNode)) item[name] = null;
    else return undefined;
  }
  return item;
}

/** The record the labelled lines of `text` give for `schema`. */
export function extractLabelledRecord(
  text: string,
  schema: DeterministicExtractionSchema,
): Record<string, unknown> {
  return recordFromLines(labelledLines(text), schema, undefined);
}

/** The record `lines` give for `schema`; `idFields` are the item properties that cite spans. */
function recordFromLines(
  lines: readonly LabelledLine[],
  schema: DeterministicExtractionSchema,
  idFields: readonly string[] | undefined,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(schema.properties)) {
    const label = normalizeLabel(name);
    const matching = lines.filter((line) => line.label === label);
    const values = matching.map((line) => line.value);
    const scalar = scalarOf(node);
    if (scalar !== undefined) {
      const found = values.map((v) => convert(v, scalar)).find((v) => v !== undefined);
      if (found !== undefined) record[name] = found;
      else if (nullable(node)) record[name] = null;
      continue;
    }
    if (typesOf(node).includes('array') && isRecord(node.items)) {
      const items = node.items;
      const itemScalar = scalarOf(items);
      if (itemScalar !== undefined) {
        record[name] = values.map((v) => convert(v, itemScalar)).filter((v) => v !== undefined);
        continue;
      }
      if (typesOf(items).includes('object') && isRecord(items.properties)) {
        const itemProperties = items.properties;
        record[name] = matching
          .map((line) => objectItem(line, itemProperties, idFields))
          .filter((v): v is Record<string, unknown> => v !== undefined);
        continue;
      }
    }
    if (nullable(node)) record[name] = null;
  }
  return record;
}

/** The text the step's inputs carry, in declared order. */
export function inputText(input: AgentRuntimeExecutionInput): string {
  const texts: string[] = [];
  for (const artifact of input.artifact_inputs) {
    const value = artifact.value;
    if (typeof value === 'string') texts.push(value);
    else if (isRecord(value) && typeof value.content === 'string') texts.push(value.content);
  }
  return texts.join('\n');
}

/** The spans of `value` when it is a span set: a non-empty array of `{ id, text }` objects. */
function spanSetOf(value: unknown): { id: string; text: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const spans: { id: string; text: string }[] = [];
  for (const element of value) {
    if (!isRecord(element) || typeof element.id !== 'string' || typeof element.text !== 'string') {
      return undefined;
    }
    spans.push({ id: element.id, text: element.text });
  }
  return spans;
}

/** The labelled lines the step's inputs carry, in declared order: text inputs and span sets. */
function inputLines(input: AgentRuntimeExecutionInput): LabelledLine[] {
  const lines: LabelledLine[] = [];
  for (const artifact of input.artifact_inputs) {
    const value = artifact.value;
    if (typeof value === 'string') lines.push(...labelledLines(value));
    else if (isRecord(value) && typeof value.content === 'string') {
      lines.push(...labelledLines(value.content));
    } else {
      for (const span of spanSetOf(value) ?? []) lines.push(...labelledLines(span.text, span.id));
    }
  }
  return lines;
}

/**
 * The provider's handler for one extractor, shaped by that extractor's output schema. It writes the
 * record onto the output artifact whose `schema_ref` is the step's required output shape, or the
 * first declared output when none matches. With `options.spanSets` it also reads transcript span
 * sets and cites them (see the header); without it the handler reads text inputs only.
 */
export function deterministicExtractionHandler(
  schema: DeterministicExtractionSchema,
  options: DeterministicExtractionOptions = {},
): FakeAgentHandler {
  const spanSets = options.spanSets;
  return (input) => {
    const output =
      input.artifact_outputs.find((a) => a.schema_ref === input.required_output_shape.schema_ref) ??
      input.artifact_outputs[0];
    if (!output) return [];
    const value =
      spanSets === undefined
        ? extractLabelledRecord(inputText(input), schema)
        : recordFromLines(inputLines(input), schema, spanSets.idFields);
    return [{ ...output, value }] satisfies AgentRuntimeOutputArtifact[];
  };
}
