#!/usr/bin/env bash
# Adversarial-hardening regression test. Proves the SERVER-level interlocks the
# offline unit suite (api/test_agent_service.py) can't: concurrency cap (#1), orphan reaping on shutdown (#3),
# check_cmd moderation (#5), proxy upstream-status propagation (#4/C), healthz path-leak fix (#7/G).
# Minimal live agent use: one short `sleep` task to hold a slot. Run from the repo root.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
ADMIN="adm-$RANDOM$RANDOM"; PP=8795; AP=8796; MP=8797
PBASE="http://127.0.0.1:$PP"; ABASE="http://127.0.0.1:$AP"; MBASE="http://127.0.0.1:$MP"
scrub(){ sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
field(){ "$PY" -c "import sys,json
try:print(json.load(sys.stdin).get('$1',''))
except Exception as e:print('ERR',e)"; }
fail=0; pass(){ echo "  PASS $1"; }; bad(){ echo "  FAIL $1"; fail=1; }

# --- Coop stub: speaks the real /api/v1/content contract, blocks anything containing BLOCKME -----
COOPKEY="ck-$RANDOM$RANDOM"
STUB="$(mktemp)"; cat >"$STUB" <<PYEOF
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n)
        try: req=json.loads(body)
        except Exception: req={}
        if self.headers.get('x-api-key') != "$COOPKEY" or self.path != '/api/v1/content':
            self.send_response(401); self.end_headers(); return
        text=(req.get('content') or {}).get('text','')
        actions=[{'name':'chat-block-test'}] if 'BLOCKME' in text else []
        out=json.dumps({'actionsTriggered':actions}).encode()
        self.send_response(200); self.send_header('content-type','application/json')
        self.send_header('content-length',str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',int(sys.argv[1])),H).serve_forever()
PYEOF

"$PY" "$STUB" $MP >/tmp/ht-m.log 2>&1 & MPID=$!
( cd "$AS/api" && MODEL_UPSTREAM_TOKEN="$REAL_TOKEN" PROXY_ADMIN_KEY="$ADMIN" "$PY" -m uvicorn proxy:app --port $PP --log-level warning ) >/tmp/ht-p.log 2>&1 & P1=$!
HTDB="$(mktemp -u /tmp/ht-XXXX.db)"
( cd "$AS/api" && env -u MODEL_UPSTREAM_TOKEN AGENT_MODEL_PROXY_URL="$PBASE" PROXY_ADMIN_KEY="$ADMIN" \
    AGENT_AUTH_DISABLED=1 COOP_URL="$MBASE" COOP_API_KEY="$COOPKEY" AGENT_MAX_CONCURRENCY=1 AGENT_TOOLSETS=terminal AGENT_DB_PATH="$HTDB" \
    AGENT_SANDBOX_BACKEND=bwrap "$PY" -m uvicorn app:app --port $AP --log-level warning ) >/tmp/ht-a.log 2>&1 & P2=$!
trap 'kill $MPID $P1 $P2 2>/dev/null; pkill -f "hermes -z .*sleep" 2>/dev/null; rm -f "$STUB" "$HTDB"*' EXIT
for i in $(seq 1 40); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && curl -sf "$PBASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done; sleep 1

echo "=============================================================="
echo " HARDENING REGRESSION TEST (playtest round 2)"
echo "=============================================================="

echo; echo "--- #7/G  healthz exposes no absolute binary path ---"
hb="$(curl -s "$ABASE/healthz" | field hermes)"
[[ "$hb" == "configured" || "$hb" == "MISSING" ]] && pass "app healthz hermes='$hb' (no path)" || bad "app healthz leaked: $hb"

echo; echo "--- #5  check_cmd is moderated (server-side shell gated like the prompt) ---"
c1="$(code -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"hello world","verify":{"check_cmd":"echo BLOCKME"}}')"
[[ "$c1" == 403 ]] && pass "benign prompt + BLOCKME check_cmd -> 403 (check_cmd moderated)" || bad "check_cmd not moderated (got $c1, want 403)"
c2="$(code -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"please BLOCKME now"}')"
[[ "$c2" == 403 ]] && pass "BLOCKME prompt -> 403 (baseline prompt moderation)" || bad "prompt moderation broken (got $c2)"

echo; echo "--- #4/C  proxy propagates upstream error status (not masked as 200) ---"
curl -s -X POST "$PBASE/admin/grant" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"nonce":"htswallow1","max_requests":5}' >/dev/null
hs="$(code -X POST "$PBASE/v1/chat/completions" -H "authorization: Bearer htswallow1" -H 'content-type: application/json' -d '{"model":"nope/does-not-exist","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":1}')"
[[ "$hs" != 200 ]] && pass "bogus model -> client sees HTTP $hs (real status, not 200)" || bad "status swallowed (got 200)"

echo; echo "--- #1 + #3  concurrency cap (=1) then orphan reaping on shutdown ---"
id1="$(curl -s -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"run exactly this shell command and report done: sleep 12"}' | field id)"
sleep 4   # let task1 acquire the slot and spawn its hermes child
r2="$(code -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"second task"}')"
r3="$(code -X POST "$ABASE/run" -H 'content-type: application/json' -d '{"prompt":"third task"}')"
{ [[ "$r2" == 429 ]] && [[ "$r3" == 429 ]]; } && pass "with concurrency=1, extra runs -> 429/$r3 (slot cap holds)" || bad "concurrency cap leaked (r2=$r2 r3=$r3, want 429/429)"
inflight="$(curl -s "$ABASE/healthz" | field inflight)"
[[ "$inflight" == 1 ]] && pass "healthz inflight=1 (slot accounting)" || bad "inflight=$inflight (want 1)"
child="$(pgrep -f 'hermes -z .*sleep 12' | head -1)"
if [[ -n "$child" ]]; then
  pass "agent child alive (pid $child) while task runs"
  kill -TERM $P2 2>/dev/null            # graceful shutdown -> lifespan reaper should kill the process group
  for i in $(seq 1 20); do kill -0 "$child" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$child" 2>/dev/null; then bad "ORPHAN: agent child $child survived server shutdown"; kill -9 "$child" 2>/dev/null
  else pass "#3 orphan reaped: agent child died with the server (no orphan)"; fi
else
  bad "could not find agent child (sleep task didn't spawn?)"
fi

echo; echo "=============================================================="
[[ $fail == 0 ]] && echo " PASS: all hardening interlocks hold." || echo " FAIL: see above."
echo "=============================================================="
exit $fail
