#!/usr/bin/env bash
# The self-host stack with a model provider that cannot be reached: OPENAI_BASE_URL names a closed port,
# so the model registry never builds. The app must still serve the home page and the status banner's
# endpoint, the healthcheck must say the app is up with the registry degraded (and stay 503, since no
# chat turn can be served), and a chat turn must get a 503 carrying the copy the chat shows.
#
#   .github/selfhost-dead-provider-smoke.sh   # from the repo root; builds and starts web and db, then down -v
#
# Needs docker compose, curl, jq and openssl.
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

BASE=${BASE:-http://127.0.0.1:3000}
UNAVAILABLE="The model is unavailable right now. Try again in a minute."
tmp=$(mktemp -d)

fail() {
	echo "FAIL $*" >&2
	exit 1
}

cleanup() {
	code=$?
	if [ "$code" != 0 ]; then
		docker compose ps -a >&2 || true
		docker compose logs --no-color --tail 80 web >&2 || true
	fi
	docker compose down -v >/dev/null 2>&1 || true
	exit "$code"
}
trap cleanup EXIT

# Port 9 (discard) is closed inside the web container, so every catalog fetch is refused at once.
sed -e "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" \
	-e 's|^OPENAI_BASE_URL=.*|OPENAI_BASE_URL=http://127.0.0.1:9/v1|' .env.example > .env
grep -q '^OPENAI_BASE_URL=http://127.0.0.1:9/v1$' .env || fail ".env does not point the provider at the closed port"

# No profile: no local model. web never turns healthy (its healthcheck answers 503), so no --wait.
docker compose up -d --build

code() { curl -s -o "$tmp/$2" -w '%{http_code}' --max-time 20 "${@:3}" "$BASE$1" || true; }

root=000
for _ in $(seq 1 60); do
	root=$(code / root -L)
	[ "$root" = 200 ] && break
	sleep 5
done
[ "$root" = 200 ] || fail "GET / answered $root with the provider down (want 200): $(head -c 300 "$tmp/root")"
echo "ok   / 200 with the provider down"

status=$(code /api/status status)
[ "$status" = 200 ] || fail "GET /api/status answered $status with the provider down (want 200)"
echo "ok   /api/status 200"

health=$(code /healthcheck health)
[ "$health" = 503 ] || fail "GET /healthcheck answered $health (want 503: no chat turn can be served)"
jq -e '.app == "up" and .registry == "degraded"' "$tmp/health" >/dev/null \
	|| fail "the healthcheck body does not say app up, registry degraded: $(head -c 300 "$tmp/health")"
echo "ok   /healthcheck 503, app up, registry degraded"

turn=$(code /conversation turn -X POST -H "origin: $BASE" -H 'content-type: application/json' -d '{"model":"any"}')
[ "$turn" = 503 ] || fail "starting a chat answered $turn (want 503): $(head -c 300 "$tmp/turn")"
[ "$(jq -r '.message // empty' "$tmp/turn")" = "$UNAVAILABLE" ] \
	|| fail "the refused chat does not carry the model-unavailable copy: $(head -c 300 "$tmp/turn")"
echo "ok   a chat turn is refused with: $UNAVAILABLE"
