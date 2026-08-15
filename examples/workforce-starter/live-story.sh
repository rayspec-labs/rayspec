#!/usr/bin/env bash
# The MANUAL live acceptance path for the workforce starter: run the same story the CI test
# proves deterministically (packages/app/cli/src/workforce-story-e2e.db.test.ts), but on real
# model backends. CI never runs this script — it self-skips without credentials, its transcript
# depends on the model, and watching the same document run on a real backend is exactly what it
# exists for.
#
# Requirements: a reachable Postgres (DATABASE_URL), OPENAI_API_KEY (every agent in the starter
# binds the one backend on purpose), a built repo (pnpm build), and the usual boot secrets
# (RAYSPEC_API_KEY_PEPPER, RAYSPEC_JWT_SIGNING_KEY) in the environment or .env.
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ -z "${OPENAI_API_KEY:-}" || -z "${DATABASE_URL:-}" ]]; then
  echo "live-story: OPENAI_API_KEY and DATABASE_URL are required — this is the manual live path, skipping." >&2
  exit 0
fi

export RAYSPEC_EXPERIMENTAL_WORKFORCE=1
export RAYSPEC_SPEC_PATH="$PWD/examples/workforce-starter/rayspec.yaml"
PORT="${PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"
CLI="node packages/app/cli/dist/index.js"

echo "live-story: booting the deployment on :${PORT} (RAYSPEC_CRON_TENANT_ID must name your org)…"
node packages/app/server/dist/serve.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${BASE}/health" >/dev/null

: "${RAYSPEC_API_KEY:?live-story: set RAYSPEC_API_KEY to a store:read+store:write key for your tenant (mint one per docs/cli-reference.md)}"

echo "live-story: submitting the goal…"
curl -fsS -X POST "${BASE}/v1/workforce/starter/goals" \
  -H "authorization: Bearer ${RAYSPEC_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"goal":"Analyze our onboarding friction and draft the fix announcement."}' | head -c 2000
echo

echo "live-story: watching. When the approval parks, decide it — then watch the synthesis land."
echo "  ${CLI} workforce approvals list --url ${BASE}"
echo "  ${CLI} workforce approvals approve <id> --url ${BASE}"
while true; do
  sleep 10
  PENDING=$($CLI workforce approvals list --url "$BASE" 2>/dev/null || true)
  if [[ "$PENDING" == *'"question"'* ]]; then
    echo "live-story: an approval is pending — decide it in another shell (commands above)."
    read -r -p "live-story: press enter once you have decided it…"
  fi
  STATUS=$($CLI workforce status --workforce starter --url "$BASE" 2>/dev/null || true)
  echo "live-story: ${STATUS//$'\n'/ }" | head -c 300
  echo
  if [[ "$STATUS" == *'"completed"'* && "$STATUS" != *'"working"'* && "$STATUS" != *'"queued"'* ]]; then
    break
  fi
done

echo "live-story: the tree —"
$CLI workforce tasks --tree --url "$BASE"
echo "live-story: cost by employee —"
$CLI workforce cost --by employee --url "$BASE"
