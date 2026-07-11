# PRD — Expense Claim Auto-Coder

> This is the plain-language product brief for `expense-claim.product.yaml`. It is the product-declared
> counterpart of the backend showcase in `examples/expense-claim-coder/`.

## The product

A finance back-office wants to stop hand-coding expense claims. When an employee submits a claim, the
system should automatically assign the right expense **category** and **GL (general-ledger) account
code**, check it against the company's expense policy, persist the coded result, and expose read
endpoints so the finance UI can show a claim and list recent claims.

## Users & jobs

- **Submitter (a service / integration):** POSTs a claim `{ merchant, amount_cents, description,
  incurred_on }` to the ingress endpoint. Re-submitting the same claim id must NOT double-process it.
- **Finance reviewer (read):** GETs a single coded claim, and GETs a paged list of recent claims.

## What happens to a submission (the pipeline)

1. **Ingest** the claim (an authenticated submit; the payload is DATA, never instructions).
2. **Look up** the expense policy catalog (category → GL code → daily limit).
3. **Code** the claim with a single-turn extraction agent: assign one category + its GL code, and a
   policy verdict + short rationale — grounded in the submitted fields and the catalog.
4. **Validate** the coded output has the required fields.
5. **Persist** one coded row per claim (idempotent on the claim id).
6. **Serve** the coded claim (detail) and a paged list.

## Rules & posture

- One category + one GL code per claim; the GL code must come from the catalog.
- Re-submitting the same claim id converges on ONE processing run and ONE stored row (idempotent).
- Reads are GET endpoints; there is no product write/admin endpoint — writes happen only through the
  ingest + workflow.
- LOCAL / single-node / trusted posture (not internet-facing without the separate hardening layer).

## Explicitly out of scope (v1)

- Multi-currency reconciliation, approvals/routing, or any human-approval workflow step.
- A product-declared mutation/admin API (edit/delete a claim) — this product has no write/admin surface.
- Multi-scope persistence (everything is claim/record-scoped).

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| Authenticated submit ingress | capability `record_input` (POST `/records/{record_id}/submit`) |
| Idempotent re-submit | the `record_submitted` event's record-scoped idempotency key |
| Policy catalog lookup | a declared `expense_policies` store + a `store_read` step |
| Auto-code the claim | a single-turn extraction `agent` (`expense_coder`) |
| Validate the coded output | a `validation.check` step |
| Persist one row per claim | a declared `coded_claims` store + a `store_write` UPSERT on `claim_ref` |
| Claim detail + list reads | two GET `views` over `coded_claims` |
