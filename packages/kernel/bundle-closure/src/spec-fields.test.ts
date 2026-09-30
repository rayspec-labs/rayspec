/**
 * The spec checks of `bundle verify`: the manifest fields a spec derives, per the `derivedFrom`
 * rule of each capability id, and the comparison that refuses a manifest asking for more or less.
 * The corpus reaches only a frontend-only spec; the documents here reach every rule.
 */
import { readFileSync } from 'node:fs';
import { CAPABILITIES, type RayManifest } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import {
  type BundleSpec,
  checkDerivedFields,
  deriveManifestFields,
  parseBundleSpec,
} from './bundle-spec.js';

const EVERY_BACKEND_FEATURE = `version: '1.0'
metadata:
  name: derivation-probe
stores:
  - name: things
    columns:
      - { name: title, type: text }
api:
  - method: GET
    path: /things
    action: { kind: store, store: things, op: list }
  - method: POST
    path: /upload
    action: { kind: stream, handler: upload, mode: ingest }
  - method: POST
    path: /ask
    action: { kind: agent, agent: helper }
agents:
  - id: helper
    name: helper
    backend: anthropic
    instructions: Answer.
    model: some-model
handlers:
  - id: upload
    module: ./handlers/upload.js
    export: upload
    kind: route
  - id: job
    module: ./handlers/job.js
    export: job
    kind: trigger
triggers:
  - name: nightly
    kind: cron
    schedule: '0 0 * * *'
    action: { kind: handler, handler: job }
  - name: hook
    kind: webhook
    action: { kind: handler, handler: job }
extensions:
  - id: pack
    module: '@acme/pack'
    version: 1.0.0
deployment:
  durableWorker: true
  eventBus: {}
frontend:
  - route: /
    dir: ./web
`;

function parsed(text: string): BundleSpec {
  const r = parseBundleSpec(Buffer.from(text, 'utf8'));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const manifest = (fields: Partial<{ requires: string[]; execution: string; egress: string[] }>) =>
  ({
    kind: 'application',
    requires: fields.requires ?? [],
    permissions: { execution: fields.execution ?? 'none', egressHosts: fields.egress ?? [] },
  }) as unknown as RayManifest & { kind: 'application' };

describe('deriveManifestFields', () => {
  it('derives every backend rule, sorted by code point', () => {
    expect(deriveManifestFields(parsed(EVERY_BACKEND_FEATURE))).toEqual({
      requires: [
        'agent-backend-anthropic',
        'custom-handlers',
        'declarative-api',
        'declarative-stores',
        'durable-workflow',
        'extensions',
        'static-frontend',
        'stream-routes',
        'tenant-event-bus',
        'trigger-cron',
        'trigger-webhook',
      ],
      execution: 'in-process',
      egressHosts: [],
    });
  });

  it('derives nothing from a minimal backend spec', () => {
    expect(deriveManifestFields(parsed("version: '1.0'\nmetadata:\n  name: bare\n"))).toEqual({
      requires: [],
      execution: 'none',
      egressHosts: [],
    });
  });

  it('extensions alone make the execution in-process; durableWorker false derives nothing', () => {
    const spec = `version: '1.0'
metadata:
  name: packs
extensions:
  - id: pack
    module: '@acme/pack'
    version: 1.0.0
deployment:
  durableWorker: false
`;
    expect(deriveManifestFields(parsed(spec))).toEqual({
      requires: ['extensions'],
      execution: 'in-process',
      egressHosts: [],
    });
  });

  it('derives the product rules: the durable executor always, and the listed input capabilities', () => {
    const acme = readFileSync(
      new URL('../../../../examples/acme-notes/acme-notes.product.yaml', import.meta.url),
    );
    // The example requires audio_input, media_playback and stt; stt is not a bundle capability id.
    expect(deriveManifestFields(parsed(acme.toString('utf8')))).toEqual({
      requires: ['audio_input', 'durable-workflow', 'media_playback'],
      execution: 'none',
      egressHosts: [],
    });
  });

  it('derives only ids the vocabulary knows and a bundle may require', () => {
    const requirable = new Set(CAPABILITIES.filter((c) => c.requirableByBundle).map((c) => c.id));
    for (const id of deriveManifestFields(parsed(EVERY_BACKEND_FEATURE)).requires) {
      expect(requirable.has(id), id).toBe(true);
    }
  });
});

describe('checkDerivedFields', () => {
  const derived = {
    requires: ['declarative-api', 'static-frontend'],
    execution: 'none',
    egressHosts: [],
  } as const;
  const check = (m: Parameters<typeof manifest>[0]) =>
    checkDerivedFields(manifest(m), {
      ...derived,
      requires: [...derived.requires],
      egressHosts: [],
    }).map((e) => `${e.code}/${e.reason}`);

  it('accepts exactly the derived fields', () => {
    expect(check({ requires: ['declarative-api', 'static-frontend'] })).toEqual([]);
  });

  it('refuses a requires list that is short, long or out of order', () => {
    for (const requires of [
      ['static-frontend'],
      ['declarative-api', 'static-frontend', 'extensions'],
      ['static-frontend', 'declarative-api'],
    ]) {
      expect(check({ requires })).toEqual(['RAY_MANIFEST_INVALID/requires-mismatch']);
    }
  });

  it('refuses another execution level, then any egress host the spec does not declare', () => {
    const requires = ['declarative-api', 'static-frontend'];
    expect(check({ requires, execution: 'in-process' })).toEqual([
      'RAY_MANIFEST_INVALID/execution-mismatch',
    ]);
    expect(check({ requires, egress: ['api.example.com'] })).toEqual([
      'RAY_MANIFEST_INVALID/permissions-mismatch',
    ]);
  });

  it('checks in the contract order: requires before execution before egress', () => {
    expect(check({ requires: [], execution: 'in-process', egress: ['a.example.com'] })).toEqual([
      'RAY_MANIFEST_INVALID/requires-mismatch',
    ]);
  });
});

describe('parseBundleSpec', () => {
  it('refuses bytes that are not UTF-8 as RAY_SPEC_INVALID alone', () => {
    const r = parseBundleSpec(Buffer.from([0x76, 0xff, 0xfe]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['RAY_SPEC_INVALID']);
  });

  it('maps each spec error to its SPEC_ code with its path, after RAY_SPEC_INVALID', () => {
    const r = parseBundleSpec(Buffer.from("version: '1.0'\nmetadata:\n  name: x\nbogus: 1\n"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe('RAY_SPEC_INVALID');
      expect(r.errors[1]).toMatchObject({
        code: 'SPEC_UNKNOWN_FIELD',
        path: 'bogus',
        retryable: false,
      });
    }
  });

  it('builds each message from the rule and position, never from the spec text', () => {
    const r = parseBundleSpec(
      Buffer.from("version: '1.0'\nmetadata:\n  name: x\nsecret_token_value: 1\n"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[1]).toMatchObject({
        code: 'SPEC_UNKNOWN_FIELD',
        message: 'the spec breaks the unknown field rule',
        path: 'secret_token_value',
      });
    }
    const y = parseBundleSpec(Buffer.from('a: 1\nkey: "s3cr3t" [\n'));
    expect(!y.ok && y.errors[1]!.message).toMatch(
      /^the spec breaks the yaml parse error rule at line 2, column \d+$/,
    );
    expect(JSON.stringify(y)).not.toContain('s3cr3t');
  });

  it('refuses a YAML syntax error', () => {
    const r = parseBundleSpec(Buffer.from('version: [\n'));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.code)).toEqual(['RAY_SPEC_INVALID', 'SPEC_YAML_PARSE_ERROR']);
  });
});
