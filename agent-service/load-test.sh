#!/usr/bin/env bash
# Load/soak test (Phase 1 hardening): burst the concurrency cap and prove it holds under contention —
# excess rejected with 429 (not crash/OOM), server stays responsive mid-burst, no slot leak after settle,
# slot freed for the next run, no orphaned agents. Cheap: only ~CAP tasks actually run (rest 429 for free).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
ADMIN="adm-$RANDOM$RANDOM"; PP=8831; AP=8832; PBASE="http://127.0.0.1:$PP"; ABASE="http://127.0.0.1:$AP"
DB="$(mktemp -u /tmp/load-XXXX.db)"; CODES="$(mktemp -d)"; CAP=3; BURST=30
field(){ "$PY" -c "import sys,json
try:print(json.load(sys.stdin).get('$1',''))
except Exception as e:print('ERR',e)"; }
fail=0; pass(){ echo "  PASS $1"; }; bad(){ echo "  FAIL $1"; fail=1; }
( cd "$AS/api" && MODEL_UPSTREAM_TOKEN="$REAL_TOKEN" PROXY_ADMIN_KEY="$ADMIN" "$PY" -m uvicorn proxy:app --port $PP --log-level warning ) >/tmp/load-p.log 2>&1 & P1=$!
( cd "$AS/api" && env -u MODEL_UPSTREAM_TOKEN AGENT_MODEL_PROXY_URL="$PBASE" PROXY_ADMIN_KEY="$ADMIN" \
    AGENT_AUTH_DISABLED=1 AGENT_MODERATION_DISABLED=1 AGENT_DB_PATH="$DB" AGENT_MAX_CONCURRENCY=$CAP \
    AGENT_SANDBOX_BACKEND=bwrap "$PY" -m uvicorn app:app --port $AP --log-level warning ) >/tmp/load-a.log 2>&1 & P2=$!
trap 'kill $P1 $P2 2>/dev/null; pkill -f "hermes -z" 2>/dev/null; rm -rf "$DB"* "$CODES"' EXIT
for i in $(seq 1 40); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && curl -sf "$PBASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done; sleep 1

echo "=============================================================="
echo " LOAD/SOAK TEST  (cap=$CAP, burst=$BURST concurrent /run)"
echo "=============================================================="

echo; echo "--- burst $BURST concurrent submissions ---"
pids=()
for i in $(seq 1 $BURST); do
  ( curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$ABASE/run" -H 'content-type: application/json' \
      -d '{"prompt":"reply with the word ok"}' > "$CODES/$i" ) &
  pids+=($!)
done
# prove the server answers health checks WHILE the burst is in flight
hz="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$ABASE/healthz")"
wait "${pids[@]}"   # ONLY the burst curls — NOT the uvicorn servers (bare `wait` would hang on them)
acc=$(grep -l '^20' "$CODES"/* 2>/dev/null | wc -l); rej=$(grep -l '^429' "$CODES"/* 2>/dev/null | wc -l); oth=$((BURST-acc-rej))
echo "  accepted(2xx)=$acc  rejected(429)=$rej  other=$oth"
[[ "$hz" == 200 ]] && pass "server responsive mid-burst (healthz 200)" || bad "server unresponsive mid-burst ($hz)"
[[ "$acc" -ge 1 && "$acc" -le $((CAP+1)) ]] && pass "accepted within cap ($acc <= cap+1)" || bad "cap not honored (accepted=$acc, cap=$CAP)"
[[ "$rej" -ge $((BURST-CAP-1)) ]] && pass "excess shed as 429 ($rej)" || bad "too few 429s ($rej)"
[[ "$oth" -eq 0 ]] && pass "no errors/timeouts (no 5xx/000)" || bad "$oth non-2xx/429 responses (crash/timeout?)"
inf="$(curl -s "$ABASE/healthz"|field inflight)"; echo "  inflight right after burst: $inf"

echo; echo "--- drain: wait for accepted tasks to finish, assert no slot leak ---"
for i in $(seq 1 90); do inf="$(curl -s "$ABASE/healthz"|field inflight)"; [[ "$inf" == 0 ]] && break; sleep 2; done
[[ "$inf" == 0 ]] && pass "inflight drained to 0 (no slot leak)" || bad "slot leak: inflight stuck at $inf"

echo; echo "--- post-drain: a fresh run is accepted (slots were freed) ---"
c="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"final ok"}')"
[[ "$c" == 200 ]] && pass "fresh run accepted after drain ($c)" || bad "slots not freed ($c)"
for i in $(seq 1 60); do inf="$(curl -s "$ABASE/healthz"|field inflight)"; [[ "$inf" == 0 ]] && break; sleep 2; done

echo; echo "--- no orphaned agents ---"
sleep 1; orph="$(pgrep -f 'hermes -z' | grep -v grep | wc -l)"
[[ "$orph" -eq 0 ]] && pass "no orphaned hermes processes" || bad "$orph orphaned agents"
echo "  total tasks recorded: $(curl -s "$ABASE/healthz"|field tasks_total)"

echo; echo "=============================================================="
[[ $fail == 0 ]] && echo " PASS: concurrency cap holds under load; responsive; no leak." || echo " FAIL: see above."
echo "=============================================================="
exit $fail
