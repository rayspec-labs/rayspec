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
import type { TurnClassification, TurnIntent } from '@rayspec/tasks';
import type { EmployeeRole } from './roles.js';

/**
 * The closed mapping. Null means "this turn carries no classification": a non-decision seat, a
 * verdict/housekeeping/failure ending, or no collected intent at all.
 */
export function classifyTurnIntent(
  intent: TurnIntent,
  role: EmployeeRole,
): TurnClassification | null {
  if (role !== 'orchestrator' && role !== 'manager') return null;
  switch (intent.kind) {
    case 'complete':
      return 'direct';
    case 'fan_out':
      // The resolver wrote `delegatedTo` from the validated target — `team:` there means a team
      // was ADDRESSED, whoever ended up owning the child rows.
      return intent.children.some((child) => child.delegatedTo?.startsWith('team:'))
        ? 'team'
        : 'delegate';
    case 'request_review':
      return 'review';
    case 'request_approval':
    case 'escalate':
    case 'request_clarification':
      // All three hand the decision upward — to a human, to the reporting line, or back to the
      // requester. The exit class, whichever door.
      return 'escalate';
    default:
      // submit_review (a verdict, journaled on its own event), cancel_task, yield, fail —
      // housekeeping and failure endings classify nothing.
      return null;
  }
}
