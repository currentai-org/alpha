#!/usr/bin/env bash
# Checks that a stack running compose.two-web.yaml behaves as one app when consecutive requests land on
# different web processes. The proxy names the process that answered each request in X-Served-By. Run by
# .github/workflows/load.yml's two-web job from the repository root, after up.sh, with COMPOSE_FILE naming
# compose.two-web.yaml and the aimock overlay.
#
# 1. reach:   requests reach both processes.
# 2. session: one guest session's turns are all answered, across both processes (no 401 or 404).
# 3. limit:   the per-session limit refuses the turn past RATE_LIMIT in a minute while turns alternate
#             processes. The job sets 20 (USAGE_LIMITS). A limit kept in one process's memory would let
#             about 40 through.
# 4. stop:    Stop sent to the process that is not streaming cuts a long answer short: its final event says
#             interrupted and holds less than the whole answer. Stop markers live in Postgres, and the
#             streaming process polls them once a second. How long the stream took to end is reported.
#
# Writes loadtest-out/two-web/checks.json and a table to the step summary. Exits 1 when a check fails.
set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
OUT="loadtest-out/two-web"
mkdir -p "$OUT"
TMP=$(mktemp -d "$OUT/tmp.XXXX")
LIMIT=$(jq -r '.messagesPerMinute // 20' <<< "${USAGE_LIMITS:-{\}}")
LONG_FIXTURES="$PWD/deploy/loadtest/long-model"
RESULTS="$OUT/results.jsonl"
: > "$RESULTS"

served() { awk 'tolower($1) == "x-served-by:" { gsub(/\r/, "", $2); print $2 }' "$1"; }
result() { # name pass detail
	jq -nc --arg name "$1" --argjson pass "$2" --arg detail "$3" '{name: $name, pass: $pass, detail: $detail}' >> "$RESULTS"
	echo "$( [ "$2" = true ] && echo PASS || echo FAIL ) $1: $3"
}

MODEL=$(curl -fsS "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty')
[ -n "$MODEL" ] || { echo "::error::no model advertised by $BASE/api/models"; exit 1; }

create() { # jar -> conversation id
	curl -sS -c "$1" -b "$1" -H "origin: $BASE" -H 'content-type: application/json' \
		-d "{\"model\":\"$MODEL\"}" "$BASE/conversation" | jq -r '.conversationId // empty'
}
# turn <jar> <id> <text> <tag>: writes $TMP/<tag>.h and .b, prints "<status> <served by> <answered>"
turn() {
	local data status ok
	data=$(jq -nc --arg inputs "$3" --arg id "$(cat /proc/sys/kernel/random/uuid)" \
		'{inputs: $inputs, id: $id, is_retry: false, webSearchMode: "off"}')
	status=$(curl -sS -c "$1" -b "$1" -H "origin: $BASE" -D "$TMP/$4.h" -o "$TMP/$4.b" -w '%{http_code}' \
		--max-time 120 --form-string "data=$data" "$BASE/conversation/$2")
	ok=false
	if [ "$status" = 200 ] && grep -q '"finalAnswer"' "$TMP/$4.b" && ! grep -q -e '"status":"error"' -e '"type":"safety"' "$TMP/$4.b"; then ok=true; fi
	echo "$status $(served "$TMP/$4.h") $ok"
}

# 1. reach
WEB_COUNT=$(cd deploy && docker compose ps -q web | wc -l)
for i in $(seq 1 10); do curl -sS -o /dev/null -D "$TMP/reach$i.h" "$BASE/healthcheck"; served "$TMP/reach$i.h"; done | sort -u > "$TMP/reach.txt"
N=$(grep -c . "$TMP/reach.txt")
result reach "$([ "$N" -ge 2 ] && echo true || echo false)" "$WEB_COUNT web containers; 10 health checks reached $N processes ($(paste -sd' ' "$TMP/reach.txt"))"

# 2. session
JAR="$TMP/session.jar"
ID=$(create "$JAR")
ANSWERED=0
SERVERS=()
BAD=""
for i in $(seq 1 8); do
	read -r STATUS BY OK < <(turn "$JAR" "$ID" "What is the capital of Norway? ($i)" "session$i")
	SERVERS+=("$BY")
	[ "$OK" = true ] && ANSWERED=$((ANSWERED + 1)) || BAD="$BAD turn $i HTTP $STATUS;"
done
DISTINCT=$(printf '%s\n' "${SERVERS[@]}" | sort -u | grep -c .)
result session "$([ -n "$ID" ] && [ "$ANSWERED" = 8 ] && [ "$DISTINCT" -ge 2 ] && echo true || echo false)" \
	"$ANSWERED of 8 turns answered in one guest session, across $DISTINCT processes;${BAD:- no failures}"

# 3. limit: as fast as turns answer, two conversations so neither nears its own message cap.
JAR="$TMP/limit.jar"
IDS=("$(create "$JAR")" "$(create "$JAR")")
T0=$(date +%s)
FIRST429=""
STATUSES=""
BEFORE=()
for i in $(seq 1 $((LIMIT + 5))); do
	read -r STATUS BY _ < <(turn "$JAR" "${IDS[$((i % 2))]}" "Limit turn $i" "limit$i")
	STATUSES="$STATUSES $STATUS"
	if [ "$STATUS" = 429 ]; then FIRST429=$i; break; fi
	BEFORE+=("$BY")
done
SECS=$(($(date +%s) - T0))
DISTINCT=$(printf '%s\n' "${BEFORE[@]}" | sort -u | grep -c .)
result limit "$([ "$FIRST429" = "$((LIMIT + 1))" ] && [ "$DISTINCT" -ge 2 ] && [ "$SECS" -lt 60 ] && echo true || echo false)" \
	"first 429 at turn ${FIRST429:-none} of a limit of $LIMIT, in ${SECS}s; the turns before it went to $DISTINCT processes; statuses:$STATUSES"

# 4. stop: a long answer (deploy/loadtest/long-model, about 40 s at 20 tokens a second).
(cd deploy && AIMOCK_FIXTURES="$LONG_FIXTURES" docker compose up -d --wait --wait-timeout 120 aimock) >/dev/null
JAR="$TMP/stop.jar"
ID=$(create "$JAR")
DATA=$(jq -nc --arg id "$(cat /proc/sys/kernel/random/uuid)" '{inputs: "Tell me a long story", id: $id, is_retry: false, webSearchMode: "off"}')
START=$(date +%s.%N)
curl -sS -N -c "$JAR" -b "$JAR" -H "origin: $BASE" -D "$TMP/stream.h" -o "$TMP/stream.b" --max-time 120 \
	--form-string "data=$DATA" "$BASE/conversation/$ID" &
STREAM=$!
sleep 5
STREAM_BY=$(served "$TMP/stream.h")
# A Stop that reached the streaming process would end it through that process's own memory and prove
# nothing. So health checks run until one lands on the streaming process; the proxy's next turn, the Stop,
# then goes to the other.
for _ in 1 2 3 4; do
	curl -sS -o /dev/null -D "$TMP/nudge.h" "$BASE/healthcheck"
	[ "$(served "$TMP/nudge.h")" = "$STREAM_BY" ] && break
done
STOP_STATUS=$(curl -sS -o "$TMP/stop.b" -c "$JAR" -b "$JAR" -H "origin: $BASE" -H 'content-type: application/json' \
	-d '{}' -D "$TMP/stop.h" -w '%{http_code}' "$BASE/conversation/$ID/stop-generating")
STOP_BY=$(served "$TMP/stop.h")
STOPPED=$(date +%s.%N)
wait "$STREAM"
ENDED=$(date +%s.%N)
AFTER=$(awk -v a="$STOPPED" -v b="$ENDED" 'BEGIN { printf "%.1f", b - a }')
TOTAL=$(awk -v a="$START" -v b="$ENDED" 'BEGIN { printf "%.1f", b - a }')
FULL_LEN=$(jq -r '.fixtures[0].response.content | length' "$LONG_FIXTURES/fixtures.json")
# The answer's final event says whether it was cut and carries the text that was kept.
read -r GOT_LEN INTERRUPTED < <(jq -rR 'fromjson? | select(.type == "finalAnswer") | "\(.text | length) \(.interrupted // false)"' "$TMP/stream.b" | tail -n 1)
result stop "$([ -n "$STREAM_BY" ] && [ "$STOP_BY" != "$STREAM_BY" ] && [ "$STOP_STATUS" = 200 ] && [ "${INTERRUPTED:-}" = true ] && [ "${GOT_LEN:-$FULL_LEN}" -lt "$FULL_LEN" ] && echo true || echo false)" \
	"streamed by $STREAM_BY, Stop answered HTTP $STOP_STATUS by $STOP_BY; the final answer says interrupted=${INTERRUPTED:-none} with ${GOT_LEN:-no} of $FULL_LEN characters; the stream ended ${AFTER}s after Stop, ${TOTAL}s after it began"
(cd deploy && AIMOCK_FIXTURES='' docker compose up -d --wait --wait-timeout 120 aimock) >/dev/null

jq -s '.' "$RESULTS" > "$OUT/checks.json"
{
	echo "### Two web processes"
	echo
	echo "| Check | Result | What it saw |"
	echo "| --- | --- | --- |"
	jq -r '.[] | "| \(.name) | \(if .pass then "pass" else "**fail**" end) | \(.detail) |"' "$OUT/checks.json"
	echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
# Kept beside checks.json when a check fails: the headers and bodies say why.
jq -e 'all(.pass)' "$OUT/checks.json" >/dev/null && rm -rf "$TMP" && exit 0
exit 1
