/**
 * The spec checks shared by `pack` and `bundle verify`: the manifest fields a spec derives, per the
 * `derivedFrom` rule of each capability id, and the comparison that refuses a manifest asking for
 * more or less; the application identity; the bindings the agent backends read. The corpus reaches
 * only a frontend-only spec; the documents here reach every rule.
 */
import { readFileSync } from 'node:fs';
import {
  CAPABILITIES,
  CONTRACT_SCHEMAS,
  isReservedBindingName,
  PLATFORM_GRANTABLE_BINDINGS,
  type RayManifest,
} from '@rayspec/bundle-contract';
import { APPLICATION_ID_PATTERN, APPLICATION_VERSION_PATTERN } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  type BundleSpec,
  checkDerivedFields,
  deriveBindings,
  deriveManifestFields,
  parseBundleSpec,
  resolveApplicationIdentity,
} from './spec-fields.js';

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

describe('the application identity', () => {
  const backend = (metadata: string) => parsed(`version: '1.0'\nmetadata:\n  name: n\n${metadata}`);
  const product = (metadata: string) =>
    parsed(
      `version: '1.0'\nproduct:\n  id: p_app\n  name: P\n${metadata === '' ? '' : `  metadata:\n${metadata}`}`,
    );

  it('uses the grammar patterns the manifest schema uses', () => {
    const defs = (CONTRACT_SCHEMAS.manifest as { $defs: Record<string, { pattern: string }> })
      .$defs;
    expect(APPLICATION_ID_PATTERN.source).toBe(defs.applicationId!.pattern);
    expect(APPLICATION_VERSION_PATTERN.source).toBe(defs.exactVersion!.pattern);
  });

  it('takes the backend metadata, and the product metadata map', () => {
    expect(resolveApplicationIdentity(backend("  id: notes\n  version: '1.2.3'\n"))).toEqual({
      ok: true,
      value: { id: 'notes', version: '1.2.3' },
    });
    expect(resolveApplicationIdentity(product("    id: notes\n    version: '1.2.3'\n"))).toEqual({
      ok: true,
      value: { id: 'notes', version: '1.2.3' },
    });
  });

  it('lets the overrides win over the spec', () => {
    expect(
      resolveApplicationIdentity(backend("  id: notes\n  version: '1.2.3'\n"), {
        id: 'other',
        version: '2.0.0',
      }),
    ).toEqual({ ok: true, value: { id: 'other', version: '2.0.0' } });
  });

  it('never derives the id from the name or the product id', () => {
    const fromName = resolveApplicationIdentity(backend("  version: '1.0.0'\n"));
    expect(fromName).toMatchObject({
      ok: false,
      errors: [{ code: 'RAY_APPLICATION_IDENTITY_MISSING', reason: 'id' }],
    });
    const fromProduct = resolveApplicationIdentity(product(''), { version: '1.0.0' });
    expect(fromProduct).toMatchObject({ ok: false, errors: [{ reason: 'id' }] });
    if (!fromProduct.ok) expect(fromProduct.errors[0]!.message).toContain('product.metadata.id');
  });

  it('refuses a missing version, and an override that breaks a pattern', () => {
    expect(resolveApplicationIdentity(backend('  id: notes\n'))).toMatchObject({
      ok: false,
      errors: [{ reason: 'version' }],
    });
    expect(
      resolveApplicationIdentity(backend(''), { id: 'Notes', version: '1.0.0' }),
    ).toMatchObject({
      ok: false,
      errors: [{ reason: 'id' }],
    });
    expect(
      resolveApplicationIdentity(backend(''), { id: 'n', version: '1.0.0+build' }),
    ).toMatchObject({
      ok: false,
      errors: [{ reason: 'version' }],
    });
  });
});

describe('the bindings', () => {
  const withAgents = (...backends: string[]) =>
    parsed(
      `version: '1.0'\nmetadata:\n  name: n\nagents:\n${backends
        .map((b, i) => `  - { id: a${i}, name: a${i}, backend: ${b}, instructions: x, model: m }\n`)
        .join('')}`,
    );

  it('declares the credential each agent backend reads, once, sorted by name', () => {
    expect(deriveBindings(withAgents('openai', 'pi')).map((b) => [b.name, b.required])).toEqual([
      ['OPENAI_API_KEY', true],
    ]);
    expect(
      deriveBindings(withAgents('anthropic', 'codex')).map((b) => [b.name, b.required]),
    ).toEqual([
      ['ANTHROPIC_API_KEY', false],
      ['CLAUDE_CODE_OAUTH_TOKEN', false],
      ['CODEX_API_KEY', false],
    ]);
  });

  it('takes the product backends from the configuration files the caller read', () => {
    const product = parsed("version: '1.0'\nproduct:\n  id: p\n  name: P\n");
    expect(deriveBindings(product)).toEqual([]);
    expect(deriveBindings(product, ['openai', 'unknown-backend']).map((b) => b.name)).toEqual([
      'OPENAI_API_KEY',
    ]);
  });

  it('declares only platform-grantable secrets, never a reserved name', () => {
    const all = deriveBindings(withAgents('openai', 'pi', 'anthropic', 'codex'));
    const grantable = new Set(PLATFORM_GRANTABLE_BINDINGS.map((b) => b.name));
    for (const binding of all) {
      expect(grantable.has(binding.name)).toBe(true);
      expect(isReservedBindingName(binding.name)).toBe(false);
      expect(binding.kind).toBe('secret');
      expect(binding.description.length).toBeGreaterThan(0);
    }
  });
});
