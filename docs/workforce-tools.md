# Workforce tools

The native toolsets a workforce employee runs with — injected by ROLE at dispatch, beside the
agent tools its declared `agents[]` entry carries. Natives are runtime-provided: they are not
declarable in `tooling:`, they cannot be redeclared (an agent tool named after a native is
refused at validation — `reserved_tool_name` — and again at dispatch composition), and they are
never inherited through delegation: a child task's turn gets exactly its own role's natives plus
its own agent's declared tools, full stop.

**EXPERIMENTAL**, like the section that declares the employees
(`RAYSPEC_EXPERIMENTAL_WORKFORCE`).

## Toolsets by role

A role determines which native toolset a seat STARTS from. It is not the only input: the TASK
narrows the set too — a task dispatched to decide a review does not carry `request_review` (an
independent review of a review is an unbounded chain, refused), and role also gates the
server-derived classification journaling (decision seats only) and the structured-output result
check. So a seat's effective tools are its role's set, minus what the task withholds. The four
role sets:

The orchestrator toolset is: `create_task`, `delegate_task`, `request_review`,
`request_approval`, `submit_result`, `report_failure`, `cancel_task`, `get_workforce_state`,
`get_task`, `list_open_tasks`, `send_message`.

The manager toolset is: `get_task`, `create_subtask`, `delegate_task`, `request_review`,
`request_approval`, `submit_result`, `report_failure`, `escalate`, `list_department_tasks`,
`send_message`, `submit_review`.

The worker toolset is: `get_task`, `submit_result`, `report_failure`, `request_clarification`,
`request_review`, `escalate`, `send_message`.

The reviewer toolset is: `get_task`, `submit_result`, `report_failure`,
`request_clarification`, `request_review`, `escalate`, `send_message`, `submit_review`.

Read tools (`get_task`, `get_workforce_state`, `list_open_tasks`, `list_department_tasks`)
answer from a bounded, role-gated snapshot built once before the run — an orchestrator sees its
subtree page and the workforce state view, a manager its subtree and department, a reviewer
additionally the work under review — and nothing a tool call says can widen that visibility.
`send_message` and the create tools buffer; they do not end the turn.

## Turn-ending tools

Exactly ONE turn-ending tool may be called per turn — emission order is the order of record, and
a second ending is a typed tool error with the first intent standing. The turn-ending tools are:
`cancel_task`, `delegate_task`, `escalate`, `report_failure`, `request_approval`,
`request_clarification`, `request_review`, `submit_result`, `submit_review`.

A turn that attempts an ending the dispatch layer REFUSES (arguments outside the tool's schema)
takes the declared fate — one typed re-queue, then `failed` — rather than silently yielding; the
transcript is how the runtime knows an ending was attempted, and the check normalizes the
recorded tool name because adapters disagree on it (one records the bridged
`mcp__rayspec__<tool>` form verbatim; the others record the neutral name).

`request_approval` carries one refusal beyond its schema: a decision this task already holds a
human answer to (`approved` or `rejected`) may not be asked again. A genuinely different question
still parks, and the rows the timeout chain leaves behind (`timed_out`, `escalated`) carry no
answer and block nothing — the cap is on repeating a settled decision, not on asking for one.
The tool refuses first, so a seat that hits it can still end the turn a different way; the engine
refuses independently, so no caller escapes it.

Identity is the question with surrounding and repeated whitespace collapsed and case folded — a
string comparison, with both of that method's failures. A REWORDED question counts as a new decision
and is not capped. **And the mirror, which matters more when authoring prompts: two genuinely
different authorizations that share one question string are treated as one, and a seat that re-asks
rather than rephrasing loses its task to the tool-error fate.** So write approval questions that
name their subject — "Proceed?" asked twice about different things is one decision here, while
"Proceed with the migration?" and "Proceed with the announcement?" are two. See
`docs/workforce-architecture.md` → "Parks and their exits" for why the cap keys on the question at
all.

A delegation may declare its children's `priority` (the closed `low`–`urgent` set): dispatch
ordering within the tenant honors it, deliberately — urgency is part of what a hand-off says —
and it steers ORDER only, inside the same budgets and ceilings as everything else; a self-styled
urgent child can never out-spend or out-count its scopes.

Every linkage a model must not choose is injected by the trusted layer, never read from
arguments: the review id a verdict targets comes from the parent's park binding, the escalation
target from the declared reporting edge, the approval window and fate from the policy matching the
employee's declared labels. Arguments carrying a forged linkage are refused at the schema.

## The structured result

`submit_result` carries the one result contract, so an orchestrator reasons over its
subordinates' work instead of parsing prose. The structured result fields are: `status`,
`summary`, `findings`, `recommendations`, `artifacts`, `confidence`, `needsFollowUp`,
`suggestedFollowUp`.

- `status` is a closed enum: `completed`, `partial`. It is a CAVEAT on an accepted result, never
  a status claim: a `submit_result` completes the task whichever of the two it carries, because
  the engine writes `completed` from the intent and never reads this field. A task that did NOT
  succeed is ended with `report_failure` (below), and a question is asked with
  `request_clarification` — both real endings with real effects on the row.
- `confidence` is REQUIRED, a number in [0, 1] — review policies key on it, and a result
  omitting it fails the schema rather than the rule.
- `artifacts` entries are `{ kind, id, title }` references.

A result that fails the schema NEVER completes the task: the turn ends with a typed tool error,
the task re-queues once with `tool_error` in context, and a second consecutive offense fails it.
Malformed results are not accepted and hoped over — and a schema-refused `submit_result` cannot
be re-read as a different intent, because what crosses to the engine on refusal is a typed
sentinel, never the model's bytes.

When a parent's turn wakes after a fan-out, it receives its children's FULL structured results
keyed by child task id — never summaries, never completion-ordered.

## The failure channel

`report_failure` ends the turn by recording that the task could not be done: the task transitions
`working → failed` through the one status writer, its `message` is stored as the task's result
summary, and the terminal `workforce.task.failed` event carries that summary into the journal.
Nothing picks the task up afterwards — `failed` is terminal, and re-opening finished work means a
new task with `parentTaskId` set.

It exists because the alternative was a lie. A `submit_result` completes the task whatever its
payload says, so before this tool a seat that could not do its work had no ending that recorded
that fact, and its honest explanation was filed under a completed task. The engine has always had
the typed intent and the legal transition; what it lacked was a tool that reached them.

Choosing between the three neighbouring endings:

- **`escalate`** — someone above you may still be able to move this. Your task PARKS and a fresh
  task carries it to your superior. The work continues.
- **`report_failure`** — this task is over and it did not succeed. Terminal, for you and for
  everyone. Use it when no superior, reviewer or human decision changes the outcome.
- **`submit_result` with `status: 'partial'`** — you did some of the job. The task COMPLETES; the
  caveat rides in the result payload for the parent to reason over.

What a failure does to the tasks around it follows the ordinary terminal rules, with no special
case: a parent waiting on a fan-out join is woken when its bound children are terminal, and reads
this child's `failed` status and message in its next turn's child results; a parent parked
`waiting_for_review` on a reviewer that fails is released to `waiting_for_user`, because the park's
only other exit was the verdict that will now never arrive; a parent parked `blocked(escalated)` on
an escalation child that fails receives the escalation reply, carrying the failure's summary; the
opening delegation record settles `failed`. A failed task does not fail its parent — what the parent
does about a failed child is the parent's own decision to take.

Two limits of the ending, stated because a seat reading only the happy path would be misled. Both
are the long-standing behaviour of every route to `failed`, not something this tool introduces:

- **The turn's buffered effects are discarded.** A turn that calls `send_message` (or a create tool)
  and then ends with `report_failure` has those effects dropped — the message is never written and
  the child is never opened. So a note to a human must not be sent this way: put what a human needs
  to read into the `message`, which is what gets stored and journaled.
- **A failure does not cancel the task's own live children.** A task that opened detached children
  with `create_task` and then fails leaves them running; they finish under a `failed` parent and
  wake nobody. Cancel them first with `cancel_task` if they should not continue.

## The escalate contract

`escalate` hands a task up the declared reporting line, with a typed reason from a closed set:
`out_of_scope`, `insufficient_context`, `budget`, `capability_missing`, `policy_conflict`,
`risk`.

1. The escalating task — the caller's own — parks `blocked(escalated)`. It is the only task the
   call moves.
2. A fresh task carries the escalation to the caller's effective superior (`reportsTo`, else the
   department's manager); the target is resolved from the declared edge, never from arguments.
3. The escalating task re-queues when the superior answers, or is cancelled — it never resumes
   on its own. What is ENFORCED is that the chain is FINITE and rooted at the orchestrator: each
   escalation climbs one declared reporting edge, the orchestrator reports to no one (the lint
   requires it), and `escalate` is not in the orchestrator's toolset — so the chain cannot climb
   past that seat. Where it TERMINATES from there is the orchestrator's own turn: it may hand the
   decision to a human with `request_approval`, answer with `submit_result` and end the chain
   itself, or record with `report_failure` that the goal cannot be met. "Always terminates at a
   human" is a choice that seat can make, not a mechanism the runtime imposes.

## See also

- **[Workforce architecture](./workforce-architecture.md)** — the trust boundary these tools
  sit behind.
- **[Workforce events](./workforce-events.md)** — what each ending journals.
- **[Spec reference → workforce](./spec-reference.md#workforce-experimental)** — roles,
  policy labels, and the policies that route these tools' output.
