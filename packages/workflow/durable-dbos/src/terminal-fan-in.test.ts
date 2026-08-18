/**
 * EVERY PATH THAT APPLIES A TERMINAL STATUS RUNS THE FAN-IN — a static tripwire, not a comment.
 *
 * A task reaching `completed` / `failed` / `cancelled` has to do more than move its own row: its
 * opening delegation record must settle, and its parent's park must be answered. `afterTaskTerminal`
 * (@rayspec/tasks task-locks.ts) is the ONE function that does both, and for one park it is the only
 * exit that exists at all — `waiting_for_review` appears in no wake set and no sweep covers it, so
 * `releaseAbandonedReview`, which runs from `afterTaskTerminal` and nowhere else, is the sole release.
 * A terminal-applying path that forgets the call therefore does not merely skip some bookkeeping; it
 * can strand a parent permanently.
 *
 * That is exactly the shape of defect this program keeps finding, and prose is what failed to prevent
 * the previous six: the guarantee lived in a docstring while the code did not carry it. So it is
 * pinned here instead. The scan reads the engine's own sources, requires the call to appear within a
 * short window after each terminal `applyTransition`, and carries ONE justified exception with its
 * reason spelled out. It fails closed on an empty walk and on an exception that no longer matches
 * anything, so neither a broken glob nor a stale allowlist can read green.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
/** The two packages that own the engine's write paths; never the repo root (agent worktrees). */
const PACKAGES = resolve(here, '..', '..', '..');
const REPO_ROOT = resolve(PACKAGES, '..');
const SCAN_ROOTS = [
  join(PACKAGES, 'kernel', 'tasks', 'src'),
  join(PACKAGES, 'workflow', 'durable-dbos', 'src'),
];

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
/** How far after the `to: '<terminal>'` line the fan-in call may sit (the widest real gap is 8). */
const WINDOW_LINES = 14;

/**
 * The ONE terminal-applying path that legitimately does not call `afterTaskTerminal`, with the reason
 * it does not need to. `cancelDescendants` cancels every non-terminal descendant of an origin that is
 * ITSELF being cancelled: it settles each delegation row inline (the `workforceDelegations` update in
 * the same loop), and every descendant's parent is inside the same cancelled subtree, so there is no
 * surviving park anywhere to answer. `engine.db.test.ts` ('a cancel cascade from an ancestor leaves no
 * task parked on a review it can never receive') asserts that property against a real database; this
 * entry records that the omission is a decision, not an oversight.
 */
const EXCEPTIONS: { readonly file: string; readonly enclosing: string; readonly why: string }[] = [
  {
    file: 'packages/kernel/tasks/src/apply-intents.ts',
    enclosing: 'export async function cancelDescendants(',
    why: 'the cascade settles each delegation row inline and every parent is inside the cancelled subtree',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      walk(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

interface TerminalWrite {
  readonly file: string;
  readonly line: number;
  readonly status: string;
  readonly hasFanIn: boolean;
  /** The nearest preceding `function`/`async` declaration line — how an exception is matched. */
  readonly enclosing: string;
}

/** Every `applyTransition({... to: '<terminal>' ...})` in the engine, with its fan-in verdict. */
function terminalWrites(): TerminalWrite[] {
  const found: TerminalWrite[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, text] of lines.entries()) {
        const match = /to:\s*'(completed|failed|cancelled)'/.exec(text);
        if (!match) continue;
        const status = match[1] as string;
        // Only a real transition counts — a `to:` inside a type, a payload or a comment does not.
        const preamble = lines.slice(Math.max(0, index - 12), index).join('\n');
        if (!preamble.includes('applyTransition(')) continue;
        const window = lines.slice(index, index + WINDOW_LINES).join('\n');
        const enclosing =
          lines
            .slice(0, index)
            .reverse()
            .find((l) => /^(export )?(async )?function |^ {2}async #|^ {2}async [a-zA-Z]/.test(l))
            ?.trim() ?? '<top level>';
        found.push({
          file: relative(REPO_ROOT, file),
          line: index + 1,
          status,
          hasFanIn: window.includes('afterTaskTerminal('),
          enclosing,
        });
      }
    }
  }
  return found;
}

/** An exception covers a write only in the SAME file AND the same enclosing function. */
function covers(exception: (typeof EXCEPTIONS)[number], write: TerminalWrite): boolean {
  return write.file === exception.file && write.enclosing.startsWith(exception.enclosing);
}

describe('every terminal status write runs the fan-in (afterTaskTerminal)', () => {
  const writes = terminalWrites();

  it('scanned a real tree (fail-closed: an empty scan must not read green)', () => {
    // Nine terminal writes exist today across the two roots. The floor is what stops a regex that
    // stopped matching — or a walk that found nothing — from passing vacuously.
    expect(writes.length).toBeGreaterThanOrEqual(8);
    for (const status of TERMINAL_STATUSES) {
      expect(
        writes.some((w) => w.status === status),
        `the scan must find at least one '${status}' write`,
      ).toBe(true);
    }
  });

  it('every exception still matches a real, fan-in-less write (a stale allowlist must fail)', () => {
    for (const exception of EXCEPTIONS) {
      const matched = writes.filter((w) => covers(exception, w) && !w.hasFanIn);
      expect(
        matched.length,
        `the exception for ${exception.enclosing} in ${exception.file} (${exception.why}) matches ` +
          'no fan-in-less write any more — the path changed, so re-justify it or remove the entry',
      ).toBeGreaterThan(0);
    }
  });

  it('no terminal write is missing afterTaskTerminal outside the recorded exception', () => {
    const offenders = writes
      .filter((w) => !w.hasFanIn)
      .filter((w) => !EXCEPTIONS.some((e) => covers(e, w)))
      .map((w) => `${w.file}:${w.line} (to '${w.status}', in ${w.enclosing})`);
    expect(
      offenders,
      'a terminal status applied without afterTaskTerminal can strand its parent — a ' +
        'waiting_for_review park has no other exit at all. Add the call (and the lockRootFirst that ' +
        'must precede it), or record a justified exception here.',
    ).toEqual([]);
  });
});
