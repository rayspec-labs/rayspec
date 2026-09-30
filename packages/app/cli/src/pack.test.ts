/**
 * `runPack` in process: the checks that guard the write, which a real process reaches only by
 * racing it (a file rewritten between the closure and the archive, a signal in between), the
 * mapping of codes outside the pack pipeline, the binding-name check, and the verb's flags and
 * error list against the contract's definition of the verb.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor, schemaValidator } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import {
  handlerApp,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { PACK_ERROR_CODES, type PackOutcome, reservedBindingErrors, runPack } from './pack.js';
import { CONTRACT_ROOT } from './test-support/bundles.js';

afterAll(removeTemporaryDirectories);

const valid = schemaValidator('resultEnvelope');
const OPERATION_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

interface ContractVerb {
  verb: string;
  flags: { flag: string; value: string | null }[];
  errors: string[];
}
const packVerb = (
  JSON.parse(readFileSync(join(CONTRACT_ROOT, 'contract', 'cli-verbs.json'), 'utf8')) as {
    verbs: ContractVerb[];
  }
).verbs.find((v) => v.verb === 'rayspec pack')!;

function checked(outcome: PackOutcome): PackOutcome {
  expect(valid(outcome.envelope), JSON.stringify(valid.errors)).toBe(true);
  return outcome;
}

function app(): { spec: string; output: string; outDir: string } {
  const root = handlerApp('export const handle = 1;\n');
  const outDir = temporaryDirectory('pack-out-');
  return { spec: join(root, 'rayspec.yaml'), output: join(outDir, 'app.ray'), outDir };
}

describe('the verb against its contract definition', () => {
  it('reports exactly the codes the contract lists for pack', () => {
    expect([...PACK_ERROR_CODES].sort()).toEqual([...packVerb.errors].sort());
  });

  it('knows every flag the contract defines', async () => {
    const { spec, output } = app();
    for (const { flag, value } of packVerb.flags) {
      const args = ['--spec', spec, '--output', output, flag, ...(value === null ? [] : ['1'])];
      const outcome = await runPack(args, {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
        afterResolve: () => {
          throw new Error('stop after the arguments');
        },
      }).catch((e: Error) => e);
      const message =
        outcome instanceof Error ? outcome.message : (outcome.envelope.errors[0]?.message ?? '');
      expect(message, flag).not.toContain('Unknown option');
    }
  });
});

describe('the write', () => {
  it('writes the bundle and leaves no temporary file', async () => {
    const { spec, output, outDir } = app();
    const outcome = checked(
      await runPack(['--spec', spec, '--output', output], {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
      }),
    );
    expect(outcome.envelope.ok).toBe(true);
    expect(readdirSync(outDir)).toEqual(['app.ray']);
  });

  it('refuses a file rewritten after the closure was checked, and writes nothing', async () => {
    const { spec, output, outDir } = app();
    const outcome = checked(
      await runPack(['--spec', spec, '--output', output], {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
        afterResolve: (closure) => {
          const handler = closure.files.find((f) => f.source === 'handlers/h.js')!;
          writeFileSync(handler.file!, 'export const handle = 2;\n');
        },
      }),
    );
    expect(outcome.envelope.errors[0]).toMatchObject({ code: 'RAY_USAGE' });
    expect(outcome.envelope.errors[0]!.message).toContain('handlers/h.js changed');
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('stops at a signal before writing, reports RAY_INTERRUPTED, and writes nothing', async () => {
    const { spec, output, outDir } = app();
    const controller = new AbortController();
    const outcome = checked(
      await runPack(['--spec', spec, '--output', output], {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
        signal: controller.signal,
        afterResolve: () => controller.abort(),
      }),
    );
    expect(outcome.envelope.errors[0]).toMatchObject({ code: 'RAY_INTERRUPTED' });
    expect(exitCodeFor(outcome.envelope.errors)).toBe(6);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('reports a manifest the writer refuses as an internal error, and writes nothing', async () => {
    const { spec, output, outDir } = app();
    const outcome = checked(
      await runPack(['--spec', spec, '--output', output], {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
        afterResolve: (closure) => {
          closure.application.id = 'Not An Id';
        },
      }),
    );
    expect(outcome.envelope.errors).toEqual([
      { code: 'RAY_INTERNAL', message: 'pack failed unexpectedly', retryable: false },
    ]);
    expect(exitCodeFor(outcome.envelope.errors)).toBe(7);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('refuses a reserved binding name before writing', async () => {
    const { spec, output, outDir } = app();
    const outcome = checked(
      await runPack(['--spec', spec, '--output', output], {
        operationId: OPERATION_ID,
        cliVersion: '1.8.0',
        afterResolve: (closure) => {
          closure.bindings.push({
            name: 'DATABASE_URL',
            kind: 'secret',
            required: true,
            description: 'probe',
          });
        },
      }),
    );
    expect(outcome.envelope.errors[0]).toMatchObject({
      code: 'RAY_BINDING_RESERVED',
      path: '/bindings/0/name',
    });
    expect(exitCodeFor(outcome.envelope.errors)).toBe(4);
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe('reservedBindingErrors', () => {
  const manifest = (names: string[]) => ({
    formatVersion: 1 as const,
    kind: 'application' as const,
    application: { id: 'probe', version: '1.0.0' },
    runtime: { version: '1.8.0' },
    target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
    spec: 'payload/rayspec.yaml',
    requires: [],
    bindings: names.map((name) => ({
      name,
      kind: 'secret' as const,
      required: true,
      description: 'probe',
    })),
    permissions: { execution: 'none' as const, egressHosts: [] },
  });

  it('accepts the platform-grantable credentials and application names', () => {
    expect(
      reservedBindingErrors(manifest(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MY_APP_TOKEN'])),
    ).toEqual([]);
  });

  it('refuses each operator-reserved name, pointing at it', () => {
    const errors = reservedBindingErrors(
      manifest(['MY_APP_TOKEN', 'DATABASE_URL', 'NODE_OPTIONS']),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['RAY_BINDING_RESERVED', '/bindings/1/name'],
      ['RAY_BINDING_RESERVED', '/bindings/2/name'],
    ]);
  });
});
