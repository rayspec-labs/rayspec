/**
 * `docs/workforce-extension-seams.md` is DRIFT-LOCKED onto the code it cites.
 *
 * The page is the one an out-of-tree implementer reads to learn what a seam may and may not do, and
 * every guarantee on it names a mechanism by `file:line` or a test by name. A citation nobody checks
 * is a citation that quietly starts pointing at the wrong thing — so each one is pinned here with
 * the token the cited line must contain, each cited test name is confirmed to exist, and each stated
 * constant is compared to the constant itself.
 *
 * The loop is closed in both directions: a citation added to the page without an entry in the table
 * below fails this suite too, so the pin set cannot fall behind the prose.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEAM_MAX_MEMORY_HITS, SEAM_MAX_PLAN_STEPS } from './seam-contracts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PAGE = 'docs/workforce-extension-seams.md';
const page = readFileSync(join(repoRoot, PAGE), 'utf8');

/**
 * Every `file:line` (or `file:line-line`) citation the page makes, with a token the FIRST cited line
 * must contain. A line that moved is a failure with the real location in the message.
 */
const CITATIONS: ReadonlyArray<readonly [string, string]> = [
  ['packages/app/server/src/workforce-goal-intake.ts:107-108', 'tenantId'],
  ['packages/app/server/src/workforce-goal-intake.ts:59', 'function planRefusal'],
  ['packages/app/server/src/workforce-goal-intake.ts:68', 'SEAM_MAX_PLAN_STEPS'],
  ['packages/app/server/src/workforce-goal-intake.ts:110', 'strategy.plan'],
  ['packages/kernel/workforce-tools/src/toolset.ts:916', 'TOOLSETS_BY_ROLE['],
  ['packages/app/server/src/workforce-turn-handlers.ts:139', 'buildRoleToolset'],
  ['packages/app/server/src/workforce-turn-handlers.ts:187', 'memory.search'],
  ['packages/app/server/src/workforce-turn-handlers.ts:73', 'memoryProviderFor'],
  ['packages/app/server/src/composition-root.ts:3506', 'orchestrationStrategy'],
  ['packages/app/server/src/composition-root.ts:3493', 'buildWorkforceTurnHandlers'],
  ['packages/kernel/core/src/orchestration-strategy.ts:39', 'interface OrchestrationStrategy'],
  ['packages/kernel/core/src/seam-contracts.ts:61', 'SEAM_MAX_PLAN_STEPS = 64'],
  ['packages/kernel/core/src/memory-provider.ts:34', 'interface WorkforceMemoryProvider'],
  ['packages/kernel/workforce-tools/src/context.ts:657', 'sanitizeUntrusted(hit.text)'],
  ['packages/kernel/workforce-tools/src/context.ts:76', 'recall: 4_096'],
  ['packages/kernel/workforce-tools/src/context.ts:702-703', 'const elastic:'],
  ['packages/kernel/workforce-tools/src/context.ts:647', 'SEAM_MAX_MEMORY_HITS'],
  ['packages/kernel/workforce-tools/src/memory.ts:45', 'RECALL_MAX_HITS = 10'],
  ['packages/kernel/core/src/worker-selector.ts:53', 'interface WorkerSelector'],
  ['packages/kernel/core/src/cost-policy.ts:53', 'interface CostPolicy'],
  ['packages/kernel/tasks/src/budget.ts:551', 'LedgerCostPolicy'],
  ['packages/kernel/core/src/approval-provider.ts:45', 'interface ApprovalProvider'],
  ['packages/kernel/core/src/review-policy.ts:69', 'interface ReviewPolicy'],
  ['packages/kernel/workforce-tools/src/review-policy.ts:76', 'DeclaredReviewPolicy'],
  ['packages/kernel/tasks/src/create-task.ts:48', 'MAX_TASK_DEPENDENCIES = 100'],
  ['packages/app/server/src/workforce-goal-intake.ts:88', 'MAX_TASK_DEPENDENCIES'],
];

/**
 * The bare-line citations the page makes as ``(`:NN`)`` shorthand right after naming a symbol. The
 * TOKEN is the symbol the page prints immediately before the shorthand, which is what lets the
 * page-side arm below match each printed number to its own entry instead of merely counting them.
 * Tokens must be unique here; the suite asserts that rather than trusting it.
 */
const SHORTHAND: ReadonlyArray<readonly [string, number, string]> = [
  ['packages/kernel/core/src/orchestration-strategy.ts', 49, 'SingleTaskPlanStrategy'],
  ['packages/kernel/core/src/memory-provider.ts', 45, 'EmptyRecallMemoryProvider'],
  ['packages/kernel/core/src/worker-selector.ts', 63, 'CapabilityMatchSelector'],
  ['packages/kernel/core/src/approval-provider.ts', 57, 'UnroutedApprovalProvider'],
  ['packages/kernel/core/src/review-policy.ts', 80, 'DeclaredReviewPolicy'],
  ['packages/app/server/src/workforce-turn-handlers.ts', 73, 'memoryProviderFor'],
  ['packages/kernel/core/src/seam-confinement.ts', 52, 'SeamConfinementError'],
  ['packages/kernel/core/src/seam-confinement.ts', 75, 'confineWorkerSelector'],
  ['packages/kernel/core/src/seam-confinement.ts', 221, 'confineCostPolicy'],
  ['packages/kernel/core/src/seam-confinement.ts', 248, 'confineApprovalProvider'],
  ['packages/kernel/core/src/seam-confinement.ts', 307, 'confineMemoryProvider'],
];

/** The roots a full-path citation may start with. Anything else on the page is an unresolvable form. */
const CITATION_ROOTS = ['packages/', 'examples/', 'scripts/', 'docs/'];

function lineOf(relAndLine: string): { rel: string; line: number } {
  const at = relAndLine.lastIndexOf(':');
  const rel = relAndLine.slice(0, at);
  const line = Number.parseInt(relAndLine.slice(at + 1).split('-')[0] as string, 10);
  return { rel, line };
}

function assertCites(rel: string, line: number, token: string): void {
  const path = join(repoRoot, rel);
  expect(existsSync(path), `${rel} does not exist`).toBe(true);
  const lines = readFileSync(path, 'utf8').split('\n');
  const actual = lines[line - 1] ?? '';
  const elsewhere = lines.findIndex((l) => l.includes(token)) + 1;
  expect(
    actual.includes(token),
    `${PAGE} cites ${rel}:${line} for ${JSON.stringify(token)}, but that line reads ${JSON.stringify(actual.trim())}` +
      (elsewhere > 0 ? ` — the token is now at :${elsewhere}` : ' — the token is gone entirely'),
  ).toBe(true);
}

describe('docs/workforce-extension-seams.md', () => {
  it('every pinned file:line citation still points at what it claims', () => {
    for (const [citation, token] of CITATIONS) {
      const { rel, line } = lineOf(citation);
      assertCites(rel, line, token);
    }
    for (const [rel, line, token] of SHORTHAND) assertCites(rel, line, token);
  });

  it('every file:line citation ON THE PAGE is pinned above — the pin set cannot fall behind', () => {
    const onPage = new Set(
      [...page.matchAll(/`((?:packages|examples|scripts|docs)\/[\w./-]+\.\w+:\d+(?:-\d+)?)`/g)].map(
        (m) => m[1] as string,
      ),
    );
    const pinned = new Set(CITATIONS.map(([c]) => c));
    expect([...onPage].filter((c) => !pinned.has(c))).toEqual([]);
  });

  /**
   * Every citation-shaped token on the page must be a FULL path, so the arm above sees all of them.
   * A bare `context.ts:579` is checked by nothing: it is not a path the arm matches, and the pin
   * table cannot tell which of several same-named files it meant. Requiring the full form is what
   * makes "every citation on the page is pinned" true of the page rather than of a subset of it.
   */
  it('no citation on the page escapes the full-path form the arm above matches', () => {
    const bare = [
      ...page.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|json|md|yaml|yml):\d+(?:-\d+)?)`/g),
    ]
      .map((m) => m[1] as string)
      .filter((c) => !CITATION_ROOTS.some((root) => c.startsWith(root)));
    expect(bare, 'these citations name a file without its path, so nothing verifies them').toEqual(
      [],
    );
  });

  /**
   * The ``(`:NN`)`` shorthands, checked BY VALUE.
   *
   * This arm previously compared only the COUNT of shorthands to the size of the pin table, which is
   * a reading a wrong page also produces: a page printing ``(`:99999`)`` against a table holding 63
   * was green. Counting is not checking. Each shorthand on the page is anchored to the symbol
   * printed immediately before it, so the number the READER sees is matched to the number the table
   * VERIFIED against the source — and `(`:99999`)` is red.
   */
  it('every shorthand the page PRINTS equals the line its pin verified', () => {
    const byToken = new Map(SHORTHAND.map(([, line, token]) => [token, line]));
    expect(
      byToken.size,
      'SHORTHAND tokens must be unique — a collision would hide a wrong number',
    ).toBe(SHORTHAND.length);

    const printed = [...page.matchAll(/`([A-Za-z_][\w.]*)`[^`\n]{0,24}\(`:(\d+)`\)/g)].map((m) => ({
      token: m[1] as string,
      line: Number.parseInt(m[2] as string, 10),
    }));

    // Every shorthand on the page resolves to a pin, and prints that pin's line.
    for (const { token, line } of printed) {
      const pinned = byToken.get(token);
      expect(
        pinned,
        `the page prints a (\`:${line}\`) shorthand after \`${token}\`, which no pin covers`,
      ).toBeDefined();
      expect(
        line,
        `the page prints \`${token}\` (\`:${line}\`) but its pin verified line ${String(pinned)}`,
      ).toBe(pinned);
    }
    // …and every pin appears on the page, so a corrected table cannot leave the prose behind.
    expect(printed.map((p) => p.token).sort()).toEqual([...byToken.keys()].sort());
    // No shorthand escaped the symbol-anchored pattern above (which would make it unverified).
    expect([...page.matchAll(/\(`:\d+`\)/g)]).toHaveLength(printed.length);
  });

  it('every test name the page cites exists', () => {
    // The page quotes test names inside backticks, in either quote style. Both sides are
    // whitespace-normalized because markdown wraps a long title across lines and source does not.
    const quoted = [
      ...[...page.matchAll(/`'([^`']{12,})'`/g)].map((m) => m[1] as string),
      ...[...page.matchAll(/`"([^`"]{12,})"`/g)].map((m) => m[1] as string),
    ].map(flatten);
    expect(quoted.length).toBeGreaterThan(10);
    const haystack = testSources().map(flatten);
    for (const name of quoted) {
      expect(
        haystack.some((src) => src.includes(name)),
        `${PAGE} cites the test ${JSON.stringify(name)}, which no suite declares`,
      ).toBe(true);
    }
  });

  it('the constants the page states are the constants the code exports', () => {
    expect(SEAM_MAX_PLAN_STEPS).toBe(64);
    expect(SEAM_MAX_MEMORY_HITS).toBe(64);
    expect(page).toContain(`\`SEAM_MAX_PLAN_STEPS = ${SEAM_MAX_PLAN_STEPS}\``);
    expect(page).toContain(`\`SEAM_MAX_MEMORY_HITS = ${SEAM_MAX_MEMORY_HITS}\``);
  });
});

/** Collapse every whitespace run to one space, so a wrapped markdown line matches a source line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.test.ts')) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(join(repoRoot, 'packages'));
  walk(join(repoRoot, 'examples'));
  return out;
}
