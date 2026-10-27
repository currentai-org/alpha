#!/usr/bin/env bash
# Zero-infra LOCAL demo — no Docker, no cluster. Starts both planes on the local hermes venv and stays up
# until Ctrl-C. This is the fastest way to drive the service by hand. (Docker/compose is only needed to
# hand a portable image to someone else.)
#
#   ./demo.sh           # leaves it running on http://127.0.0.1:8731
# then, in another terminal:
#   curl -s localhost:8731/healthz | python3 -m json.tool
#   curl -s -X POST localhost:8731/run -H 'content-type: application/json' \
#        -d '{"prompt":"create a.py b.py and count the .py files; write the number to ./out.txt","verify":{"expect_file":"out.txt","expect_contains":"2"}}'
#   curl -s localhost:8731/run/<id>
set -uo pipefail
AS="$(cd "$(dirname "$0")" && pwd)"; PY="$HOME/hermes-agent/.venv/bin/python"
REAL_TOKEN="${MODEL_UPSTREAM_TOKEN:-}"
[[ -n "$REAL_TOKEN" ]] || { echo "no MODEL_UPSTREAM_TOKEN — run via \`doppler run\` (agent-service/prd)"; exit 1; }
ADMIN="demo-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' ')"
PP=8730; AP=8731; PBASE="http://127.0.0.1:$PP"; ABASE="http://127.0.0.1:$AP"
DB="$AS/.demo-tasks.db"   # gitignored (*.db)
SANDBOX="${AGENT_SANDBOX:-bwrap}"; command -v bwrap >/dev/null || SANDBOX=off

echo "starting Plane A (gateway, holds token) on $PP …"
( cd "$AS/api" && MODEL_UPSTREAM_TOKEN="$REAL_TOKEN" PROXY_ADMIN_KEY="$ADMIN" "$PY" -m uvicorn proxy:app --port $PP --log-level warning ) & P1=$!
echo "starting Plane B (agent service, credential-free) on $AP …"
( cd "$AS/api" && env -u MODEL_UPSTREAM_TOKEN AGENT_MODEL_PROXY_URL="$PBASE" PROXY_ADMIN_KEY="$ADMIN" \
    AGENT_AUTH_DISABLED=1 AGENT_MODERATION_DISABLED=1 AGENT_DB_PATH="$DB" AGENT_SANDBOX="$SANDBOX" \
    AGENT_MAX_TOKENS=60000 AGENT_USER_DAILY_TOKENS=500000 AGENT_MAX_CONCURRENCY=4 \
    AGENT_SANDBOX_BACKEND=bwrap "$PY" -m uvicorn app:app --port $AP --log-level warning ) & P2=$!
trap 'echo; echo "stopping…"; kill $P1 $P2 2>/dev/null; pkill -f "hermes -z" 2>/dev/null; exit 0' INT TERM

for i in $(seq 1 40); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
echo
echo "================================================================"
echo " DEMO UP  ·  POST tasks to  $ABASE/run   (Ctrl-C to stop)"
echo "   sandbox=$SANDBOX  auth=off(local)  caps: 60k/task, 500k/user/day"
echo "   health: $ABASE/healthz   metrics: $ABASE/metrics"
echo "================================================================"
echo " try:"
echo "   curl -s -X POST $ABASE/run -H 'content-type: application/json' \\"
echo "        -d '{\"prompt\":\"create three .py files then count them and write the number to ./out.txt\"}'"
echo
wait $P1 $P2
