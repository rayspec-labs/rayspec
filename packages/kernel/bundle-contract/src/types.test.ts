/**
 * The result envelope and quiesce types refuse what the envelope schema refuses: `ok: true` with
 * errors, `ok: false` without any, an operation outside the closed list and an unknown quiesce
 * barrier. Test files are outside the package typecheck, so the TypeScript compiler checks each
 * program here, against `types.ts` and the package's own compiler options.
 */
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './test-support/contract-files.js';

const PROBE = join(PACKAGE_ROOT, 'src', 'type-probe.ts');

const config = ts.readConfigFile(join(PACKAGE_ROOT, 'tsconfig.json'), ts.sys.readFile);
const options: ts.CompilerOptions = {
  ...ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT).options,
  noEmit: true,
  composite: false,
  incremental: false,
  declaration: false,
  declarationMap: false,
};

let previous: ts.Program | undefined;

/** The type errors of one program that imports the contract types. */
function typeErrors(body: string): string[] {
  const text = [
    "import type { BundleError } from './errors.js';",
    "import type { QuiesceData, ResultEnvelope } from './types.js';",
    'declare const error: BundleError;',
    body,
    // Keeps both imports used whichever of them the body names.
    'export type Probe = [QuiesceData, ResultEnvelope<null>];',
  ].join('\n');
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === PROBE
      ? ts.createSourceFile(name, text, language)
      : getSourceFile(name, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === PROBE || fileExists(name);
  const program = ts.createProgram([PROBE], options, host, previous);
  previous = program;
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(PROBE))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const envelope = (members: string) =>
  `const e: ResultEnvelope<null> = { contractVersion: '1.0.0-draft.2', operationId: 'x', data: null, warnings: [], ${members} }; void e;`;

describe('result envelope types', () => {
  it.each([
    ['ok with no errors', "ok: true, operation: 'bundle.verify', errors: []"],
    ['not ok with one error', "ok: false, operation: 'runtime.quiesce', errors: [error]"],
  ])('accept %s', (_label, members) => {
    expect(typeErrors(envelope(members))).toEqual([]);
  });

  it.each([
    ['ok with an error', "ok: true, operation: 'bundle.verify', errors: [error]"],
    ['not ok without errors', "ok: false, operation: 'bundle.verify', errors: []"],
    ['an operation outside the closed list', "ok: true, operation: 'bundle.teleport', errors: []"],
  ])('refuse %s', (_label, members) => {
    expect(typeErrors(envelope(members))).not.toEqual([]);
  });
}, 60_000);

describe('quiesce barrier types', () => {
  it('accept a barrier from the closed list', () => {
    const body =
      "const b: QuiesceData['barriers'][number] = { barrier: 'object-writes', state: 'held' }; void b;";
    expect(typeErrors(body)).toEqual([]);
  });

  it('refuse a barrier outside the closed list', () => {
    const body =
      "const b: QuiesceData['barriers'][number] = { barrier: 'database', state: 'held' }; void b;";
    expect(typeErrors(body)).not.toEqual([]);
  });
}, 60_000);
