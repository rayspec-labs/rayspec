/**
 * Turn CLASSIFICATION — which way a decision seat moved its task, derived from the TYPED
 * collected intent and nothing else. The model's one judgment call per turn is WHICH turn-ending
 * tool it finishes with; classification is the journal's name for that choice, computed
 * server-side AFTER the toolset validated the intent — model prose never becomes a
 * classification, and a refused ending (the malformed sentinel) or a yield carries none.
 *
 * Emitted for the DECISION SEATS only (orchestrator, manager): a worker's completion is its job,
 * not a routing decision, and a reviewer's verdict already journals as `workforce.review.decided`.
 * The `team` arm reads the resolver-written `delegatedTo` on the fan-out children — the trusted
 * record of what was ADDRESSED, which the resolver stamped and the model cannot rewrite.
 */
import { classificationForIntent, type TurnClassification, type TurnIntent } from '@rayspec/tasks';
import type { EmployeeRole } from './roles.js';

/**
 * The closed mapping. Null means "this turn carries no classification": a non-decision seat, a
 * verdict/housekeeping/failure ending, or no collected intent at all.
 *
 * The DECISION-SEAT gate lives here (the composition's concern); the intent→class map itself is
 * `classificationForIntent` in @rayspec/tasks — the ONE source the engine re-derives from at journal
 * time (apply-intents.ts), so what this deriver produces and what the engine will accept can never
 * drift.
 */
export function classifyTurnIntent(
  intent: TurnIntent,
  role: EmployeeRole,
): TurnClassification | null {
  if (role !== 'orchestrator' && role !== 'manager') return null;
  return classificationForIntent(intent);
}
