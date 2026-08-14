/**
 * The one-turn-ending-intent COLLECTOR — the mutable heart of a turn's toolset. Native tool
 * handlers write here and here only; nothing in this module (or package) executes an intent.
 *
 * The exactly-one rule, mechanically: the FIRST valid turn-ending call records the turn's intent;
 * every later turn-ending call throws `TurnAlreadyEndedError` (a typed tool error the model sees;
 * the first intent stands). A turn-ending call whose arguments failed validation records a
 * MALFORMED marker instead — if the run ends with no valid intent, the composition hands the raw
 * malformed value to the engine, whose schema refusal drives the existing requeue-once-then-fail
 * fate. A run that never calls a turn-ending tool yields.
 *
 * Buffered effects (messages; the non-turn-ending create tools) accumulate beside the intent and
 * are applied atomically WITH it by the engine. A created child's id is computed HERE from the
 * turn's deterministic child-id space — slots 0..k-1 in buffer order — so the create tool can hand
 * the model a real task id mid-turn while the row itself lands only in the receipted final
 * transaction (a crash-and-replay recomputes the same ids and collides instead of duplicating).
 */
import { deterministicChildTaskId, type TurnIntent } from '@rayspec/tasks';
import { TurnAlreadyEndedError } from './errors.js';

/**
 * THE TYPED SENTINEL a refused turn ending hands the engine — never the model's own arguments.
 *
 * Its `kind` is deliberately outside `turnIntentSchema`'s closed union, so the engine's own parse
 * refuses it by construction and drives the declared requeue-once-then-fail fate. Forwarding the
 * RAW arguments instead was a silent-privilege bug, not merely untidy: a `submit_result` whose
 * arguments failed this package's schema was recorded malformed and handed to the engine, which
 * read the very same bytes as a VALID intent of another kind — while the review-policy match, which
 * keys on the intent this package COLLECTED, saw none and passed null. A mandatory review policy
 * was skipped by sending the wrong arguments to the right tool.
 *
 * The detail stays on the collector for the composition to log; what crosses the boundary is this
 * constant and nothing else.
 */
export const MALFORMED_TURN_ENDING = Object.freeze({ kind: 'malformed_turn_ending' as const });

export interface BufferedMessage {
  readonly recipient: string;
  readonly body: string;
}

export interface BufferedCreatedChild {
  readonly title: string;
  readonly goal: string;
  readonly description?: string | null;
  readonly owner: string;
  readonly department?: string | null;
  readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
  readonly delegatedTo?: string;
}

export interface CollectedTurn {
  /** The first VALID turn-ending intent, or null when none was recorded. */
  readonly intent: TurnIntent | null;
  /** Set ONLY when no valid intent was recorded but a malformed turn-ending attempt happened. */
  readonly malformed: { readonly raw: unknown; readonly detail: string } | null;
  readonly messages: readonly BufferedMessage[];
  readonly createdChildren: readonly BufferedCreatedChild[];
}

export class TurnCollector {
  readonly #tenantId: string;
  readonly #taskId: string;
  readonly #turnNumber: number;
  #intent: TurnIntent | null = null;
  #malformed: { raw: unknown; detail: string } | null = null;
  readonly #messages: BufferedMessage[] = [];
  readonly #createdChildren: BufferedCreatedChild[] = [];

  constructor(input: {
    readonly tenantId: string;
    readonly taskId: string;
    /** The dispatched turn's 1-based number (`task.turnsUsed + 1` — frozen while the turn runs). */
    readonly turnNumber: number;
  }) {
    this.#tenantId = input.tenantId;
    this.#taskId = input.taskId;
    this.#turnNumber = input.turnNumber;
  }

  /** The kind of the recorded intent, or null — read tools use it to answer status questions. */
  get endedWith(): string | null {
    return this.#intent?.kind ?? null;
  }

  /**
   * Record the turn's ONE ending intent. Throws the typed already-ended error on a second call —
   * the first intent stands and the throw surfaces to the model as a tool error.
   */
  recordIntent(intent: TurnIntent): void {
    if (this.#intent !== null) throw new TurnAlreadyEndedError(this.#intent.kind);
    this.#intent = intent;
  }

  /** Record a turn-ending attempt whose arguments failed validation (drives the engine's fate). */
  recordMalformed(raw: unknown, detail: string): void {
    if (this.#malformed === null) this.#malformed = { raw, detail };
  }

  /** How many messages this turn has buffered — the per-turn cap's input. */
  get messageCount(): number {
    return this.#messages.length;
  }

  recordMessage(message: BufferedMessage): void {
    this.#messages.push(message);
  }

  /**
   * Buffer a child creation and return its DETERMINISTIC task id (slots are buffer order; a
   * same-turn fan-out's children continue after them, so ids can never collide).
   */
  recordCreatedChild(spec: BufferedCreatedChild): string {
    const slot = this.#createdChildren.length;
    this.#createdChildren.push(spec);
    return deterministicChildTaskId(this.#tenantId, this.#taskId, this.#turnNumber, slot);
  }

  finish(): CollectedTurn {
    return {
      intent: this.#intent,
      malformed: this.#intent === null ? this.#malformed : null,
      messages: this.#messages,
      createdChildren: this.#createdChildren,
    };
  }
}
