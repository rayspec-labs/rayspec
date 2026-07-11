#!/usr/bin/env bash
# From-clean-DB migration forcing-function — the bootstrap-from-empty gate.
#
# WHY THIS EXISTS: the committed platform chain (drizzle/0000..0005) is a *retrofit* — 0000 ALTERs
# runs/journal_steps/conversation_items that the spike created OUTSIDE the migration system. For
# a long time NO path ever applied the chain from empty (tests use makeDbWithSchema + a hand-written
# buildFullSchemaSql; deploy() feeds generated PRODUCT sql into an isolated schema; gate:shadow-dryrun
# applied the chain via psql but did not exercise the real `drizzle-kit migrate` deploy path), so the
# chain silently could NOT bootstrap a clean database — `drizzle-kit migrate` against empty failed at
# `relation "journal_steps" does not exist`. That was the bug. This gate is the forcing-function that
# makes the bug impossible to reintroduce: it provisions a FRESH EMPTY database, applies the FULL
# chain via the REAL apply path a deploy uses (`drizzle-kit migrate`, which exercises drizzle's
# journal ordering + the __drizzle_migrations bookkeeping + the per-migration transaction), then
# asserts the resulting live schema EQUALS schema.ts with ZERO drift. If 0000's self-bootstrapping
# prefix is reverted, `drizzle-kit migrate` exits non-zero here and the gate goes RED — proven by
# reverting the fix.
#
# DISTINCT from gate:shadow-dryrun: shadow-dryrun applies the chain via raw psql (lexical) from EMPTY
# and covers the PRODUCT half; THIS gate uses the real `drizzle-kit migrate` deploy path + a zero-drift
# assertion against schema.ts. This gate alone proves CLEAN-DB BOOTSTRAP via the deploy tool + no drift.
#
# WHAT "ZERO DRIFT" IS PROVEN BY (two independent oracles, both auto-derived from schema.ts):
#   (1) a fail-closed `drizzle-kit push` diff (Step 2) — the auto-derived cross-check, with ONE
#       exact documented benign line subtracted (the scopes array-default quirk, see Step 2);
#   (2) a COMPLETE structural cross-check (Step 3, migrate-clean-assert.ts) — the DETERMINISTIC
#       primary oracle: for all 12 core platform tables it asserts every column (name/type/
#       nullability/DEFAULT/array-element-type), every PRIMARY KEY (ordered cols), every FK
#       (target + ON DELETE, both directions), and every index (name/uniqueness/ORDERED columns/
#       partial-WHERE/expression body, both directions). It carries NO push quirk.
#
# Clean-room: derives the server from DATABASE_URL (fall back to the documented local default),
# creates its OWN throwaway DB (`<db>_migrate_clean`) on that server, and drops it on ANY exit.
# Exits non-zero on the first failed step (set -e + drizzle-kit's own exit) or a drift finding.
set -euo pipefail

# --- derive connection from DATABASE_URL (fall back to the documented local default) -------------
DB_URL="${DATABASE_URL:-postgres://rayspec:rayspec@localhost:5433/rayspec}"

# Parse postgres://user:pass@host:port/dbname  (pass/port optional). Mirrors shadow-dryrun.sh.
proto_stripped="${DB_URL#*://}"
creds="${proto_stripped%@*}"
hostpart="${proto_stripped##*@}"
if [[ "$proto_stripped" != *"@"* ]]; then creds=""; hostpart="$proto_stripped"; fi
PGUSER="${creds%%:*}"
if [[ "$creds" == *":"* ]]; then export PGPASSWORD="${creds#*:}"; fi
hostport="${hostpart%%/*}"
BASE_DB="${hostpart##*/}"
BASE_DB="${BASE_DB%%\?*}"
PGHOST="${hostport%%:*}"
if [[ "$hostport" == *":"* ]]; then PGPORT="${hostport##*:}"; else PGPORT=5432; fi
PGUSER="${PGUSER:-rayspec}"

# A dedicated throwaway DB on the same server: a truly EMPTY clean room (NOT the seeded shadow DB).
CLEAN_DB="${BASE_DB}_migrate_clean"
CLEAN_URL="postgres://${PGUSER}${PGPASSWORD:+:$PGPASSWORD}@${PGHOST}:${PGPORT}/${CLEAN_DB}"
DB_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"

psql() { command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 -P pager=off "$@"; }

# Drop the throwaway on ANY exit (FORCE terminates lingering backends so the DROP cannot itself
# fail). Errors swallowed so the trap never masks the script's real exit code.
cleanup() { command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -P pager=off -d postgres \
  -c "DROP DATABASE IF EXISTS $CLEAN_DB WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== target server: $PGUSER@$PGHOST:$PGPORT (from DATABASE_URL); FRESH EMPTY DB: $CLEAN_DB =="
psql -d postgres -c "DROP DATABASE IF EXISTS $CLEAN_DB WITH (FORCE);" >/dev/null
psql -d postgres -c "CREATE DATABASE $CLEAN_DB OWNER $PGUSER;" >/dev/null

# --- Step 1: APPLY THE FULL CHAIN VIA THE REAL DEPLOY PATH -----------------------------------------
# `drizzle-kit migrate` is exactly what a real deploy runs. It reads drizzle/meta/_journal.json,
# applies each pending migration (in idx order) in its own transaction, records the hash in
# drizzle.__drizzle_migrations, and exits non-zero if any migration's SQL fails. On a fresh empty DB
# this is the bootstrap a deploy performs. If 0000 is not self-bootstrapping, THIS step fails.
echo "== applying the FULL committed chain via 'drizzle-kit migrate' against the empty DB =="
( cd "$DB_PKG_DIR" && DATABASE_URL="$CLEAN_URL" pnpm exec drizzle-kit migrate )
echo "  ok: drizzle-kit migrate succeeded (chain bootstraps from empty)."

# Sanity: every committed migration is recorded as applied (no silent skip — guards the drizzle
# `when` high-water-mark skip bug; the chain's `when` values are monotonic, asserted by shadow-dryrun).
APPLIED="$(psql -d "$CLEAN_DB" -tA -c "SELECT count(*) FROM drizzle.__drizzle_migrations;")"
JOURNAL_COUNT="$(node -e 'console.log(require("'"$DB_PKG_DIR"'/drizzle/meta/_journal.json").entries.length)')"
if [[ "$APPLIED" != "$JOURNAL_COUNT" ]]; then
  echo "MIGRATE-CLEAN: FAIL — applied $APPLIED migration(s) but the journal lists $JOURNAL_COUNT (a migration was SILENTLY SKIPPED — drizzle 'when' high-water-mark?)." >&2
  exit 1
fi
echo "  ok: all $APPLIED journal migrations recorded as applied in __drizzle_migrations."

# --- Step 2: ZERO-DRIFT ORACLE (auto-derived from schema.ts via drizzle-kit push) -----------------
# `drizzle-kit push` PULLs the live schema and diffs it against schema.ts (the SAME schema-as-code the
# migrations are meant to realize), printing the statements it WOULD run to converge. Run WITHOUT
# --force + no TTY: it lists the pending statements then refuses to apply (it does NOT mutate the DB),
# so it is a non-mutating diff oracle that tracks schema.ts automatically and cannot rot.
#
# DOC-FIRST (drizzle-kit 0.31.10, re-verified empirically). push prints,
# after `Reading config`/`Using ... driver`:
#   - `[✓] Pulling schema from database...`   <- POSITIVE signal push connected + reached the diff;
#   - then EITHER `[i] No changes detected` (genuine zero drift, exit 0)
#     OR ` Warning  You are about to execute current statements:` + the pending DDL lines + a TTY
#        `Error: Interactive prompts require a TTY ...` (push refuses to apply without a TTY; exit 0).
# A CRASH (e.g. bad host) prints NEITHER `[✓] Pulling schema` NOR `No changes`/`Warning`, and exits 1.
# push's EXIT CODE is therefore NOT a drift signal (0 whether or not there are pending statements), so
# we FAIL CLOSED on a POSITIVE signal, never infer green from an empty grep:
#   green  <- push exited 0 AND printed `[✓] Pulling schema` AND (`No changes detected`
#             OR the ONLY DDL under the Warning banner is the one exact benign scopes line);
#   RED    <- push exited non-zero, OR `[✓] Pulling schema` is absent (crash/format change),
#             OR any non-benign DDL line is present.
#
# KNOWN BENIGN NOISE (the ONLY subtracted line): push ALWAYS re-emits the EXACT statement
# `ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT '{}';` because it does not recognise the
# live `'{}'::text[]` default (created by 0000) as equal to schema.ts's `.default([])` — an
# array-default normalization quirk that never converges (proven: it re-emits even on a DB pushed
# straight from schema.ts). It is purely cosmetic (the live default IS '{}'). We subtract it by an
# EXACT FULL-LINE match (value '{}' INCLUDED) — so a WRONG-value SET DEFAULT (e.g. '{read}') survives
# as drift — and FAIL on any other line. (Step 3 additionally asserts the scopes DEFAULT value
# structurally, so this benign line is also positively verified there, not merely waved through.)
echo "== zero-drift oracle (fail-closed): 'drizzle-kit push' diff of the migrated DB vs schema.ts =="
PUSH_LOG="$(mktemp)"
PUSH_EXIT=0
( cd "$DB_PKG_DIR" && DATABASE_URL="$CLEAN_URL" pnpm exec drizzle-kit push >"$PUSH_LOG" 2>&1 </dev/null ) || PUSH_EXIT=$?
PUSH_CLEAN="$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' "$PUSH_LOG")"
rm -f "$PUSH_LOG"
# FAIL CLOSED: push must have exited 0 AND reached the diff stage (positive pull-completed signal).
if [[ "$PUSH_EXIT" -ne 0 ]] || ! grep -qF 'Pulling schema from database' <<<"$PUSH_CLEAN"; then
  echo "MIGRATE-CLEAN: FAIL — 'drizzle-kit push' did NOT complete its schema pull (exit $PUSH_EXIT) — failing CLOSED (a crashed/errored push is NOT zero drift). push output:" >&2
  echo "$PUSH_CLEAN" | sed 's/^/    /' >&2
  exit 1
fi
# Pending DDL lines push printed under the "about to execute" banner. Case-INSENSITIVE: drizzle also
# emits lowercase data-loss preamble (e.g. `truncate table ... cascade;` / `delete from ...`).
DRIFT_STMTS="$(grep -iE '^[[:space:]]*(ALTER|CREATE|DROP|ADD|RENAME|TRUNCATE|DELETE|INSERT|UPDATE)[[:space:]]' <<<"$PUSH_CLEAN" \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -vxF $'ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT \'{}\';' \
  || true)"
if [[ -n "$DRIFT_STMTS" ]]; then
  echo "MIGRATE-CLEAN: FAIL — the migrated DB DRIFTS from schema.ts. push would still run:" >&2
  echo "$DRIFT_STMTS" | sed 's/^/    /' >&2
  exit 1
fi
# Positive confirmation: EITHER push declared no changes, OR the only pending line was the benign one.
if grep -qF 'No changes detected' <<<"$PUSH_CLEAN"; then
  echo "  ok: push reports 'No changes detected' (zero drift)."
else
  echo "  ok: push reports ZERO real drift (only the one documented exact benign scopes line)."
fi

# --- Step 3: COMPLETE STRUCTURAL CROSS-CHECK (the DETERMINISTIC primary oracle, push-quirk-free) ---
# A node helper introspects the live DB and asserts, for EVERY core platform table (auto-derived from
# the Drizzle table objects via getTableConfig, so it cannot rot): every column (name + type +
# nullability + DEFAULT + array element type), every PRIMARY KEY (ordered columns), every FK (target +
# ON DELETE), and every index (name + uniqueness + ORDERED columns + partial-WHERE + expression body).
# Both directions (an EXTRA column/FK/index in the DB but not schema.ts also fails). This is the
# push-quirk-free oracle that bites DETERMINISTICALLY on drift (e.g. the conv_* indexes fixed by the self-bootstrapping 0000,
# an index column re-key, a wrong column default).
echo "== complete structural cross-check (information_schema/pg_catalog vs schema.ts) =="
( cd "$DB_PKG_DIR" && MIGRATE_CLEAN_URL="$CLEAN_URL" pnpm exec tsx scripts/migrate-clean-assert.ts )

echo "== drop the throwaway clean DB =="
psql -d postgres -c "DROP DATABASE IF EXISTS $CLEAN_DB WITH (FORCE);" >/dev/null
echo "MIGRATE-CLEAN: PASS — the committed chain bootstraps a clean DB and equals schema.ts (zero drift)."
