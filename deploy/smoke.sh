#!/usr/bin/env bash
# Smoke one running Alpha web container: the health check, the model list, then one chat
# turn as a signed-out guest, requiring a non-empty answer that no safety screen declined. Exits 3
# when a safety screen declined the turn and 1 on any other failure, so a caller can retry an error
# without retrying a decline.
#
#   deploy/smoke.sh                                  # against http://localhost:3000
#   SMOKE_BASE=https://alpha.example deploy/smoke.sh
#   SMOKE_EXPECT='fixed sentence' deploy/smoke.sh    # also require the answer to contain this text
#   SMOKE_CHAT_PATH= deploy/smoke.sh                 # a chat-surface build: chat at the root, not /chat
#   SMOKE_SECOND_PROMPT='...' deploy/smoke.sh        # then a follow-up turn in the same conversation, report-only
#   SMOKE_HEADER='name: value' deploy/smoke.sh       # send one more header on every request (a Vercel bypass)
#
# Each turn prints how long its first word and its whole answer took, measured from the request.
#
# .github/workflows/web-image.yml runs it against the image it just built, with e2e/local's upstream
# stub as the model; selfhost/smoke.sh runs it against the self-host compose stack. Needs curl and jq.
set -euo pipefail

BASE="${SMOKE_BASE:-http://localhost:${PORT:-3000}}"
# Where chat's routes are: /chat on the site build, the root on a chat-surface one. `-`, not `:-`, so
# an empty value means the root.
CHAT="${SMOKE_CHAT_PATH-/chat}"
PROMPT="${SMOKE_PROMPT:-Reply with one short sentence: what is the capital of France?}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jar="$tmp/jar"
out="$tmp/turn"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
declined() { echo "SMOKE FAIL: $*" >&2; exit 3; }
hdr=()
[ -z "${SMOKE_HEADER:-}" ] || hdr=(-H "$SMOKE_HEADER")

# 1. The app can serve a turn: the healthcheck is 200 only once the model registry can.
code=""
for _ in $(seq 1 "${SMOKE_READY_TRIES:-60}"); do
	code=$(curl -s "${hdr[@]}" -o "$tmp/health" -w '%{http_code}' --max-time 10 "$BASE$CHAT/healthcheck" || true)
	[ "$code" = 200 ] && break
	sleep 5
done
[ "$code" = 200 ] || { head -c 500 "$tmp/health" >&2 || true; fail "GET $CHAT/healthcheck never returned 200 (last: $code)"; }
echo "ok   $CHAT/healthcheck 200"

# 2. The model list.
models=$(curl -sf "${hdr[@]}" --max-time 20 "$BASE$CHAT/api/models") || fail "GET $CHAT/api/models failed"
model=$(jq -r '.[0].id // .[0].name // empty' <<<"$models")
[ -n "$model" ] || fail "no model advertised: $(head -c 500 <<<"$models")"
echo "ok   model $model"

# 3. A guest conversation. The POST mints the session cookie.
cid=$(curl -sf "${hdr[@]}" --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
	-d "{\"model\":\"$model\"}" "$BASE$CHAT/conversation" | jq -r '.conversationId // empty') \
	|| fail "POST $CHAT/conversation failed"
[ -n "$cid" ] || fail "no conversationId"
echo "ok   conversation $cid"

# 4. A turn, streamed as newline-delimited JSON, each line stamped with when it arrived. turn PROMPT PARENT
#    ASSISTANT_ID writes $out and sets answer, err, first_s (first stream token) and total_s, both from the request.
#    The answer is the finalAnswer frame's text, or the stream tokens joined when no finalAnswer arrives.
turn() {
	local data t0 code=0
	data=$(jq -cn --arg p "$1" --arg id "$2" --arg a "$3" '{inputs:$p, id:$id, is_retry:false, newMessageIds:{assistant:$a}}')
	t0=$EPOCHREALTIME
	curl -sN "${hdr[@]}" --max-time "${SMOKE_TURN_TIMEOUT:-180}" -c "$jar" -b "$jar" -H "origin: $BASE" \
		-F "data=$data" "$BASE$CHAT/conversation/$cid" |
		while IFS= read -r line; do printf '%s\t%s\n' "$EPOCHREALTIME" "$line"; done > "$out.stamped" || code=$?
	cut -f2- "$out.stamped" > "$out"
	answer=$(jq -rRs '[split("\n")[] | fromjson? ] as $ev
		| ($ev | map(select(.type=="finalAnswer") | .text) | last)
		// ($ev | map(select(.type=="stream") | .token) | join(""))' < "$out")
	err=$(jq -rRs '[split("\n")[] | fromjson? | select(.type=="status" and .status=="error") | .message] | first // empty' < "$out")
	# A safety decline streams a `safety` (input screen) or `outputSafety` (answer screen) update, then its
	# decline copy as the final answer. That copy is not empty, so it is checked on its own.
	declined=$(jq -rRs '[split("\n")[] | fromjson? | select(.type=="safety" or .type=="outputSafety") | "\(.type) \(.kind // "")"] | first // empty' < "$out")
	first_s=$(jq -rRs --argjson t0 "$t0" '[split("\n")[] | select(length > 0) | split("\t") as [$t, $l]
		| select(($l | fromjson? | .type) == "stream") | ($t | tonumber) - $t0] | first // empty | . * 10 | round / 10' < "$out.stamped")
	total_s=$(jq -rRs --argjson t0 "$t0" '[split("\n")[] | select(length > 0) | split("\t")[0] | tonumber] | last // empty
		| . - $t0 | . * 10 | round / 10' < "$out.stamped")
	return "$code"
}
newid() { cat /proc/sys/kernel/random/uuid; }

first_answer_id=$(newid)
turn "$PROMPT" "$(newid)" "$first_answer_id" || fail "turn request failed (curl exit $?)"
[ -z "$err" ] || fail "the turn ended on an error: $err"
[ -z "$declined" ] || declined "the safety screen declined the turn ($declined), so no model answered it"
[ -n "$(tr -d '[:space:]' <<<"$answer")" ] || { head -c 2000 "$out" >&2; fail "empty answer"; }
if [ -n "${SMOKE_EXPECT:-}" ] && ! grep -qF -- "$SMOKE_EXPECT" <<<"$answer"; then
	fail "the answer does not contain the expected text: $answer"
fi
echo "ok   answer: $answer"
echo "ok   turn 1: first word after ${first_s:-?} s, whole answer after ${total_s:-?} s"

# 5. Optionally a follow-up turn on the first answer, to time a turn whose prompt the model has mostly seen.
#    Report-only: what it prints is a measurement, and a failure here never fails the smoke.
if [ -n "${SMOKE_SECOND_PROMPT:-}" ]; then
	if turn "$SMOKE_SECOND_PROMPT" "$first_answer_id" "$(newid)" && [ -z "$err" ] && [ -z "$declined" ] && [ -n "$(tr -d '[:space:]' <<<"$answer")" ]; then
		echo "ok   turn 2: first word after ${first_s:-?} s, whole answer after ${total_s:-?} s"
	else
		echo "WARN turn 2 did not answer (report-only): ${err:-no answer}" >&2
	fi
fi
echo "SMOKE PASS"
