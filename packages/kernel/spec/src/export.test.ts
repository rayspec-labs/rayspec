/**
 * JSON-Schema exporter CONTRACT test.
 *
 * NOT a blind test: it compiles the REAL exported artifact through a REAL Ajv2020 instance and then
 *  (a) validates a known-GOOD spec object — must PASS, and
 *  (b) validates known-BAD objects (unknown key, wrong version, wrong type) — each must FAIL.
 * If the grammar dropped `.strict()`, the unknown-key case would stop failing and this test would
 * break — so a field-flip BREAKS the contract, as required.
 *
 * We use the SAME Ajv2020 (`ajv/dist/2020`) the platform runtime uses (dispatch.ts), so the
 * exported artifact is proven to be enforceable by the runtime validator, not just by Zod.
 */
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { exportJsonSchema, exportUnifiedJsonSchema } from './export.js';

type AjvInstance = Ajv2020Class;
const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

/** A known-good spec OBJECT (already parsed shape — defaults present where the grammar requires). */
const GOOD = {
  version: '1.0',
  metadata: { name: 'contract-test' },
  stores: [
    {
      name: 'items',
      columns: [{ name: 'label', type: 'text', nullable: false, unique: false }],
      foreignKeys: [],
    },
  ],
  api: [{ method: 'GET', path: '/items', action: { kind: 'store', store: 'items', op: 'list' } }],
  agents: [
    {
      id: 'a',
      name: 'a',
      backend: 'openai',
      model: 'gpt-4o-mini',
      instructions: 'do',
      tools: [],
      maxTurns: 8,
      requireNativeStructuredOutput: false,
    },
  ],
  tooling: [
    {
      id: 't',
      name: 't',
      description: 'd',
      parameters: { type: 'object' },
      handler: 'h',
      idempotent: true,
      timeoutMs: 1000,
    },
  ],
  triggers: [],
  handlers: [{ id: 'h', module: 'm.ts', export: 'h', kind: 'tool' }],
};

describe('exportJsonSchema — Ajv2020 round-trip contract', () => {
  const artifact = exportJsonSchema();
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
  const validate = ajv.compile(artifact);

  it('the exported artifact compiles through a real Ajv2020 instance', () => {
    expect(typeof validate).toBe('function');
    expect(artifact.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('declares additionalProperties:false at the top level (fail-closed)', () => {
    expect(artifact.additionalProperties).toBe(false);
  });

  it('validates a known-GOOD spec object', () => {
    const ok = validate(GOOD);
    if (!ok) throw new Error(`GOOD should validate; errors: ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('REJECTS an unknown top-level key (proves additionalProperties:false is enforced)', () => {
    expect(validate({ ...GOOD, bogus: 1 })).toBe(false);
  });

  it('REJECTS a wrong version literal', () => {
    expect(validate({ ...GOOD, version: '9.9' })).toBe(false);
  });

  it('REJECTS an unknown key nested inside an agent (strict composes through the wrap)', () => {
    const bad = { ...GOOD, agents: [{ ...GOOD.agents[0], temperature: 0.7 }] };
    expect(validate(bad)).toBe(false);
  });

  it('REJECTS a column type outside the closed enum', () => {
    const bad = {
      ...GOOD,
      stores: [
        {
          name: 'items',
          columns: [{ name: 'x', type: 'blob', nullable: false, unique: false }],
          foreignKeys: [],
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  // Fix #2: io:'input' — the exported artifact must accept what the PARSER accepts. With the
  // default io:'output', z.toJSONSchema marks every .default()ed field required, so a
  // default-omitting minimal spec the parser ACCEPTS would be REJECTED by the artifact. These
  // cases lock io:'input' (a regression to io:'output' turns them red).
  it('top-level `required` lists ONLY version + metadata (not the .default()ed sections)', () => {
    expect(artifact.required).toEqual(['version', 'metadata']);
  });

  it('validates a default-OMITTING minimal spec the parser accepts (version + metadata only)', () => {
    const minimal = { version: '1.0', metadata: { name: 'm' } };
    const ok = validate(minimal);
    if (!ok) throw new Error(`minimal should validate; errors: ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('validates an agent declared WITHOUT its defaulted fields (no maxTurns/tools)', () => {
    const spec = {
      version: '1.0',
      metadata: { name: 'm' },
      agents: [{ id: 'a', name: 'a', backend: 'openai', model: 'm', instructions: 'i' }],
    };
    const ok = validate(spec);
    if (!ok)
      throw new Error(`agent-no-defaults should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  // The exported artifact must round-trip the new `stream` RouteAction member + the
  // `extensions[]` section through a REAL Ajv2020 instance (proves z.toJSONSchema represents them).
  it('validates a stream route (ingest + playback) through the exported artifact', () => {
    const spec = {
      version: '1.0',
      metadata: { name: 'm' },
      api: [
        { method: 'POST', path: '/u', action: { kind: 'stream', handler: 'h', mode: 'ingest' } },
        { method: 'GET', path: '/p', action: { kind: 'stream', handler: 'h', mode: 'playback' } },
      ],
      handlers: [{ id: 'h', module: 'm.ts', export: 'h', kind: 'route' }],
    };
    const ok = validate(spec);
    if (!ok) throw new Error(`stream-route should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('REJECTS a stream route with an unknown mode (closed enum exported)', () => {
    const bad = {
      version: '1.0',
      metadata: { name: 'm' },
      api: [{ method: 'POST', path: '/u', action: { kind: 'stream', handler: 'h', mode: 'nope' } }],
      handlers: [{ id: 'h', module: 'm.ts', export: 'h', kind: 'route' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('validates an extensions[] section (exact pin + opaque config)', () => {
    const spec = {
      version: '1.0',
      metadata: { name: 'm' },
      extensions: [{ id: 'p', module: './p', version: '1.2.3', config: { whatever: true } }],
    };
    const ok = validate(spec);
    if (!ok) throw new Error(`extensions should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('REJECTS an unknown key on an ExtensionRef (strict exported)', () => {
    const bad = {
      version: '1.0',
      metadata: { name: 'm' },
      extensions: [{ id: 'p', module: './p', version: '1.2.3', bogus: 1 }],
    };
    expect(validate(bad)).toBe(false);
  });

  // The exact-version constraint must now live in the EXPORTED artifact, not just
  // in Zod. `ExactVersionPin` is a `.regex()` (a `.refine()` is dropped by z.toJSONSchema), so the
  // exported schema carries a `pattern` and Ajv ENFORCES it. A range pin must be REJECTED by the
  // artifact; an exact pin ACCEPTED — fail-the-fix for the export gap (a regression to a `.refine()`
  // drops the pattern → the range case below stops failing).
  it('REJECTS a range version pin via the EXPORTED artifact (pattern enforced by Ajv)', () => {
    const bad = {
      version: '1.0',
      metadata: { name: 'm' },
      extensions: [{ id: 'p', module: './p', version: '^1.2.3' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('ACCEPTS an exact version pin via the EXPORTED artifact', () => {
    const good = {
      version: '1.0',
      metadata: { name: 'm' },
      extensions: [{ id: 'p', module: './p', version: '1.2.3' }],
    };
    const ok = validate(good);
    if (!ok) throw new Error(`exact pin should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });
});

// ── The UNIFIED `version:'1.0'` schema — a `oneOf` over the two profiles.
// The BLOCKER this suite is the forcing-function for: `z.toJSONSchema` factors a reused sub-schema into
// a ROOT-scoped `$defs.__schemaN` with `#/$defs/__schemaN` refs that resolve from the DOCUMENT ROOT.
// Embedding a profile UNDER `oneOf[n]` without hoisting its `$defs` leaves those refs dangling, so the
// unified artifact FAILS to compile under Ajv2020 (`can't resolve reference #/$defs/__schema0 from id
// #`). `exportUnifiedJsonSchema` hoists every arm's `$defs` to the unified root; the compile test below
// is what would have caught the un-hoisted regression (a MissingRefError at `ajv.compile`).
describe('exportUnifiedJsonSchema — Ajv2020 compile + oneOf round-trip contract', () => {
  const unified = exportUnifiedJsonSchema();

  // The COMPILE forcing-function: a dangling `#/$defs/...` ref throws a MissingRefError right here.
  const ajvU = new Ajv2020Ctor({ allErrors: true, strict: false });
  const validateUnified = ajvU.compile(unified);

  it('COMPILES under a real Ajv2020 instance (no MissingRefError — the blocker forcing-function)', () => {
    expect(typeof validateUnified).toBe('function');
    expect(unified.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('hoists the product profile `$defs` to the unified ROOT (not nested under an arm)', () => {
    // The blocker cause was a nested `$defs` under oneOf[1]; the fix is a single root-scoped `$defs`.
    const oneOf = unified.oneOf as Array<Record<string, unknown>>;
    expect('$defs' in unified).toBe(true);
    expect('$defs' in oneOf[0]).toBe(false);
    expect('$defs' in oneOf[1]).toBe(false);
    // Every `#/$defs/...` ref in the whole document must target a key that EXISTS at the root `$defs`.
    const rootDefKeys = new Set(Object.keys(unified.$defs as Record<string, unknown>));
    const refs = [...JSON.stringify(unified).matchAll(/"\$ref":"(#\/\$defs\/[^"]+)"/g)].map((m) =>
      m[1].replace('#/$defs/', ''),
    );
    expect(refs.length).toBeGreaterThan(0); // the product profile DOES factor a def today
    for (const r of refs) expect(rootDefKeys.has(r)).toBe(true);
  });

  // ── ROUND-TRIP through the compiled unified validator: exactly ONE profile arm must match. ──
  const MINIMAL_BACKEND = { version: '1.0', metadata: { name: 'x' } };
  const MINIMAL_PRODUCT = { version: '1.0', product: { id: 'x', name: 'x' } };

  it('ACCEPTS a minimal BACKEND doc (version + metadata, no product:)', () => {
    const ok = validateUnified(MINIMAL_BACKEND);
    if (!ok)
      throw new Error(
        `minimal backend should validate; ${ajvU.errorsText(validateUnified.errors)}`,
      );
    expect(ok).toBe(true);
  });

  it('ACCEPTS a minimal PRODUCT doc (version + product:{id,name})', () => {
    const ok = validateUnified(MINIMAL_PRODUCT);
    if (!ok)
      throw new Error(
        `minimal product should validate; ${ajvU.errorsText(validateUnified.errors)}`,
      );
    expect(ok).toBe(true);
  });

  it('REJECTS a doc matching NEITHER arm (bare version — no metadata, no product)', () => {
    // Fails the backend arm (metadata required) AND the product arm (product required) → 0 matches.
    expect(validateUnified({ version: '1.0' })).toBe(false);
  });

  it('REJECTS a wrong version literal on either shape (both arms pin version:1.0)', () => {
    expect(validateUnified({ version: '9.9', metadata: { name: 'x' } })).toBe(false);
    expect(validateUnified({ version: '9.9', product: { id: 'x', name: 'x' } })).toBe(false);
  });

  // The oneOf "exactly ONE" (never BOTH) property is UNAMBIGUOUS by construction: the backend arm keeps
  // `additionalProperties:false` and has no `product` property (so a product-carrying doc CANNOT match
  // it), and the product arm REQUIRES `product`. A doc matching BOTH is therefore not constructible; we
  // PROVE the mutual exclusion by compiling each arm standalone and asserting each minimal doc matches
  // its OWN arm and NOT the other — so `oneOf` can never see two matches for a valid doc.
  it('proves mutual exclusion: each minimal doc matches its OWN arm and NOT the other (no double-match)', () => {
    const oneOf = unified.oneOf as Array<Record<string, unknown>>;
    // Each arm must be validated as a standalone document with the root `$defs` in scope (the refs
    // live at the unified root), so wrap the arm with the hoisted `$defs` before compiling it alone.
    const rootDefs = unified.$defs as Record<string, unknown>;
    const backendArm = new Ajv2020Ctor({ strict: false }).compile({ ...oneOf[0], $defs: rootDefs });
    const productArm = new Ajv2020Ctor({ strict: false }).compile({ ...oneOf[1], $defs: rootDefs });

    expect(backendArm(MINIMAL_BACKEND)).toBe(true);
    expect(productArm(MINIMAL_BACKEND)).toBe(false);
    expect(productArm(MINIMAL_PRODUCT)).toBe(true);
    expect(backendArm(MINIMAL_PRODUCT)).toBe(false);
  });
});
