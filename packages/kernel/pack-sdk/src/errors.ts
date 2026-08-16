/**
 * The ERROR half of the contract — the closed vocabulary a pack author can be handed, and the flat
 * envelope that carries it.
 *
 * A pack's fragments are validated by the deployment's own parse pass over the MERGED document, so
 * every way a pack can be wrong is reported as one of these codes — never as a free-form string.
 * The set is CLOSED by construction: a pack author can enumerate what they must handle, write a
 * total switch over it, and be told by the compiler when this surface widens.
 *
 * The pass aggregates the FULL list of violations rather than the first, so a pack that is wrong in
 * three places learns all three in one boot attempt.
 *
 * TWO FAMILIES SHARE THE VOCABULARY. The first group is the backend-document family — the one a
 * pack contributes fragments to, and the only group a pack's own declarations can produce. The
 * second group belongs to the product-document family, which a pack does not write; it is listed
 * because the vocabulary is one closed set and a total switch has to cover it.
 */

/** One closed code. Every parse/lint violation carries exactly one. */
export type PackErrorCode =
  // ── the backend-document family — the codes a pack's own fragments can produce ────────────────
  /** The raw text is not valid YAML. */
  | 'yaml_parse_error'
  /** `version` is missing or is not the supported literal. */
  | 'unsupported_version'
  /** A shape failure that is not a pure unknown-key rejection (wrong type, missing field, bad enum). */
  | 'schema_violation'
  /** An unknown key — the grammar is fail-closed, so any extra key is refused. */
  | 'unknown_field'
  /** The document carries a mapping key literally named `__proto__` (refused anywhere it appears). */
  | 'reserved_document_key'
  /** A referenced pack is not on the deployment at all — nothing is on disk at the entry it resolves to. */
  | 'extension_pack_unavailable'
  /** A referenced pack IS on the deployment and was refused (an entry that did not load — an unbuilt
   * pack, or one missing the dependencies its entry imports — a version skew, a claim collision, …). */
  | 'extension_pack_refused'
  /** A cross-reference names an id that is not declared post-merge (a tool's handler, an agent's tool). */
  | 'dangling_ref'
  /** Two entries in one section share an id/name — including a pack id colliding with a deployment id. */
  | 'duplicate_name'
  /** An agent demands a capability its resolved backend lacks. */
  | 'capability_violation'
  /** An embedded JSON-Schema (tool parameters/output, agent output) failed to compile. */
  | 'invalid_embedded_schema'
  /** A store declares a business column whose name collides with an injected tenancy/GDPR column. */
  | 'reserved_column_name'
  /** A store declares a business column named after a list-query control keyword. */
  | 'reserved_query_keyword'
  /** A store is named after a platform table — its `CREATE TABLE` would collide with the platform's. */
  | 'reserved_store_name'
  /** A static frontend mount's route collides with another mount, a declared route, or a system prefix. */
  | 'frontend_route_collision'
  /** A declared frontend directory does not resolve to a readable directory of built assets. */
  | 'frontend_dir_missing'
  /** The declared stores form a circular foreign-key reference — no CREATE order satisfies every FK. */
  | 'fk_cycle'
  /** An agent declares both tools and an output schema: it would answer in one turn and never call one. */
  | 'agent_output_schema_shortcircuits_tools'
  /** A response projection addresses a column that is not on the response. */
  | 'projection_unknown_column'
  /** A response projection maps two exposed columns onto the same wire field name. */
  | 'projection_collision'
  /** A projection rename target equals the author name of ANOTHER column of the same store. */
  | 'projection_query_shadow'
  // ── the product-document family — a pack writes no such document; listed so a switch stays total ─
  /** Implementation (code/handler/SQL/shell) appears where only product meaning belongs. */
  | 'no_code_in_yaml'
  /** A provider-native payload or provider policy leaked into the provider-neutral executable graph. */
  | 'provider_native_leak'
  /** Reserved (closed-code discipline): capability wiredness is enforced at deploy, not at parse. */
  | 'invalid_capability_status'
  /** A declared contract uses a key/type outside the closed, declarative schema vocabulary. */
  | 'invalid_contract'
  /** A graph string claims prompt/model EXECUTION, which is a runtime concern rather than meaning. */
  | 'prompt_execution_claim'
  /** A graph string claims production EXECUTION. */
  | 'production_execution_claim'
  /** A step's dependency names a step that is not declared before it (a forward or self reference). */
  | 'invalid_dependency_order'
  /** A view declaration violates the view semantics (source/contract conflation, shape, pagination). */
  | 'invalid_view'
  /** A store or store-step declaration violates the store semantics. */
  | 'invalid_store';

/**
 * One fail-closed violation: the closed code, a message written for the author, and — where the
 * violation is IN the document — a JSON path to the exact offending node (dot/bracket notation,
 * e.g. `agents[0].backend`). The path is absent for whole-document failures, where no in-document
 * node applies.
 */
export interface PackError {
  /** The closed code. Branch on this; the message is for humans and is not part of the contract. */
  readonly code: PackErrorCode;
  /** The human-readable explanation. Free text — never parsed. */
  readonly message: string;
  /** JSON path into the document; absent for whole-document failures. */
  readonly path?: string;
}
