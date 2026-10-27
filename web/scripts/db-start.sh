#!/usr/bin/env bash
# Start (creating on first run) the local Postgres container ci-local.sh and the shared `dev`
# Doppler config both assume already exists: `aipotluck-dev-pg`, database `aipotluck_test`, on
# loopback 5432 — the exact DATABASE_URL Doppler's `dev` config declares
# (postgres://postgres:postgres@localhost:5432/aipotluck_test). ci-local.sh assumes this container
# exists and tells you to `docker start` it if it is stopped.
#
# postgres:16 matches .github/workflows/ci.yml's own service image, so local dev and CI run the
# same major version.
set -euo pipefail

NAME="aipotluck-dev-pg"

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
	echo "== $NAME already running"
	exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
	echo "== starting existing $NAME container"
	docker start "$NAME" >/dev/null
else
	echo "== creating $NAME (postgres:16, db aipotluck_test, loopback 5432)"
	docker run -d --name "$NAME" \
		-e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=aipotluck_test \
		-p 127.0.0.1:5432:5432 postgres:16 >/dev/null
fi

echo "== waiting for $NAME to accept connections"
for _ in $(seq 1 15); do
	docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && { echo "== ready"; exit 0; }
	sleep 1
done

echo "$NAME did not become ready after 15s — check \`docker logs $NAME\`" >&2
exit 1
