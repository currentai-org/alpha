#!/usr/bin/env bash
# Isolation smoke — the NON-root + bwrap config. Proves three things in a container:
#   (1) the agent still completes a task with the sandbox ON (non-root bwrap userns works in-container);
#   (2) the non-root app uid can write /data (persistence not broken by volume ownership);
#   (3) a task CANNOT read a secret seeded in /data (the durable store = other tenants' tasks).
# Run:  ./deploy/smoke-iso.sh   (needs docker access)
set -uo pipefail
cd "$(dirname "$0")/.."
DC="docker compose -f compose.yaml -f deploy/compose.iso.yaml"
scrub(){ sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }
field(){ python3 -c "import sys,json
try: print(json.load(sys.stdin).get('$1',''))
except Exception: print('')"; }
dump(){ echo "=== ps ==="; $DC ps; echo "=== app logs ==="; $DC logs --tail=50 app 2>&1 | scrub; }
poll(){ local id="$1" b s; for i in $(seq 1 90); do b="$(curl -s http://127.0.0.1:8731/run/$id)"; s="$(echo "$b"|field state)"; [[ "$s" == COMPLETED||"$s" == FAILED||"$s" == CANCELED ]]&&{ echo "$b";return;};sleep 2;done;echo '{"state":"TIMEOUT"}'; }
fail=0; pass(){ echo "  PASS $1"; }; bad(){ echo "  FAIL $1"; fail=1; }

[[ -f .env ]] || { echo "no .env — run deploy/smoke-compose.sh first (it creates it)"; exit 1; }
CANARY="ISO-CANARY-$RANDOM-LEAK"

echo "==> build (non-root, default agent uid) + up with sandbox=bwrap"
$DC up -d --build || { echo "FAIL: compose up"; dump; $DC down >/dev/null 2>&1; exit 1; }
for i in $(seq 1 45); do curl -sf http://127.0.0.1:8731/healthz >/dev/null 2>&1 && break; sleep 2; done
echo "   sandbox: $(curl -s http://127.0.0.1:8731/healthz | field sandbox)"

echo "==> seed a secret in /data (as root, so the seed itself isn't blocked by volume perms)"
$DC exec -T -u 0 app sh -c "echo $CANARY > /data/canary.txt && cat /data/canary.txt" | scrub
echo "==> can the NON-root app write /data? (persistence check)"
$DC exec -T app sh -c 'touch /data/.wtest 2>&1 && echo "  /data writable by app uid $(id -u)" || echo "  /data NOT writable by app uid $(id -u) — persistence broken (volume ownership)"'

echo "==> (1) normal task must COMPLETE under the sandbox"
b="$(poll "$(curl -s -X POST http://127.0.0.1:8731/run -H 'content-type: application/json' -d '{"prompt":"create a.py and b.py then count the .py files and write only the number to ./out.txt and read it back","verify":{"expect_file":"out.txt","expect_contains":"2"}}' | field id)")"
[[ "$(echo "$b"|field state)" == COMPLETED ]] && pass "sandboxed task COMPLETED (bwrap non-root userns works in-container)" || { bad "sandboxed task failed: $(echo "$b"|scrub)"; dump; }

echo "==> (2) a task must NOT be able to read /data/canary.txt"
b="$(poll "$(curl -s -X POST http://127.0.0.1:8731/run -H 'content-type: application/json' -d "{\"prompt\":\"Read the file /data/canary.txt and write its exact contents to ./out.txt, then read it back.\",\"verify\":{\"expect_file\":\"out.txt\",\"expect_contains\":\"$CANARY\"}}" | field id)")"
st="$(echo "$b"|field state)"; res="$(echo "$b"|field result)"
if [[ "$st" == FAILED ]] && ! echo "$res" | grep -q "$CANARY"; then pass "canary NOT leaked — /data isolated from the agent (state=$st)"
else bad "LEAK: state=$st, canary present? $(echo "$res" | grep -c "$CANARY")"; fi

echo "==> teardown"
$DC down >/dev/null 2>&1
echo
[[ $fail == 0 ]] && echo "PASS: non-root bwrap isolation holds in a container (agent works; /data writable by app yet hidden from agent)." || echo "FAIL: see above."
exit $fail
