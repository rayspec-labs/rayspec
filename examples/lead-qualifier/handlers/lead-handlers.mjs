/**
 * Escape-hatch handlers for the lead-qualifier backend — the ingress ROUTE handler that enqueues the
 * qualify run, and the TOOL handler the agent calls to record its verdict.
 *
 * Self-contained native ESM (NO imports): the engine injects the tenant-bound HandlerInit and the
 * handlers return neutral data. Kept import-free on purpose so the module loads through the REAL
 * path-jailed handler loader in BOTH vitest AND a plain `node`/`tsx` boot — which is exactly the
 * property this example proves: the shipped entrypoint boots the backend directly, handlers and all.
 * (`@rayspec/handler-sdk` is a workspace package; it does not resolve from a plain `.mjs` under
 * examples/, so the enriched-response BRAND is inlined below rather than imported — the same
 * zero-import shape the platform's own boot fixtures use.)
 */

/**
 * The reserved brand key the engine's `isHttpResponse` discriminator checks (see
 * `@rayspec/handler-sdk`'s `HTTP_RESPONSE_BRAND`). A route handler returns a plain object for a 200,
 * or this branded envelope to choose the status / headers. Inlined here (single literal) because the
 * SDK does not resolve from a plain example `.mjs`; the value is a stable part of the route contract.
 */
const HTTP_RESPONSE_BRAND = '__rayspecHttpResponse';

/** Build the enriched route response envelope (status + JSON body). */
function httpResponse({ status, headers, body }) {
  return {
    [HTTP_RESPONSE_BRAND]: true,
    ...(status !== undefined ? { status } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * INGRESS route handler (kind: route) for `POST /leads`.
 *
 * Runs INSIDE the engine's tenant-scoped transaction. It inserts the inbound lead as `unqualified`,
 * then ENQUEUES a durable `qualifier` run for it (the agent runs OFF-REQUEST on the durable worker),
 * and returns 201 with the created lead's id + the enqueued run id. `init.enqueue` is tenant-bound by
 * construction — the run inherits THIS request's server-derived tenant, so the qualify run and its
 * persist tool can only ever touch this tenant's data.
 *
 * @param {{
 *   body?: unknown,
 *   db: { insert: (store: string, values: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   enqueue?: (req: { agentId: string, input: string }) => Promise<{ runId: string }>,
 * }} init
 */
export async function ingestLead(init) {
  // The request body is UNTRUSTED caller DATA — validate the shape fail-closed (a route handler owns
  // its own body validation; a bad payload is a 400, never a persisted half-row).
  const body = /** @type {Record<string, unknown>} */ (
    init.body && typeof init.body === 'object' ? init.body : {}
  );
  const company = typeof body.company === 'string' ? body.company.trim() : '';
  const contactEmail = typeof body.contact_email === 'string' ? body.contact_email.trim() : '';
  const message = typeof body.message === 'string' ? body.message : '';
  const headcount =
    typeof body.headcount === 'number' && Number.isFinite(body.headcount)
      ? Math.trunc(body.headcount)
      : Number.NaN;
  if (!company || !contactEmail || !message || Number.isNaN(headcount) || headcount < 0) {
    return httpResponse({
      status: 400,
      body: {
        error: 'invalid_lead',
        detail:
          'company, contact_email, message (strings) and headcount (a non-negative number) are required.',
      },
    });
  }

  // Fail-closed: the qualify run is enqueued onto the durable worker, so the deployment MUST declare
  // `deployment.durableWorker: true` (else `init.enqueue` is absent). Never a silent no-op.
  if (!init.enqueue) {
    throw new Error(
      'ingest_lead: init.enqueue is unavailable (no durable worker wired) — declare ' +
        'deployment.durableWorker:true. Fail-closed.',
    );
  }

  // Insert the lead as `unqualified`; the injected id/tenant_id/created_at are auto-stamped by the
  // tenant-bound facade. The verdict columns stay null until the agent's tool records them.
  const lead = await init.db.insert('leads', {
    company,
    contact_email: contactEmail,
    message,
    headcount,
    status: 'unqualified',
  });

  // Enqueue the durable `qualifier` run, handing it the created lead (including its id) as JSON input.
  // The agent reads the lead, classifies it, and calls save_qualification with the lead's id.
  const { runId } = await init.enqueue({
    agentId: 'qualifier',
    input: JSON.stringify(lead),
  });

  return httpResponse({
    status: 201,
    headers: { Location: `/leads/${String(lead.id)}` },
    body: { id: String(lead.id), status: 'unqualified', run_id: runId },
  });
}

/**
 * TOOL handler (kind: tool) for `save_qualification` — the agent calls this to RECORD its verdict.
 *
 * `args` are the model-supplied, schema-validated tool arguments (the qualify contract); the return
 * is neutral data validated against the tool's `outputSchema`. It updates the lead BY ID (tenant-
 * scoped by the facade), writing the verdict columns and flipping `status` to `qualified`. Idempotent:
 * re-running with the same args converges on the same row. `qualified_at` is set as an ISO string —
 * the facade coerces it to the timestamp column's Date.
 *
 * @param {{ lead_id: string, tier: string, fit_score: number, owning_queue: string, rationale: string }} args
 * @param {{ db: { update: (store: string, filter: Record<string, unknown>, patch: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> } }} init
 * @returns {Promise<{ lead_id: string, status: string }>}
 */
export async function saveQualification(args, init) {
  const updated = await init.db.update(
    'leads',
    { id: args.lead_id },
    {
      tier: args.tier,
      fit_score: args.fit_score,
      owning_queue: args.owning_queue,
      rationale: args.rationale,
      status: 'qualified',
      qualified_at: new Date().toISOString(),
    },
  );
  const row = updated[0];
  if (!row) {
    // The lead does not exist for this tenant (a bad lead_id, or a cross-tenant id the structural
    // predicate made invisible). Fail loudly rather than silently recording nothing.
    throw new Error(
      `save_qualification: lead '${String(args.lead_id)}' not found for this tenant.`,
    );
  }
  return { lead_id: String(row.id), status: String(row.status) };
}
