#!/usr/bin/env bash
# Checks legal-page.sh's verdicts against local stand-ins: two builds that redirect /privacy-notice, and site
# hosts that answer, refuse, 404 or drop the first connection. Run by ci.yml's workflow-lint job.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
. ./legal-page.sh
export LEGAL_RETRY_WAIT=0

# serve PORT MODE: redirect:<url> (/privacy-notice 301s there), ok, notfound, error (500) or flaky (drops the
# first connection, then 200).
pids=()
serve() {
	python3 -I -c '
import sys, http.server
port, mode = int(sys.argv[1]), sys.argv[2]
state = {"n": 0}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        state["n"] += 1
        if mode.startswith("redirect:"):
            self.send_response(301); self.send_header("Location", mode[9:] + self.path); self.end_headers(); return
        if mode == "flaky" and state["n"] == 1:
            self.connection.close(); return
        code = {"ok": 200, "flaky": 200, "notfound": 404, "error": 500}[mode]
        self.send_response(code); self.send_header("Content-Length", "0"); self.end_headers()
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
' "$1" "$2" &
	pids+=($!)
}
trap 'kill "${pids[@]}" 2>/dev/null' EXIT

serve 18301 ok
serve 18302 notfound
serve 18303 error
serve 18304 flaky
# 18309 has nothing listening: a refused connection, as from a site host that is down.
serve 18311 redirect:http://127.0.0.1:18301 # a build whose site host answers
serve 18312 redirect:http://127.0.0.1:18309 # a build whose site host is down
serve 18313 redirect:http://127.0.0.1:18309 # the build before it, same site host
serve 18314 redirect:http://127.0.0.1:18302 # a build that points at a page that isn't there
serve 18315 ok                               # a build with no redirect at all
serve 18316 redirect:http://127.0.0.1:18303 # a site host that answers 500
serve 18317 redirect:http://127.0.0.1:18304 # a site host that drops the first connection
for port in 18301 18302 18303 18304 18311 18312 18313 18314 18315 18316 18317; do
	for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
done
B=http://127.0.0.1

failures=0
expect() { # name want base [current]
	local rc=0
	legal_verdict "$3" "${4:-}" || rc=$?
	if [ "$rc" = "$2" ]; then echo "ok   $1: verdict $rc ($LEGAL_WHY)"
	else echo "FAIL $1: verdict $rc, want $2 ($LEGAL_WHY)"; failures=$((failures + 1)); fi
}
expect "a site host that answers passes" 0 "$B:18311" "$B:18313"
expect "a site host down for both builds is an outage" 2 "$B:18312" "$B:18313"
expect "a site host down for this build only blames the build" 1 "$B:18312" "$B:18311"
expect "a site host down with no build before blames the build" 1 "$B:18312"
expect "a 500 for both builds is an outage" 2 "$B:18316" "$B:18316"
expect "a redirect to a page that 404s blames the build" 1 "$B:18314" "$B:18314"
expect "no redirect to another host blames the build" 1 "$B:18315" "$B:18311"
expect "a dropped first connection passes on the retry" 0 "$B:18317" "$B:18311"
[ "$failures" = 0 ] || { echo "$failures case(s) failed"; exit 1; }
echo "all cases pass"
