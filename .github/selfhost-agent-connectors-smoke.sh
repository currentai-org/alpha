#!/usr/bin/env bash
# A person's connected Google account on an agent turn, through the self-host stack with
# `--profile agent --profile google`, the Google connector and the model stood in for by
# .github/selfhost-agent-connectors.compose.yaml. Two accounts sign up; B connects Google through the web
# app's real connect flow, with Google's consent and token endpoint answered by the app's own stand-in
# (the `google_connector_stub` fault, googleE2eStub.ts). Then it requires:
#
#   1. B's agent turn asking about Gmail answers with the stand-in's message, so the call went
#      sandbox -> gateway -> connector with B's access token swapped in.
#   2. Owner scoping: A never connected, and A's agent turn sends no connector (agent-service's
#      `run.connectors` line) and A's grants carry none (the gateway's `grant.registered` lines). B's do.
#   3. A turn that asks to send a reply is refused at the gateway: the stand-in never sees the send, and the
#      answer says it was refused.
#   4. A turn whose search the connector answers 401 ends with "Reconnect Google".
#   5. The access token is nowhere in the sandbox's environment or files, agent-service's or the gateway's
#      logs, or tasks.db.
#
# Prints one `ok`/`FAIL` line per claim and `AGENT CONNECTORS PASS` or `AGENT CONNECTORS FAIL` at the end.
# No secret: every credential here is made up on the spot or is the stand-in's fixed token. Linux only; it
# writes selfhost/.env, so it refuses a directory that has one outside CI.
set -uo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo/selfhost" || exit 1
if [ -e .env ] && [ -z "${CI:-}" ]; then
	echo "refusing to overwrite selfhost/.env outside CI" >&2
	exit 1
fi

export COMPOSE_FILE="compose.yaml:../.github/selfhost-agent-connectors.compose.yaml"
export DOCKER_SOCK_GID=${DOCKER_SOCK_GID:-$(stat -c %g /var/run/docker.sock)}
compose() { docker compose --profile agent --profile google "$@"; }
BASE="http://localhost:${PORT:-3000}"
# googleE2eStub.ts STUB_ACCESS_TOKEN: the only bearer the stand-in connector takes.
ACCESS_TOKEN="ya29.e2e-google-access"
MESSAGE_FACT="watering rota moves to Thursdays"
# The label the docker sandbox backend puts on each container it makes, read from the backend itself.
SBX_LABEL=$(sed -n 's/^_LABEL = "\([^"]*\)".*/\1/p' ../agent-service/api/sandbox_docker.py)
[ -n "$SBX_LABEL" ] || { echo "FAIL could not read the sandbox label from sandbox_docker.py"; exit 1; }
fault_token=$(openssl rand -hex 24)
work=$(mktemp -d)
fail=0
pass() { echo "ok   $*"; }
bad() {
	echo "FAIL $*"
	fail=1
}

# .env.example without block A's local model, with the stand-ins in its place.
grep -vE '^(OPENAI_BASE_URL|OPENAI_API_KEY|MODEL_ALLOWLIST)=' .env.example |
	sed "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" >.env
cat >>.env <<EOF
OPENAI_BASE_URL=http://model:8080/v1
OPENAI_API_KEY=none
MODEL_ALLOWLIST=*
AGENT_MODEL=stub-model
ALPHA_OPEN_SIGNUP=true
E2E_FAULT_INJECT_TOKEN=$fault_token
GOOGLE_CONNECT_CLIENT_ID=selfhost-e2e.apps.googleusercontent.com
GOOGLE_CONNECT_CLIENT_SECRET=selfhost-e2e-client-secret
EOF

dump_logs() {
	compose ps -a || true
	for s in web agent gateway google model; do
		echo "--- $s log"
		compose logs --no-color --no-log-prefix --tail 80 "$s" 2>&1 | cut -c1-600 || true
	done
}
cleanup() {
	if [ "$fail" -ne 0 ]; then dump_logs; fi
	compose down -v >/dev/null 2>&1 || true
	docker ps -aq --filter "label=$SBX_LABEL" | xargs -r docker rm -f >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

started=$(date +%s)
if ! compose up -d --build --wait --wait-timeout "${CONNECTORS_UP_TIMEOUT:-1500}"; then
	bad "the stack did not come up healthy"
	echo "AGENT CONNECTORS FAIL"
	exit 1
fi
pass "stack up in $(($(date +%s) - started)) s"

fault=(-H "x-e2e-fault-inject: google_connector_stub" -H "x-e2e-fault-inject-token: $fault_token")
newid() { cat /proc/sys/kernel/random/uuid; }

signup() { # name: signs up a fresh account into $work/<name>.jar
	local jar="$work/$1.jar" code
	code=$(curl -s -o "$work/$1.signup" -w '%{http_code}' --max-time 30 -c "$jar" -b "$jar" -H "origin: $BASE" \
		-H 'content-type: application/json' \
		-d "{\"email\":\"$1-$(newid | cut -c1-8)@example.org\",\"password\":\"selfhost-e2e-password\",\"name\":\"\"}" \
		"$BASE/chat/api/auth/sign-up/email")
	[ "$code" = 200 ] || { bad "sign-up for $1 answered $code: $(head -c 300 "$work/$1.signup")"; return 1; }
}

connect_google() { # jar
	local jar=$1 consent state back code
	consent=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 30 -c "$jar" -b "$jar" "${fault[@]}" \
		"$BASE/chat/api/connectors/google/connect")
	state=$(python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlsplit(sys.argv[1]).query).get("state",[""])[0])' "$consent")
	back=$(python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlsplit(sys.argv[1]).query).get("redirect_uri",[""])[0])' "$consent")
	[ -n "$state" ] && [ -n "$back" ] || { bad "the connect did not send the person to the consent screen: ${consent:-nothing}"; return 1; }
	code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 30 -c "$jar" -b "$jar" "${fault[@]}" \
		"$back?code=selfhost-e2e-code&state=$state")
	grep -q 'google=connected' <<<"$code" || { bad "the callback did not connect Google: $code"; return 1; }
	pass "B connected Google through the connect flow ($code)"
}

answer=""
turn() { # jar prompt -> sets answer
	local jar=$1 prompt=$2 model cid data out="$work/turn.$RANDOM"
	model=$(curl -sf --max-time 20 -b "$jar" "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty')
	cid=$(curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
		-d "{\"model\":\"$model\"}" "$BASE/conversation" | jq -r '.conversationId // empty')
	[ -n "$cid" ] || { answer=""; bad "no conversation for the turn"; return 1; }
	data=$(jq -cn --arg p "$prompt" --arg id "$(newid)" --arg a "$(newid)" \
		'{inputs:$p, id:$id, is_retry:false, newMessageIds:{assistant:$a}, agentMode:"on"}')
	curl -sN --max-time "${CONNECTORS_TURN_TIMEOUT:-240}" -c "$jar" -b "$jar" -H "origin: $BASE" "${fault[@]}" \
		-F "data=$data" "$BASE/conversation/$cid" >"$out" || true
	answer=$(jq -rRs '[split("\n")[] | fromjson? ] as $ev
		| ($ev | map(select(.type=="finalAnswer") | .text) | last)
		// ($ev | map(select(.type=="stream") | .token) | join(""))' <"$out")
	echo "answer: $(tr '\n' ' ' <<<"$answer" | cut -c1-500)"
}

# The task ids agent-service accepted, oldest first, and the connector names each was sent.
agent_events() { compose logs --no-color --no-log-prefix agent 2>/dev/null | jq -cR --arg e "$1" 'fromjson? | select(.event==$e)'; }
gateway_events() { compose logs --no-color --no-log-prefix gateway 2>/dev/null | jq -cR --arg e "$1" 'fromjson? | select(.event==$e)'; }
last_task() { agent_events run.connectors | tail -n1; }

signup a && signup b || { echo "AGENT CONNECTORS FAIL"; exit 1; }
jar_a="$work/a.jar" jar_b="$work/b.jar"
pass "accounts A and B signed up"
connect_google "$jar_b" || { echo "AGENT CONNECTORS FAIL"; exit 1; }

QUESTION="What does the latest email in my Gmail say about the plot 7 rota?"

# 2. A, who never connected, while B has.
turn "$jar_a" "$QUESTION"
a_task=$(last_task)
a_id=$(jq -r '.id' <<<"$a_task")
if [ -n "$a_id" ] && [ "$(jq -c '.connectors' <<<"$a_task")" = "[]" ]; then
	pass "A's agent turn ($a_id) sent no connector: $a_task"
else
	bad "A's agent turn sent a connector, or never reached agent-service: ${a_task:-no run.connectors line}"
fi
a_grants=$(gateway_events grant.registered | jq -c --arg id "$a_id" 'select(.label==$id)')
if [ -n "$a_grants" ] && ! jq -e 'select(.mcp != [])' <<<"$a_grants" >/dev/null; then
	pass "A's grants carry no mcp map: $(tr '\n' ' ' <<<"$a_grants")"
else
	bad "A's grants carried a connector, or none was registered: ${a_grants:-none}"
fi
if grep -qF "$MESSAGE_FACT" <<<"$answer"; then bad "A's answer carries B's Gmail message"; fi

# 1. B's Gmail question.
turn "$jar_b" "$QUESTION"
b_task=$(last_task)
b_id=$(jq -r '.id' <<<"$b_task")
if [ "$b_id" != "$a_id" ] && [ "$(jq -c '.connectors' <<<"$b_task")" = '["google"]' ]; then
	pass "B's agent turn ($b_id) sent its Google connector: $b_task"
else
	bad "B's agent turn did not send its Google connector: ${b_task:-no run.connectors line}"
fi
b_grants=$(gateway_events grant.registered | jq -c --arg id "$b_id" 'select(.label==$id)')
if jq -e 'select(.mcp == ["google"])' <<<"$b_grants" >/dev/null 2>&1; then
	pass "B's grant carries the google relay: $(tr '\n' ' ' <<<"$b_grants")"
else
	bad "B's grant has no google relay: ${b_grants:-none}"
fi
if grep -qF "$MESSAGE_FACT" <<<"$answer"; then
	pass "B's agent answer carries the stand-in's Gmail message"
else
	bad "B's agent answer does not carry the stand-in's Gmail message"
fi
stub_log=$(compose logs --no-color --no-log-prefix google 2>&1)
if grep -q '"method": "tools/call", "tool": "search_gmail_messages"' <<<"$stub_log" &&
	! grep -q '"bearer_ok": false' <<<"$stub_log"; then
	pass "the connector was called with B's access token on every request"
else
	bad "the connector saw no search, or a request without the access token: $(grep 'google-stub request' <<<"$stub_log" | tail -n5 | tr '\n' ' ')"
fi

# 5. The token is nowhere it must not be. Positive control above: the connector saw it.
leaks=""
for c in $(docker ps -aq --filter "label=$SBX_LABEL"); do
	if docker inspect -f '{{json .Config.Env}}' "$c" | grep -qF "$ACCESS_TOKEN"; then leaks+=" sandbox-config-env:$c"; fi
	if docker exec "$c" sh -c 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\0" "\n"' 2>/dev/null | grep -qF "$ACCESS_TOKEN"; then
		leaks+=" sandbox-process-env:$c"
	fi
	if docker exec "$c" grep -rlaF "$ACCESS_TOKEN" /home/user /tmp 2>/dev/null | grep -q .; then leaks+=" sandbox-files:$c"; fi
done
if compose logs --no-color agent gateway 2>&1 | grep -qF "$ACCESS_TOKEN"; then leaks+=" service-logs"; fi
if compose exec -T agent sh -c "grep -rlaF '$ACCESS_TOKEN' /data" 2>/dev/null | grep -q .; then leaks+=" tasks.db"; fi
n_sbx=$(docker ps -aq --filter "label=$SBX_LABEL" | wc -l)
if [ "$n_sbx" -lt 1 ]; then
	bad "no sandbox container was left to search, so the sandbox half of the leak check proves nothing"
elif [ -n "$leaks" ]; then
	bad "the access token was found in:$leaks"
else
	pass "the access token is in none of $n_sbx sandbox(es)' env or files, the agent and gateway logs, or /data (tasks.db)"
fi

# 3. A call to a tool that is not read-only.
turn "$jar_b" "Send a reply to the latest email in my Gmail saying thanks."
if grep -q 'refused' <<<"$answer" && grep -q 'send_gmail_message' <<<"$answer"; then
	pass "the send was refused, and the answer says so"
else
	bad "the answer does not say the send was refused"
fi
if compose logs --no-color --no-log-prefix google 2>&1 | grep -q 'google-stub SENT'; then
	bad "the connector received the send the gateway should have refused"
else
	pass "the connector never received the send"
fi
refused=$(gateway_events mcp.refused | tail -n1)
[ -n "$refused" ] && pass "the gateway logged the refusal: $refused" || bad "the gateway logged no refusal"

# 4. The connector refuses the token partway through.
turn "$jar_b" "Search my Gmail for the lapsed access notice about plot 7."
if grep -q 'Reconnect Google' <<<"$answer"; then
	pass "a 401 from the connector reached the person as 'Reconnect Google'"
else
	bad "the answer does not tell the person to reconnect Google"
fi

if [ "$fail" -eq 0 ]; then echo "AGENT CONNECTORS PASS"; else echo "AGENT CONNECTORS FAIL"; fi
exit "$fail"
