/**
 * The validators against the golden corpus and the document cases, plus every semantic rule the
 * corpus does not reach.
 *
 * Each byte-level case is rebuilt, and the bytes of its `ray.json` entry go through
 * `validateManifest`. The golden expectation of the first failing reader step decides what must
 * come out: a failure in the manifest bytes, schema, kind limit or semantics steps must be
 * reproduced with the exact code and reason, and every other case must pass, because its defect
 * lies in the container, the payload or a later step. Cases that pass inspection then go through
 * `checkRuntimeAdmission` with the case's runtime profile.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalJsonFile } from './canonical-json.js';
import { schemaValidator } from './schemas.js';
import { loadExpectations } from './test-support/contract-files.js';
import { buildCase, type CaseExpectation, type CorpusCase } from './test-support/corpus.js';
import type { ApplicationManifest, RayManifest } from './types.js';
import {
  checkRuntimeAdmission,
  type RuntimeProfile,
  validateManifest,
  validateReceipt,
  validateSnapshot,
} from './validate.js';
import { CAPABILITIES, DEFAULT_READER_LIMITS, type ReaderLimits } from './vocabulary.js';

const expectations = loadExpectations();

/** Reasons a failure in the manifest bytes, schema, kind limit or semantics steps can carry. */
const MANIFEST_STEP = new Set([
  'RAY_LIMIT_EXCEEDED:manifest-size',
  'RAY_LIMIT_EXCEEDED:json-depth',
  ...[
    'invalid-utf8',
    'bom',
    'invalid-json',
    'duplicate-key',
    'float',
    'non-nfc',
    'not-canonical',
    'schema',
    'inventory-unsorted',
    'inventory-duplicate',
    'spec-not-in-inventory',
    'binding-duplicate',
    'closure-files-missing',
    'product-migration-files-missing',
    'migration-inventory',
  ].map((r) => `RAY_MANIFEST_INVALID:${r}`),
]);
/** Codes of the runtime, target, capability and reserved-binding steps. */
const ADMISSION_STEP = new Set([
  'RAY_RUNTIME_UNSUPPORTED',
  'RAY_TARGET_UNSUPPORTED',
  'RAY_CAPABILITY_UNSUPPORTED',
  'RAY_BINDING_RESERVED',
]);

const AVAILABLE = CAPABILITIES.filter((c) => c.status === 'available').map((c) => c.id);
const PROFILES: Record<string, RuntimeProfile> = {
  fixture: { version: expectations.runtimeProfiles.fixture!.version, capabilities: AVAILABLE },
  other: { version: expectations.runtimeProfiles.other!.version, capabilities: AVAILABLE },
  'without-static-frontend': {
    version: expectations.runtimeProfiles['without-static-frontend']!.version,
    capabilities: AVAILABLE.filter((id) => id !== 'static-frontend'),
  },
};

function firstExpectation(c: CorpusCase): CaseExpectation {
  return c.expect.find((e) => e.operation === 'bundle.inspect') ?? c.expect[0]!;
}

/** The archive-size refusal belongs to the schema step when the operation budget let it pass. */
function isManifestStep(c: CorpusCase, e: CaseExpectation, size: number): boolean {
  if (e.ok) return false;
  if (e.code === 'RAY_LIMIT_EXCEEDED' && e.reason === 'archive-size') {
    const limits = { ...DEFAULT_READER_LIMITS, ...c.construction.readerLimits };
    return size <= Math.max(limits.archiveBytes, limits.migrationArchiveBytes);
  }
  return MANIFEST_STEP.has(`${e.code}:${e.reason}`);
}

const runs = expectations.cases.map((c) => {
  const { bytes, manifestBytes } = buildCase(expectations, c.construction);
  return { c, bytes, manifestBytes };
});

describe('validateManifest over the corpus', () => {
  const manifestCases = runs.filter(({ c, bytes }) =>
    isManifestStep(c, firstExpectation(c), bytes.length),
  );

  it('covers every case whose outcome is decided by the manifest', () => {
    expect(manifestCases.length).toBe(50);
    expect(new Set(manifestCases.map(({ c }) => c.layer))).toEqual(
      new Set(['manifest-json', 'limit', 'manifest-schema', 'manifest-semantic', 'migration']),
    );
  });

  it.each(
    manifestCases.map((r) => [r.c.id, r] as const),
  )('%s is refused with its exact code and reason', (_id, { c, bytes, manifestBytes }) => {
    const e = firstExpectation(c);
    const result = validateManifest(manifestBytes!, {
      limits: c.construction.readerLimits as Partial<ReaderLimits>,
      archiveSize: bytes.length,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect({ code: error!.code, reason: error!.reason }).toEqual({
      code: e.code,
      reason: e.reason,
    });
    expect(error!.retryable).toBe(false);
  });

  const passing = runs.filter(
    ({ c, bytes, manifestBytes }) =>
      manifestBytes !== null && !isManifestStep(c, firstExpectation(c), bytes.length),
  );

  it.each(
    passing.map((r) => [r.c.id, r] as const),
  )('%s has a manifest that passes, so its defect lies elsewhere', (_id, {
    c,
    bytes,
    manifestBytes,
  }) => {
    const result = validateManifest(manifestBytes!, {
      limits: c.construction.readerLimits as Partial<ReaderLimits>,
      archiveSize: bytes.length,
    });
    expect(result.ok ? 'ok' : result.errors[0]).toBe('ok');
  });

  it('the two raw-bytes cases have no manifest entry at all', () => {
    expect(runs.filter((r) => r.manifestBytes === null).map((r) => r.c.id)).toEqual([
      'archive-not-a-zip',
      'archive-empty-zip',
    ]);
  });
});

describe('checkRuntimeAdmission over the corpus', () => {
  const admitted = runs.filter(({ c }) => {
    const inspect = c.expect.find((e) => e.operation === 'bundle.inspect');
    return (
      (inspect === undefined || inspect.ok) && c.expect.some((e) => e.operation === 'bundle.verify')
    );
  });

  const verifyOf = (c: CorpusCase) => c.expect.find((e) => e.operation === 'bundle.verify')!;

  it.each(
    admitted.map((r) => [r.c.id, r] as const),
  )('%s gets its expected admission verdict', (_id, { c, manifestBytes }) => {
    const parsed = validateManifest(manifestBytes!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const e = verifyOf(c);
    const result = checkRuntimeAdmission(parsed.value, PROFILES[e.runtimeProfile!]!);
    if (!e.ok && ADMISSION_STEP.has(e.code!)) {
      expect(
        result.ok ? 'ok' : { code: result.errors[0]!.code, reason: result.errors[0]!.reason },
      ).toEqual({
        code: e.code,
        reason: e.reason,
      });
    } else {
      expect(result.ok ? 'ok' : result.errors[0]).toBe('ok');
    }
  });

  it('carries forward exactly the verdicts that need the payload', () => {
    // Spec parse, derived fields, secret scan and signature follow admission and read the payload;
    // the archive reader runs them. Listing them here keeps any of them from being dropped silently.
    const later = admitted
      .filter(({ c }) => !verifyOf(c).ok && !ADMISSION_STEP.has(verifyOf(c).code!))
      .map(({ c }) => `${c.id}:${verifyOf(c).code}`);
    expect(later).toEqual([
      'semantic-requires-mismatch:RAY_MANIFEST_INVALID',
      'semantic-execution-mismatch:RAY_MANIFEST_INVALID',
      'semantic-egress-mismatch:RAY_MANIFEST_INVALID',
      'spec-invalid:RAY_SPEC_INVALID',
      'secret-dotenv-file:RAY_SECRET_DETECTED',
      'secret-private-key-pem:RAY_SECRET_DETECTED',
      'signature-untrusted:RAY_SIGNATURE_INVALID',
      'signature-mismatch:RAY_SIGNATURE_INVALID',
      'signature-flipped-bit:RAY_SIGNATURE_INVALID',
    ]);
  });
});

// ─── semantic rules the corpus does not reach ──────────────────────────────────────────────────

const base = expectations.bases.application.manifest as unknown as ApplicationManifest;
const bytesOf = (m: unknown) => canonicalJsonFile(m);
const withChange = (change: (m: ApplicationManifest) => void): string => {
  const m = structuredClone(base);
  change(m);
  return bytesOf(m);
};
const outcome = (r: {
  ok: boolean;
  errors?: { code: string; reason?: string; path?: string }[];
}) =>
  r.ok
    ? 'ok'
    : { code: r.errors![0]!.code, reason: r.errors![0]!.reason, path: r.errors![0]!.path };

describe('manifest semantics', () => {
  const sha = 'a'.repeat(64);
  const withMigration = (inventoryPaths: string[], allowlist: boolean) =>
    withChange((m) => {
      m.productMigration = {
        fromProductSchemaDigest: sha,
        toProductSchemaDigest: sha,
        deltaPath: 'payload/migrations/0001.sql',
        destructive: false,
        ...(allowlist ? { allowlistPath: 'payload/migrations/allow.json' } : {}),
      };
      for (const path of inventoryPaths) m.inventory.push({ path, size: 0, sha256: sha });
      m.inventory.sort((a, b) => (a.path < b.path ? -1 : 1));
    });

  it('accepts a product migration whose files are in the inventory', () => {
    const text = withMigration(
      ['payload/migrations/0001.sql', 'payload/migrations/allow.json'],
      true,
    );
    expect(outcome(validateManifest(text))).toBe('ok');
  });

  it('refuses a product migration whose delta is not in the inventory', () => {
    expect(outcome(validateManifest(withMigration([], false)))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'product-migration-files-missing',
      path: '/productMigration/deltaPath',
    });
  });

  it('refuses a product migration whose allowlist is not in the inventory', () => {
    expect(outcome(validateManifest(withMigration(['payload/migrations/0001.sql'], true)))).toEqual(
      {
        code: 'RAY_MANIFEST_INVALID',
        reason: 'product-migration-files-missing',
        path: '/productMigration/allowlistPath',
      },
    );
  });

  it('refuses a missing notices file as it refuses a missing SBOM', () => {
    const text = withChange((m) => {
      m.inventory = m.inventory.filter((e) => e.path !== 'payload/THIRD-PARTY-NOTICES.txt');
    });
    expect(outcome(validateManifest(text))).toMatchObject({ reason: 'closure-files-missing' });
  });

  it('names the second of two equal inventory paths', () => {
    const text = withChange((m) => {
      m.inventory.splice(2, 0, structuredClone(m.inventory[1]!));
    });
    expect(outcome(validateManifest(text))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'inventory-duplicate',
      path: '/inventory/2/path',
    });
  });

  it('points a schema failure at the offending member', () => {
    expect(
      outcome(
        validateManifest(
          withChange((m) => {
            (m as unknown as Record<string, unknown>).extra = 1;
          }),
        ),
      ),
    ).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema', path: '/extra' });
    expect(
      outcome(
        validateManifest(
          withChange((m) => {
            delete (m as Partial<ApplicationManifest>).bindings;
          }),
        ),
      ),
    ).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema', path: '/bindings' });
    expect(
      outcome(
        validateManifest(
          withChange((m) => {
            m.target.nodeMajor = 0;
          }),
        ),
      ),
    ).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema', path: '/target/nodeMajor' });
  });

  it('applies the archive limit of the kind only when an archive size is given', () => {
    const text = bytesOf(base);
    expect(outcome(validateManifest(text, { limits: { archiveBytes: 10 } }))).toBe('ok');
    expect(
      outcome(validateManifest(text, { limits: { archiveBytes: 10 }, archiveSize: 11 })),
    ).toMatchObject({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'archive-size',
    });
    expect(outcome(validateManifest(text, { limits: { archiveBytes: 10 }, archiveSize: 10 }))).toBe(
      'ok',
    );
  });

  it('returns the typed manifest', () => {
    const result = validateManifest(bytesOf(base));
    expect(result.ok && (result.value as RayManifest).kind).toBe('application');
    expect(result.ok && canonicalJson(result.value)).toBe(canonicalJson(base));
  });
});

describe('runtime admission', () => {
  const fixture = PROFILES.fixture!;
  const admit = (change: (m: ApplicationManifest) => void, profile = fixture) => {
    const parsed = validateManifest(withChange(change));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return outcome(checkRuntimeAdmission(parsed.value, profile));
  };

  it('checks capabilities in requires order, before the execution level', () => {
    expect(
      admit((m) => {
        m.requires = ['static-frontend', 'teleport', 'zzz-unknown'];
        m.permissions.execution = 'sandboxed';
      }),
    ).toEqual({ code: 'RAY_CAPABILITY_UNSUPPORTED', reason: 'unknown-id', path: '/requires/1' });
  });

  it('refuses a planned capability the runtime does not list', () => {
    expect(
      admit((m) => {
        m.requires = ['extraction-deterministic'];
      }),
    ).toEqual({ code: 'RAY_CAPABILITY_UNSUPPORTED', reason: 'not-provided', path: '/requires/0' });
  });

  it('accepts in-process on a v1 runtime and refuses it where the runtime lacks it', () => {
    expect(
      admit((m) => {
        m.permissions.execution = 'in-process';
      }),
    ).toBe('ok');
    expect(
      admit(
        (m) => {
          m.permissions.execution = 'in-process';
        },
        { ...fixture, executionLevels: ['none'] },
      ),
    ).toMatchObject({ reason: 'execution-level' });
  });

  it('refuses reserved names and admits application and platform-grantable names', () => {
    const declare = (name: string) => (m: ApplicationManifest) => {
      m.bindings.push({ name, kind: 'secret', required: true, description: 'x' });
    };
    expect(admit(declare('PGHOST'))).toEqual({
      code: 'RAY_BINDING_RESERVED',
      reason: undefined,
      path: '/bindings/0/name',
    });
    expect(admit(declare('OTEL_EXPORTER_OTLP_ENDPOINT'))).toMatchObject({
      code: 'RAY_BINDING_RESERVED',
    });
    expect(admit(declare('ACME_WEBHOOK_SECRET'))).toBe('ok');
    expect(admit(declare('OPENAI_API_KEY'))).toBe('ok');
  });

  it('checks a migration manifest for runtime and target only', () => {
    const migration = expectations.bases.migration.manifest;
    const parsed = validateManifest(bytesOf(migration));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      outcome(checkRuntimeAdmission(parsed.value, { version: 'x', capabilities: [] })),
    ).toMatchObject({
      code: 'RAY_RUNTIME_UNSUPPORTED',
    });
    expect(outcome(checkRuntimeAdmission(parsed.value, { ...fixture, capabilities: [] }))).toBe(
      'ok',
    );
    expect(
      outcome(
        checkRuntimeAdmission(parsed.value, {
          ...fixture,
          targets: [{ os: 'linux', arch: 'arm64', nodeMajor: 22 }],
        }),
      ),
    ).toMatchObject({ code: 'RAY_TARGET_UNSUPPORTED' });
  });
});

// ─── document cases ────────────────────────────────────────────────────────────────────────────

describe('document cases', () => {
  const cases = expectations.documentCases;

  it('covers every document case', () => {
    expect(cases).toHaveLength(41);
  });

  const snapshotCases = cases.filter((d) => d.schema === 'snapshot.schema.json');
  it.each(snapshotCases.map((d) => [d.id, d] as const))('snapshot %s', (_id, d) => {
    const result = validateSnapshot(canonicalJsonFile(d.document));
    expect(result.ok).toBe(d.valid);
    if (!result.ok)
      expect(outcome(result)).toMatchObject({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
  });

  const receiptCases = cases.filter((d) => d.schema === 'managed-receipt.schema.json');
  it.each(receiptCases.map((d) => [d.id, d] as const))('receipt %s', (_id, d) => {
    const result = validateReceipt(JSON.stringify(d.document, null, 2));
    expect(result.ok).toBe(d.valid);
    if (!result.ok)
      expect(outcome(result)).toMatchObject({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
  });

  const SCHEMA_OF: Record<string, [Parameters<typeof schemaValidator>[0], string]> = {
    'snapshot.schema.json#/$defs/objectIndex': ['snapshot', '/$defs/objectIndex'],
    'release-manifest.schema.json': ['releaseManifest', ''],
    'release-manifest.schema.json#/$defs/signatureFile': [
      'releaseManifest',
      '/$defs/signatureFile',
    ],
    'cli-verbs.json#/envelopeSchema': ['resultEnvelope', ''],
    'reserved-bindings.json#/bindingsFile/schema': ['bindingsFile', ''],
  };
  const schemaCases = cases.filter((d) => SCHEMA_OF[d.schema] !== undefined);

  it('every document case has a validator', () => {
    expect(snapshotCases.length + receiptCases.length + schemaCases.length).toBe(cases.length);
  });

  it.each(schemaCases.map((d) => [d.id, d] as const))('schema %s', (_id, d) => {
    const [name, pointer] = SCHEMA_OF[d.schema]!;
    expect(schemaValidator(name, pointer)(d.document)).toBe(d.valid);
  });
});

describe('snapshot and receipt semantics', () => {
  const goodSnapshot = expectations.documentCases.find((d) => d.id === 'snapshot-good')!
    .document as {
    inventory: { path: string }[];
  };
  const goodReceipt = expectations.documentCases.find((d) => d.id === 'receipt-good')!.document as {
    capabilities: string[];
  };

  it('refuses a snapshot inventory out of byte order', () => {
    const s = structuredClone(goodSnapshot);
    s.inventory.reverse();
    expect(outcome(validateSnapshot(canonicalJsonFile(s)))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'inventory-unsorted',
      path: '/inventory/1/path',
    });
  });

  it('requires snapshot.json in canonical form but not a receipt', () => {
    expect(outcome(validateSnapshot(JSON.stringify(goodSnapshot)))).toMatchObject({
      reason: 'not-canonical',
    });
    expect(outcome(validateReceipt(JSON.stringify(goodReceipt)))).toBe('ok');
  });

  it('refuses a receipt capability the vocabulary does not know', () => {
    const r = structuredClone(goodReceipt);
    r.capabilities = ['static-frontend', 'teleport'];
    expect(outcome(validateReceipt(JSON.stringify(r)))).toEqual({
      code: 'RAY_CAPABILITY_UNSUPPORTED',
      reason: 'unknown-id',
      path: '/capabilities/1',
    });
  });

  it('refuses a receipt with a duplicate key even though canonical form is not required', () => {
    const text = JSON.stringify(goodReceipt).replace('{', '{"agentTraceExport":"on",');
    expect(outcome(validateReceipt(text))).toMatchObject({ reason: 'duplicate-key' });
  });
});
