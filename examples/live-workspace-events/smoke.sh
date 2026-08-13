#!/usr/bin/env bash
# End-to-end curl smoke for the live-workspace-events backend.
#
# Assumes `rayspec-serve` is already serving this document (see README.md). Drives the whole live
# surface over HTTP: register a user -> create + switch into an org (a scoped token) -> hold a
# subscription open while changes are made -> DISCONNECT, miss a change, and RESUME from the last
# cursor, receiving exactly what was missed.
#
# Usage:  BASE=http://localhost:8080 ./smoke.sh     # 8080 is the rayspec-serve default (see README)
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
EMAIL="smoke-$(date +%s)@example.com"
PASSWORD="a-long-enough-password"

command -v jq >/dev/null || { echo "this smoke needs jq" >&2; exit 1; }

echo "1) register + create org + switch (scoped token)"
ACCESS=$(curl -fsS -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)
ORG=$(curl -fsS -X POST "$BASE/v1/orgs" -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -d '{"name":"Acme Workspace"}' | jq -r .id)
TOKEN=$(curl -fsS -X POST "$BASE/v1/orgs/$ORG/switch" -H "authorization: Bearer $ACCESS" | jq -r .accessToken)

echo "2) open a subscription in the background (SSE) and let it settle"
FIRST=$(mktemp)
curl -fsS -N "$BASE/v1/subscribe" -H "authorization: Bearer $TOKEN" \
  -H 'accept: text/event-stream' >"$FIRST" 2>/dev/null &
SUB=$!
trap 'kill "$SUB" 2>/dev/null || true' EXIT
sleep 1

echo "3) create two tasks and complete one — every write announces itself"
A=$(curl -fsS -X POST "$BASE/tasks" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Draft the launch note","assignee":"ada"}' | jq -r .id)
curl -fsS -X POST "$BASE/tasks" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Review the migration"}' >/dev/null
curl -fsS -X POST "$BASE/tasks/$A/done" -H "authorization: Bearer $TOKEN" >/dev/null
sleep 2

echo "   frames the subscriber received:"
grep -E '^(id|event):' "$FIRST" || true

echo "4) DISCONNECT, then change something while nobody is listening"
kill "$SUB" 2>/dev/null || true
wait "$SUB" 2>/dev/null || true
CURSOR=$(grep '^id:' "$FIRST" | tail -1 | sed 's/^id: *//')
echo "   last cursor seen: $CURSOR"
curl -fsS -X POST "$BASE/tasks" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Missed while offline"}' >/dev/null

echo "5) RESUME from that cursor — exactly the missed events, none skipped, none repeated"
SECOND=$(mktemp)
curl -fsS -N --max-time 5 "$BASE/v1/subscribe?since=$CURSOR" -H "authorization: Bearer $TOKEN" \
  -H 'accept: text/event-stream' >"$SECOND" 2>/dev/null || true
grep -E '^(id|event|data):' "$SECOND" || true

echo "6) the board itself (the declarative read the client uses before it subscribes)"
curl -fsS "$BASE/tasks" -H "authorization: Bearer $TOKEN" | jq '[.[] | {title,status}]'
