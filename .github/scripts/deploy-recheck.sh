#!/usr/bin/env bash
# deploy.yml's recheck. A deploy went ahead although a guest's turn failed on the new build and on the build
# it replaced (deploy-smoke.sh's verdict 2). Every 15 minutes, for RECHECK_MINUTES (default 180), this smokes the host
# again against CURRENT:
#   - verdict 0: the turn answers again. It tells the alerts channel and ends green.
#   - verdict 1: the new build still fails while CURRENT answers (or its identity broke). The host moves
#     back to CURRENT, the step's output rolled_back is true, and it ends red.
#   - verdict 2: both still fail, so it waits for the next check. When the window ends it tells the alerts
#     channel and ends red.
# It ends green at once when HOST no longer serves WATCH: a newer deploy, or a person, moved the host, and
# that run or person owns it now.
#
#   WATCH=<deployment url> CURRENT=<url> HOST=<host> MOVE_BACK=alias|promote [RECHECK_MINUTES=180] \
#     VERCEL_CLI=.. VERCEL_SCOPE=.. VERCEL_TOKEN=.. [BYPASS=..] .github/scripts/deploy-recheck.sh
# With HOST empty (deploy.yml's prove_red=provider run) it smokes WATCH itself and moves nothing.
set -u
watch=${WATCH:?WATCH is the deployment the deploy left on the host}
current=${CURRENT:?CURRENT is the deployment to compare with and to move back to}
host=${HOST:-}
window=${RECHECK_MINUTES:-180}
[[ $window =~ ^[0-9]+$ ]] || { echo "::error::RECHECK_MINUTES is '$window', not a number of minutes"; exit 1; }
every=${RECHECK_EVERY:-900}
vercel() { npx --yes "$VERCEL_CLI" "$@" --scope "$VERCEL_SCOPE" --token "$VERCEL_TOKEN"; }
id_of() { vercel api "/v13/deployments/$1" | jq -er .id; }
tell() { .github/scripts/tell-alerts.sh "$1"; }
label=${host:-$watch}

want=$(id_of "${watch#https://}") || want=""
deadline=$(($(date +%s) + window * 60))
while :; do
	sleep "$every"
	base=$watch
	if [ -n "$host" ]; then
		got=$(id_of "$host") || got=""
		if [ -n "$want" ] && [ -n "$got" ] && [ "$got" != "$want" ]; then
			echo "$host serves $got now, not $want, so whoever moved it owns it; the recheck ends"
			exit 0
		fi
		base="https://$host"
	fi
	rc=0
	BASE="$base" CURRENT="$current" .github/scripts/deploy-smoke.sh || rc=$?
	case $rc in
	0)
		tell "✅ $label answers a guest's turn again; the recheck ends."
		exit 0
		;;
	1)
		if [ -z "$host" ]; then
			echo "::error::$watch is at fault and $current answers"
			exit 1
		fi
		echo "rolled_back=true" >> "${GITHUB_OUTPUT:-/dev/null}"
		if [ "$MOVE_BACK" = promote ]; then
			vercel promote "$current" --yes
		else
			vercel alias set "$current" "$host"
		fi
		tell "🔴 $host still fails a guest's turn while $current answers it, so the recheck moved $host back to $current."
		echo "::error::$host failed its recheck while $current answers; it is back on $current"
		exit 1
		;;
	esac
	if [ "$(date +%s)" -ge "$deadline" ]; then
		tell "🔴 $label and $current have both failed a guest's turn for $window minutes; the recheck stops here, red. Read the provider's status, then the run."
		echo "::error::no guest turn answered on $label or $current for $window minutes"
		exit 1
	fi
	echo "both still fail; next check in $((every / 60)) minutes"
done
