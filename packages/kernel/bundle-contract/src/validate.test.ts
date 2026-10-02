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
import { loadExpectations, readContractJson } from './test-support/contract-files.js';
import { buildCase, type CaseExpectation, type CorpusCase } from './test-support/corpus.js';
import type { ApplicationManifest, RayManifest } from './types.js';
import {
  checkRuntimeAdmission,
  type RuntimeProfile,
  validateManifest,
  validateObjectIndex,
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
      'secret-private-key-pem-digit-word:RAY_SECRET_DETECTED',
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

  it.each([
    Number.NaN,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    2 ** 53,
  ])('refuses an archive size of %s as a usage error instead of skipping the check', (size) => {
    expect(outcome(validateManifest(bytesOf(base), { archiveSize: size }))).toMatchObject({
      code: 'RAY_USAGE',
    });
  });

  it('accepts an archive size of 0', () => {
    expect(outcome(validateManifest(bytesOf(base), { archiveSize: 0 }))).toBe('ok');
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

  it('refuses a capability the runtime does not list', () => {
    const without = {
      ...fixture,
      capabilities: fixture.capabilities.filter((id) => id !== 'extraction-deterministic'),
    };
    expect(without.capabilities).not.toEqual(fixture.capabilities);
    expect(
      admit((m) => {
        m.requires = ['extraction-deterministic'];
      }, without),
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
    expect(admit(declare('ANTHROPIC_BASE_URL'))).toMatchObject({ code: 'RAY_BINDING_RESERVED' });
    expect(admit(declare('CLAUDE_CODE_OAUTH_TOKEN'))).toBe('ok');
  });

  it('leaves the shape of requires to the derived-fields check', () => {
    // capabilities.json: requires lists only requirable ids, sorted by code point. A list that is
    // out of order or names an id a bundle cannot require never equals the list derived from the
    // spec, so the derived-fields check that follows admission refuses it as requires-mismatch
    // (the carried-forward case semantic-requires-mismatch). Refusing it any earlier would report
    // an id this runtime does not know as something other than unknown-id.
    const rules = readContractJson<{ rules: string[] }>('capabilities.json').rules;
    expect(
      rules.some((r) => r.includes('requirableByBundle') && r.includes('requires-mismatch')),
    ).toBe(true);
    expect(
      admit((m) => {
        m.requires = ['trigger-cron', 'static-frontend'];
      }),
    ).toBe('ok');
    expect(
      admit((m) => {
        m.requires = ['static-frontend', 'stt-deepgram'];
      }),
    ).toBe('ok');
    expect(
      admit((m) => {
        m.requires = ['zzz-unknown', 'static-frontend'];
      }),
    ).toEqual({ code: 'RAY_CAPABILITY_UNSUPPORTED', reason: 'unknown-id', path: '/requires/0' });
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
    // A second `agentTraceExport` member, written ahead of the receipt's own.
    const text = `{"agentTraceExport":"on",${JSON.stringify(goodReceipt).slice(1)}`;
    expect(outcome(validateReceipt(text))).toMatchObject({ reason: 'duplicate-key' });
  });
});

describe('document size limits', () => {
  // biome-ignore lint/suspicious/noExplicitAny: the documents are edited member by member.
  type Loose = Record<string, any>;
  const document = (id: string) =>
    structuredClone(expectations.documentCases.find((d) => d.id === id)!.document) as Loose;

  it('accepts the largest snapshot.json its schema admits, above the manifest limit', () => {
    const s = document('snapshot-good');
    s.tableCounts = Array.from({ length: 10_000 }, (_, i) => ({
      database: 'workflow-system',
      schema: `s${'_'.repeat(62)}`,
      table: `t${String(i).padStart(62, '0')}`,
      rows: Number.MAX_SAFE_INTEGER,
    }));
    const text = canonicalJsonFile(s);
    expect(text.length).toBeGreaterThan(DEFAULT_READER_LIMITS.manifestBytes);
    expect(outcome(validateSnapshot(text))).toBe('ok');
  });

  it('refuses snapshot.json above its limit, before parsing, as snapshot-size', () => {
    const over = ' '.repeat(DEFAULT_READER_LIMITS.snapshotBytes + 1);
    expect(outcome(validateSnapshot(over))).toMatchObject({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'snapshot-size',
    });
    const good = canonicalJsonFile(document('snapshot-good'));
    expect(outcome(validateSnapshot(good, { limits: { snapshotBytes: 10 } }))).toMatchObject({
      reason: 'snapshot-size',
    });
    // The manifest limit does not apply to snapshot.json.
    expect(outcome(validateSnapshot(good, { limits: { manifestBytes: 10 } }))).toBe('ok');
  });

  it('accepts the largest receipt its schema admits, and refuses one above its limit', () => {
    const r = document('receipt-good');
    // U+0001 is written as a six-byte escape, the longest form a character takes.
    const wide = (n: number, tail: string) => '\u0001'.repeat(n - tail.length) + tail;
    r.evidence = Array.from({ length: 128 }, (_, i) => ({
      protection: wide(128, `p${i}`),
      reference: wide(2048, 'r'),
      sha256: 'a'.repeat(64),
    }));
    r.residualRisks = Array.from({ length: 128 }, (_, i) => ({
      risk: wide(2048, `r${i}`),
      owner: wide(256, 'o'),
    }));
    const text = JSON.stringify(r);
    expect(text.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(outcome(validateReceipt(text))).toBe('ok');
    expect(outcome(validateReceipt(text, { limits: { receiptBytes: 1024 } }))).toMatchObject({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'receipt-size',
    });
  });
});

describe('object index semantics', () => {
  const TENANT_A = '00000000-0000-4000-8000-00000000000a';
  const TENANT_B = '00000000-0000-4000-8000-00000000000b';
  const sha = 'c'.repeat(64);
  const entry = (tenantId: string, key: string, storedOffset: number, storedSize: number) => ({
    tenantId,
    key,
    size: 1,
    sha256: sha,
    storedOffset,
    storedSize,
    storedSha256: sha,
  });
  const index = (objects: ReturnType<typeof entry>[]) =>
    canonicalJsonFile({ objectIndexFormatVersion: 1, objects });

  it('accepts the good document case, with and without the objects.bin size', () => {
    const good = expectations.documentCases.find((d) => d.id === 'object-index-good')!.document;
    expect(outcome(validateObjectIndex(canonicalJsonFile(good)))).toBe('ok');
    expect(outcome(validateObjectIndex(canonicalJsonFile(good), { objectsSize: 60 }))).toBe('ok');
  });

  it('accepts entries sorted by tenant, then key by byte value, with consecutive ranges', () => {
    // 'Z' (0x5a) sorts before 'a' (0x61), and an ASCII key before one starting with U+00E9.
    const doc = index([
      entry(TENANT_A, 'Z', 0, 10),
      entry(TENANT_A, 'a', 10, 5),
      entry(TENANT_A, '\u00e9', 15, 7),
      entry(TENANT_B, 'a', 22, 8),
    ]);
    const result = validateObjectIndex(doc, { objectsSize: 30 });
    expect(outcome(result)).toBe('ok');
    expect(result.ok && result.value.objects).toHaveLength(4);
  });

  it('refuses a pair listed twice, and entries out of order', () => {
    expect(
      outcome(validateObjectIndex(index([entry(TENANT_A, 'k', 0, 5), entry(TENANT_A, 'k', 5, 5)]))),
    ).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'inventory-duplicate',
      path: '/objects/1/key',
    });
    expect(
      outcome(validateObjectIndex(index([entry(TENANT_B, 'a', 0, 5), entry(TENANT_A, 'z', 5, 5)]))),
    ).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'inventory-unsorted',
      path: '/objects/1/key',
    });
    expect(
      outcome(validateObjectIndex(index([entry(TENANT_A, 'b', 0, 5), entry(TENANT_A, 'a', 5, 5)]))),
    ).toMatchObject({ reason: 'inventory-unsorted' });
  });

  it('refuses a gap, an overlap, a first range past 0 and a short or long cover of objects.bin', () => {
    const at = (objects: ReturnType<typeof entry>[], objectsSize?: number) =>
      outcome(
        validateObjectIndex(index(objects), objectsSize === undefined ? {} : { objectsSize }),
      );
    const range = { code: 'RAY_DIGEST_MISMATCH', reason: 'object-range' };
    expect(at([entry(TENANT_A, 'a', 1, 5)])).toEqual({ ...range, path: '/objects/0/storedOffset' });
    expect(at([entry(TENANT_A, 'a', 0, 5), entry(TENANT_A, 'b', 6, 5)])).toEqual({
      ...range,
      path: '/objects/1/storedOffset',
    });
    expect(at([entry(TENANT_A, 'a', 0, 5), entry(TENANT_A, 'b', 4, 5)])).toMatchObject(range);
    expect(at([entry(TENANT_A, 'a', 0, 5)], 6)).toEqual({ ...range, path: '/objects' });
    expect(at([entry(TENANT_A, 'a', 0, 5)], 4)).toMatchObject(range);
    expect(at([], 0)).toBe('ok');
    expect(at([], 1)).toMatchObject(range);
  });

  it('refuses the missing stored digest of the document case, and a non-canonical index', () => {
    const missing = expectations.documentCases.find(
      (d) => d.id === 'object-index-missing-stored-digest',
    )!.document;
    expect(outcome(validateObjectIndex(canonicalJsonFile(missing)))).toMatchObject({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'schema',
      path: '/objects/0/storedSha256',
    });
    expect(
      outcome(
        validateObjectIndex(JSON.stringify({ objectIndexFormatVersion: 1, objects: [] }, null, 1)),
      ),
    ).toMatchObject({ reason: 'not-canonical' });
  });

  it('refuses an index above the extracted byte limit as object-index-size, and a bad size option', () => {
    const doc = index([entry(TENANT_A, 'a', 0, 5)]);
    expect(
      outcome(validateObjectIndex(doc, { limits: { migrationExtractedBytes: 10 } })),
    ).toMatchObject({ code: 'RAY_LIMIT_EXCEEDED', reason: 'object-index-size' });
    expect(outcome(validateObjectIndex(doc, { objectsSize: -1 }))).toMatchObject({
      code: 'RAY_USAGE',
    });
  });
});
