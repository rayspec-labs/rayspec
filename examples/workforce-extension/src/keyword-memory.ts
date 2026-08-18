/**
 * An out-of-tree `WorkforceMemoryProvider`: keep what it is told, rank recall by keyword overlap.
 *
 * A real one would be a vector index. What matters here is that recall is DATA and never
 * instruction: whatever this returns is rendered into a later turn's context as a bounded, neutered
 * list item, so it cannot begin a line, forge a section header, or carry a directive that outranks
 * the engine's own frame. The provider does not know that and does not need to — the neutralization
 * is the caller's, at the render site, which is the only place that knows the document being
 * rendered into.
 *
 * What this implementation OWES the caller is smaller and entirely about size: honor the query
 * limit, stay inside the seam ceiling, and hand back hits whose scores are real numbers. Those are
 * the properties the contract kit checks, and the ones a caller cannot recover from cheaply.
 */
import {
  type MemoryEntry,
  type MemoryHit,
  type MemoryQuery,
  SEAM_MAX_MEMORY_HITS,
  type WorkforceMemoryProvider,
} from '@rayspec/core';

interface StoredEntry {
  readonly id: string;
  readonly text: string;
  readonly tokens: ReadonlySet<string>;
}

export class KeywordMemoryProvider implements WorkforceMemoryProvider {
  readonly id = 'keyword-memory';
  readonly #entries: StoredEntry[] = [];

  constructor(seed: readonly string[] = []) {
    for (const text of seed) this.#store(text);
  }

  search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    const wanted = tokenize(query.text);
    // The narrower of the caller's limit and the seam ceiling. A provider that returned more than
    // it was asked for would be spending the caller's context budget on its own behalf.
    const ceiling = Math.min(query.limit ?? SEAM_MAX_MEMORY_HITS, SEAM_MAX_MEMORY_HITS);
    const hits = this.#entries
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        score: overlap(wanted, entry.tokens),
      }))
      .filter((hit) => hit.score > 0)
      // Rank descending, then by id, so an equal-scoring pair does not reorder between calls.
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, ceiling));
    return Promise.resolve(hits);
  }

  remember(entry: MemoryEntry): Promise<void> {
    this.#store(entry.text);
    return Promise.resolve();
  }

  #store(text: string): void {
    this.#entries.push({ id: `kw-${this.#entries.length}`, text, tokens: tokenize(text) });
  }
}

function tokenize(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

/** Overlap as a fraction of the query's own tokens — always finite, always in [0, 1]. */
function overlap(wanted: ReadonlySet<string>, have: ReadonlySet<string>): number {
  if (wanted.size === 0) return 0;
  let shared = 0;
  for (const token of wanted) if (have.has(token)) shared += 1;
  return shared / wanted.size;
}
