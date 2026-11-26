#!/usr/bin/env bash
# The self-host stack comes back by itself, the way selfhost/README.md says ("When a service crashes"),
# on a running stack.
#
#   .github/selfhost-crash-restart-smoke.sh                     # a stack smoke.sh left up
#   COMPOSE_PROFILES=local,s3 .github/selfhost-crash-restart-smoke.sh
#
# 1. A crash: the main process of llama and then of web is killed with SIGKILL from the host, as an
#    out-of-memory kill would, and no compose command runs after. Each must restart (its RestartCount
#    goes up) and turn healthy again, and /healthcheck must answer 200.
# 2. A reboot: the Docker daemon restarts, which stops every container the way a host reboot does. Every
#    service that was running before must be running and healthy again, with no compose command.
# SKIP_DAEMON_RESTART=<reason> stops after part 1, for a stack whose override files add services the
# web container depends on that compose.yaml does not restart (a CI that adds its own services).
# Prints one ok/RESTART FAIL line per check and RESTART PASS at the end; exits non-zero on any failure.
# Needs docker compose, curl and passwordless sudo (a GitHub-hosted runner has it).
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

export COMPOSE_PROFILES="${COMPOSE_PROFILES:-local}"
BASE="http://localhost:${PORT:-3000}"
fail() { echo "RESTART FAIL: $*" >&2; exit 1; }
app_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/healthcheck" || true)" = 200 ]; }
state() { # container id -> "<status> <health or none> <restart count>"
	docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$1" 2>/dev/null || echo "gone none -1"
}
started=$(date +%s)

app_ok || fail "GET /healthcheck is not 200 before the checks; start the stack first"

# 1. A crash, one service at a time.
for svc in llama web; do
	cid=$(docker compose ps -q "$svc")
	[ -n "$cid" ] || fail "$svc is not running before the crash"
	read -r _ _ before <<<"$(state "$cid")"
	pid=$(docker inspect -f '{{.State.Pid}}' "$cid")
	[ "$pid" -gt 0 ] || fail "$svc has no host pid to kill"
	t0=$(date +%s)
	sudo kill -KILL "$pid"
	back=""
	for _ in $(seq 1 120); do
		read -r status health count <<<"$(state "$cid")"
		if [ "$count" -gt "$before" ] && [ "$status" = running ] && [ "$health" = healthy ]; then
			back=1
			break
		fi
		sleep 5
	done
	[ -n "$back" ] || fail "$svc did not come back healthy after SIGKILL: $(state "$cid") (restart count was $before)"
	echo "ok   $svc killed with SIGKILL restarted by itself and was healthy again in $(($(date +%s) - t0)) s"
done
for _ in $(seq 1 24); do app_ok && break; sleep 5; done
app_ok || fail "GET /healthcheck is not 200 after the crashes"
echo "ok   /healthcheck answers 200 after both crashes"

# 2. A reboot: every compose.yaml service running now must be running and healthy after the daemon
# restarts. Services a CI-only override file adds are left out: they are not what an operator runs.
if [ -n "${SKIP_DAEMON_RESTART:-}" ]; then
	echo "SKIP daemon restart: $SKIP_DAEMON_RESTART"
	echo "RESTART PASS in $(($(date +%s) - started)) s (crashes only)"
	exit 0
fi
mapfile -t services < <(comm -12 <(docker compose ps --status running --services | sort) \
	<(docker compose -f compose.yaml config --services 2>/dev/null | sort))
[ "${#services[@]}" -gt 0 ] || fail "no running services before the daemon restart"
t0=$(date +%s)
sudo systemctl restart docker
missing=""
for _ in $(seq 1 120); do
	missing=""
	for svc in "${services[@]}"; do
		cid=$(docker compose ps -q "$svc" 2>/dev/null || true)
		read -r status health _ <<<"$( [ -n "$cid" ] && state "$cid" || echo "gone none -1")"
		if [ "$status" != running ] || { [ "$health" != none ] && [ "$health" != healthy ]; }; then
			missing="$missing $svc($status/$health)"
		fi
	done
	[ -z "$missing" ] && app_ok && break
	sleep 5
done
[ -z "$missing" ] || fail "after the daemon restart these did not come back by themselves:$missing"
app_ok || fail "GET /healthcheck is not 200 after the daemon restart"
echo "ok   after a Docker daemon restart every service came back healthy by itself in $(($(date +%s) - t0)) s: ${services[*]}"
echo "RESTART PASS in $(($(date +%s) - started)) s"
