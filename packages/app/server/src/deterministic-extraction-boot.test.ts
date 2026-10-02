/**
 * The shipped deterministic extraction provider at boot (no DB, no network): it is built only for
 * extractors whose config selects it, it never stands in for a real backend, it never answers a live
 * run, the managed posture refuses it, and the handler it builds reads the document-intake
 * example's documents into the records the seed manifest expects.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildDeterministicExtraction,
  buildLiveAgent,
  nonRealProviderBanner,
  ProductBootError,
  validateProductYamlSpec,
} from './product-boot.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(here, '../../../../examples/document-intake');
const SPEC_NAME = 'document-intake.product.yaml';
const CONFIG = 'extraction/record_extractor.extractor.json';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the example's spec and extraction directory, with `config` as the extractor config. */
function app(config?: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deterministic-extraction-'));
  created.push(root);
  cpSync(join(EXAMPLE, SPEC_NAME), join(root, SPEC_NAME));
  cpSync(join(EXAMPLE, 'extraction'), join(root, 'extraction'), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, CONFIG), JSON.stringify(config));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const specPath = join(root, SPEC_NAME);
  const spec = validateProductYamlSpec(readFileSync(specPath, 'utf8'), specPath);
  return { specPath, spec };
}

const DETERMINISTIC = {
  agent_id: 'record_extractor',
  backend: 'deterministic',
  schema_file: 'record_extractor.schema.json',
};

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProductBootError);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('the deterministic extraction provider at boot', () => {
  it("builds one handler per extractor from the example's own config", () => {
    const { specPath, spec } = app();
    const registry = buildDeterministicExtraction({}, specPath, spec, undefined);
    expect(registry.ids()).toEqual(['agent.record_extractor']);
  });

  it('reads every seed document into the record the seed manifest expects', async () => {
    const { specPath, spec } = app();
    const handler = buildDeterministicExtraction({}, specPath, spec, undefined).get(
      'agent.record_extractor',
    );
    expect(handler).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(EXAMPLE, 'seed', 'manifest.json'), 'utf8')) as {
      documents: { file: string; content_type: string; expected: unknown }[];
    };
    const text = manifest.documents.filter((d) => d.content_type === 'text/plain');
    expect(text.length).toBe(40);
    for (const doc of text) {
      const content = readFileSync(join(EXAMPLE, 'seed', doc.file), 'utf8');
      const out = await handler!(
        {
          operation: 'agent.record_extractor',
          intent: 'document_record',
          artifact_inputs: [
            {
              name: 'document_text',
              ref: 'intake.extracted_text',
              kind: 'extracted_text',
              required: true,
              value: { content },
            },
          ],
          artifact_outputs: [
            {
              name: 'record',
              ref: 'intake.record',
              kind: 'document_record',
              schema_ref: 'intake.record',
            },
          ],
          required_output_shape: { schema_ref: 'intake.record' },
          acceptance_boundary: { type: 'validation_node', requires: ['validation.check'] },
        },
        {} as never,
      );
      expect(out[0]?.value, doc.file).toEqual(doc.expected);
    }
  });

  it('refuses an extractor whose config names a real backend, never standing in for it', () => {
    const { specPath, spec } = app({ ...DETERMINISTIC, backend: 'openai' });
    const message = refusal(() => buildDeterministicExtraction({}, specPath, spec, undefined));
    expect(message).toContain("extractor 'record_extractor'");
    expect(message).toContain("selects the backend 'openai'");
    expect(message).toContain('never stands in for a provider the application chose');
  });

  it('refuses a config that also names a model or a prompt', () => {
    const { specPath, spec } = app({ ...DETERMINISTIC, model: 'm', prompt_file: 'p.md' });
    expect(refusal(() => buildDeterministicExtraction({}, specPath, spec, undefined))).toContain(
      'it also carries model, prompt_file',
    );
  });

  it('refuses a config for another extractor, one without a schema and an unusable schema', () => {
    const other = app({ ...DETERMINISTIC, agent_id: 'someone_else' });
    expect(
      refusal(() => buildDeterministicExtraction({}, other.specPath, other.spec, undefined)),
    ).toContain("names agent 'someone_else'");

    const { schema_file: _omitted, ...withoutSchema } = DETERMINISTIC;
    const none = app(withoutSchema);
    expect(
      refusal(() => buildDeterministicExtraction({}, none.specPath, none.spec, undefined)),
    ).toContain('names no schema_file');

    const flat = app(
      { ...DETERMINISTIC, schema_file: 'flat.schema.json' },
      { 'extraction/flat.schema.json': JSON.stringify({ type: 'string' }) },
    );
    expect(
      refusal(() => buildDeterministicExtraction({}, flat.specPath, flat.spec, undefined)),
    ).toContain("the output schema's type is not 'object'");

    const missing = app({ ...DETERMINISTIC, schema_file: 'absent.schema.json' });
    expect(
      refusal(() => buildDeterministicExtraction({}, missing.specPath, missing.spec, undefined)),
    ).toContain('could not read it');
  });

  it('refuses a schema path outside the extraction directory', () => {
    const { specPath, spec } = app({ ...DETERMINISTIC, schema_file: `../${SPEC_NAME}` });
    expect(refusal(() => buildDeterministicExtraction({}, specPath, spec, undefined))).toContain(
      'path-traversal guard',
    );
  });

  it('is refused under the managed posture, whose capability list holds it test-only', () => {
    const { specPath, spec } = app();
    const message = refusal(() => buildDeterministicExtraction({}, specPath, spec, 'managed'));
    expect(message).toContain('RAYSPEC_HOSTING_POSTURE=managed');
    expect(message).toContain("'extraction-deterministic' is test-only");
  });

  it('never answers a live run: a live boot of a config that selects it is refused', () => {
    const { specPath, spec } = app();
    const message = refusal(() =>
      buildLiveAgent({ RAYSPEC_EXTRACTION_MODE: 'live' }, specPath, spec),
    );
    expect(message).toContain('runs only under RAYSPEC_EXTRACTION_MODE=deterministic');
    expect(message).toContain('not for production extraction');
  });

  it("resolves the example's live config for a live run, through the single-file override", () => {
    const root = mkdtempSync(join(tmpdir(), 'live-extraction-'));
    created.push(root);
    cpSync(EXAMPLE, root, {
      recursive: true,
      filter: (src) => !src.slice(EXAMPLE.length).startsWith('/seed'),
    });
    const specPath = join(root, SPEC_NAME);
    const spec = validateProductYamlSpec(readFileSync(specPath, 'utf8'), specPath);
    // An inert key: constructing the adapter calls nothing; no run happens here.
    const env = {
      RAYSPEC_EXTRACTION_MODE: 'live',
      RAYSPEC_EXTRACTION_CONFIG: join(root, 'live-extraction', 'record_extractor.extractor.json'),
      OPENAI_API_KEY: ['inert', 'test', 'value'].join('-'),
    };
    const live = buildLiveAgent(env, specPath, spec);
    expect(live.agentIds).toEqual(['record_extractor']);
  });

  it('says at boot that no real extraction model runs', () => {
    const banner = nonRealProviderBanner({}, false, 'deterministic');
    expect(banner).toContain('RAYSPEC_EXTRACTION_MODE=deterministic');
    expect(banner).toContain('not for production extraction');
    expect(nonRealProviderBanner({}, false, 'live')).toBeNull();
  });
});
