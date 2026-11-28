#!/usr/bin/env bash
# Smoke for deploy.yml. A deployment passes only when a visitor could use it:
#   1. /chat/healthcheck and / answer 200 (six tries, ten seconds apart), and / carries the chat composer's
#      data-testid, so a page that loads without the chat surface fails.
#   2. The identity the build was given is the one it serves. When web/config/deployment.json names a
#      statusPageUrl, /api/status must return it; when it names a siteHost, /privacy-notice must resolve
#      to 200 on another host. A build that lost its identity file fails here.
#   3. One real chat turn as a signed-out guest (deploy/smoke.sh), which fails on an error, an empty answer
#      or a safety decline, so a deployment whose model or screen is broken never takes the host.
#
#   BASE=<url> [BYPASS=<secret>] [SMOKE_EXPECT=<text>] .github/scripts/deploy-smoke.sh
# BYPASS is Vercel's deployment protection bypass secret, sent as a header; a preview build answers 401
# without it. SMOKE_EXPECT also requires the answer to contain that text (deploy.yml's prove_red input
# sets text no answer has, to show the gate goes red).
set -u
base=${BASE:?BASE is the URL to smoke}
base=${base%/}
hdr=()
if [ -n "${BYPASS:-}" ]; then hdr=(-H "x-vercel-protection-bypass: $BYPASS"); fi
code() { curl -sS "${hdr[@]}" -o /dev/null -w '%{http_code}' -L "$1" || echo 000; }
fail() { echo "::error title=deploy smoke::$base: $*"; exit 1; }

up=false
for attempt in 1 2 3 4 5 6; do
	health=$(code "$base/chat/healthcheck")
	root=$(code "$base/")
	echo "attempt $attempt: healthcheck=$health root=$root"
	if [ "$health" = 200 ] && [ "$root" = 200 ]; then up=true; break; fi
	sleep 10
done
$up || fail "healthcheck=$health root=$root"
curl -sS "${hdr[@]}" -L "$base/" | grep -q 'data-testid="chat-scroll"' ||
	fail "/ is 200 but has no chat-scroll marker: the chat surface is not at the root"
echo "ok   / serves the chat"

identity=web/config/deployment.json
if [ -f "$identity" ]; then
	want_status=$(jq -r '.statusPageUrl // empty' "$identity")
	if [ -n "$want_status" ]; then
		got_status=$(curl -sS "${hdr[@]}" --max-time 20 "$base/api/status" | jq -r '.url // empty' 2>/dev/null)
		[ "$got_status" = "$want_status" ] ||
			fail "/api/status names status page '${got_status:-none}', not the identity file's: the build lost its identity"
		echo "ok   /api/status names the status page"
	fi
	if [ -n "$(jq -r '.siteHost // empty' "$identity")" ]; then
		read -r final status < <(curl -sS "${hdr[@]}" -o /dev/null -L --max-time 20 -w '%{url_effective} %{http_code}' "$base/privacy-notice" || echo "none 000")
		host=${final#*://}; host=${host%%/*}
		[ "$status" = 200 ] && [ "$host" != "${base#*://}" ] ||
			fail "/privacy-notice ended at $final ($status), not on the site host: the build has no site host"
		echo "ok   /privacy-notice resolves on $host"
	fi
else
	echo "no $identity, so the deployment's identity is not checked"
fi

SMOKE_BASE="$base" SMOKE_CHAT_PATH="" SMOKE_READY_TRIES=6 \
	SMOKE_HEADER="${BYPASS:+x-vercel-protection-bypass: $BYPASS}" \
	SMOKE_PROMPT="Reply with one short sentence: what is the capital of France?" \
	deploy/smoke.sh || fail "a guest's chat turn did not get an answer (deploy/smoke.sh above says why)"
echo "smoke ok on $base"
