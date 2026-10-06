/**
 * The shipped deterministic extraction provider at boot (no DB, no network): it is built only for
 * extractors whose config selects it, it never stands in for a real backend, it never answers a live
 * run, the managed posture refuses it, and the handler it builds reads the document-intake
 * example's documents into the records the seed manifest expects.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertNoStandInUnderLive,
  buildDeterministicExtraction,
  buildLiveAgent,
  deterministicExtraction,
  deterministicStandInEnabled,
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

describe('the deterministic provider as a stand-in for a configured backend', () => {
  const ACME = resolve(here, '../../../../examples/acme-notes');
  const ACME_SPEC = 'acme-notes.product.yaml';
  const ACME_CONFIG = 'extraction/extractor.json';
  const STAND_IN = { RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'true' };
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

  /** A copy of the acme-notes example, with `edit` applied to its committed extraction config. */
  function acme(edit?: (config: Record<string, unknown>) => Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), 'extraction-stand-in-'));
    created.push(root);
    cpSync(join(ACME, ACME_SPEC), join(root, ACME_SPEC));
    cpSync(join(ACME, 'extraction'), join(root, 'extraction'), { recursive: true });
    if (edit) {
      const path = join(root, ACME_CONFIG);
      writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')))));
    }
    const specPath = join(root, ACME_SPEC);
    return {
      root,
      specPath,
      spec: validateProductYamlSpec(readFileSync(specPath, 'utf8'), specPath),
    };
  }

  it('is off unless the operator turns it on: a real-backend config is refused as before', () => {
    const specPath = join(ACME, ACME_SPEC);
    const spec = validateProductYamlSpec(readFileSync(specPath, 'utf8'), specPath);
    const expected =
      "Boot aborted (Product-YAML) — extractor 'note_extractor': " +
      'RAYSPEC_EXTRACTION_MODE=deterministic, but its extraction config selects the backend ' +
      "'openai' — the deterministic extraction provider never stands in for a provider the " +
      'application chose. Run RAYSPEC_EXTRACTION_MODE=live, or set "backend": "deterministic" ' +
      'for a development or test run. Fail-closed.';
    for (const env of [
      {},
      { RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'false' },
      { RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: '  ' },
    ]) {
      expect(refusal(() => buildDeterministicExtraction(env, specPath, spec, undefined))).toBe(
        expected,
      );
    }
  });

  it('answers for the committed production config, which it leaves untouched, with no key', async () => {
    const specPath = join(ACME, ACME_SPEC);
    const spec = validateProductYamlSpec(readFileSync(specPath, 'utf8'), specPath);
    const committed = JSON.parse(readFileSync(join(ACME, ACME_CONFIG), 'utf8'));
    // The config under test is the one the example ships for a live run.
    expect(committed).toMatchObject({ backend: 'openai', model: 'gpt-5' });
    expect(Object.keys(committed)).toContain('prompt_file');
    const before = sha(join(ACME, ACME_CONFIG));

    // No provider key is in this environment, and none is asked for.
    const built = deterministicExtraction({ ...STAND_IN }, specPath, spec, undefined);
    expect(built.registry.ids()).toEqual(['agent.note_extractor']);
    expect(built.standIns).toEqual([{ id: 'note_extractor', backend: 'openai' }]);
    expect(sha(join(ACME, ACME_CONFIG))).toBe(before);

    // It reads the transcript spans and cites, for each claim, the span the claim was read from.
    const out = await built.registry.get('agent.note_extractor')!(
      {
        operation: 'agent.note_extractor',
        intent: 'note_extraction',
        artifact_inputs: [
          {
            name: 'transcript',
            ref: 'stt.transcript',
            kind: 'transcript',
            required: true,
            value: { session_id: 's', tracks: [] },
          },
          {
            name: 'spans',
            ref: 'stt.transcript_span',
            kind: 'transcript_span_set',
            required: true,
            value: [
              { id: 'mic:s0', track: 'mic', text: 'headline: Stable.' },
              { id: 'mic:s1', track: 'mic', text: 'detail: Nothing moves.' },
              { id: 'mic:s2', track: 'mic', text: 'output_language: en' },
              { id: 'mic:s3', track: 'mic', text: 'items: Keep it stable.' },
              { id: 'system:s0', track: 'system', text: 'mentions: Acme' },
            ],
          },
        ],
        artifact_outputs: [
          {
            name: 'candidate_notes',
            ref: 'acme.notes',
            kind: 'note_candidate',
            schema_ref: 'acme.notes',
          },
        ],
        required_output_shape: { schema_ref: 'acme.notes' },
        acceptance_boundary: { type: 'validation_node', requires: ['grounding.check'] },
      },
      {} as never,
    );
    expect(out[0]?.value).toEqual({
      headline: 'Stable.',
      detail: 'Nothing moves.',
      output_language: 'en',
      items: [{ text: 'Keep it stable.', evidence: ['mic:s3'] }],
      pointers: [],
      queries: [],
      labels: [],
      mentions: [{ name: 'Acme', evidence: ['system:s0'] }],
    });
  });

  it('reads agent_id and schema_file only: no prompt file, no model, no credential', () => {
    const { root, specPath, spec } = acme((config) => ({
      ...config,
      model: 'a-model-that-does-not-exist',
      prompt_file: 'a-prompt-that-does-not-exist.md',
      structured_output_mode: 'not-a-mode',
      input_context: 'not-an-object',
    }));
    rmSync(join(root, 'extraction', 'note-extraction.prompt.md'));
    const built = deterministicExtraction({ ...STAND_IN }, specPath, spec, undefined);
    expect(built.standIns).toEqual([{ id: 'note_extractor', backend: 'openai' }]);
    // A live boot of the same config does read the rest of it, and fails on it.
    expect(() => buildLiveAgent({ RAYSPEC_EXTRACTION_MODE: 'live' }, specPath, spec)).toThrow();
  });

  it('stands in for a backend this release does not wire, and still names it', () => {
    const { specPath, spec } = acme((config) => ({ ...config, backend: 'not-a-backend' }));
    expect(deterministicExtraction({ ...STAND_IN }, specPath, spec, undefined).standIns).toEqual([
      { id: 'note_extractor', backend: 'not-a-backend' },
    ]);
  });

  it('keeps every refusal about the two keys it reads', () => {
    const other = acme((config) => ({ ...config, agent_id: 'someone_else' }));
    expect(
      refusal(() =>
        buildDeterministicExtraction({ ...STAND_IN }, other.specPath, other.spec, undefined),
      ),
    ).toContain("names agent 'someone_else'");

    const none = acme(({ schema_file: _omitted, ...rest }) => rest);
    expect(
      refusal(() =>
        buildDeterministicExtraction({ ...STAND_IN }, none.specPath, none.spec, undefined),
      ),
    ).toContain('names no schema_file');

    const outside = acme((config) => ({ ...config, schema_file: `../${ACME_SPEC}` }));
    expect(
      refusal(() =>
        buildDeterministicExtraction({ ...STAND_IN }, outside.specPath, outside.spec, undefined),
      ),
    ).toContain('path-traversal guard');

    const missing = acme((config) => ({ ...config, schema_file: 'absent.schema.json' }));
    expect(
      refusal(() =>
        buildDeterministicExtraction({ ...STAND_IN }, missing.specPath, missing.spec, undefined),
      ),
    ).toContain('could not read it');
  });

  it('leaves a config that selects the provider itself exactly as it was: no stand-in, three keys', async () => {
    const { specPath, spec } = app();
    const built = deterministicExtraction({ ...STAND_IN }, specPath, spec, undefined);
    expect(built.standIns).toEqual([]);
    const extra = app({ ...DETERMINISTIC, model: 'm' });
    expect(
      refusal(() =>
        buildDeterministicExtraction({ ...STAND_IN }, extra.specPath, extra.spec, undefined),
      ),
    ).toContain('it also carries model');
    // Such an extractor does not read spans: the stand-in switch changes nothing for it.
    const out = await built.registry.get('agent.record_extractor')!(
      {
        operation: 'agent.record_extractor',
        intent: 'document_record',
        artifact_inputs: [
          {
            name: 'spans',
            ref: 'x',
            kind: 'x',
            required: true,
            value: [{ id: 'a:s0', text: 'Title: from a span' }],
          },
        ],
        artifact_outputs: [
          { name: 'record', ref: 'intake.record', kind: 'r', schema_ref: 'intake.record' },
        ],
        required_output_shape: { schema_ref: 'intake.record' },
        acceptance_boundary: { type: 'validation_node', requires: ['validation.check'] },
      },
      {} as never,
    );
    expect(JSON.stringify(out[0]?.value)).not.toContain('from a span');
  });

  it('refuses a value other than true or false', () => {
    expect(deterministicStandInEnabled({})).toBe(false);
    expect(deterministicStandInEnabled({ RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: ' ' })).toBe(
      false,
    );
    expect(
      deterministicStandInEnabled({ RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'false' }),
    ).toBe(false);
    expect(
      deterministicStandInEnabled({ RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: ' true ' }),
    ).toBe(true);
    const { specPath, spec } = acme();
    for (const value of ['yes', '1', 'TRUE']) {
      expect(
        refusal(() =>
          buildDeterministicExtraction(
            { RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: value },
            specPath,
            spec,
            undefined,
          ),
        ),
      ).toBe(
        `Boot aborted (Product-YAML) — RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN '${value}' is not ` +
          'supported (wired: true | false; unset or blank ⇒ false). Fail-closed.',
      );
    }
  });

  it('is refused under a live run, which calls the configured backends', () => {
    expect(refusal(() => assertNoStandInUnderLive({ ...STAND_IN }))).toBe(
      'Boot aborted (Product-YAML) — RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN=true needs ' +
        "RAYSPEC_EXTRACTION_MODE=deterministic, but the mode is 'live': a live run calls the " +
        'backend each extraction config names. Unset it, or set ' +
        'RAYSPEC_EXTRACTION_MODE=deterministic. Fail-closed.',
    );
    expect(
      refusal(() => assertNoStandInUnderLive({ RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'on' })),
    ).toContain('is not supported');
    for (const env of [{}, { RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN: 'false' }]) {
      expect(() => assertNoStandInUnderLive(env)).not.toThrow();
    }
  });

  it('is refused under the managed posture like the provider itself', () => {
    const { specPath, spec } = acme();
    expect(
      refusal(() => buildDeterministicExtraction({ ...STAND_IN }, specPath, spec, 'managed')),
    ).toContain("'extraction-deterministic' is test-only");
  });
});
