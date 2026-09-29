/**
 * Compiled JSON Schema validators for the contract documents, through the same Ajv 2020 engine
 * `@rayspec/spec` uses, in strict mode.
 *
 * The schema documents come from `schemas.gen.ts`, which is generated from the committed files
 * under `contract/`; nothing here reads a file. Each validator compiles on first use.
 */
// ajv ships CJS with no `exports` map; under NodeNext + verbatimModuleSyntax the default import
// types as the module namespace even though at run time it is the class. Resolve the constructor
// across both interop shapes and take the instance type from the named class export, as
// `@rayspec/spec` does.
import type { Ajv2020 as Ajv2020Class, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { escapePointer } from './canonical-json.js';
import {
  BINDINGS_FILE_SCHEMA,
  BUNDLE_SIGNATURE_FILE_SCHEMA,
  MANAGED_RECEIPT_SCHEMA,
  RAY_MANIFEST_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  RESULT_ENVELOPE_SCHEMA,
  SNAPSHOT_SCHEMA,
} from './schemas.gen.js';

const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => Ajv2020Class;

export type ContractSchemaName =
  | 'manifest'
  | 'snapshot'
  | 'managedReceipt'
  | 'releaseManifest'
  | 'bundleSignatureFile'
  | 'resultEnvelope'
  | 'bindingsFile';

/** The contract's JSON Schemas, keyed by document. */
export const CONTRACT_SCHEMAS: Readonly<
  Record<ContractSchemaName, Readonly<Record<string, unknown>>>
> = {
  manifest: RAY_MANIFEST_SCHEMA,
  snapshot: SNAPSHOT_SCHEMA,
  managedReceipt: MANAGED_RECEIPT_SCHEMA,
  releaseManifest: RELEASE_MANIFEST_SCHEMA,
  bundleSignatureFile: BUNDLE_SIGNATURE_FILE_SCHEMA,
  resultEnvelope: RESULT_ENVELOPE_SCHEMA,
  bindingsFile: BINDINGS_FILE_SCHEMA,
};

const compiled = new Map<string, ValidateFunction>();

/**
 * The compiled validator of one contract schema. `pointer` selects a `$defs` member of it (for
 * example `/$defs/objectIndex` of the snapshot schema), compiled against its root so internal
 * references resolve.
 */
export function schemaValidator(name: ContractSchemaName, pointer = ''): ValidateFunction {
  const key = `${name}#${pointer}`;
  let validate = compiled.get(key);
  if (validate === undefined) {
    const ajv = new Ajv2020Ctor({ strict: true, allErrors: false });
    const root = CONTRACT_SCHEMAS[name] as Record<string, unknown> & { $id: string };
    if (pointer === '') {
      validate = ajv.compile(root);
    } else {
      ajv.addSchema(root);
      validate = ajv.compile({ $ref: `${root.$id}#${pointer}` });
    }
    compiled.set(key, validate);
  }
  return validate;
}

/** Longest pointer an error reports: the `path` limit of the result envelope. */
const MAX_POINTER_LENGTH = 4096;

/**
 * A pointer segment an error may report: at most 64 printable ASCII characters. A member name
 * comes from the document, so a longer one, or one holding a control character, a terminal escape
 * or a bidirectional override, is never repeated.
 */
const REPORTABLE_SEGMENT = /^[\x20-\x7e]{0,64}$/;

/**
 * The JSON pointer of the member a schema error is about. For a missing or an unexpected member
 * that is the member itself, not the object holding it. The pointer stops before the first
 * segment that is not reportable, or that would take it past the envelope's `path` limit, so it
 * then names the nearest member above.
 */
export function failingPointer(error: ErrorObject): string {
  const segments = error.instancePath === '' ? [] : error.instancePath.slice(1).split('/');
  if (error.keyword === 'required')
    segments.push(escapePointer(String(error.params.missingProperty)));
  if (error.keyword === 'additionalProperties') {
    segments.push(escapePointer(String(error.params.additionalProperty)));
  }
  let pointer = '';
  for (const segment of segments) {
    if (!REPORTABLE_SEGMENT.test(segment)) break;
    if (pointer.length + 1 + segment.length > MAX_POINTER_LENGTH) break;
    pointer += `/${segment}`;
  }
  return pointer;
}
