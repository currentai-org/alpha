#!/usr/bin/env bash
# Checks tell-alerts.sh posts a real alert and keeps a prove_red alert off the channel, against a local
# stand-in for the webhook. Run by ci.yml's workflow-lint job.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
dir=$(mktemp -d)
python3 -I -c '
import sys, http.server
log = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        open(log, "ab").write(body + b"\n")
        self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' 18401 "$dir/posts" &
pid=$!
trap 'kill $pid; rm -rf "$dir"' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null -X POST -H 'content-length: 0' http://127.0.0.1:18401/ && break; sleep 0.1; done
: > "$dir/posts"
export SLACK_ALERT_WEBHOOK=http://127.0.0.1:18401/ GITHUB_STEP_SUMMARY="$dir/summary"

failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }
PROVE_RED=provider .github/scripts/tell-alerts.sh "test alert one" > /dev/null
check "a prove_red alert is not posted" '[ ! -s "$dir/posts" ]'
check "a prove_red alert is in the step summary" 'grep -q "Alert not sent (prove_red=provider).*test alert one" "$dir/summary"'
PROVE_RED=none .github/scripts/tell-alerts.sh "real alert two" > /dev/null
check "an alert outside prove_red is posted" 'grep -q "real alert two" "$dir/posts"'
.github/scripts/tell-alerts.sh "real alert three" > /dev/null
check "an alert with no PROVE_RED is posted" 'grep -q "real alert three" "$dir/posts"'
[ "$failures" = 0 ] || { echo "$failures case(s) failed"; exit 1; }
echo "all cases pass"
