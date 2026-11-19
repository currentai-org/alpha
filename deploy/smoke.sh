#!/usr/bin/env bash
# Smoke one running Alpha web container: the health check, the model list, then one chat
# turn as a signed-out guest, requiring a non-empty answer. Exits non-zero on any failure.
#
#   deploy/smoke.sh                                  # against http://localhost:3000
#   SMOKE_BASE=https://alpha.example deploy/smoke.sh
#   SMOKE_EXPECT='fixed sentence' deploy/smoke.sh    # also require the answer to contain this text
#   SMOKE_CHAT_PATH= deploy/smoke.sh                 # a chat-surface build: chat at the root, not /chat
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

# 1. The app can serve a turn: the healthcheck is 200 only once the model registry can.
code=""
for _ in $(seq 1 "${SMOKE_READY_TRIES:-60}"); do
	code=$(curl -s -o "$tmp/health" -w '%{http_code}' --max-time 10 "$BASE$CHAT/healthcheck" || true)
	[ "$code" = 200 ] && break
	sleep 5
done
[ "$code" = 200 ] || { head -c 500 "$tmp/health" >&2 || true; fail "GET $CHAT/healthcheck never returned 200 (last: $code)"; }
echo "ok   $CHAT/healthcheck 200"

# 2. The model list.
models=$(curl -sf --max-time 20 "$BASE$CHAT/api/models") || fail "GET $CHAT/api/models failed"
model=$(jq -r '.[0].id // .[0].name // empty' <<<"$models")
[ -n "$model" ] || fail "no model advertised: $(head -c 500 <<<"$models")"
echo "ok   model $model"

# 3. A guest conversation. The POST mints the session cookie.
cid=$(curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
	-d "{\"model\":\"$model\"}" "$BASE$CHAT/conversation" | jq -r '.conversationId // empty') \
	|| fail "POST $CHAT/conversation failed"
[ -n "$cid" ] || fail "no conversationId"
echo "ok   conversation $cid"

# 4. One turn, streamed as newline-delimited JSON. The answer is the finalAnswer frame's text, or the
#    stream tokens joined when no finalAnswer arrives.
data=$(jq -cn --arg p "$PROMPT" --arg id "$(cat /proc/sys/kernel/random/uuid)" '{inputs:$p, id:$id, is_retry:false}')
curl -sN --max-time "${SMOKE_TURN_TIMEOUT:-180}" -c "$jar" -b "$jar" -H "origin: $BASE" \
	-F "data=$data" "$BASE$CHAT/conversation/$cid" > "$out" || fail "turn request failed (curl exit $?)"
answer=$(jq -rRs '[split("\n")[] | fromjson? ] as $ev
	| ($ev | map(select(.type=="finalAnswer") | .text) | last)
	// ($ev | map(select(.type=="stream") | .token) | join(""))' < "$out")
err=$(jq -rRs '[split("\n")[] | fromjson? | select(.type=="status" and .status=="error") | .message] | first // empty' < "$out")
[ -z "$err" ] || fail "the turn ended on an error: $err"
[ -n "$(tr -d '[:space:]' <<<"$answer")" ] || { head -c 2000 "$out" >&2; fail "empty answer"; }
if [ -n "${SMOKE_EXPECT:-}" ] && ! grep -qF -- "$SMOKE_EXPECT" <<<"$answer"; then
	fail "the answer does not contain the expected text: $answer"
fi
echo "ok   answer: $answer"
echo "SMOKE PASS"
