/**
 * The `workforce:` section must SAY it is experimental everywhere a third party reads it.
 *
 * The `RAYSPEC_EXPERIMENTAL_WORKFORCE` flag REFUSES the section at parse
 * (`experimental_section_disabled`), but a refusal is not a marking: a consumer holding the
 * exported JSON-Schema, or hovering an imported symbol in an IDE, saw `workforce:` presented as an
 * ordinary part of the frozen v1.0 grammar. This file pins the two markings this package owns:
 *
 *  1. THE EMITTED JSON-SCHEMA ARTIFACT. Asserted on the COMMITTED files, not only on the exporter
 *     that derives them — the committed artifact is what a schema-aware editor or a code generator
 *     actually consumes, and it is a separate thing from the function that produces it.
 *     `gate:spec-schema` byte-compares the two, so the pair cannot drift apart.
 *  2. THE SHIPPED TYPE DECLARATIONS. Every exported symbol of the three workforce modules carries
 *     an `@experimental` TSDoc tag, in the SOURCE and in the emitted `dist/*.d.ts` — the latter is
 *     what an IDE reads out of an installed package, and `@rayspec/spec` is in the published
 *     runtime closure (`scripts/publish.mjs` — the closure of `rayspec`/`@rayspec/cli`/
 *     `@rayspec/server` over production dependencies).
 *
 * The `.d.ts` assertions read `packages/kernel/spec/dist`, so they need a build behind them
 * (`pnpm build` precedes every test step in all three CI lanes). They fail CLOSED with that
 * instruction rather than skipping — the same posture `scripts/check-spec-schema.mjs` takes toward
 * the built exporter it imports.
 *
 * SCOPE, stated so nothing wider is implied: this covers the DECLARED-CONTRACT surface — the
 * grammar, its derivations and its lint. The `@rayspec/tasks` engine API (`pauseWorkforce`,
 * `decideApproval`, …) is a different surface and is not asserted here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SpecErrorCode } from './errors.js';
import { WORKFORCE_EXPERIMENT_ENV } from './experimental.js';
import { exportJsonSchema, exportUnifiedJsonSchema } from './export.js';
import { WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION, WorkforceSpec } from './workforce-grammar.js';

const here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');
const readPkg = (rel: string): string => readFileSync(resolve(here, `../${rel}`), 'utf8');

/** The three modules whose every export must carry the tag. */
const WORKFORCE_MODULES = ['workforce-grammar', 'workforce-config', 'workforce-lint'] as const;

/** The TSDoc tag an IDE surfaces on hover. */
const TAG = '@experimental';

/**
 * Every exported symbol name in a TS source, paired with the doc comment that immediately precedes
 * its `export` line. Deliberately line-based rather than AST-based: the property under test is a
 * property of the SOURCE TEXT (a tag inside a leading block comment), and a line scan cannot
 * silently agree with a formatter that moved the comment somewhere the compiler still accepts but
 * a reader would not see.
 */
function exportsWithLeadingDoc(source: string): Array<{ name: string; doc: string }> {
  const lines = source.split('\n');
  const out: Array<{ name: string; doc: string }> = [];
  for (const [index, line] of lines.entries()) {
    const decl =
      /^export\s+(?:declare\s+)?(?:const|let|var|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (!decl) continue;
    // Walk back over the block comment that ends on the line above, if there is one.
    let cursor = index - 1;
    const doc: string[] = [];
    if (cursor >= 0 && (lines[cursor] as string).trim().endsWith('*/')) {
      while (cursor >= 0) {
        doc.unshift(lines[cursor] as string);
        if ((lines[cursor] as string).trim().startsWith('/*')) break;
        cursor -= 1;
      }
    }
    out.push({ name: decl[1] as string, doc: doc.join('\n') });
  }
  return out;
}

/**
 * The `workforce` property node of the unified schema's BACKEND arm. Located by which arm declares
 * the property rather than by index, so an arm reorder cannot make this assert against the wrong
 * profile — and a missing property throws here rather than silently yielding `undefined`.
 */
function backendArmWorkforceNode(unified: unknown): Record<string, unknown> {
  const arms = (unified as { oneOf?: Array<{ properties?: Record<string, unknown> }> }).oneOf ?? [];
  const backend = arms.find((arm) => arm.properties !== undefined && 'workforce' in arm.properties);
  if (backend === undefined) {
    throw new Error('no oneOf arm of the unified schema declares a `workforce` property');
  }
  return (backend.properties as Record<string, Record<string, unknown>>).workforce;
}

/** `dist/<module>.d.ts`, or a hard failure naming the build step that produces it. */
function readDeclarations(moduleName: string): string {
  const path = resolve(here, `../dist/${moduleName}.d.ts`);
  if (!existsSync(path)) {
    throw new Error(
      `workforce-experimental-marking: ${path} is absent — run \`pnpm build\` first. This ` +
        'assertion reads the SHIPPED type declarations on purpose: the tag existing in src/ ' +
        'proves nothing about what an installed package hands an IDE.',
    );
  }
  return readFileSync(path, 'utf8');
}

describe('the workforce section is marked EXPERIMENTAL in the emitted JSON-Schema artifacts', () => {
  it('the annotation names the flag, the refusal code, and the compatibility page', () => {
    const { description } = WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION;
    // Every claim in the annotation is one a mechanism in THIS repo enforces; assert each
    // mechanism exists rather than trusting the prose.
    expect(description).toContain(WORKFORCE_EXPERIMENT_ENV);
    expect(description).toContain('experimental_section_disabled');
    expect(SpecErrorCode.options).toContain('experimental_section_disabled');
    expect(description).toContain('docs/workforce-compatibility.md');
    expect(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION['x-rayspec-experimental']).toBe(true);
  });

  it('exportJsonSchema() emits the annotation on the workforce property', () => {
    const schema = exportJsonSchema() as {
      properties: { workforce: Record<string, unknown> };
    };
    const node = schema.properties.workforce;
    expect(node['x-rayspec-experimental']).toBe(true);
    expect(node.title).toBe(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION.title);
    expect(node.description).toBe(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION.description);
  });

  it('exportUnifiedJsonSchema() carries it on the BACKEND arm (the profile that has the section)', () => {
    const node = backendArmWorkforceNode(exportUnifiedJsonSchema());
    expect(node['x-rayspec-experimental']).toBe(true);
    expect(node.description).toBe(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION.description);
  });

  it('the COMMITTED spec.schema.json carries it — the artifact a consumer actually reads', () => {
    const artifact = JSON.parse(readPkg('spec.schema.json')) as {
      properties: { workforce: Record<string, unknown> };
    };
    expect(artifact.properties.workforce['x-rayspec-experimental']).toBe(true);
    expect(artifact.properties.workforce.description).toBe(
      WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION.description,
    );
  });

  it('the COMMITTED version-1.0.schema.json carries it on its backend arm', () => {
    const node = backendArmWorkforceNode(JSON.parse(readPkg('version-1.0.schema.json')));
    expect(node['x-rayspec-experimental']).toBe(true);
    expect(node.description).toBe(WORKFORCE_EXPERIMENTAL_SCHEMA_ANNOTATION.description);
  });

  it('is an ANNOTATION, not a shape change: the accept set is byte-identical', () => {
    const valid = {
      id: 'helpdesk',
      name: 'Helpdesk',
      orchestrator: 'lead',
      employees: [{ id: 'lead', agent: 'lead_agent', title: 'Lead', role: 'orchestrator' }],
    };
    expect(WorkforceSpec.safeParse(valid).success).toBe(true);
    // The annotated schema is STILL closed — `.meta()` must not have replaced the strict object.
    expect(WorkforceSpec.safeParse({ ...valid, bogus: 1 }).success).toBe(false);
    // …and the emitted node keeps the fail-closed keyword the spec-schema gate walks for.
    const node = (exportJsonSchema() as { properties: { workforce: Record<string, unknown> } })
      .properties.workforce;
    expect(node.additionalProperties).toBe(false);
  });
});

describe('every exported symbol of the workforce contract surface is marked @experimental', () => {
  for (const moduleName of WORKFORCE_MODULES) {
    it(`${moduleName}.ts — every export carries the tag in SOURCE`, () => {
      const found = exportsWithLeadingDoc(readPkg(`src/${moduleName}.ts`));
      expect(found.length, `no exports parsed out of ${moduleName}.ts`).toBeGreaterThan(0);
      const unmarked = found.filter((e) => !e.doc.includes(TAG)).map((e) => e.name);
      expect(unmarked, `${moduleName}.ts exports without ${TAG}`).toEqual([]);
    });

    it(`${moduleName}.d.ts — the tag SHIPS in the emitted declarations`, () => {
      const sourceCount = (readPkg(`src/${moduleName}.ts`).match(/@experimental/g) ?? []).length;
      const declCount = (readDeclarations(moduleName).match(/@experimental/g) ?? []).length;
      expect(sourceCount).toBeGreaterThan(0);
      // `tsc` carries leading doc comments into the declaration file. A drop here means the tag
      // exists in the repo and NOT in what npm ships — the failure this assertion exists for.
      expect(declCount).toBeGreaterThanOrEqual(sourceCount);
    });
  }
});

describe('the forward-compatibility page pins what this package marks', () => {
  it('exists and names both of this package’s markers', () => {
    const page = readRepo('docs/workforce-compatibility.md');
    expect(page).toContain('x-rayspec-experimental');
    expect(page).toContain(TAG);
    expect(page).toContain(WORKFORCE_EXPERIMENT_ENV);
    expect(page).toContain('experimental_section_disabled');
  });
});
