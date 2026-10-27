#!/usr/bin/env bash
# Durability + observability integration test (maturity gaps C/D/E/F). ONE real agent run, then:
#  - F  webhook push delivery on terminal
#  - E  /metrics counters + structured logs
#  - D  per-user budget 429 (daily task limit)
#  - C  persistence ACROSS A RESTART (kill app, restart same DB, result still there)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
ADMIN="adm-$RANDOM$RANDOM"; PP=8801; AP=8802; WH=8803
PBASE="http://127.0.0.1:$PP"; ABASE="http://127.0.0.1:$AP"
DB="$(mktemp -u /tmp/pt-XXXX.db)"; WHFILE="$(mktemp)"
scrub(){ sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }
field(){ "$PY" -c "import sys,json
try:print(json.load(sys.stdin).get('$1',''))
except Exception as e:print('ERR',e)"; }
fail=0; pass(){ echo "  PASS $1"; }; bad(){ echo "  FAIL $1"; fail=1; }

# webhook listener: append the POST body to $WHFILE
WHSTUB="$(mktemp)"; cat >"$WHSTUB" <<'PYEOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n)
        open(sys.argv[2],'wb').write(body)
        self.send_response(200); self.send_header('content-length','0'); self.end_headers()
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',int(sys.argv[1])),H).serve_forever()
PYEOF
"$PY" "$WHSTUB" $WH "$WHFILE" >/tmp/pt-wh.log 2>&1 & WPID=$!

start_app(){ ( cd "$AS/api" && env -u MODEL_UPSTREAM_TOKEN AGENT_MODEL_PROXY_URL="$PBASE" PROXY_ADMIN_KEY="$ADMIN" \
    AGENT_AUTH_DISABLED=1 AGENT_MODERATION_DISABLED=1 AGENT_DB_PATH="$DB" AGENT_USER_DAILY_TASKS=1 \
    AGENT_WEBHOOK_ALLOW_PRIVATE=1 \
    AGENT_SANDBOX_BACKEND=bwrap "$PY" -m uvicorn app:app --port $AP --log-level warning ) >/tmp/pt-a.log 2>&1 & echo $!; }
( cd "$AS/api" && MODEL_UPSTREAM_TOKEN="$REAL_TOKEN" PROXY_ADMIN_KEY="$ADMIN" "$PY" -m uvicorn proxy:app --port $PP --log-level warning ) >/tmp/pt-p.log 2>&1 & P1=$!
APID="$(start_app)"
trap 'kill $WPID $P1 $APID 2>/dev/null; pkill -f "hermes -z" 2>/dev/null; rm -f "$DB"* "$WHFILE" "$WHSTUB"' EXIT
for i in $(seq 1 40); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && curl -sf "$PBASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done; sleep 1
poll(){ local id="$1" s st; for i in $(seq 1 80); do s="$(curl -s "$ABASE/run/$id")"; st="$(echo "$s"|field state)"; [[ "$st" == COMPLETED||"$st" == FAILED||"$st" == CANCELED ]]&&{ echo "$s";return;};sleep 2;done;echo TIMEOUT; }

echo "=============================================================="
echo " PERSISTENCE + OBSERVABILITY INTEGRATION TEST"
echo "=============================================================="
echo "healthz persistence: $(curl -s "$ABASE/healthz" | field persistence)"

echo; echo "--- F + run: one real task with a webhook, expect COMPLETED + tokens metered ---"
id="$(curl -s -X POST "$ABASE/run" -H 'content-type: application/json' \
  -d "{\"prompt\":\"create a.py b.py c.py then count the .py files and write only the number to ./out.txt and read it back\",\"verify\":{\"expect_file\":\"out.txt\",\"expect_contains\":\"3\"},\"webhook_url\":\"http://127.0.0.1:$WH/cb\"}" | field id)"
st="$(poll "$id")"; echo "  $(echo "$st" | scrub)"
[[ "$(echo "$st"|field state)" == COMPLETED ]] && pass "task COMPLETED" || bad "task not COMPLETED"
[[ "$(echo "$st"|field verified)" == True ]] && pass "verified=true" || bad "not verified"
tok="$(echo "$st"|field tokens)"; [[ "$tok" =~ ^[0-9]+$ && "$tok" -gt 0 ]] && pass "tokens metered ($tok) + persisted in status" || bad "tokens not metered (got $tok)"
sleep 1
whst="$(cat "$WHFILE" 2>/dev/null | field state)"; [[ "$whst" == COMPLETED ]] && pass "#F webhook delivered terminal payload (state=$whst)" || bad "webhook not delivered (got '$whst')"

echo; echo "--- E  /metrics counters ---"
M="$(curl -s "$ABASE/metrics")"
echo "$M" | grep -q "agent_runs_completed_total 1" && pass "metrics: completed_total=1" || bad "metrics completed_total wrong: $(echo "$M"|grep completed_total)"
ct="$(echo "$M" | grep '^agent_tokens_total ' | awk '{print $2}')"; [[ "${ct%.*}" -gt 0 ]] && pass "metrics: tokens_total>0 ($ct)" || bad "metrics tokens_total=$ct"
echo "  structured log sample:"; grep '"event": "run.finished"' /tmp/pt-a.log | tail -1 | scrub | sed 's/^/    /'

echo; echo "--- D  per-user daily task budget (=1) -> 2nd run 429 ---"
c2="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"second task"}')"
[[ "$c2" == 429 ]] && pass "budget exhausted -> 429" || bad "budget not enforced (got $c2)"

echo; echo "--- C  PERSISTENCE ACROSS RESTART (kill app, restart same DB, result survives) ---"
kill -TERM $APID 2>/dev/null; for i in $(seq 1 20); do kill -0 $APID 2>/dev/null || break; sleep 0.5; done
APID="$(start_app)"
for i in $(seq 1 40); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done; sleep 1
after="$(curl -s "$ABASE/run/$id")"
[[ "$(echo "$after"|field state)" == COMPLETED ]] && pass "task still COMPLETED after restart" || bad "lost task across restart"
[[ "$(echo "$after"|field tokens)" == "$tok" ]] && pass "tokens preserved across restart ($tok)" || bad "tokens lost across restart"
echo "  healthz tasks_total after restart: $(curl -s "$ABASE/healthz" | field tasks_total)"

echo; echo "=============================================================="
[[ $fail == 0 ]] && echo " PASS: persistence + observability + budgets + webhooks all hold." || echo " FAIL: see above."
echo "=============================================================="
exit $fail
