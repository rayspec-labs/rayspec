/**
 * Untrusted-content trust boundary — the binding security contract, ASSERTED here.
 *
 * Rehydrated history + tool outputs are ATTACKER-CONTROLLED DATA, never INSTRUCTIONS. On the way
 * OUT of the store we:
 *   - read via the TenantDb CHOKEPOINT (one tenant can never rehydrate another's transcript);
 *   - re-validate each stored part payload against the neutral Zod `ConvPart`/`ConvTurn` schema
 *     (a row whose `payload` does not match the neutral shape is DROPPED, not trusted) via the
 *     core `validateConversation` read-path validator;
 *   - take the role from the TRUSTED DB column, NEVER inferred from the content;
 *   - place content into a dedicated typed part — it is NEVER concatenated into the system prompt
 *     (that is the adapter's obligation; a stored 'system' role is coerced to a 'user' data
 *     turn so a prompt-injection row cannot masquerade as a system instruction).
 *
 * The store evolved from flat {role,name,content} items to ConvTurn/ConvPart parts
 * (one row per part, the part as a `jsonb` payload). This function reassembles the part rows into
 * a typed `ConvTurn[]`, validating each payload on read. Adapter authors MUST rehydrate through
 * this function (or honor the same contract): the system prompt is composed ONLY from the trusted
 * AgentSpec.instructions, and rehydrated parts are appended as user/assistant/tool turns.
 */
import { type ConvTurn, validateConversation } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { asc, eq } from 'drizzle-orm';

/** A stored conversation_items row, as the chokepoint select returns it (part shape). */
interface ConvPartRow {
  seq: string;
  turnIndex: string | null;
  role: string;
  kind: string | null;
  toolCallId: string | null;
  payload: unknown;
  // legacy columns (DEPRECATED) — present so a pre-existing flat row still reads back.
  name: string | null;
  content: string | null;
}

/**
 * Rehydrate a run's neutral conversation from the store, tenant-scoped + re-validated. Part rows
 * are read in global `seq` order, grouped into turns by `turnIndex` (using the TRUSTED `role`
 * column), each part payload re-validated on read; rows that fail neutral-shape validation are
 * dropped. A stored 'system' turn is downgraded to 'user' so untrusted content can never re-enter
 * as a system instruction.
 *
 * The grouped, candidate `ConvTurn[]` is run through the core `validateConversation` read-path
 * validator as the FINAL security gate before returning — so a malformed stored payload yields a
 * clean (possibly empty) array, never a trusted-but-malformed turn.
 */
export async function rehydrateConversation(tdb: TenantDb, runId: string): Promise<ConvTurn[]> {
  const rows = (await tdb
    .select(schema.conversationItems)
    .where(eq(schema.conversationItems.runId, runId))
    .orderBy(asc(schema.conversationItems.seq))) as unknown as ConvPartRow[];

  // Group parts into turns, preserving seq order. We build CANDIDATE turns from the trusted role +
  // turnIndex columns and the stored part payloads, then hand the whole thing to the core
  // read-path validator (validateConversation) which drops anything that does not match the
  // neutral shape — the single security gate so this path and any other jsonb-payload reader share
  // exactly one validator.
  const candidateTurns: Array<{ role: string; index: number; parts: unknown[] }> = [];
  // Map turnIndex -> position in candidateTurns so parts of the same turn coalesce in seq order.
  const turnPos = new Map<number, number>();

  for (const row of rows) {
    const trustedRole = coerceRole(row.role);
    // Part rows carry their turn in `turnIndex`. A LEGACY flat row (DEPRECATED) has
    // no turnIndex; it is its OWN one-part turn, so we key it by its global `seq` (preserving the
    // old one-item-per-turn semantics) rather than collapsing all legacy rows into turn 0.
    const turnIndex = row.turnIndex !== null ? Number(row.turnIndex) : Number(row.seq);
    const part = partFromRow(row);
    if (part === undefined) continue; // unreconstructable row -> dropped (not trusted)

    let pos = turnPos.get(turnIndex);
    if (pos === undefined) {
      pos = candidateTurns.length;
      turnPos.set(turnIndex, pos);
      candidateTurns.push({ role: trustedRole, index: turnIndex, parts: [] });
    }
    candidateTurns[pos]?.parts.push(part);
  }

  // FINAL security gate: validate the assembled candidates against the neutral schema. A malformed
  // payload is dropped here, never trusted.
  return validateConversation(candidateTurns);
}

/**
 * Reconstruct a candidate ConvPart from a stored row. Prefer the `payload` jsonb (the
 * canonical part); fall back to the legacy flat {content} as a neutral `text` part so a pre-existing
 * row still reads back. Returns undefined for a row carrying neither.
 */
function partFromRow(row: ConvPartRow): unknown {
  if (row.payload !== null && row.payload !== undefined) return row.payload;
  // Legacy flat-item fallback (DEPRECATED): a {role,content} item becomes a text part.
  if (typeof row.content === 'string') return { kind: 'text', text: row.content };
  return undefined;
}

/**
 * Coerce a stored role to a neutral role from the TRUSTED column. A stored 'system' is downgraded
 * to 'user' (untrusted content must not re-enter as a system instruction); unknown roles default
 * to 'user'.
 */
function coerceRole(role: string): 'user' | 'assistant' | 'tool' {
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'user';
}
