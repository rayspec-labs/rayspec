/**
 * Deterministic RENDER tests (the byte-gated handler-codegen floor).
 *
 * Three things proven here:
 *   1. GOLDEN byte-stability — the committed reference handlers (Expense-Claim Auto-Coder) re-render
 *      IDENTICALLY from their committed holes (a render regression flips this RED). This is the
 *      analogue of "the CLIs are byte-deterministically gated" — but STRONGER: the handler CODE is
 *      deterministic too, never LLM output.
 *   2. SAFETY PROPERTIES of every rendered handler — type-only SDK import, ZERO npm deps, the
 *      untrusted-arg coercion present, NO injected-column write, the tenant-namespaced ref
 *      server-derived (upsert), the FK re-validation present (when declared).
 *   3. The rendered code COMPILES against the real `@rayspec/handler-sdk` types (tsc --noEmit), so a
 *      type-broken emission is caught deterministically (not only at the live smoke).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LookupHandlerHoles, PersistHandlerHoles } from './holes.js';
import { genHandler, renderLookupHandler, renderPersistHandler } from './templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../..');
const REF_DIR = join(REPO_ROOT, 'examples/expense-claim-coder');

function readHoles<T>(name: string): T {
  return JSON.parse(readFileSync(join(REF_DIR, 'holes', name), 'utf8')) as T;
}
function readGolden(name: string): string {
  return readFileSync(join(REF_DIR, 'handlers', name), 'utf8');
}

const lookupHoles = readHoles<LookupHandlerHoles>('lookup-categories.holes.json');
const persistHoles = readHoles<PersistHandlerHoles>('code-claim.holes.json');

describe('golden render — the committed Expense-Claim handlers re-render byte-identical', () => {
  it('lookup-categories.gen.ts matches its committed golden', () => {
    expect(genHandler(lookupHoles)).toBe(readGolden('lookup-categories.gen.ts'));
  });
  it('code-claim.gen.ts matches its committed golden', () => {
    expect(genHandler(persistHoles)).toBe(readGolden('code-claim.gen.ts'));
  });
  it('render is a pure function (same holes -> identical output across calls)', () => {
    expect(genHandler(persistHoles)).toBe(genHandler(persistHoles));
    expect(genHandler(lookupHoles)).toBe(genHandler(lookupHoles));
  });
});

describe('JavaScript emit — the same holes render as plain ESM', () => {
  it("an explicit 'ts' target is byte-identical to the default render (the goldens)", () => {
    expect(genHandler(persistHoles, 'ts')).toBe(readGolden('code-claim.gen.ts'));
    expect(genHandler(lookupHoles, 'ts')).toBe(readGolden('lookup-categories.gen.ts'));
  });

  it('carries no import at all and no TypeScript-only syntax (both templates)', () => {
    for (const code of [genHandler(persistHoles, 'js'), genHandler(lookupHoles, 'js')]) {
      // The SDK import was TYPE-ONLY, so nothing survives it — the JS emission has zero imports.
      expect(code).not.toMatch(/^\s*import\b/m);
      expect(code).not.toMatch(/\binterface\s+\w+\s*\{/);
      expect(code).not.toMatch(/\bas\s+(const|readonly|Record<)/);
      expect(code).not.toMatch(/:\s*(StoreRow|StoreFilter|ToolHandler|Promise<|Record<)/);
      expect(code).toMatch(/^export const \w+ = async \(args, init\) => \{$/m);
    }
  });

  it('keeps the safety properties of the TypeScript render', () => {
    const persistJs = genHandler(persistHoles, 'js');
    const lookupJs = genHandler(lookupHoles, 'js');
    for (const code of [persistJs, lookupJs]) {
      expect(code).toContain('TRUSTED-AUTHOR, NOT SANDBOXED');
      expect(code).not.toMatch(/\brequire\s*\(/);
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(code).toMatch(/init\.db\.(update|insert|select)/);
    }
    expect(persistJs).toContain('UNTRUSTED');
    expect(persistJs).toContain('coerceRow');
    expect(lookupJs).toContain('.slice(0, MAX_ROWS)');
  });
});

// The JavaScript render of the CLAMP-BEARING reference hole-set. The example ships a TypeScript handler
// module (its spec pins `handlers/code-claim.gen.ts`), so the `js` target has no home under examples/ —
// it is pinned here instead, byte-for-byte, next to the renderer it comes from.
function readJsGolden(): string {
  return readFileSync(join(here, '__fixtures__/code-claim.gen.js'), 'utf8');
}

/**
 * The committed byte-golden for the persist template with NO clamp declared.
 *
 * It exists because the shipped `code-claim.gen.ts` now declares one, so the repository lost its only
 * byte-gated reference for the unclamped T1 render — the shape every hole-set that does not opt in
 * still gets. `code-claim.holes.json` minus `clampValues` is deliberately the source, so the fixture
 * differs from the shipped golden in exactly the clamp and nothing else.
 */
const unclampedPersistHoles: PersistHandlerHoles = (() => {
  const { clampValues: _none, ...rest } = persistHoles as PersistHandlerHoles & {
    clampValues?: unknown;
  };
  return rest as PersistHandlerHoles;
})();
function readUnclampedGolden(): string {
  return readFileSync(join(here, '__fixtures__/code-claim-unclamped.gen.ts'), 'utf8');
}

describe('server-side clamp — a clamp-bearing hole-set renders its bound deterministically', () => {
  it('caps the declared enum column, ranked by that column’s declared enumValues order', () => {
    const code = genHandler(persistHoles);
    // RANK is the DECLARED enumValues order and nothing else; the bound is a literal in the emission.
    expect(code).toContain('const ORDER = ["ok", "review", "violation"];');
    expect(code).toContain('const proposed = coerced.row.policy_flag;');
    expect(code).toContain('coerced.row.policy_flag = "review";');
    // A clamp that FIRES carries BOTH the model's original choice and the applied bound onto the
    // result — which is the object dispatchTool journals, so the record survives the run.
    expect(code).toContain('clamped.push({ column: "policy_flag", proposed, applied: "review" });');
    expect(code).toContain('...(clamped.length > 0 ? { clamped } : {})');
  });

  it('applies the bound AFTER the coercion and BEFORE the write (and before the fixed-value stamp)', () => {
    const code = genHandler(persistHoles);
    const clamp = code.indexOf('clamped.push(');
    expect(clamp).toBeGreaterThan(code.indexOf('const coerced = coerceRow(args);'));
    expect(clamp).toBeLessThan(code.indexOf('Object.assign(coerced.row'));
    expect(clamp).toBeLessThan(code.indexOf('init.db.update(STORE'));
  });

  it('the JavaScript render of the same clamp-bearing holes matches its committed golden', () => {
    expect(genHandler(persistHoles, 'js')).toBe(readJsGolden());
  });

  it('BACK-COMPAT: the same holes WITHOUT clampValues carry no clamp machinery at all', () => {
    // The clamp is strictly opt-in: a hole-set that declares none renders exactly what it always did,
    // which is what keeps every committed golden of an unclamped hole-set byte-stable.
    for (const target of ['ts', 'js'] as const) {
      const code = genHandler(unclampedPersistHoles, target);
      expect(code).not.toContain('clamp');
      expect(code).not.toContain('ORDER');
    }
  });

  it('BACK-COMPAT, byte-gated: the unclamped persist render matches its own committed golden', () => {
    // The two `not.toContain` assertions above say only that the clamp machinery is absent. They would
    // stay green through any other change to the unclamped T1 render — and since the shipped
    // `code-claim.gen.ts` now DECLARES a clamp, it is no longer a golden for the unclamped shape.
    // Without this fixture the persist template's opt-out path has no byte gate at all.
    expect(genHandler(unclampedPersistHoles, 'ts')).toBe(readUnclampedGolden());
  });
});

describe('safety properties — every rendered handler', () => {
  const persistCode = renderPersistHandler(persistHoles);
  const lookupCode = renderLookupHandler(lookupHoles);

  it('imports @rayspec/handler-sdk TYPE-ONLY (import type) — both templates', () => {
    for (const code of [persistCode, lookupCode]) {
      expect(code).toMatch(/^import type \{[^}]*\} from '@rayspec\/handler-sdk';$/m);
      // the ONLY import line is the type-only SDK import (no value import, no other module).
      const importLines = code
        .split('\n')
        .filter((l) => /^\s*(import|export .* from|require\()/.test(l));
      expect(importLines).toHaveLength(1);
      expect(importLines[0]).toContain('import type');
      expect(importLines[0]).toContain('@rayspec/handler-sdk');
    }
  });

  it('takes ZERO npm/platform deps (no other import / require / dynamic import)', () => {
    for (const code of [persistCode, lookupCode]) {
      expect(code).not.toMatch(/from '(?!@rayspec\/handler-sdk')/);
      expect(code).not.toMatch(/\brequire\s*\(/);
      expect(code).not.toMatch(/\bimport\s*\(/); // no dynamic import()
      expect(code).not.toContain('@rayspec/platform');
      expect(code).not.toContain('@rayspec/db');
    }
  });

  it('persist coerces every UNTRUSTED arg + never writes an injected column', () => {
    expect(persistCode).toContain('UNTRUSTED');
    expect(persistCode).toContain('coerceRow');
    // the coercion never throws — it returns a failed result.
    expect(persistCode).toMatch(/status: 'failed'/);
    // it does not assign to an injected/server column.
    for (const col of ['tenant_id', 'created_at', 'deleted_at', 'retention_days', 'region']) {
      expect(persistCode).not.toMatch(new RegExp(`row\\["${col}"\\]\\s*=`));
    }
    // it reaches the DB only through init.db (never a self-built handle).
    expect(persistCode).toMatch(/init\.db\.(update|insert|select)/);
    expect(persistCode).not.toMatch(/\bnew Pool\b|\bforTenant\b|\bdrizzle\b|\bmakeDb\b/);
  });

  it('persist FK re-validation is present when declared (server-side, never trusts the model)', () => {
    expect(persistCode).toContain('FK re-validation');
    expect(persistCode).toContain('init.db.select("expense_categories"');
  });

  it('upsert arm tenant-NAMESPACES the natural key SERVER-SIDE (never an arg)', () => {
    const upsert = renderPersistHandler({
      ...persistHoles,
      mode: 'upsert-by-natural-key',
      idArg: undefined,
      naturalKeyCol: 'category_code',
    } as PersistHandlerHoles);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the EMITTED template-literal text.
    expect(upsert).toContain('`${init.tenantId}:${keyVal}`');
    expect(upsert).toContain('tenant-NAMESPACED');
  });

  it('lookup keys on a CLOSED filter allowlist + caps the result rows', () => {
    expect(lookupCode).toContain('FILTER_COLS');
    expect(lookupCode).toContain('MAX_ROWS');
    expect(lookupCode).toContain('.slice(0, MAX_ROWS)');
    // tenant predicate is the facade's job (the comment documents it; the call is plain init.db.select).
    expect(lookupCode).toMatch(/init\.db\.select\(STORE, filter\)/);
  });

  it('rendered code carries the honest trusted-author-NOT-sandboxed note (no sandbox claim)', () => {
    for (const code of [persistCode, lookupCode]) {
      expect(code).toContain('TRUSTED-AUTHOR, NOT SANDBOXED');
      expect(code).toContain('TRIPWIRES, not a sandbox');
      // Every occurrence of "sandbox(ed)" must be a NEGATIVE framing ("NOT SANDBOXED" / "not a
      // sandbox") — the code never claims it IS sandboxed. Check each match's context.
      const matches = code.match(/.{0,8}sandbox(ed)?/gi) ?? [];
      for (const m of matches) {
        expect(m.toLowerCase()).toMatch(/not\s+(a\s+)?sandbox/);
      }
    }
  });
});

// The rendered code must COMPILE against the real SDK types. We copy the committed reference handlers
// into the platform package's src (which references @rayspec/handler-sdk) and run `tsc --noEmit` over
// JUST those files via a throwaway tsconfig, then clean up. A type-broken emission flips this RED.
describe('rendered handlers type-check against @rayspec/handler-sdk (tsc --noEmit)', () => {
  it('both committed reference handlers compile cleanly', () => {
    const scratch = mkdtempSync(join(REPO_ROOT, 'packages/kernel/platform/src/__gen_tc_'));
    try {
      writeFileSync(join(scratch, 'lookup.ts'), readGolden('lookup-categories.gen.ts'));
      writeFileSync(join(scratch, 'code.ts'), readGolden('code-claim.gen.ts'));
      // The clamp reaches BOTH persist arms, but the committed golden is update-by-id only. Compile the
      // upsert arm of the same clamp-bearing holes too, so its `clamped` return (spread onto a result
      // whose id is a conditional expression) cannot type-break unnoticed.
      writeFileSync(
        join(scratch, 'upsert.ts'),
        renderPersistHandler({
          ...persistHoles,
          mode: 'upsert-by-natural-key',
          idArg: undefined,
          naturalKeyCol: 'category_code',
        } as PersistHandlerHoles),
      );
      const tsconfig = join(scratch, 'tsconfig.json');
      // Extend the platform tsconfig so the workspace @rayspec/handler-sdk resolves exactly as it does
      // for platform source (NodeNext + verbatimModuleSyntax — the real compile conditions).
      writeFileSync(
        tsconfig,
        JSON.stringify({
          extends: '../../../../../tsconfig.base.json',
          compilerOptions: { noEmit: true, composite: false, rootDir: '.', types: ['node'] },
          include: ['*.ts'],
        }),
      );
      // tsc is resolved from the repo's node_modules.
      execFileSync('node', [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', tsconfig], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
