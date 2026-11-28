#!/usr/bin/env bash
# deploy-smoke.sh's legal-page check, sourced by it and by legal-page.test.sh. A build whose identity names a
# siteHost serves /privacy-notice as a redirect to that host, where the page itself lives.
#
# legal_verdict BASE [CURRENT] sets LEGAL_WHY and returns
#   0  BASE redirects /privacy-notice to another host, and the page there answers 200.
#   1  the build is at fault: no redirect to another host, the target answers 4xx, or the target fails for
#      BASE while the build the host serves now (CURRENT) reaches its own target. With no CURRENT, a failed
#      target is 1 too.
#   2  the target gave a connection error or a 5xx twice, and CURRENT's target fails the same way, so the
#      site host is down, not this build.
# Requests send ${hdr[@]} when the caller set it (Vercel's protection bypass). LEGAL_RETRY_WAIT is the pause
# in seconds before the target's one retry.

# legal_target URL: 0 when URL/privacy-notice reaches 200 on another host, 1 when the build is wrong, 2 when
# the target host failed twice with a connection error or a 5xx. Sets LEGAL_WHY.
legal_target() {
	local first code target host status
	# shellcheck disable=SC2154 # hdr is the caller's, and optional
	first=$(curl -sS ${hdr[@]+"${hdr[@]}"} -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' "$1/privacy-notice") || true
	code=${first%% *}
	target=${first#* }
	[ "$target" = "$first" ] && target=""
	host=${target#*://}
	host=${host%%/*}
	if [[ "$code" != 3?? ]] || [ -z "$host" ] || [ "$host" = "${1#*://}" ]; then
		LEGAL_WHY="/privacy-notice answered ${code:-nothing} with no redirect to another host: the build has no site host"
		return 1
	fi
	for attempt in 1 2; do
		status=$(curl -sS -o /dev/null -L --max-time 20 -w '%{http_code}' "$target") || true
		status=${status:0:3}
		if [ "$status" = 200 ]; then
			LEGAL_WHY="/privacy-notice resolves on $host"
			return 0
		fi
		if [[ "$status" = 4?? ]]; then
			LEGAL_WHY="/privacy-notice redirects to $target, which answers $status: the build points at the wrong page"
			return 1
		fi
		[ "$attempt" = 2 ] || sleep "${LEGAL_RETRY_WAIT:-5}"
	done
	LEGAL_WHY="/privacy-notice redirects to $target, which answered ${status:-000} twice"
	return 2
}

legal_verdict() {
	local rc=0 why
	legal_target "$1" || rc=$?
	[ "$rc" = 2 ] || return "$rc"
	why=$LEGAL_WHY
	if [ -z "${2:-}" ]; then
		LEGAL_WHY="$why, and no build served the host before this one to compare with"
		return 1
	fi
	rc=0
	legal_target "$2" || rc=$?
	if [ "$rc" = 2 ]; then
		LEGAL_WHY="$why, and $2's does too: the site host is down"
		return 2
	fi
	if [ "$rc" = 0 ]; then
		LEGAL_WHY="$why, while $2 reaches its own: this build is at fault"
	else
		LEGAL_WHY="$why, and $2 fails another way ($LEGAL_WHY): this build is at fault"
	fi
	return 1
}
