#!/usr/bin/env bash
# Back up a running Alpha stack: the database as a plain SQL dump, and every volume that holds state
# the database does not, as a tarball each. README.md, "Back up and restore", says what to keep safe
# beside it.
#
#   ./backup.sh                  # into backups/<UTC timestamp>/ beside this file
#   ./backup.sh /srv/alpha-bak   # into that directory
#   ALPHA_COMPOSE_DIR=. ../selfhost/backup.sh   # the stack in the current directory (deploy/)
#
# What it writes:
#   db.sql.gz              pg_dump --clean --if-exists, so restore.sh replaces what a fresh database holds;
#                          left out, with a line saying so, when DATABASE_URL names a Postgres outside the stack
#   <volume>.tar.gz        one per volume the stack has of: files (people's files on the local store,
#                          key objects included), objects (the s3 profile's SeaweedFS), agent-secrets and
#                          agent-data (agent mode)
#
# The dump runs while the app serves. The services that write to those volumes are stopped for the
# seconds the copy takes and started again, so no file is copied half written. .env is not copied: it
# holds BETTER_AUTH_SECRET and any sealing master key, which belong somewhere other than the backups.
# Needs docker compose and gzip on the host.
set -euo pipefail
# A directory given on the command line is read from where you ran this; the default sits beside the
# compose file.
if [ -n "${1:-}" ]; then mkdir -p "$1" && out=$(cd "$1" && pwd); fi
cd "${ALPHA_COMPOSE_DIR:-$(dirname "$0")}"
if [ -z "${out:-}" ]; then
	out="backups/$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$out" && out=$(cd "$out" && pwd)
fi

# DATABASE_URL naming a host other than the bundled `db` means the data lives in a Postgres this stack
# does not run: the database is left to that server's own backups, and the volumes are still copied.
dburl=${DATABASE_URL:-$(sed -n 's/^[[:space:]]*DATABASE_URL=//p' .env 2>/dev/null | tail -n 1)}
dburl=${dburl#[\"\']}; dburl=${dburl%[\"\']}
dbhost=$(printf '%s' "$dburl" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]*).*#\2#')
external=
if [ -n "$dburl" ] && [ "$dbhost" != db ]; then external=$dbhost; fi
if [ -n "$external" ]; then
	web=$(docker compose ps -q web)
	[ -n "$web" ] || { echo "backup: the web service is not running here ($(pwd)); start the stack first" >&2; exit 1; }
	project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$web")
	# The image the bundled db would run carries tar.
	helper=${POSTGRES_IMAGE:-postgres:17-alpine}
else
	db=$(docker compose ps -q db)
	[ -n "$db" ] || { echo "backup: the db service is not running here ($(pwd)); start the stack first" >&2; exit 1; }
	project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$db")
	# The Postgres image the stack already runs carries tar, so the volume copies pull nothing.
	helper=$(docker inspect -f '{{ .Config.Image }}' "$db")
fi

started=$(date +%s)
if [ -n "$external" ]; then
	echo "skip database: DATABASE_URL points at a Postgres outside this stack ($external); back it up with that server's own tools, such as pg_dump run against it"
else
	docker compose exec -T db pg_dump -U alpha -d alpha --clean --if-exists | gzip > "$out/db.sql.gz.part"
	# pipefail fails the line above if pg_dump fails. pg_dump ends a whole dump with this line, so a
	# truncated one fails here too.
	gzip -dc "$out/db.sql.gz.part" | tail -n 5 | grep -q '^-- PostgreSQL database dump complete' \
		|| { echo "backup: the database dump is incomplete" >&2; exit 1; }
	mv "$out/db.sql.gz.part" "$out/db.sql.gz"
	echo "ok   database -> $out/db.sql.gz"
fi

# The running containers of the services that write to the volumes below (selfhost's SeaweedFS is
# `seaweedfs`, deploy's is `files`), in the order they start again: what web calls before web.
writers=()
for svc in seaweedfs files gateway agent web; do
	while read -r id; do [ -n "$id" ] && writers+=("$id"); done < <(docker ps -q \
		--filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$svc")
done
restart() { [ "${#writers[@]}" = 0 ] || docker start "${writers[@]}" >/dev/null; }
trap restart EXIT
[ "${#writers[@]}" = 0 ] || docker stop -t 30 "${writers[@]}" >/dev/null

for vol in files objects agent-secrets agent-data; do
	docker volume inspect "${project}_$vol" >/dev/null 2>&1 || continue
	docker run --rm --entrypoint tar -v "${project}_$vol:/volume:ro" -v "$out:/backup" "$helper" \
		czf "/backup/$vol.tar.gz" -C /volume .
	echo "ok   volume ${project}_$vol -> $out/$vol.tar.gz"
done

restart
trap - EXIT
echo "BACKUP DONE in $(($(date +%s) - started)) s: $out"
[ -z "$external" ] || echo "The database on $external is NOT in this backup: back it up there." >&2
echo "Keep .env (BETTER_AUTH_SECRET, CUSTODIAL_MASTER_IDENTITIES) safe as well, apart from this directory."
