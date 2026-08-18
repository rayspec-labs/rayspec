/**
 * THE WIRING TRIPWIRE — the empirical half of a claim that is otherwise just prose.
 *
 * The extension-seam documentation states that `WorkerSelector`, `CostPolicy` and `ApprovalProvider`
 * are DECLARED SURFACES WITH NO PRODUCTION CALL SITE. That is an assertion about the whole tree, and
 * an assertion about the whole tree that nothing checks is a sentence that goes stale the first time
 * somebody wires one. This suite reads the tree and measures it.
 *
 * It is a TRIPWIRE, and its limits are the same ones every greppable guard in this repository
 * carries. It matches IDENTIFIERS in comment-stripped source; it does not chase aliasing
 * (`const S = CapabilityMatchSelector; new S()` is invisible to it), and it does not do type
 * analysis, so a structurally-compatible object literal that never names the interface is invisible
 * too. What it does buy is that the ORDINARY way to wire a seam — importing its type or its shipped
 * default — turns this suite red and points at the confinement the wiring has to route through.
 *
 * It fails CLOSED on an empty scan: a moved package or a renamed directory must redden this suite,
 * not quietly retire it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOT = join(repoRoot, 'packages');

/**
 * The seam machinery itself: the interface modules, the contract kit and the confinements. These
 * necessarily name every seam, so scanning them would only measure that they exist.
 */
const SEAM_MACHINERY = new Set([
  'packages/kernel/core/src/approval-provider.ts',
  'packages/kernel/core/src/cost-policy.ts',
  'packages/kernel/core/src/memory-provider.ts',
  'packages/kernel/core/src/orchestration-strategy.ts',
  'packages/kernel/core/src/review-policy.ts',
  'packages/kernel/core/src/seam-confinement.ts',
  'packages/kernel/core/src/seam-contracts.ts',
  'packages/kernel/core/src/worker-selector.ts',
]);

/**
 * Strip `//` line comments and block comments in one string-aware pass, so a docblock that merely
 * DISCUSSES a seam is not read as wiring it. Mirrors the stripper the platform gate scripts use.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every identifier that naming would mean touching the seam: the interface, its types, its default. */
const SEAM_IDENTIFIERS: Record<string, readonly string[]> = {
  WorkerSelector: [
    'WorkerSelector',
    'WorkerCandidate',
    'WorkerSelection',
    'WorkerSelectionError',
    'SelectionTask',
    'CapabilityMatchSelector',
  ],
  ApprovalProvider: [
    'ApprovalProvider',
    'ApprovalRequest',
    'ApprovalTicket',
    'ApprovalUnroutedError',
    'UnroutedApprovalProvider',
  ],
  CostPolicy: ['CostPolicy', 'LedgerCostPolicy'],
};

/** Pure so the teeth arm below can drive it with a synthetic source and no I/O. */
function detectSeamReferences(seam: keyof typeof SEAM_IDENTIFIERS, src: string): readonly string[] {
  const code = stripComments(src);
  return (SEAM_IDENTIFIERS[seam] as readonly string[]).filter((id) =>
    new RegExp(`\\b${id}\\b`).test(code),
  );
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    yield full;
  }
}

interface Scanned {
  readonly rel: string;
  readonly src: string;
}

const scanned: Scanned[] = [];
for (const full of walk(SCAN_ROOT)) {
  const rel = relative(repoRoot, full).split('\\').join('/');
  if (!rel.includes('/src/')) continue;
  if (rel.includes('/test-support/')) continue;
  scanned.push({ rel, src: readFileSync(full, 'utf8') });
}

/** Files that name a seam identifier, excluding the seam machinery itself. */
function referencesOutsideTheSeamModules(
  seam: keyof typeof SEAM_IDENTIFIERS,
): { rel: string; identifiers: readonly string[] }[] {
  return scanned
    .filter(({ rel }) => !SEAM_MACHINERY.has(rel))
    .map(({ rel, src }) => ({ rel, identifiers: detectSeamReferences(seam, src) }))
    .filter(({ identifiers }) => identifiers.length > 0);
}

describe('the extension-seam wiring tripwire', () => {
  it('reads a non-empty set of production sources — an empty scan fails CLOSED', () => {
    expect(scanned.length).toBeGreaterThan(200);
    // The scan must actually be reaching the packages the claim is about.
    expect(scanned.some(({ rel }) => rel === 'packages/kernel/core/src/worker-selector.ts')).toBe(
      true,
    );
    expect(
      scanned.some(({ rel }) => rel === 'packages/app/server/src/workforce-goal-intake.ts'),
    ).toBe(true);
  });

  it('WorkerSelector has NO production reference outside its own module', () => {
    expect(referencesOutsideTheSeamModules('WorkerSelector')).toEqual([]);
  });

  it('ApprovalProvider has NO production reference outside its own module', () => {
    expect(referencesOutsideTheSeamModules('ApprovalProvider')).toEqual([]);
  });

  it('CostPolicy is IMPLEMENTED in the task engine and never constructed', () => {
    // The interface has a shipped, ledger-backed implementation — which is not the same thing as a
    // call site. These two files are the whole of its production footprint, and neither of them, nor
    // anything else, ever constructs it: the engine's budget path calls the underlying
    // authorize/settle functions directly.
    expect(referencesOutsideTheSeamModules('CostPolicy')).toEqual([
      {
        rel: 'packages/kernel/tasks/src/budget.ts',
        identifiers: ['CostPolicy', 'LedgerCostPolicy'],
      },
      { rel: 'packages/kernel/tasks/src/index.ts', identifiers: ['LedgerCostPolicy'] },
    ]);
    const constructions = scanned.filter(({ src }) =>
      /\bnew\s+LedgerCostPolicy\s*\(/.test(stripComments(src)),
    );
    expect(constructions.map(({ rel }) => rel)).toEqual([]);
  });

  it('the shipped defaults of the three unwired seams are never constructed in production', () => {
    for (const identifier of ['CapabilityMatchSelector', 'UnroutedApprovalProvider']) {
      const constructions = scanned
        .filter(({ src }) => new RegExp(`\\bnew\\s+${identifier}\\s*\\(`).test(stripComments(src)))
        .map(({ rel }) => rel);
      expect(constructions).toEqual([]);
    }
  });

  /**
   * The seam interfaces are the whole of what an extension is handed and the whole of what it may
   * hand back, so two of the boundary's load-bearing claims are properties of these five files:
   * an implementation cannot mutate a task row because it never receives a handle to one, and it
   * cannot assert a tenant because no type it touches carries a tenant at all.
   */
  const SEAM_INTERFACE_MODULES = [
    'packages/kernel/core/src/approval-provider.ts',
    'packages/kernel/core/src/cost-policy.ts',
    'packages/kernel/core/src/memory-provider.ts',
    'packages/kernel/core/src/orchestration-strategy.ts',
    'packages/kernel/core/src/worker-selector.ts',
  ];

  it('no seam interface imports anything — a seam is handed plain data, never a capability', () => {
    for (const rel of SEAM_INTERFACE_MODULES) {
      const file = scanned.find((s) => s.rel === rel);
      expect(file, `${rel} was not scanned`).toBeDefined();
      const imports = [...stripComments((file as Scanned).src).matchAll(/\bfrom\s+'([^']+)'/g)].map(
        (m) => m[1] as string,
      );
      expect(imports, rel).toEqual([]);
    }
  });

  it('no seam type carries a tenant — an extension has no field in which to assert one', () => {
    for (const rel of SEAM_INTERFACE_MODULES) {
      const file = scanned.find((s) => s.rel === rel);
      expect(stripComments((file as Scanned).src), rel).not.toMatch(/\btenant/i);
    }
  });

  it('TEETH: a planted wiring is detected, and a comment that merely names a seam is not', () => {
    const planted =
      "import { CapabilityMatchSelector } from '@rayspec/core';\nconst s = new CapabilityMatchSelector();";
    expect(detectSeamReferences('WorkerSelector', planted)).toContain('CapabilityMatchSelector');

    const discussed =
      '// the WorkerSelector seam is unwired; see the extension-seam doc\nconst x = 1;';
    expect(detectSeamReferences('WorkerSelector', discussed)).toEqual([]);

    const blockDiscussed =
      '/* CapabilityMatchSelector is the shipped default */ export const y = 2;';
    expect(detectSeamReferences('WorkerSelector', blockDiscussed)).toEqual([]);

    // A seam name inside a STRING is code, not prose — the stripper must leave it visible.
    const stringified = "export const id = 'ApprovalProvider';";
    expect(detectSeamReferences('ApprovalProvider', stringified)).toContain('ApprovalProvider');
  });
});
