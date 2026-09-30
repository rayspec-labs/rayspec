/**
 * The pure runtime-control rules: request checks, the whole-second timestamp form, the plan digest
 * input and its expiry, the product schema digest and the binding revision id.
 *
 * The plan digest is pinned against a hand-written canonical document, so a change to key order,
 * sorting or the constants shows up as a different digest rather than as a silently different plan.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bindingRevisionId,
  checkApplyControl,
  checkApplyRequest,
  checkPrepareRequest,
  checkQuiesceRequest,
  checkRequestBase,
  checkResumeRequest,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  formatTimestamp,
  isPlanExpired,
  normalizeProductSchema,
  PLAN_LIFETIME_MS,
  type PlanDigestInputs,
  type ProductTable,
  parseTimestamp,
  planDigest,
  planDigestInput,
  planExpiresAt,
  productSchemaDigest,
  sameSchemaHead,
} from './runtime-control.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const base = {
  contractVersion: '1.0.0-draft.2',
  operationId: '0b6f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  actor: 'operator@example.test',
};

describe('checkRequestBase', () => {
  it('accepts a well-formed request', () => {
    expect(checkRequestBase(base)).toEqual([]);
  });

  it.each([
    ['a non-object', null, ''],
    ['another contract version', { ...base, contractVersion: '1.0.0' }, '/contractVersion'],
    [
      'a UUID that is not version 4',
      { ...base, operationId: '0b6f7c1e-2f3a-1b5c-8d9e-0f1a2b3c4d5e' },
      '/operationId',
    ],
    [
      'an upper-case UUID',
      { ...base, operationId: base.operationId.toUpperCase() },
      '/operationId',
    ],
    ['an empty actor', { ...base, actor: '' }, '/actor'],
    ['an actor over 256 characters', { ...base, actor: 'x'.repeat(257) }, '/actor'],
    ['an actor with a control character', { ...base, actor: 'a\nb' }, '/actor'],
  ])('refuses %s with RAY_USAGE at its path', (_label, request, path) => {
    const errors = checkRequestBase(request);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'RAY_USAGE', path, retryable: false });
  });
});

describe('checkPrepareRequest', () => {
  const prepare = {
    ...base,
    bundleSha256: A,
    bundlePath: '/srv/staging/app.ray',
    bindingRevision: [{ name: 'OPENAI_API_KEY', revisionId: 'r1' }],
    expectedSchemaHead: null,
  };

  it('accepts a well-formed request, with or without an expected head', () => {
    expect(checkPrepareRequest(prepare)).toEqual([]);
    expect(
      checkPrepareRequest({
        ...prepare,
        expectedSchemaHead: { platform: '0011_tenant_event_bus', product: B },
      }),
    ).toEqual([]);
  });

  it.each([
    ['an upper-case digest', { ...prepare, bundleSha256: A.toUpperCase() }, '/bundleSha256'],
    ['a relative path', { ...prepare, bundlePath: 'app.ray' }, '/bundlePath'],
    ['a path with a NUL byte', { ...prepare, bundlePath: '/a\0b' }, '/bundlePath'],
    ['revisions that are not a list', { ...prepare, bindingRevision: {} }, '/bindingRevision'],
    [
      'a revision with an extra member',
      { ...prepare, bindingRevision: [{ name: 'A', revisionId: 'r', value: 'x' }] },
      '/bindingRevision/0',
    ],
    [
      'a lower-case binding name',
      { ...prepare, bindingRevision: [{ name: 'a', revisionId: 'r' }] },
      '/bindingRevision/0',
    ],
    [
      'a binding named twice',
      {
        ...prepare,
        bindingRevision: [
          { name: 'A', revisionId: 'r' },
          { name: 'A', revisionId: 's' },
        ],
      },
      '/bindingRevision/1/name',
    ],
    [
      'a missing expected head',
      { ...base, bundleSha256: A, bundlePath: '/x', bindingRevision: [] },
      '/expectedSchemaHead',
    ],
    [
      'a malformed expected head',
      { ...prepare, expectedSchemaHead: { platform: 'latest', product: B } },
      '/expectedSchemaHead',
    ],
  ])('refuses %s', (_label, request, path) => {
    const errors = checkPrepareRequest(request);
    expect(errors[0]).toMatchObject({ code: 'RAY_USAGE', path });
  });
});

describe('checkQuiesceRequest', () => {
  const quiesce = {
    ...base,
    reason: 'export before a host move',
    deadline: '2026-09-29T12:05:00Z',
    sourceStopped: false,
  };

  it('accepts a well-formed request', () => {
    expect(checkQuiesceRequest(quiesce)).toEqual([]);
    expect(checkQuiesceRequest({ ...quiesce, sourceStopped: true })).toEqual([]);
  });

  it.each([
    ['a base member that is wrong', { ...quiesce, actor: '' }, '/actor'],
    ['an empty reason', { ...quiesce, reason: '' }, '/reason'],
    ['a reason over 1024 characters', { ...quiesce, reason: 'r'.repeat(1025) }, '/reason'],
    ['a reason with a control character', { ...quiesce, reason: 'a\u0007b' }, '/reason'],
    [
      'a deadline with fractional seconds',
      { ...quiesce, deadline: '2026-09-29T12:05:00.5Z' },
      '/deadline',
    ],
    [
      'a deadline with an offset',
      { ...quiesce, deadline: '2026-09-29T12:05:00+01:00' },
      '/deadline',
    ],
    ['a missing deadline', { ...base, reason: 'r', sourceStopped: false }, '/deadline'],
    [
      'a sourceStopped that is not a boolean',
      { ...quiesce, sourceStopped: 'yes' },
      '/sourceStopped',
    ],
  ])('refuses %s', (_label, request, path) => {
    const errors = checkQuiesceRequest(request);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'RAY_USAGE', path });
  });
});

describe('checkResumeRequest', () => {
  it('accepts epoch 0 and a positive epoch', () => {
    expect(checkResumeRequest({ ...base, fenceEpoch: 0 })).toEqual([]);
    expect(checkResumeRequest({ ...base, fenceEpoch: 7 })).toEqual([]);
  });

  it.each([
    ['a negative epoch', -1],
    ['a fractional epoch', 1.5],
    ['an epoch past the safe integers', 2 ** 53],
    ['an epoch given as a string', '3'],
    ['a missing epoch', undefined],
  ])('refuses %s', (_label, fenceEpoch) => {
    const errors = checkResumeRequest({ ...base, fenceEpoch });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/fenceEpoch' });
  });
});

describe('checkApplyRequest', () => {
  const apply = {
    ...base,
    planDigest: A,
    bundleSha256: B,
    bundlePath: '/srv/staging/app.ray',
    bindingRevision: [{ name: 'SUPPORT_EMAIL', revisionId: C }],
    preparedAt: '2026-09-29T12:00:00Z',
    expectedEnvironmentRevision: 3,
    idempotencyKey: 'deploy-2026-09-29_0001',
    grant: { approvedBy: 'owner@example.test', approvedAt: '2026-09-29T12:01:00Z' },
  };

  it('accepts a complete request, and the apply members alone', () => {
    expect(checkApplyRequest(apply)).toEqual([]);
    expect(
      checkApplyControl({
        ...base,
        planDigest: A,
        expectedEnvironmentRevision: 1,
        idempotencyKey: 'k'.repeat(16),
      }),
    ).toEqual([]);
  });

  it.each([
    ['a plan digest that is not a SHA-256', { planDigest: 'A'.repeat(64) }, '/planDigest'],
    ['revision 0', { expectedEnvironmentRevision: 0 }, '/expectedEnvironmentRevision'],
    ['a fractional revision', { expectedEnvironmentRevision: 1.5 }, '/expectedEnvironmentRevision'],
    ['a key of 15 characters', { idempotencyKey: 'k'.repeat(15) }, '/idempotencyKey'],
    ['a key of 129 characters', { idempotencyKey: 'k'.repeat(129) }, '/idempotencyKey'],
    ['a key with a dot', { idempotencyKey: 'deploy.2026-09-29' }, '/idempotencyKey'],
    ['a relative bundle path', { bundlePath: 'app.ray' }, '/bundlePath'],
    ['a sub-second preparedAt', { preparedAt: '2026-09-29T12:00:00.5Z' }, '/preparedAt'],
    ['a grant with an extra member', { grant: { ...apply.grant, note: 'x' } }, '/grant'],
    [
      'an approver with a newline',
      { grant: { approvedBy: 'a\nb', approvedAt: '2026-09-29T12:01:00Z' } },
      '/grant/approvedBy',
    ],
    [
      'an approval time without Z',
      { grant: { approvedBy: 'owner', approvedAt: '2026-09-29T12:01:00' } },
      '/grant/approvedAt',
    ],
  ])('refuses %s', (_label, change, path) => {
    const errors = checkApplyRequest({ ...apply, ...change });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'RAY_USAGE', path });
  });

  it('checks the common members first', () => {
    expect(checkApplyRequest({ ...apply, operationId: 'nope' })[0]).toMatchObject({
      path: '/operationId',
    });
  });
});

describe('timestamps', () => {
  it('writes whole seconds in UTC with Z', () => {
    expect(formatTimestamp(new Date('2026-09-29T12:00:00.999Z'))).toBe('2026-09-29T12:00:00Z');
  });

  it('parses only the form it writes', () => {
    expect(parseTimestamp('2026-09-29T12:00:00Z')?.toISOString()).toBe('2026-09-29T12:00:00.000Z');
    expect(parseTimestamp('2026-09-29T12:00:00.5Z')).toBeNull();
    expect(parseTimestamp('2026-09-29T12:00:00+00:00')).toBeNull();
    expect(parseTimestamp('2026-02-30T12:00:00Z')).toBeNull();
    expect(parseTimestamp(42)).toBeNull();
  });
});

describe('plan expiry', () => {
  const preparedAt = '2026-09-29T12:00:00Z';

  it('expires exactly thirty minutes after preparedAt', () => {
    expect(PLAN_LIFETIME_MS).toBe(1_800_000);
    expect(planExpiresAt(preparedAt)).toBe('2026-09-29T12:30:00Z');
  });

  it('is valid up to, and not including, expiresAt', () => {
    const at = Date.parse('2026-09-29T12:00:00Z');
    expect(isPlanExpired(preparedAt, new Date(at))).toBe(false);
    expect(isPlanExpired(preparedAt, new Date(at + PLAN_LIFETIME_MS - 1))).toBe(false);
    expect(isPlanExpired(preparedAt, new Date(at + PLAN_LIFETIME_MS))).toBe(true);
  });

  it('treats a preparedAt in the future or in another form as expired', () => {
    const at = Date.parse('2026-09-29T12:00:00Z');
    expect(isPlanExpired('2026-09-29T12:00:01Z', new Date(at))).toBe(true);
    expect(isPlanExpired('2026-09-29T12:00:00.000Z', new Date(at))).toBe(true);
    expect(() => planExpiresAt('yesterday')).toThrow(RangeError);
  });
});

describe('plan digest', () => {
  const inputs: PlanDigestInputs = {
    bundleSha256: A,
    releaseManifestSha256: null,
    schemaHeadFrom: { platform: '0011_tenant_event_bus', product: B },
    schemaHeadTo: { platform: '0012_runtime_control', product: C },
    productDeltaSha256: null,
    bindingRevisions: [
      { name: 'OPENAI_API_KEY', revisionId: 'r2' },
      { name: 'ANTHROPIC_API_KEY', revisionId: 'r1' },
    ],
    grants: {
      execution: 'in-process',
      egressHosts: ['b.example', 'a.example'],
      capabilities: ['stream-routes', 'declarative-api'],
    },
    environmentRevision: 3,
    preparedAt: '2026-09-29T12:00:00Z',
  };

  it('is the SHA-256 of the canonical document the contract lists', () => {
    const expected =
      '{"bindingRevisions":[{"name":"ANTHROPIC_API_KEY","revisionId":"r1"},{"name":"OPENAI_API_KEY","revisionId":"r2"}],' +
      `"bundleSha256":"${A}","contractVersion":"1.0.0-draft.2","environmentRevision":3,"expiresAt":"2026-09-29T12:30:00Z",` +
      '"grants":{"capabilities":["declarative-api","stream-routes"],"egressHosts":["a.example","b.example"],"execution":"in-process"},' +
      `"planFormatVersion":1,"preparedAt":"2026-09-29T12:00:00Z","productDeltaSha256":null,"runtimeReleaseDigest":"unreleased",` +
      `"schemaHeadFrom":{"platform":"0011_tenant_event_bus","product":"${B}"},"schemaHeadTo":{"platform":"0012_runtime_control","product":"${C}"}}`;
    expect(planDigest(inputs)).toBe(sha(expected));
  });

  it('does not depend on the order the caller lists revisions, hosts or capabilities in', () => {
    const shuffled: PlanDigestInputs = {
      ...inputs,
      bindingRevisions: [...inputs.bindingRevisions].reverse(),
      grants: {
        ...inputs.grants,
        egressHosts: ['a.example', 'b.example'],
        capabilities: ['declarative-api', 'stream-routes'],
      },
    };
    expect(planDigest(shuffled)).toBe(planDigest(inputs));
  });

  it.each<[string, Partial<PlanDigestInputs>]>([
    ['the bundle', { bundleSha256: B }],
    ['the release', { releaseManifestSha256: C }],
    ['the live head', { schemaHeadFrom: null }],
    ['the target head', { schemaHeadTo: { platform: '0012_runtime_control', product: A } }],
    ['the product delta', { productDeltaSha256: A }],
    ['a binding revision', { bindingRevisions: [{ name: 'OPENAI_API_KEY', revisionId: 'r3' }] }],
    ['the grants', { grants: { ...inputs.grants, execution: 'none' } }],
    ['the environment revision', { environmentRevision: 4 }],
    ['preparedAt', { preparedAt: '2026-09-29T12:00:01Z' }],
  ])('changes when %s changes', (_label, change) => {
    expect(planDigest({ ...inputs, ...change })).not.toBe(planDigest(inputs));
  });

  it('carries the release digest when the runtime has one', () => {
    expect(planDigestInput({ ...inputs, releaseManifestSha256: C }).runtimeReleaseDigest).toBe(C);
  });
});

describe('product schema digest', () => {
  const table = (name: string, extra: Partial<ProductTable> = {}): ProductTable => ({
    name,
    columns: [
      { name: 'title', type: 'text', nullable: false, default: null },
      { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    ],
    primaryKey: ['id'],
    uniques: [['title', 'tenant_id'], ['id']],
    indexes: [
      { name: 'z_idx', columns: ['title'], unique: false },
      { name: 'a_idx', columns: ['tenant_id', 'title'], unique: true },
    ],
    foreignKeys: [
      {
        columns: ['tenant_id'],
        references: { table: 'orgs', columns: ['id'] },
        onDelete: 'cascade',
      },
    ],
    ...extra,
  });

  it('is the digest of the empty description for a database without product tables', () => {
    expect(EMPTY_PRODUCT_SCHEMA_DIGEST).toBe(sha('{"productSchemaFormatVersion":1,"tables":[]}'));
  });

  it('sorts tables, columns, uniques, indexes and keys, and keeps the order inside a key', () => {
    const normalized = normalizeProductSchema([table('notes'), table('boards')]);
    expect(normalized.tables.map((t) => t.name)).toEqual(['boards', 'notes']);
    const notes = normalized.tables[1]!;
    expect(notes.columns.map((c) => c.name)).toEqual(['id', 'title']);
    expect(notes.uniques).toEqual([['id'], ['title', 'tenant_id']]);
    expect(notes.indexes.map((i) => i.name)).toEqual(['a_idx', 'z_idx']);
    expect(notes.indexes[0]!.columns).toEqual(['tenant_id', 'title']);
    expect(productSchemaDigest([table('notes'), table('boards')])).toBe(
      productSchemaDigest([table('boards'), table('notes')]),
    );
  });

  it('changes with a column type, a nullability, a default or an index', () => {
    const d = productSchemaDigest([table('notes')]);
    const col = (patch: object) => [
      { name: 'title', type: 'text', nullable: false, default: null, ...patch },
    ];
    expect(productSchemaDigest([table('notes', { columns: col({ type: 'varchar' }) })])).not.toBe(
      d,
    );
    expect(productSchemaDigest([table('notes', { columns: col({ nullable: true }) })])).not.toBe(d);
    expect(
      productSchemaDigest([table('notes', { columns: col({ default: "''::text" }) })]),
    ).not.toBe(d);
    expect(productSchemaDigest([table('notes', { indexes: [] })])).not.toBe(d);
  });

  it('compares heads, null included', () => {
    const head = { platform: '0011_tenant_event_bus', product: A };
    expect(sameSchemaHead(head, { ...head })).toBe(true);
    expect(sameSchemaHead(head, { ...head, product: B })).toBe(false);
    expect(sameSchemaHead(null, null)).toBe(true);
    expect(sameSchemaHead(head, null)).toBe(false);
  });
});

describe('binding revision id', () => {
  const key = new Uint8Array(32).fill(7);

  it('is the HMAC-SHA256 over the name, a NUL byte and the value', () => {
    const expected = createHmac('sha256', key).update('OPENAI_API_KEY\0sk-test').digest('hex');
    expect(bindingRevisionId(key, 'OPENAI_API_KEY', 'sk-test')).toBe(expected);
  });

  it('changes with the value and never contains it', () => {
    const one = bindingRevisionId(key, 'OPENAI_API_KEY', 'value-one');
    expect(bindingRevisionId(key, 'OPENAI_API_KEY', 'value-two')).not.toBe(one);
    expect(one).not.toContain('value-one');
  });

  it('refuses a key of the wrong length and a malformed name', () => {
    expect(() => bindingRevisionId(new Uint8Array(16), 'A', 'v')).toThrow(RangeError);
    expect(() => bindingRevisionId(key, 'lower', 'v')).toThrow(RangeError);
  });
});
