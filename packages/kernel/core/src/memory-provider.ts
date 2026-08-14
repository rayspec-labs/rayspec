/**
 * WorkforceMemoryProvider — the neutral recall seam.
 *
 * Context assembly reserves a bounded recall section for prior results and decisions; this seam
 * fills it. The provider ranks and returns — it never writes tasks, never carries authority, and
 * whatever it returns is DATA in a later turn's context, subject to the caller's own byte budget.
 *
 * The default recalls NOTHING, and says so instead of pretending: `search` returns an empty list
 * and `remember` retains nothing. Both facts are the contract — a deployment has no memory until a
 * real provider replaces this one, and code that consumes the seam must behave correctly on an
 * always-empty recall (which is exactly what this default proves in every test).
 */

export interface MemoryQuery {
  /** Free-text query — matched by the implementation, opaque to the caller. */
  readonly text: string;
  readonly workforceId?: string;
  /** Upper bound on returned hits; implementations must never exceed it. */
  readonly limit?: number;
}

export interface MemoryHit {
  readonly id: string;
  readonly text: string;
  /** Relative rank, higher first — comparable within one response only. */
  readonly score: number;
}

export interface MemoryEntry {
  readonly text: string;
  readonly tags?: readonly string[];
}

export interface WorkforceMemoryProvider {
  readonly id: string;
  search(query: MemoryQuery): Promise<readonly MemoryHit[]>;
  remember(entry: MemoryEntry): Promise<void>;
}

/**
 * The explicit empty-recall default. Returns no hits and retains nothing — loudly, by contract,
 * not as a stub that grew load-bearing: consumers must render an empty recall section correctly,
 * and this default is what keeps that path tested. A real provider replaces it.
 */
export class EmptyRecallMemoryProvider implements WorkforceMemoryProvider {
  readonly id = 'empty-recall';

  search(_query: MemoryQuery): Promise<readonly MemoryHit[]> {
    return Promise.resolve([]);
  }

  remember(_entry: MemoryEntry): Promise<void> {
    return Promise.resolve();
  }
}
