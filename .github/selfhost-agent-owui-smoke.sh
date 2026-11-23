#!/usr/bin/env bash
# The agent profile's model gateway starts on Open WebUI's env names alone (selfhost/.env.example block C),
# and forwards to the endpoint they name. Writes selfhost/.env from .env.example with block A's
# OPENAI_BASE_URL and OPENAI_API_KEY removed and OPENAI_API_BASE_URLS / OPENAI_API_KEYS set, then requires:
#   - with neither name set, the gateway exits non-zero naming the missing setting (so a pass below is not
#     a gateway that starts whatever the env says);
#   - with only the Open WebUI names, `--profile local --profile agent` brings the gateway up healthy, its
#     /healthz names the first URL of the list as its one provider, and a /v1/models call on a grant comes
#     back from the local llama.cpp with its model in the list.
# No secret: the local model downloads from Hugging Face without a token. Linux only; it writes
# selfhost/.env, so it refuses a directory that has one outside CI.
set -uo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo/selfhost" || exit 1
if [ -e .env ] && [ -z "${CI:-}" ]; then
	echo "refusing to overwrite selfhost/.env outside CI" >&2
	exit 1
fi

fail=0
pass() { echo "PASS $*"; }
bad() {
	echo "FAIL $*"
	fail=1
}
compose() { docker compose --profile local --profile agent "$@"; }
first_url=http://llama:8080/v1

# .env.example as an Open WebUI operator edits it: block A's two endpoint lines out, block C's names in.
grep -vE '^OPENAI_(BASE_URL|API_KEY)=' .env.example |
	sed "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" >.env
cat >>.env <<EOF
OPENAI_API_BASE_URLS=$first_url;http://second.invalid/v1
OPENAI_API_KEYS=;unused-second-key
EOF
if grep -qE '^OPENAI_(BASE_URL|API_KEY)=' .env; then bad ".env still sets OPENAI_BASE_URL or OPENAI_API_KEY, so this proves nothing"; fi

cleanup() {
	if [ "$fail" -ne 0 ]; then
		compose ps -a || true
		echo "--- gateway log"
		compose logs --no-color --no-log-prefix --tail 60 gateway 2>&1 | cut -c1-400 || true
	fi
	compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

# agent-init builds the image the gateway runs and writes the admin key it reads.
compose up --build --exit-code-from agent-init agent-init || {
	bad "agent-init did not finish"
	echo "AGENT OWUI NAMES FAIL"
	exit 1
}

# Neither name set: the gateway must refuse to start and say which setting is missing.
neg=$(compose run --rm --no-deps -e OPENAI_API_BASE_URLS= -e OPENAI_API_KEYS= gateway 2>&1)
neg_code=$?
if [ "$neg_code" -ne 0 ] && grep -q 'needs OPENAI_BASE_URL' <<<"$neg"; then
	pass "with no endpoint named, the gateway exits $neg_code: $(grep -m1 'needs OPENAI_BASE_URL' <<<"$neg")"
else
	bad "with no endpoint named, the gateway exited $neg_code without naming the missing setting: $(cut -c1-300 <<<"$neg")"
fi

if compose up -d --wait --wait-timeout 1500 llama gateway; then
	pass "gateway healthy on the Open WebUI names: $(compose ps --format '{{.Service}}={{.Status}}' gateway llama | tr '\n' ' ')"
else
	bad "llama and gateway did not both come up healthy"
	echo "AGENT OWUI NAMES FAIL"
	exit 1
fi

# Read the log once: under pipefail, `compose logs | grep -q` fails on a match, because grep -q
# exits at the first hit and compose logs dies on the closed pipe.
gw_log=$(compose logs --no-color --no-log-prefix gateway 2>&1)
grep '^gateway: ' <<<"$gw_log" | sed 's/^/gateway log: /'
if grep -qF "model endpoint from OPENAI_API_BASE_URLS: $first_url" <<<"$gw_log"; then
	pass "the gateway logged the endpoint it took from OPENAI_API_BASE_URLS"
else
	bad "the gateway did not log taking its endpoint from OPENAI_API_BASE_URLS"
fi

# Inside the gateway: its provider list, then a real forward to llama.cpp on a grant, as an agent task would.
out=$(compose exec -T -e FIRST_URL="$first_url" gateway python - <<'PY' 2>&1
import json, os, secrets, urllib.request

def call(method, path, bearer, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:8732{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read())

health = json.loads(urllib.request.urlopen("http://127.0.0.1:8732/healthz", timeout=10).read())
provs = [(p["name"], p["base_url"]) for p in health["providers"]]
print("healthz providers:", provs, "credential:", health["credential"])
ok = provs == [("stack", os.environ["FIRST_URL"])] and health["credential"] == "configured"
admin = open("/secrets/proxy-admin-key").read().strip()
nonce = secrets.token_hex(16)
call("POST", "/admin/grant", admin, {"nonce": nonce, "max_requests": 2, "label": "owui-names-smoke"})
status, models = call("GET", "/v1/models", nonce)
ids = [m.get("id") for m in models.get("data", [])]
print("models via gateway:", status, ids)
ok = ok and status == 200 and bool(ids)
print("RESULT", "ok" if ok else "bad")
PY
)
echo "$out" | cut -c1-400
if grep -q '^RESULT ok' <<<"$out"; then
	pass "the gateway's one provider is $first_url, and /v1/models came back from llama.cpp through it"
else
	bad "the gateway's provider or its forward to llama.cpp was not what the Open WebUI names set"
fi

if [ "$fail" -eq 0 ]; then echo "AGENT OWUI NAMES PASS"; else echo "AGENT OWUI NAMES FAIL"; fi
exit "$fail"
