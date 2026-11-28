#!/usr/bin/env bash
# Post one message to the team's alerts channel through SLACK_ALERT_WEBHOOK, an incoming webhook kept as
# a secret in the web-develop and web-production environments. Without it (a fork, a self-host) this
# prints a warning and sends nothing. It never fails the job: the step that calls it already says why.
# Under a prove_red mode nothing is posted: a test must not page the team. The alert goes to the step
# summary instead, so the run still shows what would have been sent.
#   RUN_URL=<url> [PROVE_RED=<mode>] .github/scripts/tell-alerts.sh '<message>'
set -u
text="$1${RUN_URL:+ $RUN_URL}"
if [ -n "${PROVE_RED:-}" ] && [ "$PROVE_RED" != none ]; then
	text="(a deliberate test, prove_red=$PROVE_RED) $text"
	echo "alert, not sent: $text"
	echo "**Alert not sent (prove_red=$PROVE_RED):** $text" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
	exit 0
fi
echo "alert: $text"
if [ -z "${SLACK_ALERT_WEBHOOK:-}" ]; then
	echo "::warning title=alert not sent::SLACK_ALERT_WEBHOOK is not set in this environment"
	exit 0
fi
jq -n --arg t "$text" '{text: $t}' |
	curl -sS --fail --max-time 20 -X POST -H 'content-type: application/json' -d @- "$SLACK_ALERT_WEBHOOK" >/dev/null ||
	echo "::warning title=alert not sent::the alerts webhook refused the message"
exit 0
