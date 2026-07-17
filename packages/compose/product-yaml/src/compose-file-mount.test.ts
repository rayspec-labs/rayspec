/**
 * The file_input conditional mount at the COMPOSE layer (following the record
 * conditional-mount test pattern, extended for the binary two-route surface):
 *
 *   1. WHEN DECLARED: the capability-owned store + BOTH routes — asserted as WHOLE TUPLES
 *      (method/path/action.kind/action.mode/action.handler), not path strings, because the upload
 *      route's `{kind:'stream', mode:'ingest'}` shape is what makes the engine hand it the RAW
 *      Request + the tenant-bound blob — a route that silently regressed to `{kind:'handler'}`
 *      would still "exist" by path but buffer/parse JSON — + the handler map + the DEFAULT-join
 *      trigger vocabulary.
 *   2. THE single-flight KEY PIN: the composed ingress derives the CLEAN GENERIC `file_id:<id>` idempotency
 *      key (the record law — the ':finalized' suffix stays audio-only, byte-stable).
 *   3. THE CONDITIONAL (fail-the-fix): a doc NOT declaring file_input mounts ZERO file surface —
 *      no store, no routes, no handlers, no trigger event (both the record-only and the audio doc).
 *   4. ROLLOUT THREADING: `rollout.file.basePath` moves both mounted routes; a
 *      `rollout.file.capability` override reaches the REAL `resolveFileConfig` (an invalid byte cap
 *      fail-closes AT COMPOSE — proving the override seam is wired, not decorative).
 *   5. ROUTE-COLLISION fail-closed: a declared POST view on the file submit route key is a compose
 *      rejection naming both owners, never a silent second owner.
 */
import type { BlobStore } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import { composeCapabilityStores, declaresFileInput } from './capability-stores.js';
import { composeProductDeploy, type ProductYamlRollout } from './compose.js';
import { deriveProductStores } from './derive-stores.js';
import {
  FILE_INTAKE_YAML,
  FILE_PARSE_YAML,
  INTAKE_YAML,
  parseFixture,
  RecordingEnqueuer,
} from './test-support/fixture.js';

const TENANT = '00000000-0000-0000-0000-0000000000f2';

/** The file-intake rollout: no stt/agents (the fixture uses neither); stores derived from the doc. */
function fileRollout(
  overrides: Partial<ProductYamlRollout> = {},
  yaml: string = FILE_INTAKE_YAML,
): ProductYamlRollout {
  const spec = parseFixture(yaml);
  const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    ...overrides,
  };
}

describe('composeProductDeploy — the file_input capability (conditional mount + the generic key)', () => {
  it('mounts the file capability WHEN DECLARED: store + BOTH routes as WHOLE TUPLES + handlers + trigger event', () => {
    const spec = parseFixture(FILE_INTAKE_YAML);
    expect(declaresFileInput(spec)).toBe(true);
    const composed = composeProductDeploy(spec, fileRollout());

    // The capability-owned store joins the composed read surface (engineSpec.stores).
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    expect(storeNames).toContain('file_uploads');
    expect(storeNames).toContain('ingested_files');

    // BOTH routes, WHOLE-TUPLE: the raw-byte upload is a stream/ingest route (the shape that makes
    // the engine pass the RAW Request + tenant-bound blob), the submit a handler route.
    const upload = composed.engineSpec.api.find((r) => r.path === '/files/{file_id}');
    expect(upload).toEqual({
      method: 'PUT',
      path: '/files/{file_id}',
      action: { kind: 'stream', handler: 'file_input_upload', mode: 'ingest' },
    });
    const submit = composed.engineSpec.api.find((r) => r.path === '/files/{file_id}/submit');
    expect(submit).toEqual({
      method: 'POST',
      path: '/files/{file_id}/submit',
      action: { kind: 'handler', handler: 'file_input_submit' },
    });

    // The resolved handler map carries exactly the two capability handlers.
    expect(composed.handlers.has('file_input_upload')).toBe(true);
    expect(composed.handlers.has('file_input_submit')).toBe(true);

    // The workflow compiled onto the canonical DEFAULT-join event; the dispatcher listens on it.
    expect(composed.workflows.get('log_file')?.trigger.event).toBe('file_input.file_submitted');
    expect(composed.triggerEvents).toEqual(['file_input.file_submitted']);
  });

  it('enqueues through the composed ingress with the CLEAN GENERIC key `file_id:<id>` (never the audio suffix)', async () => {
    const enqueuer = new RecordingEnqueuer();
    const composed = composeProductDeploy(
      parseFixture(FILE_INTAKE_YAML),
      fileRollout({ enqueuer }),
    );
    const result = await composed.ingress.emit({
      id: `${TENANT}:doc-1`,
      type: 'file_input.file_submitted',
      occurred_at: '2026-07-04T00:00:00.000Z',
      payload: {
        file_id: 'doc-1',
        tenant_id: TENANT,
        source_capability: 'file_input',
        sha256: 'a'.repeat(64),
        size_bytes: 12,
        content_type: 'text/plain',
        original_filename: null,
        blob_key: `files/doc-1/${'a'.repeat(64)}`,
      },
    });
    expect(result.enqueued).toHaveLength(1);
    expect(enqueuer.calls[0]?.workflow.id).toBe('log_file');
    expect(enqueuer.calls[0]?.tenantId).toBe(TENANT);
    // ★ THE single-flight KEY PIN: the file event derives the generic `<field>:<value>` format — the legacy
    // ':finalized' suffix is audio-only (its own byte-stable pin lives in compose.test.ts).
    expect(enqueuer.calls[0]?.idempotencyKey).toBe('file_id:doc-1');
  });

  it('does NOT mount the file surface when the doc does not declare file_input (record-only doc)', () => {
    const spec = parseFixture(INTAKE_YAML);
    expect(declaresFileInput(spec)).toBe(false);
    const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
    const composed = composeProductDeploy(spec, {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
    });
    expect(composed.engineSpec.stores.map((s) => s.name)).not.toContain('file_uploads');
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).not.toContain('PUT /files/{file_id}');
    expect(paths).not.toContain('POST /files/{file_id}/submit');
    expect(composed.handlers.has('file_input_upload')).toBe(false);
    expect(composed.handlers.has('file_input_submit')).toBe(false);
    expect(composed.triggerEvents).toEqual(['record_input.record_submitted']);
  });

  it('threads rollout.file.basePath into BOTH mounted routes (the deployment option seam)', () => {
    const composed = composeProductDeploy(
      parseFixture(FILE_INTAKE_YAML),
      fileRollout({ file: { basePath: '/uploads' } }),
    );
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('PUT /uploads/{file_id}');
    expect(paths).toContain('POST /uploads/{file_id}/submit');
    expect(paths).not.toContain('PUT /files/{file_id}');
  });

  it('threads rollout.file.capability into the REAL config resolution (an invalid cap fail-closes at compose)', () => {
    // resolveFileConfig rejects a non-positive byte cap AT CONSTRUCTION (the fail-closed belt);
    // reaching that error through composeProductDeploy proves the override seam is actually wired.
    expect(() =>
      composeProductDeploy(
        parseFixture(FILE_INTAKE_YAML),
        fileRollout({ file: { capability: { maxFileBytes: -1 } } }),
      ),
    ).toThrow(/maxFileBytes must be a positive integer/);
  });

  it('rejects a route collision between a declared POST view and the file submit route (fail-closed)', () => {
    // A POST view landing on the file submit route key must be a LOUD compose rejection (no
    // delegation exists for a byte-ingest/submit route) — never a silent second owner.
    const yaml = `${FILE_INTAKE_YAML}
views:
  - id: shadowing_view
    route:
      method: POST
      path: "/files/{file_id}/submit"
    auth: bearer_tenant
    params:
      file_id: { in: path, shape: safe_id }
    source: { kind: store, ref: ingested_files }
    read:
      mode: single
      filter:
        file_id: { param: file_id }
      shape:
        fields:
          file_id: { kind: param, param: file_id }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          file_id: { kind: param, param: file_id }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: fileintake.status_response
`.replace(
      'contracts:\n  fileintake.row:\n    type: object',
      `contracts:
  fileintake.row:
    type: object
  fileintake.status_response:
    type: object
    additional_properties: false
    properties:
      file_id: { type: string }
      status: { type: [string, "null"] }
    required: [file_id, status]`,
    );
    expect(() => composeProductDeploy(parseFixture(yaml), fileRollout({}, yaml))).toThrow(
      /route collision: 'POST \/files\/\{file_id\}\/submit'/,
    );
  });
});

// ── the `file_input.parse_text` node wiring ─────────────────────────────────────────────

/** A tenant-recording stub blob factory (compose only WIRES; the node reads at run time). */
function stubBlobFactory(seen: string[] = []): (tenantId: string) => BlobStore {
  return (tenantId) => {
    seen.push(tenantId);
    return {
      put: async () => {},
      get: async (key: string) => ({ notFound: true as const, key }),
      createReadStream: async (key: string) => ({ notFound: true as const, key }),
      stat: async (key: string) => ({ notFound: true as const, key }),
      delete: async () => {},
      deleteTenant: async () => {},
    };
  };
}

describe('composeProductDeploy — file_input.parse_text (the injected blob reader)', () => {
  it('registers the parse node TENANT-BOUND when the doc declares file_input and rollout.file.blob is supplied', () => {
    const seenTenants: string[] = [];
    const composed = composeProductDeploy(
      parseFixture(FILE_PARSE_YAML),
      fileRollout({ file: { blob: stubBlobFactory(seenTenants) } }, FILE_PARSE_YAML),
    );
    // The parse step compiled onto the neutral dispatch shape (capability=file_input, op=parse_text).
    const steps = composed.workflows.get('log_file')?.steps ?? [];
    expect(steps.map((s) => `${s.capability}.${s.operation}`)).toEqual([
      'file_input.parse_text',
      'store.write',
    ]);
    // The per-run registry carries the node, built over the run tenant's blob handle.
    const registry = composed.buildNodeRegistry({
      tdb: {} as never,
      productTables: new Map(),
      tenantId: TENANT,
    });
    expect(registry.has('file_input.parse_text')).toBe(true);
    expect(seenTenants).toEqual([TENANT]);
  });

  it('fail-closes a parse_text step WITHOUT rollout.file.blob, naming the missing reader', () => {
    expect(() =>
      composeProductDeploy(parseFixture(FILE_PARSE_YAML), fileRollout({}, FILE_PARSE_YAML)),
    ).toThrow(/no tenant-bound blob reader \(rollout\.file\.blob\)/);
  });

  it('fail-closes a parse_text step on a doc that does NOT declare file_input, naming the capability', () => {
    // The PARSER already rejects this shape (product-lint dangling_ref: a capability step must
    // name a declared capability), so this compose check is defense-in-depth for a CODE-BUILT spec
    // that bypassed the parser (the checkProductStores re-run rationale) — driven here by mutating
    // the parsed record-only spec directly. record_submitted carries no blob key, so the smuggled
    // parse step must reject at compose naming file_input, never fail at run time.
    const spec = structuredClone(parseFixture(INTAKE_YAML));
    const wf = spec.workflows[0];
    if (!wf) throw new Error('fixture must declare a workflow');
    (wf.steps as unknown[]).unshift({
      id: 'parse',
      type: 'capability',
      use: 'file_input.parse_text',
      outputs: { text: 'intake.request_row' },
    });
    expect(() =>
      composeProductDeploy(spec, {
        tenantId: TENANT,
        enqueuer: new RecordingEnqueuer(),
        stores: deriveProductStores(spec, composeCapabilityStores(spec).names).stores,
        file: { blob: stubBlobFactory() },
      }),
    ).toThrow(/does not declare the 'file_input' capability/);
  });

  it('does NOT register the parse node for a file doc with no parse step and no reader (file-mount shape unchanged)', () => {
    const composed = composeProductDeploy(parseFixture(FILE_INTAKE_YAML), fileRollout());
    const registry = composed.buildNodeRegistry({
      tdb: {} as never,
      productTables: new Map(),
      tenantId: TENANT,
    });
    expect(registry.has('file_input.parse_text')).toBe(false);
  });

  it('validates rollout.file.parse overrides fail-closed AT COMPOSE (a malformed cap never reaches run time)', () => {
    expect(() =>
      composeProductDeploy(
        parseFixture(FILE_PARSE_YAML),
        fileRollout(
          { file: { blob: stubBlobFactory(), parse: { maxPdfPages: 0 } } },
          FILE_PARSE_YAML,
        ),
      ),
    ).toThrow(/rollout\.file\.parse is invalid: .*maxPdfPages must be a positive integer/);
  });

  it('fail-closes a pdfParseTimeoutMs override AT/ABOVE the compiled step timeout (typed-timeout-wins)', () => {
    // The documented invariant: the node's typed `pdf_parse_timeout` fires BEFORE the engine's
    // generic step timeout. An override >= the compiled step's timeout_policy would silently
    // invert that — cross-checked against the COMPILED value, fail-closed at compose.
    expect(() =>
      composeProductDeploy(
        parseFixture(FILE_PARSE_YAML),
        fileRollout(
          { file: { blob: stubBlobFactory(), parse: { pdfParseTimeoutMs: 40_000 } } },
          FILE_PARSE_YAML,
        ),
      ),
    ).toThrow(/pdfParseTimeoutMs .*must stay UNDER the compiled parse step's/);
  });
});
