#!/usr/bin/env bash
# End-to-end curl smoke for the lead-qualifier backend.
#
# Assumes `rayspec-serve` is already serving this document (see README.md) and that OPENAI_API_KEY was
# set in its environment so the live `qualifier` agent can run. Drives the whole loop over HTTP:
# register a user -> create + switch into an org (a scoped token) -> POST a lead -> poll until the
# durable qualify run flips it to `qualified`.
#
# Usage:  BASE=http://localhost:8788 ./smoke.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8788}"
EMAIL="smoke-$(date +%s)@example.com"
PASSWORD="a-long-enough-password"

command -v jq >/dev/null || { echo "this smoke needs jq" >&2; exit 1; }

echo "1) register + create org + switch (scoped token)"
ACCESS=$(curl -fsS -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)
ORG=$(curl -fsS -X POST "$BASE/v1/orgs" -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -d '{"name":"Acme Sales"}' | jq -r .id)
TOKEN=$(curl -fsS -X POST "$BASE/v1/orgs/$ORG/switch" -H "authorization: Bearer $ACCESS" | jq -r .accessToken)

echo "2) POST a lead -> 201 (created id + enqueued run id); the agent runs off-request"
LEAD=$(curl -fsS -X POST "$BASE/leads" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"company":"Globex Manufacturing","contact_email":"ap@globex.example",
       "message":"Rolling out to every regional plant next quarter.","headcount":4200}')
echo "$LEAD" | jq .
ID=$(echo "$LEAD" | jq -r .id)

echo "3) poll the lead until the durable qualify run flips it to qualified"
for _ in $(seq 1 60); do
  ROW=$(curl -fsS "$BASE/leads/$ID" -H "authorization: Bearer $TOKEN")
  if [ "$(echo "$ROW" | jq -r .status)" = "qualified" ]; then
    echo "qualified:"
    echo "$ROW" | jq '{status,tier,fit_score,owning_queue,rationale}'
    break
  fi
  sleep 1
done

echo "4) list this tenant's leads"
curl -fsS "$BASE/leads" -H "authorization: Bearer $TOKEN" | jq '[.[] | {company,status,tier}]'
