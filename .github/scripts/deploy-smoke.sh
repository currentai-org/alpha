#!/usr/bin/env bash
# Smoke for deploy.yml. It exits with one of three verdicts:
#   0  a visitor could use the deployment.
#   1  the build is at fault: it must not take the host, or must give it back.
#   2  the guest turn or the legal page failed here and on the build the host serves now, so the fault is
#      upstream (the model provider, or the site host the legal pages live on), not this build. deploy.yml
#      goes ahead with a warning and rechecks it.
#
# The checks, in order:
#   1. /chat/healthcheck and / answer 200 (six tries, ten seconds apart). The app builds its model list
#      from the provider at boot, so a provider outage fails this step too: when it fails, CURRENT gets the
#      same check. CURRENT up means this build is at fault (1); CURRENT down too means the provider is (2).
#      With no CURRENT, a first deploy, it is 1.
#   2. / carries the chat composer's data-testid, so a page that loads without the chat surface fails.
#   3. The identity the build was given is the one it serves. When the identity file names a
#      statusPageUrl, /api/status must return it; when it names a siteHost, /privacy-notice must redirect to
#      another host whose page answers 200 (legal-page.sh). A build that lost its identity file fails here.
#      A target that gives a connection error or a 5xx is retried once, then tried from CURRENT: failing
#      there too means the site host is down for every build, so the checks go on and a smoke that
#      otherwise passes ends in 2.
#   4. With PICKER_SITE set, /api/models lists the committed picker's first entry for that site
#      (web/config/picker.ts) first, so a build that would hand every visitor another default model fails.
#      Steps 2 to 4 run only on a build that is up, and their failure is always 1.
#   5. One real chat turn as a signed-out guest (deploy/smoke.sh). It is judged on errors and safety
#      declines only, never on the answer's wording. An error is retried once after 20 s; a decline is not.
#      When the turn fails, CURRENT gets the same turn: if CURRENT answers, this build is at fault (1); if
#      it fails too, the provider is (2). With no CURRENT, the turn's failure is 1.
#
#   BASE=<url> [CURRENT=<url>] [BYPASS=<secret>] [IDENTITY=<file>] [PICKER_SITE=<site>] [PROVIDER_DOWN_OK=1] .github/scripts/deploy-smoke.sh
# CURRENT is the deployment the host serves now. BYPASS is Vercel's deployment protection bypass secret,
# sent as a header when set. IDENTITY is the identity file the build was given: by default the copy
# .github/scripts/deploy-prove-red.sh keeps in $RUNNER_TEMP, so a build that dropped the file still fails
# step 3, or web/config/deployment.json. PICKER_SITE names the picker list this deployment serves
# (develop or production). PROVIDER_DOWN_OK=1 turns verdict 2 into exit 0 with the step
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
fail() { echo "::error title=deploy smoke::$base: $*"; echo "verdict 1: the build is at fault"; exit 1; }
# shellcheck source=legal-page.sh
. "$(dirname "$0")/legal-page.sh"

# up URL: /chat/healthcheck and / both 200 within six tries, ten seconds apart.
up() {
	local attempt health root
	for attempt in 1 2 3 4 5 6; do
		health=$(code "$1/chat/healthcheck")
		root=$(code "$1/")
		echo "$1 attempt $attempt: healthcheck=$health root=$root"
		if [ "$health" = 200 ] && [ "$root" = 200 ]; then return 0; fi
		sleep 10
	done
	return 1
}
# provider_down WHAT [WHO]: verdict 2, or exit 0 with the step output provider_down=true under
# PROVIDER_DOWN_OK=1, which starts deploy.yml's recheck. WHO is what is down, the model provider by default.
provider_down() {
	local who=${2:-the model provider}
	echo "::warning title=deploy smoke::$base: $1 here and on $current too, so $who is the likely fault, not this build"
	echo "verdict 2: $who is down; the deploy goes ahead"
	if [ "${PROVIDER_DOWN_OK:-}" = 1 ]; then
		echo "provider_down=true" >> "${GITHUB_OUTPUT:-/dev/null}"
		exit 0
	fi
	exit 2
}

if ! up "$base"; then
	[ -n "$current" ] || fail "it never came up, and no build served the host before this one to compare with"
	echo "$base never came up; checking $current, which the host serves now"
	if up "$current"; then fail "it never came up, and $current is up: this build is at fault"; fi
	provider_down "the app never came up"
fi
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
		lrc=0
		legal_verdict "$base" "$current" || lrc=$?
		[ "$lrc" != 1 ] || fail "$LEGAL_WHY"
		if [ "$lrc" = 2 ]; then
			# The rest still runs: a down site host must not hide a broken build behind verdict 2.
			site_down=$LEGAL_WHY
			echo "down $LEGAL_WHY"
		else
			echo "ok   $LEGAL_WHY"
		fi
	fi
else
	echo "no $identity, so the deployment's identity is not checked"
fi

if [ -n "${PICKER_SITE:-}" ]; then
	want_model=$(node --input-type=module -e "const { PICKER } = await import('./web/config/picker.ts'); process.stdout.write(PICKER[process.argv[1]]?.[0] ?? '')" "$PICKER_SITE") ||
		fail "could not read the $PICKER_SITE picker from web/config/picker.ts"
	[ -n "$want_model" ] || fail "web/config/picker.ts has no $PICKER_SITE list"
	got_model=$(curl -sS "${hdr[@]}" --max-time 20 "$base/api/models" | jq -r '.[0].id // empty' 2>/dev/null)
	[ "$got_model" = "$want_model" ] ||
		fail "/api/models lists ${got_model:-nothing} first, not $want_model, the $PICKER_SITE picker's default: every visitor would get another model"
	echo "ok   /api/models lists $want_model first"
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
	[ -z "${site_down:-}" ] || provider_down "the legal page failed ($site_down)" "the site host"
	echo "smoke ok on $base"
	echo "verdict 0: a visitor can use it"
	exit 0
fi
if [ "$rc" = 3 ]; then why="was declined by a safety screen"; else why="got no answer"; fi
[ -n "$current" ] ||
	fail "a guest's turn $why (deploy/smoke.sh above says why), and no build served the host before this one to compare with"

echo "a guest's turn $why on $base; sending the same turn to $current, which the host serves now"
crc=0
answers "$current" || crc=$?
[ "$crc" != 0 ] || fail "a guest's turn $why here, and $current answers it: this build is at fault"
provider_down "a guest's turn $why"
