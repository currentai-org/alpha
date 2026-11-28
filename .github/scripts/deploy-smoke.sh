#!/usr/bin/env bash
# Smoke for deploy.yml. It exits with one of three verdicts:
#   0  a visitor could use the deployment.
#   1  the build is at fault: it must not take the host, or must give it back.
#   2  the guest turn failed here and on the build the host serves now, so the fault is upstream (the
#      model provider), not this build. deploy.yml goes ahead with a warning and rechecks it.
#
# The checks, in order:
#   1. /chat/healthcheck and / answer 200 (six tries, ten seconds apart), and / carries the chat composer's
#      data-testid, so a page that loads without the chat surface fails.
#   2. The identity the build was given is the one it serves. When the identity file names a
#      statusPageUrl, /api/status must return it; when it names a siteHost, /privacy-notice must resolve to
#      200 on another host. A build that lost its identity file fails here.
#   Neither calls the model provider (the model registry boots from a committed snapshot), so a provider
#   outage leaves them passing, and their failure is always verdict 1.
#   3. One real chat turn as a signed-out guest (deploy/smoke.sh). It is judged on errors and safety
#      declines only, never on the answer's wording. An error is retried once after 20 s; a decline is not.
#      When the turn fails, CURRENT gets the same turn: if CURRENT answers, this build is at fault (1); if
#      it fails too, the provider is (2). With no CURRENT, a first deploy, the turn's failure is 1.
#
#   BASE=<url> [CURRENT=<url>] [BYPASS=<secret>] [IDENTITY=<file>] [PROVIDER_DOWN_OK=1] .github/scripts/deploy-smoke.sh
# CURRENT is the deployment the host serves now. BYPASS is Vercel's deployment protection bypass secret,
# sent as a header when set. IDENTITY is the identity file the build was given: by default the copy
# .github/scripts/deploy-prove-red.sh keeps in $RUNNER_TEMP, so a build that dropped the file still fails
# step 2, or web/config/deployment.json. PROVIDER_DOWN_OK=1 turns verdict 2 into exit 0 with the step
# output provider_down=true, for a workflow step that goes ahead and lets a later job act on it.
set -u
base=${BASE:?BASE is the URL to smoke}
base=${base%/}
current=${CURRENT:-}
current=${current%/}
identity=${IDENTITY:-}
if [ -z "$identity" ]; then
	identity=web/config/deployment.json
	if [ -n "${RUNNER_TEMP:-}" ] && [ -f "$RUNNER_TEMP/deployment.json" ]; then identity=$RUNNER_TEMP/deployment.json; fi
fi
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

# turn URL: 0 when a guest's turn is answered, 3 when a safety screen declined it, 1 on any other failure.
turn() {
	SMOKE_BASE="$1" SMOKE_CHAT_PATH="" SMOKE_READY_TRIES=6 \
		SMOKE_HEADER="${BYPASS:+x-vercel-protection-bypass: $BYPASS}" \
		SMOKE_PROMPT="Reply with one short sentence: what is the capital of France?" \
		deploy/smoke.sh
}
# answers URL: turn, retried once on an error and never on a decline.
answers() {
	local rc=0
	turn "$1" || rc=$?
	[ "$rc" = 1 ] || return "$rc"
	echo "the turn on $1 errored; one retry in 20 s"
	sleep 20
	rc=0
	turn "$1" || rc=$?
	return "$rc"
}

rc=0
answers "$base" || rc=$?
if [ "$rc" = 0 ]; then
	echo "smoke ok on $base"
	exit 0
fi
if [ "$rc" = 3 ]; then why="was declined by a safety screen"; else why="got no answer"; fi
[ -n "$current" ] ||
	fail "a guest's turn $why (deploy/smoke.sh above says why), and no build served the host before this one to compare with"

echo "a guest's turn $why on $base; sending the same turn to $current, which the host serves now"
crc=0
answers "$current" || crc=$?
[ "$crc" != 0 ] || fail "a guest's turn $why here, and $current answers it: this build is at fault"
echo "::warning title=deploy smoke::$base: a guest's turn $why here and on $current too, so the model provider is the likely fault, not this build"
if [ "${PROVIDER_DOWN_OK:-}" = 1 ]; then
	echo "provider_down=true" >> "${GITHUB_OUTPUT:-/dev/null}"
	exit 0
fi
exit 2
