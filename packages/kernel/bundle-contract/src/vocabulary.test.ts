/**
 * The exported constants restate the committed contract vocabularies exactly, and the helpers
 * built on them follow the contract's rules.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  EXIT_PRECEDENCE,
  exitCodeFor,
  exitCodeOf,
  isBundleErrorCode,
  specEnvelopeCode,
  WARNING_CODES,
} from './errors.js';
import { CONTRACT_SCHEMAS, schemaValidator } from './schemas.js';
import { loadExpectations, PACKAGE_ROOT, readContractJson } from './test-support/contract-files.js';
import {
  ALWAYS_EXCLUDED_DATA_CATEGORIES,
  BINDING_NAME_PATTERN,
  CAPABILITIES,
  CAPABILITY_VOCABULARY_VERSION,
  DATA_CATEGORIES,
  DEFAULT_READER_LIMITS,
  EXECUTION_LEVELS,
  isReservedBindingName,
  PLATFORM_GRANTABLE_BINDINGS,
  QUIESCE_BARRIERS,
  RESERVED_BINDING_NAMES,
  RESERVED_BINDING_PREFIXES,
  RESULT_OPERATIONS,
  resolveReaderLimits,
  SUPPORTED_TARGETS,
  V1_EXECUTION_LEVELS,
} from './vocabulary.js';

// biome-ignore lint/suspicious/noExplicitAny: the contract JSON files are read untyped and compared member by member.
type Json = Record<string, any>;

describe('error vocabulary', () => {
  const doc = readContractJson<Json>('error-codes.json');

  it('ERROR_CODES equals error-codes.json code for code, in order', () => {
    expect(Object.keys(ERROR_CODES)).toEqual(doc.codes.map((c: Json) => c.code));
    for (const c of doc.codes) {
      const mine = ERROR_CODES[c.code as keyof typeof ERROR_CODES];
      expect(
        { exit: mine.exit, retryable: mine.retryable, reasons: [...mine.reasons] },
        c.code,
      ).toEqual({
        exit: c.exit,
        retryable: c.retryable,
        reasons: c.reasons ?? [],
      });
    }
  });

  it('warnings and exit precedence equal the contract', () => {
    expect([...WARNING_CODES]).toEqual(doc.warnings.map((w: Json) => w.code));
    expect([...EXIT_PRECEDENCE]).toEqual(doc.exitPrecedence);
    expect(doc.exitCodes.map((e: Json) => e.exit)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('maps every spec error and warning code mechanically to its SPEC_ code', () => {
    const mapping = doc.specCodeMapping;
    expect(mapping.errors).toHaveLength(28);
    expect(mapping.warnings).toHaveLength(7);
    for (const m of [...mapping.errors, ...mapping.warnings]) {
      expect(specEnvelopeCode(m.specCode)).toBe(m.code);
    }
    expect(exitCodeOf('SPEC_YAML_PARSE_ERROR')).toBe(mapping.exit);
  });

  it('exits with the first class of the precedence among all errors', () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([{ code: 'RAY_LOCK_TIMEOUT' }])).toBe(5);
    expect(exitCodeFor([{ code: 'RAY_LOCK_TIMEOUT' }, { code: 'SPEC_FK_CYCLE' }])).toBe(1);
    expect(exitCodeFor([{ code: 'RAY_SPEC_INVALID' }, { code: 'RAY_USAGE' }])).toBe(2);
    expect(exitCodeFor([{ code: 'RAY_TARGET_UNSUPPORTED' }, { code: 'RAY_USAGE' }])).toBe(3);
    expect(exitCodeFor([{ code: 'RAY_TARGET_UNSUPPORTED' }, { code: 'RAY_POLICY_DENIED' }])).toBe(
      4,
    );
    expect(exitCodeFor([{ code: 'RAY_POLICY_DENIED' }, { code: 'RAY_SCHEMA_DRIFT' }])).toBe(6);
    expect(exitCodeFor([{ code: 'RAY_SCHEMA_DRIFT' }, { code: 'RAY_INTERNAL' }])).toBe(7);
    // A code outside the vocabulary is an internal error, never a success or a soft verdict.
    expect(exitCodeOf('RAY_NOT_A_CODE')).toBe(7);
    expect(isBundleErrorCode('toString')).toBe(false);
  });
});

describe('capability vocabulary', () => {
  const doc = readContractJson<Json>('capabilities.json');

  it('CAPABILITIES equals capabilities.json', () => {
    expect(CAPABILITY_VOCABULARY_VERSION).toBe(doc.vocabularyVersion);
    expect(CAPABILITIES).toEqual(
      doc.capabilities.map((c: Json) => ({
        id: c.id,
        status: c.status,
        requirableByBundle: c.requirableByBundle,
        managedPosture: c.managedPosture,
      })),
    );
    const pattern = new RegExp(doc.idPattern);
    expect(CAPABILITIES.every((c) => pattern.test(c.id))).toBe(true);
  });

  it('the receipt schema refuses exactly the ids the managed posture does not allow', () => {
    const receipt = CONTRACT_SCHEMAS.managedReceipt as Json;
    const refused = [...receipt.properties.capabilities.items.not.enum].sort();
    expect(refused).toEqual(
      CAPABILITIES.filter((c) => c.managedPosture !== 'allowed')
        .map((c) => c.id)
        .sort(),
    );
    const backends = CAPABILITIES.filter(
      (c) => c.id.startsWith('agent-backend-') && c.managedPosture === 'allowed',
    ).map((c) => c.id.slice('agent-backend-'.length));
    expect(receipt.properties.supportedBackends.items.enum).toEqual(backends);
  });
});

describe('reserved bindings', () => {
  const doc = readContractJson<Json>('reserved-bindings.json');

  it('the reserved names, prefixes and grantable names equal reserved-bindings.json', () => {
    expect(RESERVED_BINDING_NAMES).toEqual(doc.reservedExact.map((x: Json) => x.name));
    expect(RESERVED_BINDING_PREFIXES).toEqual(doc.reservedPrefixes.map((x: Json) => x.prefix));
    expect(PLATFORM_GRANTABLE_BINDINGS).toEqual(
      doc.platformGrantable.map((x: Json) => ({
        name: x.name,
        kind: x.kind,
        fileVariant: x.fileVariant,
      })),
    );
    expect(BINDING_NAME_PATTERN.source).toBe(doc.namePattern);
  });

  it('reserves every _FILE variant and no platform-grantable name', () => {
    for (const g of PLATFORM_GRANTABLE_BINDINGS) {
      expect(isReservedBindingName(g.fileVariant), g.fileVariant).toBe(true);
      expect(isReservedBindingName(g.name), g.name).toBe(false);
    }
  });

  it('matches exact names and prefixes byte for byte', () => {
    expect(isReservedBindingName('DATABASE_URL')).toBe(true);
    expect(isReservedBindingName('PGPASSWORD')).toBe(true);
    expect(isReservedBindingName('RAYSPEC_JWT_SIGNING_KEY')).toBe(true);
    expect(isReservedBindingName('CLOUD_PROVIDER_TOKEN')).toBe(true);
    expect(isReservedBindingName('NODE_OPTIONS')).toBe(true);
    expect(isReservedBindingName('ACME_WEBHOOK_SECRET')).toBe(false);
    expect(isReservedBindingName('DATABASE_URL_2')).toBe(false);
    expect(isReservedBindingName('database_url')).toBe(false);
  });

  it('reserves the provider and process settings an agent subprocess inherits', () => {
    // The Anthropic adapter hands its whole environment to the agent CLI subprocess, so a bundle
    // binding under these names would redirect provider traffic, and the key with it.
    for (const name of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_USE_BEDROCK',
      'ALL_PROXY',
      'BASH_ENV',
      'GLIBC_TUNABLES',
      'OPENSSL_CONF',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      expect(isReservedBindingName(name), name).toBe(true);
    }
    expect(isReservedBindingName('ANTHROPIC_API_KEY')).toBe(false);
    expect(isReservedBindingName('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
    expect(isReservedBindingName('ANTHROPIC_API_KEY_FILE')).toBe(true);
  });

  it('every source a reserved name cites is a repository file or a contract document', () => {
    const repoRoot = join(PACKAGE_ROOT, '..', '..', '..');
    const lockFiles = readContractJson<Json>('CONTRACT-LOCK.json').files as Record<string, string>;
    for (const entry of doc.reservedExact as Json[]) {
      for (const part of String(entry.source).split('; ')) {
        const cited = /^([^\s:]+):\d+(?:-\d+)?(?:,\d+)*$/.exec(part);
        if (cited === null) continue;
        const file = cited[1]!;
        expect(existsSync(join(repoRoot, file)) || lockFiles[file] !== undefined, part).toBe(true);
      }
    }
  });
});

describe('limits, targets, execution levels and data categories', () => {
  const expectations = loadExpectations();

  it('DEFAULT_READER_LIMITS equals the contract defaults', () => {
    expect({ ...DEFAULT_READER_LIMITS }).toEqual(expectations.readerLimitsDefault);
  });

  it('a limit may be lowered, never raised or made invalid', () => {
    expect(resolveReaderLimits({ archiveBytes: 1024 }).archiveBytes).toBe(1024);
    expect(resolveReaderLimits({}).entryCount).toBe(10_000);
    expect(() => resolveReaderLimits({ entryCount: 10_001 })).toThrow(RangeError);
    expect(() => resolveReaderLimits({ jsonDepth: -1 })).toThrow(RangeError);
    expect(() => resolveReaderLimits({ manifestBytes: 1.5 })).toThrow(RangeError);
  });

  it('a v1 runtime supports exactly the fixture target', () => {
    expect(SUPPORTED_TARGETS).toEqual([expectations.runtimeProfiles.fixture!.target]);
  });

  it('execution levels equal the manifest and receipt schemas', () => {
    const manifest = CONTRACT_SCHEMAS.manifest as Json;
    const receipt = CONTRACT_SCHEMAS.managedReceipt as Json;
    expect(EXECUTION_LEVELS).toEqual(manifest.properties.permissions.properties.execution.enum);
    expect(V1_EXECUTION_LEVELS).toEqual(receipt.properties.executionLevels.items.enum);
  });

  it('data categories equal the snapshot schema and snapshot-categories.json', () => {
    const snapshot = CONTRACT_SCHEMAS.snapshot as Json;
    const categories = readContractJson<Json>('snapshot-categories.json').categories;
    expect(DATA_CATEGORIES).toEqual(snapshot.$defs.dataCategory.enum);
    expect(DATA_CATEGORIES).toEqual(categories.map((c: Json) => c.id));
    const alwaysExcluded = snapshot.properties.excludedDataCategories.allOf.map(
      (a: Json) => a.contains.const,
    );
    expect(ALWAYS_EXCLUDED_DATA_CATEGORIES).toEqual(alwaysExcluded);
    expect(ALWAYS_EXCLUDED_DATA_CATEGORIES).toEqual(
      categories.filter((c: Json) => c.default === 'excluded').map((c: Json) => c.id),
    );
  });

  it('result operations and quiesce barriers equal the result envelope schema', () => {
    const envelope = readContractJson<Json>('cli-verbs.json').envelopeSchema;
    expect([...RESULT_OPERATIONS]).toEqual(envelope.properties.operation.enum);
    const quiesce = envelope.allOf.find(
      (a: Json) => a.if?.properties?.operation?.const === 'runtime.quiesce',
    );
    const data = quiesce.then.properties.data.oneOf[0];
    expect([...QUIESCE_BARRIERS]).toEqual(data.properties.barriers.items.properties.barrier.enum);
  });

  it('every contract schema compiles under Ajv 2020 strict mode', () => {
    for (const name of Object.keys(CONTRACT_SCHEMAS) as (keyof typeof CONTRACT_SCHEMAS)[]) {
      expect(() => schemaValidator(name), name).not.toThrow();
    }
    expect(() => schemaValidator('snapshot', '/$defs/objectIndex')).not.toThrow();
    expect(() => schemaValidator('releaseManifest', '/$defs/signatureFile')).not.toThrow();
  });
});
