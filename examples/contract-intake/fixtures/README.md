# Committed sample contracts (SELF-MADE — no internet samples)

- `sample-contract.txt` — a short mutual NDA (counterparty **Nordwind Robotics GmbH**, effective
  2026-05-01, 24-month term, auto-renewal with 30-day notice, German law, no stated value). The
  shared document: the merge-gated deterministic e2e derives its coded fields from it, and the live
  smoke sends it through ONE real gpt-5 call.
- `sample-contract.pdf` — a text-layer DPA (counterparty **Helios Cloud Services AG**, effective
  2026-06-15, 36-month term, Irish law, EUR 50,000.00 stated value) — a DIFFERENT `contract_type`
  than the .txt NDA on purpose, so the catalog-matched retention policy provably comes from a
  different seeded row (privacy-office/6y vs legal-ops/5y — the match is not canned). Generated with
  the deterministic test-support builder
  (`packages/compose/product-yaml/src/test-support/pdf-fixture.ts`), exactly:

  ```js
  buildPdf({
    pages: [
      { text: 'DATA PROCESSING AGREEMENT' },
      { text: 'Helios Cloud Services AG and our company.' },
      { text: 'Effective Date: 2026-06-15' },
      { text: 'Initial Term: 36 months' },
      { text: 'Governing Law: Ireland' },
      { text: 'Total Contract Value (EUR cents): 5000000' },
    ],
  })
  ```

  (One line per page; the parse node joins page texts with a blank line.)

Consumed by `packages/app/server/src/contract-intake-e2e.db.test.ts` (both files, deterministic,
merge-gated) and `packages/app/server/src/contract-intake-live.smoke.db.test.ts` (the .txt, ONE real
gpt-5 call, self-skips without `OPENAI_API_KEY`).
