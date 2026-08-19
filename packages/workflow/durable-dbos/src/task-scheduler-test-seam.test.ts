/**
 * `onPassReadBarrier` is a TEST-ONLY dependency of `DbosTaskScheduler`, and this pins that it stays
 * one — production source may not wire it, anywhere.
 *
 * WHY THE SEAM EXISTS AT ALL. The reserve pass takes its candidate page and its concurrency counts
 * in two separate database snapshots, and the ORDER of those two reads is what keeps
 * `maxConcurrentWorkers` from being overshot: a claim committing between them is invisible to both
 * if the counts are read first. A property about an interleaving cannot be proven by any test that
 * cannot CAUSE the interleaving — the only alternatives are a statistical run (the flake this
 * replaced: 23 failures in 44 runs) or a sleep. So the pass awaits one optional hook at exactly the
 * point that separates the two reads, and `task-scheduler.db.test.ts` commits a claim there.
 *
 * WHAT KEEPS THAT HONEST is this file rather than the comment on the declaration: a hook that is
 * merely DOCUMENTED as test-only is one careless wiring away from being production behaviour, and
 * the whole point of the seam is that production never awaits anything there. The scan fails closed
 * on an empty walk, so a broken glob cannot read green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/** `packages/` — never the repo root: sibling agent worktrees live under `.claude/`, not here. */
const PACKAGES = resolve(here, '..', '..', '..');
const REPO_ROOT = resolve(PACKAGES, '..');

/** The ONE production file allowed to mention the seam: where it is declared, and awaited. */
const DECLARING_FILE = 'packages/workflow/durable-dbos/src/task-scheduler.ts';
const SEAM = 'onPassReadBarrier';

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      walkSources(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

describe('the reserve pass read barrier stays a TEST-ONLY seam', () => {
  const sources = walkSources(PACKAGES);

  it('scanned a real tree (fail-closed: an empty walk must not read green)', () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.map((f) => relative(REPO_ROOT, f))).toContain(DECLARING_FILE);
  });

  it('is named by no production source but the file that declares it', () => {
    const mentions = sources
      .filter((file) => readFileSync(file, 'utf8').includes(SEAM))
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(
      mentions,
      `${SEAM} is a test-only dependency; production code must never supply or await it`,
    ).toEqual([DECLARING_FILE]);
  });

  it('the declaring file supplies it nowhere — it only declares it and awaits it when given', () => {
    const src = readFileSync(join(REPO_ROOT, DECLARING_FILE), 'utf8');
    // Exactly three occurrences of the name: the optional dep on `TaskSchedulerDeps`, and the two
    // in the single guarded await (the `!== undefined` test and the call it guards). A fourth would
    // mean a second call site, which the ordering argument in `runReservePass` does not cover.
    expect(src.match(new RegExp(SEAM, 'g')) ?? []).toHaveLength(3);
    expect(src).toContain(`readonly ${SEAM}?: () => Promise<void>;`);
    expect(src).toContain(`if (this.#deps.${SEAM} !== undefined) await this.#deps.${SEAM}();`);
  });
});
