#!/usr/bin/env bash
# Shadow-DB dry-run for the platform migration chain — the post-scan gate step.
#
# Proves the reviewed chain APPLIES cleanly statement-by-statement (via psql, stripping Drizzle's
# --> statement-breakpoint markers) and reaches the intended end state. The destructive-scan gate
# (pnpm gate:migrations) only READS the SQL; this step is the "scan -> shadow-DB dry-run" chain the
# exit-gate advertises: scan != apply. It also covers the PRODUCT half (the throwaway-generated
# product migration + generic tenancy/cascade invariants) — see the product section below.
#
# 0000 is now SELF-BOOTSTRAPPING (it CREATEs the three run tables in their
# authentic spike pre-state before retrofitting them), so this script NO LONGER pre-seeds them —
# doing so would collide with `relation "journal_steps" already exists`. The chain is applied against
# a TRULY EMPTY DB here. (The REAL deploy apply path — `drizzle-kit migrate` from empty + a zero-drift
# assertion against schema.ts — is the SEPARATE, stronger gate:migrate-clean forcing-function; this
# script remains the lexical per-statement apply + end-state + FK-cascade + PRODUCT-half coverage.)
#
# Clean-room + self-contained: it does NOT reuse whatever happens to be in the shared shadow DB.
# It derives the server from SHADOW_DATABASE_URL (so CI and local both target the right Postgres)
# and creates its OWN throwaway DB (`<shadow-db>_dryrun`) on that server, applies the whole chain,
# then ASSERTS the end state and drops the throwaway DB.
#
# Exits non-zero on the first failed step (set -e + ON_ERROR_STOP) or failed assertion, so it is
# a real CI gate. Runnable locally against the existing rayspec_shadow server with no setup.
set -euo pipefail

# --- derive connection from SHADOW_DATABASE_URL (fall back to the documented local defaults) ---
SHADOW_URL="${SHADOW_DATABASE_URL:-postgres://rayspec:rayspec@localhost:5433/rayspec_shadow}"

# Parse postgres://user:pass@host:port/dbname  (pass/port optional).
proto_stripped="${SHADOW_URL#*://}"
creds="${proto_stripped%@*}"      # user:pass  (or just user if no @ ... handled below)
hostpart="${proto_stripped##*@}"  # host:port/db
if [[ "$proto_stripped" != *"@"* ]]; then creds=""; hostpart="$proto_stripped"; fi
PGUSER="${creds%%:*}"
if [[ "$creds" == *":"* ]]; then export PGPASSWORD="${creds#*:}"; fi
hostport="${hostpart%%/*}"
SHADOW_DB="${hostpart##*/}"
SHADOW_DB="${SHADOW_DB%%\?*}"     # strip any ?query suffix
PGHOST="${hostport%%:*}"
if [[ "$hostport" == *":"* ]]; then PGPORT="${hostport##*:}"; else PGPORT=5432; fi
PGUSER="${PGUSER:-rayspec}"

# A dedicated throwaway DB on the same server so we neither pollute nor depend on shadow state.
DRYRUN_DB="${SHADOW_DB}_dryrun"
MIGRATION_DIR="$(cd "$(dirname "$0")/../drizzle" && pwd)"

psql() { command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 -P pager=off "$@"; }

# Clean-room on ANY exit: a failed assertion (set -e) used to leave <shadow>_dryrun behind,
# breaking the next re-run. Drop it unconditionally on EXIT (FORCE terminates any lingering
# backend so the DROP cannot itself fail and re-trip the trap). The success path still drops it
# explicitly below; this trap is the safety net for the failure path. Errors here are swallowed
# so the trap never masks the script's real exit code.
cleanup() { command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -P pager=off -d postgres \
  -c "DROP DATABASE IF EXISTS $DRYRUN_DB WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# scalar(query) -> trimmed single value (for assertions).
scalar() { psql -d "$DRYRUN_DB" -tA -c "$1"; }
# assert "<expected>" "<query>" "<label>"
assert_eq() {
  local expected="$1" query="$2" label="$3" got
  got="$(scalar "$query")"
  if [[ "$got" != "$expected" ]]; then
    echo "SHADOW DRY-RUN: FAIL — $label: expected [$expected], got [$got]" >&2
    exit 1
  fi
  echo "  ok: $label = $got"
}

echo "== target server: $PGUSER@$PGHOST:$PGPORT (from SHADOW_DATABASE_URL); throwaway DB: $DRYRUN_DB =="
psql -d postgres -c "DROP DATABASE IF EXISTS $DRYRUN_DB;" >/dev/null
psql -d postgres -c "CREATE DATABASE $DRYRUN_DB OWNER $PGUSER;" >/dev/null

# NO pre-seed. 0000 is now self-bootstrapping (it CREATEs runs/journal_steps/
# conversation_items in their authentic spike pre-state, then retrofits them), so the chain is
# applied against a truly EMPTY DB. Pre-seeding the run tables here would collide ("relation already
# exists"). The retrofit's TRUNCATE is a no-op on the freshly-created empty tables; the end-state
# assertions below still prove the text->uuid retrofit + FK + UNIQUE re-key landed.
# HONESTY: with the self-bootstrapping 0000, the TRUNCATE + text->uuid cast now ALWAYS run
# on freshly-created EMPTY tables on the only live bootstrap path — the historical "non-castable spike
# tenant_id" data path (a spike row whose arbitrary text tenant_id could not cast to uuid) CANNOT
# recur, so we do NOT re-add a probe for that dead path (the original concern is now structurally moot).

# JOURNAL `when` MONOTONICITY GUARD. Drizzle's migrator gates each migration's
# apply on `Number(lastDbMigration.created_at) < migration.folderMillis` (folderMillis = the journal
# `when`). A migration whose `when` is EARLIER than an already-applied one is SILENTLY SKIPPED on an
# incremental deploy (the cost columns would never be created -> runtime failure). This lexical-from-
# empty apply CANNOT catch that (it applies every file regardless of `when`), so assert monotonicity
# of `when` (strictly increasing with idx) directly against meta/_journal.json before the apply.
echo "== ASSERT journal \`when\` is strictly monotonic with idx (drizzle incremental-skip guard) =="
node -e '
  const j = require("'"$MIGRATION_DIR"'/meta/_journal.json");
  const es = [...j.entries].sort((a,b)=>a.idx-b.idx);
  for (let i=1;i<es.length;i++){
    if (!(es[i].when > es[i-1].when)) {
      console.error(`SHADOW DRY-RUN: FAIL — journal when NOT monotonic: idx ${es[i-1].idx} (when ${es[i-1].when}) >= idx ${es[i].idx} (when ${es[i].when}) — drizzle would SILENTLY SKIP ${es[i].tag} on a DB already at ${es[i-1].tag}`);
      process.exit(1);
    }
  }
  console.log(`  ok: journal when monotonic across ${es.length} migrations (idx ${es[0].idx}..${es[es.length-1].idx})`);
'

echo "== apply the FULL reviewed migration CHAIN, DYNAMICALLY discovered from meta/_journal.json =="
# The chain is no longer a hard-coded 0000..0005 glob — it is DISCOVERED
# from the journal (in idx order) so a NEW core migration is exercised automatically (and a *.sql
# file with no journal entry, or vice versa, is caught below). Each migration runs in its OWN
# all-or-nothing transaction (mirrors Drizzle), in journal idx order. Drizzle separates statements
# with '--> statement-breakpoint'; strip the markers and run. Keeps the full-chain coverage (every
# migration in the chain runs, not just 0000).
CHAIN_TAGS="$(node -e '
  const j = require("'"$MIGRATION_DIR"'/meta/_journal.json");
  for (const e of [...j.entries].sort((a,b)=>a.idx-b.idx)) console.log(e.tag);
')"
# Cross-check: the set of journal tags must equal the set of *.sql basenames (no orphan file / entry).
SQL_BASENAMES="$(cd "$MIGRATION_DIR" && for f in [0-9]*.sql; do echo "${f%.sql}"; done | sort)"
JOURNAL_SORTED="$(echo "$CHAIN_TAGS" | sort)"
if [[ "$SQL_BASENAMES" != "$JOURNAL_SORTED" ]]; then
  echo "SHADOW DRY-RUN: FAIL — journal tags != drizzle/*.sql basenames (orphan migration or entry):" >&2
  echo "  *.sql:    $(echo "$SQL_BASENAMES" | tr '\n' ' ')" >&2
  echo "  journal:  $(echo "$JOURNAL_SORTED" | tr '\n' ' ')" >&2
  exit 1
fi
COUNT=0
while IFS= read -r TAG; do
  [[ -z "$TAG" ]] && continue
  MIGRATION_FILE="$MIGRATION_DIR/$TAG.sql"
  if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo "SHADOW DRY-RUN: FAIL — journal references missing migration file $TAG.sql" >&2
    exit 1
  fi
  echo "  applying $(basename "$MIGRATION_FILE") ..."
  sed 's#--> statement-breakpoint##g' "$MIGRATION_FILE" | psql -d "$DRYRUN_DB" -1 >/dev/null
  COUNT=$((COUNT + 1))
done <<< "$CHAIN_TAGS"
echo "full migration chain applied cleanly ($COUNT migrations, each in its own transaction, journal order)."

echo "== ASSERT end state =="
# tenant_id is now uuid on all three run tables (the text->uuid USING-cast landed).
assert_eq "3" \
  "SELECT count(*) FROM information_schema.columns WHERE column_name='tenant_id' AND data_type='uuid' AND table_schema='public' AND table_name IN ('journal_steps','conversation_items','runs');" \
  "tenant_id is uuid on all 3 run tables"
# Post-apply the run tables are empty (chain bootstrapped from empty + the retrofit's TRUNCATE is a
# no-op on the freshly-created tables). The non-vacuous FK-cascade assertions below exercise real rows.
assert_eq "0" "SELECT count(*) FROM runs;" "runs empty post-apply"
assert_eq "0" "SELECT count(*) FROM journal_steps;" "journal_steps empty post-apply"
# The orgs FK exists on journal_steps.
assert_eq "1" \
  "SELECT count(*) FROM pg_constraint WHERE conname='journal_steps_tenant_id_orgs_id_fk';" \
  "journal_steps -> orgs FK exists"
# The replay index is UNIQUE and keyed on (tenant_id, run_id, idempotency_key).
assert_eq "1" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='journal_idem_idx' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(tenant_id, run_id, idempotency_key)%';" \
  "journal_idem_idx is UNIQUE(tenant_id, run_id, idempotency_key)"
# All six identity tables exist.
assert_eq "6" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('orgs','users','memberships','sessions','api_keys','auth_audit');" \
  "all 6 identity tables exist"

echo "== ASSERT 0001/0002/0003 end state (the rest of the chain actually ran) =="
# 0001 created oidc_models + idempotency_keys.
assert_eq "2" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('oidc_models','idempotency_keys');" \
  "0001 created oidc_models + idempotency_keys"
# 0002 added sessions.revoked_reason.
assert_eq "1" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name='revoked_reason';" \
  "0002 added sessions.revoked_reason"
# 0003 — conversation_items ConvPart end state: the four additive columns are present.
assert_eq "4" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='conversation_items' AND column_name IN ('turn_index','kind','tool_call_id','payload');" \
  "0003 added conversation_items turn_index/kind/tool_call_id/payload"
# 0003 — legacy `content` is now NULLABLE (a part row writes payload + leaves content null).
assert_eq "YES" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='conversation_items' AND column_name='content';" \
  "0003 relaxed conversation_items.content to NULLABLE"
# 0003 — a part row (payload set, content/name null) INSERTS cleanly (the real write path).
psql -d "$DRYRUN_DB" >/dev/null <<'SQL'
INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-0000-0000-0000000000d1', 'PartOrg', 'partorg');
INSERT INTO conversation_items (run_id, tenant_id, seq, turn_index, role, kind, tool_call_id, payload)
VALUES ('r-part', '00000000-0000-0000-0000-0000000000d1', 0, 0, 'assistant', 'tool_call', 'tc-1',
        '{"kind":"tool_call","toolCallId":"tc-1","name":"lookup","args":{}}'::jsonb);
SQL
assert_eq "1" \
  "SELECT count(*) FROM conversation_items WHERE run_id='r-part' AND content IS NULL AND payload IS NOT NULL;" \
  "0003 part row (payload set, content null) inserts cleanly"

echo "== ASSERT 0004 end state (run_events durable event log) =="
# 0004 created the run_events table.
assert_eq "1" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='run_events';" \
  "0004 created run_events"
# Its tenant_id is uuid (the chokepoint predicate column) + data/seq/type present.
assert_eq "1" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='run_events' AND column_name='tenant_id' AND data_type='uuid';" \
  "run_events.tenant_id is uuid"
assert_eq "3" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='run_events' AND column_name IN ('seq','type','data');" \
  "run_events has seq/type/data"
# The orgs FK exists (so a GDPR org-delete cascades run events).
assert_eq "1" \
  "SELECT count(*) FROM pg_constraint WHERE conname='run_events_tenant_id_orgs_id_fk';" \
  "run_events -> orgs FK exists"
# UNIQUE(tenant_id, run_id, seq) makes the persist idempotent + one row per (tenant,run,seq).
assert_eq "1" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='run_events_tenant_run_seq_idx' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(tenant_id, run_id, seq)%';" \
  "run_events_tenant_run_seq_idx is UNIQUE(tenant_id, run_id, seq)"
# The (run_id, seq) ordered-replay read index exists.
assert_eq "1" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='run_events_run_seq_idx' AND indexdef ILIKE '%(run_id, seq)%';" \
  "run_events_run_seq_idx on (run_id, seq) exists"

echo "== ASSERT 0005 end state (cost reconciliation + provenance columns) =="
# 0005 added the FIVE cost-reconciliation + provenance columns to journal_steps (incl. pricing_version).
assert_eq "5" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_steps' AND column_name IN ('provider_cost_usd','billed_cost_usd','cost_drift','produced_by','pricing_version');" \
  "0005 added journal_steps provider_cost_usd/billed_cost_usd/cost_drift/produced_by/pricing_version"
# pricing_version is NULLABLE text (the effective-dated entry that computed the step, or 'FALLBACK').
assert_eq "YES" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_steps' AND column_name='pricing_version';" \
  "0005 journal_steps.pricing_version is NULLABLE text"
# provider_cost_usd is NULLABLE (NULL = backend reported no provider cost — never fabricated).
assert_eq "YES" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_steps' AND column_name='provider_cost_usd';" \
  "0005 journal_steps.provider_cost_usd is NULLABLE (null = no provider cost)"
# billed_cost_usd is NOT NULL with a default (subscription runs write 0; api-key runs write computed).
assert_eq "NO" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_steps' AND column_name='billed_cost_usd';" \
  "0005 journal_steps.billed_cost_usd is NOT NULL"
# cost_drift is a boolean.
assert_eq "boolean" \
  "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_steps' AND column_name='cost_drift';" \
  "0005 journal_steps.cost_drift is boolean"
# 0005 added the three roll-up columns to runs.
assert_eq "3" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='runs' AND column_name IN ('provider_cost_usd','billed_cost_usd','cost_drift');" \
  "0005 added runs provider_cost_usd/billed_cost_usd/cost_drift"
# A REAL write through the new columns: a subscription step (billed=0, provider set, drift true,
# KNOWN-model pricing_version) + a FALLBACK-priced step — both insert, and the pricing_version makes
# them DISTINGUISHABLE in the ledger (a fallback step is not silently indistinguishable).
psql -d "$DRYRUN_DB" >/dev/null <<'SQL'
INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-0000-0000-0000000000f5', 'CostOrg', 'costorg');
INSERT INTO journal_steps
  (run_id, tenant_id, backend, type, idempotency_key, input_hash, status, auth_mode,
   cost_usd, provider_cost_usd, billed_cost_usd, cost_drift, produced_by, pricing_version)
VALUES
  ('r-cost', '00000000-0000-0000-0000-0000000000f5', 'anthropic', 'llm', 'k0', 'h0', 'ok',
   'subscription-oauth-official-harness', '0.01', '0.013', '0', true,
   '@anthropic-ai/claude-agent-sdk@0.3.185+adapter-anthropic@p2s4', 'claude-haiku-4-5@2025-10-15'),
  ('r-cost', '00000000-0000-0000-0000-0000000000f5', 'openai', 'llm', 'k1', 'h1', 'ok',
   'api-key', '0.01', NULL, '0.01', false,
   '@openai/agents@0.11.8+adapter-openai', 'FALLBACK');
SQL
assert_eq "1" \
  "SELECT count(*) FROM journal_steps WHERE run_id='r-cost' AND billed_cost_usd='0' AND provider_cost_usd='0.013' AND cost_drift=true AND produced_by IS NOT NULL AND pricing_version='claude-haiku-4-5@2025-10-15';" \
  "0005 subscription step (billed=0, provider set, drift true, provenance+pricing_version set) inserts cleanly"
# The FALLBACK-priced step is DISTINGUISHABLE from the known-priced step by pricing_version.
assert_eq "1" \
  "SELECT count(*) FROM journal_steps WHERE run_id='r-cost' AND pricing_version='FALLBACK';" \
  "0005 a FALLBACK-priced step is distinguishable in the ledger by pricing_version='FALLBACK'"
# Clean up the 0005 cost-row + its org so the journal_steps cascade assertion below starts from 0 rows.
psql -d "$DRYRUN_DB" -c "DELETE FROM orgs WHERE id='00000000-0000-0000-0000-0000000000f5';" >/dev/null

echo "== ASSERT run_events FK CASCADE: deleting an org removes its run_events rows =="
psql -d "$DRYRUN_DB" >/dev/null <<'SQL'
INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-0000-0000-0000000000e1', 'EventsOrg', 'eventsorg');
INSERT INTO run_events (run_id, tenant_id, seq, type, data)
VALUES ('r-ev', '00000000-0000-0000-0000-0000000000e1', 0, 'run_started',
        '{"type":"run_started","runId":"r-ev","seq":0}'::jsonb);
SQL
assert_eq "1" "SELECT count(*) FROM run_events;" "run_events row present before org delete"
psql -d "$DRYRUN_DB" -c "DELETE FROM orgs WHERE id='00000000-0000-0000-0000-0000000000e1';" >/dev/null
assert_eq "0" "SELECT count(*) FROM run_events;" "run_events row cascaded away after org delete"

echo "== ASSERT FK CASCADE: deleting an org removes its journal rows =="
psql -d "$DRYRUN_DB" >/dev/null <<'SQL'
INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-0000-0000-0000000000c1', 'CascadeOrg', 'cascade');
INSERT INTO journal_steps (run_id, tenant_id, backend, type, idempotency_key, input_hash, status, auth_mode)
VALUES ('r', '00000000-0000-0000-0000-0000000000c1', 'openai', 'llm', 'k', 'h', 'ok', 'api-key');
SQL
assert_eq "1" "SELECT count(*) FROM journal_steps;" "row present before org delete"
psql -d "$DRYRUN_DB" -c "DELETE FROM orgs WHERE id='00000000-0000-0000-0000-0000000000c1';" >/dev/null
assert_eq "0" "SELECT count(*) FROM journal_steps;" "row cascaded away after org delete"

# =====================================================================================
# GENERIC, SPEC-DERIVED PRODUCT-TABLE invariants on the THROWAWAY-generated migration.
#
# The PLATFORM chain (applied above) is core-only (binding topology: product-empty baseline), so the
# generic product-table invariants are exercised on a SEPARATE throwaway PRODUCT DB seeded with the
# orgs root + the throwaway's generated product migration (examples/acme-notes-backend/drizzle). The
# node helper (shadow-product-assertions.ts) parses the throwaway spec and asserts, for EVERY product
# table: tenant_id FK -> orgs ON DELETE CASCADE + the cascade actually removes rows + a NON-EMPTY
# (non-vacuous) assertion count. This is the generalized dry-run's product half.
# =====================================================================================
DRYRUN_PRODUCT_DB="${SHADOW_DB}_product_dryrun"
PRODUCT_MIGRATION_DIR="$(cd "$(dirname "$0")/../../../../examples/acme-notes-backend/drizzle" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup_product() { command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -P pager=off -d postgres \
  -c "DROP DATABASE IF EXISTS $DRYRUN_PRODUCT_DB WITH (FORCE);" >/dev/null 2>&1 || true; }
trap 'cleanup; cleanup_product' EXIT

echo "== build the throwaway PRODUCT DB ($DRYRUN_PRODUCT_DB): orgs root + generated product migration =="
psql -d postgres -c "DROP DATABASE IF EXISTS $DRYRUN_PRODUCT_DB;" >/dev/null
psql -d postgres -c "CREATE DATABASE $DRYRUN_PRODUCT_DB OWNER $PGUSER;" >/dev/null
# The orgs cascade root (minimal — the generic product assertions need orgs.id only).
psql -d "$DRYRUN_PRODUCT_DB" >/dev/null <<'SQL'
CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL DEFAULT 'x',
  region text NOT NULL DEFAULT 'eu',
  retention_days integer,
  external_idp_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
SQL
# Apply the THROWAWAY-generated product migration (strip statement-breakpoints, like the chain above).
for PRODUCT_FILE in "$PRODUCT_MIGRATION_DIR"/[0-9]*.sql; do
  echo "  applying product $(basename "$PRODUCT_FILE") ..."
  sed 's#--> statement-breakpoint##g' "$PRODUCT_FILE" | psql -d "$DRYRUN_PRODUCT_DB" -1 >/dev/null
done

echo "== ASSERT generic, spec-derived PRODUCT-table invariants (non-vacuous; FK+cascade per table) =="
PRODUCT_URL="postgres://$PGUSER${PGPASSWORD:+:$PGPASSWORD}@$PGHOST:$PGPORT/$DRYRUN_PRODUCT_DB"
DRYRUN_PRODUCT_URL="$PRODUCT_URL" npx tsx "$SCRIPT_DIR/shadow-product-assertions.ts"

echo "== drop the throwaway dry-run DBs =="
psql -d postgres -c "DROP DATABASE IF EXISTS $DRYRUN_DB;" >/dev/null
psql -d postgres -c "DROP DATABASE IF EXISTS $DRYRUN_PRODUCT_DB;" >/dev/null
echo "SHADOW DRY-RUN: PASS"
