#!/usr/bin/env bash
# Model-boundary gateway proof (brief §6B): secrets-at-boundary + step-cap + spend metering.
# Starts proxy.py (holds the ONLY real token) and app.py (started WITHOUT a real token, routed through the
# gateway). If a task completes, the agent could only have been credentialed via the per-task nonce — that
# IS the secrets boundary. Then proves the step-cap forces a verified failure. Deterministic asserts; offline
# toolsets only. Ports overridable: APORT=, PPORT=.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
ADMIN="${PROXY_ADMIN_KEY:-admin-$RANDOM$RANDOM}"; PPORT="${PPORT:-8742}"; APORT="${APORT:-8741}"
PBASE="http://127.0.0.1:$PPORT"; ABASE="http://127.0.0.1:$APORT"
scrub() { sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }

( cd "$AS/api" && MODEL_UPSTREAM_TOKEN="$REAL_TOKEN" PROXY_ADMIN_KEY="$ADMIN" "$PY" -m uvicorn proxy:app --port "$PPORT" --log-level warning ) >/tmp/gw-proxy.log 2>&1 & P1=$!
GWDB="$(mktemp -u /tmp/gw-XXXX.db)"
( cd "$AS/api" && env -u MODEL_UPSTREAM_TOKEN AGENT_MODEL_PROXY_URL="$PBASE" PROXY_ADMIN_KEY="$ADMIN" \
    AGENT_AUTH_DISABLED=1 AGENT_MODERATION_DISABLED=1 AGENT_TOOLSETS="terminal,file" AGENT_DB_PATH="$GWDB" \
    AGENT_SANDBOX_BACKEND=bwrap "$PY" -m uvicorn app:app --port "$APORT" --log-level warning ) >/tmp/gw-app.log 2>&1 & P2=$!
trap 'kill $P1 $P2 2>/dev/null; rm -f "$GWDB"*' EXIT
for i in $(seq 1 30); do curl -sf "$ABASE/healthz" >/dev/null 2>&1 && curl -sf "$PBASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

field() { "$PY" -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
submit() { curl -s -X POST "$ABASE/run" -H "content-type: application/json" -d "$1" | field id; }
poll() { local id="$1" s st; for i in $(seq 1 90); do s="$(curl -s "$ABASE/run/$id")"; st="$(echo "$s" | field state)"; [[ "$st" == COMPLETED || "$st" == FAILED ]] && { echo "$s"; return; }; sleep 2; done; echo '{"state":"TIMEOUT"}'; }

echo "boundary: $(curl -s "$ABASE/healthz" | field secrets_boundary)"
fail=0

echo "== T1: normal task, expect COMPLETED + verified + tally (app has NO real token) =="
R1="$(poll "$(submit '{"prompt":"Using terminal+file tools: create a.py b.py c.py, then count the .py files and write only that integer to ./out.txt and read it back.","verify":{"expect_file":"out.txt","expect_contains":"3"}}')")"
echo "  $(echo "$R1" | scrub)"
[[ "$(echo "$R1" | field state)" == COMPLETED && "$(echo "$R1" | field verified)" == True ]] || { echo "  !! T1 FAILED expectation"; fail=1; }

echo "== T2: step-cap max_steps=1, expect FAILED (cap -> no artifact -> verification fails) =="
R2="$(poll "$(submit '{"prompt":"Create a.py b.py c.py, count the .py files, write the integer to ./out.txt and read it back.","verify":{"expect_file":"out.txt","expect_contains":"3"},"max_steps":1}')")"
echo "  $(echo "$R2" | scrub)"
[[ "$(echo "$R2" | field state)" == FAILED ]] || { echo "  !! T2 FAILED expectation"; fail=1; }

leak="$(grep -c "$REAL_TOKEN" /tmp/gw-app.log 2>/dev/null)"; leak="${leak:-0}"
echo "== boundary: real-token occurrences in app log = $leak (expect 0) =="
[[ "$leak" == 0 ]] || { echo "  !! TOKEN LEAK"; fail=1; }

[[ "$fail" == 0 ]] && echo "PASS: gateway enforces secrets-boundary + step-cap; verification catches capped runs." || echo "FAIL: see above."
exit $fail
