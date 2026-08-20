/**
 * SEAM CONFINEMENT — re-validating what an extension seam returned, at the boundary where its
 * answer becomes the engine's action.
 *
 * The seams are the injection point for out-of-tree intelligence, so an implementation of one is
 * UNTRUSTED CODE the same way model output is untrusted data: it may be excellent, and the engine
 * still may not take its word for anything that carries authority. These wrappers turn each
 * interface's prose contract into a check the engine performs on the returned value.
 *
 * THE SPLIT THAT RUNS THROUGH ALL OF THEM:
 *   - AUTHORITY is REFUSED. An employee id, an approval status, a spend decision, a hit's score:
 *     wrong means a typed `SeamConfinementError` and the caller parks or fails. There is no
 *     normalizing an identity into a correct one.
 *   - SIZE is CLAMPED. A selection rationale, a recall hit count: these carry no authority, and
 *     refusing on them would hand an extension a denial-of-service — return one oversized string and
 *     the turn dies. Clamping keeps the work bounded and the turn running.
 *
 * WIRING STATUS, STATED PLAINLY: `WorkerSelector`, `CostPolicy` and `ApprovalProvider` have no
 * production call site in this repository, and neither do their confinements. `confineMemoryProvider`
 * likewise wraps a seam whose one call site
 * (`packages/app/server/src/workforce-turn-handlers.ts:154`) does not route through it. Nothing here
 * is enforced on a running deployment today; these are the checks a call site must adopt when one is
 * built, and `seam-wiring.test.ts` fails the moment one of those three seams gains a reference under
 * `packages/**`, so the wrapping cannot be forgotten quietly.
 */
import type { ApprovalProvider, ApprovalRequest, ApprovalTicket } from './approval-provider.js';
import type {
  BudgetScopeKind,
  CostPolicy,
  PolicyDecision,
  ProposedExecution,
  SettledExecution,
} from './cost-policy.js';
import type { MemoryHit, MemoryQuery, WorkforceMemoryProvider } from './memory-provider.js';
import {
  SEAM_MAX_MEMORY_HITS,
  SEAM_MAX_SELECTION_REASON_CHARS,
  type SeamName,
} from './seam-contracts.js';
import { truncateCodeUnits } from './text-utils.js';
import type {
  SelectionTask,
  WorkerCandidate,
  WorkerSelection,
  WorkerSelector,
} from './worker-selector.js';

/**
 * An extension returned something the seam does not permit it to return. Carries the seam and the
 * contract property that refused, so a park reason names WHAT was over-reached, not just that
 * something was.
 */
export class SeamConfinementError extends Error {
  readonly seam: SeamName;
  readonly property: string;
  constructor(seam: SeamName, property: string, detail: string) {
    super(`${seam} confinement refused [${property}]: ${detail}. Fail-closed.`);
    this.name = 'SeamConfinementError';
    this.seam = seam;
    this.property = property;
  }
}

const BUDGET_SCOPE_KINDS: readonly BudgetScopeKind[] = ['task', 'root', 'department', 'workforce'];

/**
 * Confine a `WorkerSelector`. The selection's IDENTITY is re-derived against the candidate array the
 * caller passed, so the seam can only ever narrow that set — there is no path by which a returned id
 * that was not in the list becomes an assignment. Capability coverage is re-checked for the same
 * reason: handing a task to a seat that does not declare what the task requires would be the seam
 * granting a capability, which is exactly the authority it does not have.
 *
 * The rationale is clamped rather than refused: it is journal text, it decides nothing, and killing
 * an otherwise-valid assignment over prose length would be a worse outcome than a shorter string.
 */
export function confineWorkerSelector(inner: WorkerSelector): WorkerSelector {
  return {
    id: `confined(${inner.id})`,
    async select(
      task: SelectionTask,
      candidates: readonly WorkerCandidate[],
    ): Promise<WorkerSelection> {
      // An empty candidate set has no correct answer, so no answer is accepted from one. Checked
      // BEFORE the inner call: an implementation that invents a seat from nothing must not even get
      // the chance to have its invention inspected.
      if (candidates.length === 0) {
        throw new SeamConfinementError(
          'WorkerSelector',
          'an-empty-candidate-list-fails-closed',
          `task '${task.taskId}' has no candidates, so there is no selection to confine`,
        );
      }
      // An inner refusal is the seam behaving correctly; it travels unchanged so the caller still
      // sees a WorkerSelectionError and can park on it.
      const selection = await inner.select(task, candidates);

      if (typeof selection?.employeeId !== 'string' || selection.employeeId.length === 0) {
        throw new SeamConfinementError(
          'WorkerSelector',
          'selection-names-a-given-candidate',
          `the selection carries employeeId '${String(selection?.employeeId)}', which is not a non-empty string`,
        );
      }
      const chosen = candidates.find((c) => c.employeeId === selection.employeeId);
      if (chosen === undefined) {
        throw new SeamConfinementError(
          'WorkerSelector',
          'selection-names-a-given-candidate',
          `'${selection.employeeId}' is not among the candidates [${candidates.map((c) => c.employeeId).join(', ')}]`,
        );
      }
      const missing = task.requiredCapabilities.filter(
        (label) => !chosen.capabilities.includes(label),
      );
      if (missing.length > 0) {
        throw new SeamConfinementError(
          'WorkerSelector',
          'selection-holds-every-required-capability',
          `'${chosen.employeeId}' does not declare [${missing.join(', ')}], which task '${task.taskId}' requires`,
        );
      }
      const reason = typeof selection.reason === 'string' ? selection.reason : '';
      return {
        employeeId: chosen.employeeId,
        // Through the shared truncation guard: the rationale is EXTENSION-authored text, so its cut
        // can land inside an astral pair like any other untrusted string.
        reason: truncateCodeUnits(reason, SEAM_MAX_SELECTION_REASON_CHARS),
      };
    },
  };
}

function assertDecisionShape(decision: unknown, extensionId: string): PolicyDecision {
  const d = decision as { allowed?: unknown; denial?: unknown };
  if (typeof d?.allowed !== 'boolean') {
    throw new SeamConfinementError(
      'CostPolicy',
      'authorize-yields-a-well-formed-decision',
      `extension '${extensionId}' answered with allowed='${String(d?.allowed)}' rather than a boolean`,
    );
  }
  if (d.allowed === true) return { allowed: true };
  const denial = d.denial as
    | {
        scopeKind?: unknown;
        scopeId?: unknown;
        ceiling?: { kind?: unknown; limit?: unknown };
        consumed?: unknown;
      }
    | undefined;
  const problems: string[] = [];
  if (
    typeof denial?.scopeKind !== 'string' ||
    !BUDGET_SCOPE_KINDS.includes(denial.scopeKind as BudgetScopeKind)
  ) {
    problems.push(
      `scope kind '${String(denial?.scopeKind)}' is outside [${BUDGET_SCOPE_KINDS.join(', ')}]`,
    );
  }
  if (typeof denial?.scopeId !== 'string' || denial.scopeId.length === 0) {
    problems.push('the denial names no scope id');
  }
  if (denial?.ceiling?.kind !== 'usd' && denial?.ceiling?.kind !== 'turns') {
    problems.push(`ceiling kind '${String(denial?.ceiling?.kind)}' is outside [usd, turns]`);
  }
  if (
    typeof denial?.ceiling?.limit !== 'number' ||
    !Number.isFinite(denial.ceiling.limit) ||
    denial.ceiling.limit < 0
  ) {
    problems.push(
      `the ceiling limit ${String(denial?.ceiling?.limit)} is not a finite non-negative number`,
    );
  }
  if (
    typeof denial?.consumed !== 'number' ||
    !Number.isFinite(denial.consumed) ||
    denial.consumed < 0
  ) {
    problems.push(
      `the consumed total ${String(denial?.consumed)} is not a finite non-negative number`,
    );
  }
  if (problems.length > 0) {
    throw new SeamConfinementError(
      'CostPolicy',
      'denial-names-a-known-scope-with-finite-numbers',
      `extension '${extensionId}' returned an unreadable denial — ${problems.join('; ')}`,
    );
  }
  return d as PolicyDecision;
}

/**
 * Compose a deterministic `baseline` cost policy with an injected `extension` so the extension can
 * only ever DENY MORE.
 *
 * `authorize` asks the baseline first and returns its denial verbatim when it denies — the extension
 * is not consulted at all, so there is no value it can return that turns a baseline denial into an
 * allow, and no ceiling it can report that replaces the baseline's. Only when the baseline allows is
 * the extension asked, and only its denial can change the outcome.
 *
 * `settle` calls the BASELINE FIRST and authoritatively — that is the durable ledger write, and its
 * failure propagates — and then the extension ADVISORILY, inside a swallowing `catch`.
 *
 * Why the extension is called at all, since an earlier version of this wrapper did not call it: the
 * argument for excluding it was that an extension able to write settlement could make its own future
 * ceilings say anything. That does not survive being followed through. An extension's `settle` writes
 * only the EXTENSION's own state — it has no handle to the durable ledger, which is the baseline's —
 * so an extension that lies to itself can only ever make itself deny LESS, and the baseline stays
 * authoritative in every case because `authorize` asks it first. Excluding `settle` bought no safety
 * and cost every stateful policy: a per-department or per-window ceiling can only accumulate if it is
 * told what was spent, so under the old wrapper such a policy silently degraded to a per-turn
 * estimate check. `examples/workforce-extension`'s own sample is exactly that shape.
 *
 * Why the `catch`: an extension's bookkeeping failing must never roll back the ledger write that has
 * already happened. The extension's own state is its problem.
 *
 * What the `catch` does NOT cover, stated rather than inherited silently: an extension that HANGS
 * still hangs the caller, here and in `authorize`, which has always awaited the extension the same
 * way. That is one hazard, not a new one, and it belongs to whoever wires this seam — a call site
 * needs a deadline around the whole confined policy, not a special case for settlement.
 */
export function confineCostPolicy(baseline: CostPolicy, extension: CostPolicy): CostPolicy {
  return {
    id: `confined(${baseline.id}+${extension.id})`,
    async authorize(proposed: ProposedExecution): Promise<PolicyDecision> {
      const base = await baseline.authorize(proposed);
      if (base.allowed === false) return base;
      // A rejecting extension fails CLOSED: the error propagates and nothing is authorized.
      return assertDecisionShape(await extension.authorize(proposed), extension.id);
    },
    async settle(actual: SettledExecution): Promise<void> {
      // Authoritative. A failure here is a failure of the turn's settlement and must surface.
      await baseline.settle(actual);
      try {
        await extension.settle(actual);
      } catch {
        // Advisory. The ledger is already written; an extension's own accounting cannot undo it.
      }
    },
  };
}

/**
 * Confine an `ApprovalProvider` so `request` can only ever hand back a PENDING ticket. A provider
 * that returned a resolved status would be deciding the approval it was asked to route, which is the
 * one thing this seam exists to keep out of an extension's hands — the answer arrives through the
 * resume surface or it does not arrive.
 */
export function confineApprovalProvider(inner: ApprovalProvider): ApprovalProvider {
  return {
    id: `confined(${inner.id})`,
    async request(request: ApprovalRequest): Promise<ApprovalTicket> {
      const ticket = await inner.request(request);
      if (ticket?.status !== 'pending') {
        throw new SeamConfinementError(
          'ApprovalProvider',
          'request-never-yields-a-decision',
          `the provider returned status '${String(ticket?.status)}' — approval resolves through the resume surface, never here`,
        );
      }
      if (
        typeof ticket.ticketId !== 'string' ||
        ticket.ticketId.length === 0 ||
        ticket.ticketId.length > 200
      ) {
        throw new SeamConfinementError(
          'ApprovalProvider',
          'ticket-is-well-formed',
          `the ticket id is not a 1..200 character string (got '${String(ticket.ticketId)}')`,
        );
      }
      if (typeof ticket.requestedAt !== 'string' || Number.isNaN(Date.parse(ticket.requestedAt))) {
        throw new SeamConfinementError(
          'ApprovalProvider',
          'ticket-is-well-formed',
          `requestedAt '${String(ticket.requestedAt)}' is not a parseable instant`,
        );
      }
      return { ticketId: ticket.ticketId, status: 'pending', requestedAt: ticket.requestedAt };
    },
    cancel(ticketId: string, reason: string): Promise<void> {
      return inner.cancel(ticketId, reason);
    },
  };
}

/**
 * Confine a `WorkforceMemoryProvider` so the recall it returns is BOUNDED and USABLE.
 *
 * The count is clamped to the narrower of the caller's own `limit` and the seam ceiling, in the rank
 * order the provider returned. Clamping rather than refusing is deliberate: the caller already
 * treats recall as elastic and droppable, so a size violation should cost hits, never the turn.
 *
 * A malformed hit is a different thing and IS refused — a non-finite score or a missing id is not an
 * oversized answer, it is an unusable one, and silently dropping it would hide a broken provider
 * behind a shorter list.
 *
 * Precisely: validation runs on the KEPT SLICE, after the clamp. So a malformed hit sitting BEYOND
 * the ceiling is dropped rather than refused, and "a malformed hit is refused" is true of hits inside
 * the ceiling. That ordering is the split applied consistently rather than an oversight — such a hit
 * was an oversized answer before it was an unusable one — but it does mean the guarantee is bounded,
 * and a reader is entitled to know which of the two it gets.
 *
 * What this wrapper does NOT do: neutralize hit TEXT. That belongs to whoever renders it, because
 * the neutralization has to match the document being rendered into; the workforce turn assembler
 * does it at `packages/kernel/workforce-tools/src/context.ts:581`.
 */
export function confineMemoryProvider(inner: WorkforceMemoryProvider): WorkforceMemoryProvider {
  return {
    id: `confined(${inner.id})`,
    async search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
      const hits = await inner.search(query);
      if (!Array.isArray(hits)) {
        throw new SeamConfinementError(
          'WorkforceMemoryProvider',
          'search-yields-a-bounded-list',
          `the provider returned ${typeof hits} rather than an array of hits`,
        );
      }
      const ceiling =
        query.limit === undefined || query.limit > SEAM_MAX_MEMORY_HITS
          ? SEAM_MAX_MEMORY_HITS
          : Math.max(0, Math.floor(query.limit));
      const kept = hits.slice(0, ceiling);
      for (const hit of kept) {
        if (typeof hit?.id !== 'string' || hit.id.length === 0) {
          throw new SeamConfinementError(
            'WorkforceMemoryProvider',
            'hits-are-well-formed',
            `a hit carries id '${String(hit?.id)}', which is not a non-empty string`,
          );
        }
        if (typeof hit.text !== 'string') {
          throw new SeamConfinementError(
            'WorkforceMemoryProvider',
            'hits-are-well-formed',
            `hit '${hit.id}' carries ${typeof hit.text} text rather than a string`,
          );
        }
        if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
          throw new SeamConfinementError(
            'WorkforceMemoryProvider',
            'hits-are-well-formed',
            `hit '${hit.id}' carries score '${String(hit.score)}', which is not a finite number`,
          );
        }
      }
      return kept;
    },
    remember(entry) {
      return inner.remember(entry);
    },
  };
}
