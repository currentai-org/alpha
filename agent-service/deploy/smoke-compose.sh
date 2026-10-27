#!/usr/bin/env bash
# Local compose smoke — proves the containerized two-plane setup runs a task end-to-end.
# Run from a docker-capable shell:   sudo ./deploy/smoke-compose.sh
# (Reads the upstream token from Doppler (agent-service/prd) as the invoking user; writes a gitignored
#  .env — compose needs a real file, it doesn't read the calling shell's env. Leaves the stack UP on
#  success so it doubles as a local demo. Dumps container logs on any failure.)
set -uo pipefail
cd "$(dirname "$0")/.."
DC="docker compose"
scrub(){ sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }
dump(){ echo "=== compose ps ==="; $DC ps; echo "=== app logs ==="; $DC logs --tail=40 app 2>&1 | scrub; echo "=== proxy logs ==="; $DC logs --tail=20 proxy 2>&1 | scrub; }

# .env (upstream token pulled fresh from Doppler; random admin key). Created once; reused after — a
# fresh random admin key on every run would invalidate an already-running stack's grants.
if [[ ! -f .env ]]; then
  RU="${SUDO_USER:-$USER}"
  TOK="$(sudo -u "$RU" doppler run --project agent-service --config prd -- printenv MODEL_UPSTREAM_TOKEN 2>/dev/null || true)"
  [[ -n "$TOK" ]] || { echo "no MODEL_UPSTREAM_TOKEN from Doppler (agent-service/prd) — is $RU logged into doppler (doppler login)?"; exit 1; }
  printf 'MODEL_UPSTREAM_TOKEN=%s\nPROXY_ADMIN_KEY=%s\n' "$TOK" "$(openssl rand -hex 24)" > .env
  echo "wrote .env (MODEL_UPSTREAM_TOKEN from Doppler + random PROXY_ADMIN_KEY)"
fi

echo "==> build + up (detached)"
$DC up -d --build || { echo "FAIL: compose up errored"; dump; exit 1; }

echo "==> wait for app health (up to 90s)"
ok=""
for i in $(seq 1 45); do
  curl -sf http://127.0.0.1:8731/healthz >/dev/null 2>&1 && { ok=1; break; }
  sleep 2
done
[[ -n "$ok" ]] || { echo "FAIL: app never became healthy"; dump; exit 1; }
echo "   healthz: $(curl -s http://127.0.0.1:8731/healthz)"

echo "==> POST a real task"
ID="$(curl -s -X POST http://127.0.0.1:8731/run -H 'content-type: application/json' \
  -d '{"prompt":"create a.py and b.py then count the .py files and write only the number to ./out.txt and read it back","verify":{"expect_file":"out.txt","expect_contains":"2"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
[[ -n "$ID" ]] || { echo "FAIL: /run did not return an id"; dump; exit 1; }
echo "   task id: $ID"

echo "==> poll to terminal (up to ~3min)"
STATE=""; BODY=""
for i in $(seq 1 90); do
  BODY="$(curl -s http://127.0.0.1:8731/run/$ID)"
  STATE="$(echo "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))' 2>/dev/null)"
  [[ "$STATE" == COMPLETED || "$STATE" == FAILED || "$STATE" == CANCELED ]] && break
  sleep 2
done
echo "   final: $(echo "$BODY" | scrub)"

echo
if [[ "$STATE" == COMPLETED ]]; then
  echo "PASS: containerized two-plane smoke green (task COMPLETED)."
  echo "  stack is UP — try: curl localhost:8731/healthz   |   stop: sudo docker compose down"
  exit 0
else
  echo "FAIL: task ended $STATE (expected COMPLETED)"; dump; exit 1
fi
