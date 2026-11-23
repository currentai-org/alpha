#!/usr/bin/env bash
# Restore a directory backup.sh wrote into a running Alpha stack. README.md, "Back up and restore", has
# the whole procedure; in short, restore into a stack started fresh from the same release:
#
#   docker compose --profile local down -v     # only when you mean to replace everything
#   docker compose --profile local up -d --wait
#   ./restore.sh backups/20261122T030000Z
#
# The database dump is loaded in one transaction that stops at the first error, so a failed restore
# leaves the database as it was. Each volume tarball in the directory replaces that volume's contents.
# The services that use those volumes are stopped first and started again at the end; web applies any
# migration newer than the dump when it starts. Use the same .env the backup was taken under: its
# BETTER_AUTH_SECRET and CUSTODIAL_MASTER_IDENTITIES are what open the restored sessions, linked
# credentials and sealed files.
#
#   ALPHA_COMPOSE_DIR=. ../selfhost/restore.sh <dir>   # the stack in the current directory (deploy/)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src="${1:?usage: restore.sh <directory backup.sh wrote>}"
src=$(cd "$src" && pwd)
cd "${ALPHA_COMPOSE_DIR:-$here}"

fail() { echo "restore: $*" >&2; exit 1; }
[ -s "$src/db.sql.gz" ] || fail "no db.sql.gz in $src"
db=$(docker compose ps -q db)
[ -n "$db" ] || fail "the db service is not running here ($(pwd)); start the stack first"
project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$db")
helper=$(docker inspect -f '{{ .Config.Image }}' "$db")

vols=()
for vol in files objects agent-secrets agent-data; do
	[ -f "$src/$vol.tar.gz" ] || continue
	docker volume inspect "${project}_$vol" >/dev/null 2>&1 \
		|| fail "the backup has $vol.tar.gz but this stack has no ${project}_$vol volume: start it with the profile that uses it, then run this again"
	vols+=("$vol")
done

# Started again in this order: the file store and the agent's gateway before what calls them.
writers=()
for svc in seaweedfs files gateway agent web; do
	while read -r id; do [ -n "$id" ] && writers+=("$id"); done < <(docker ps -q \
		--filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$svc")
done
trap 'echo "restore: failed; the stopped services stay stopped. Fix the cause and run it again, or start them with docker compose up -d" >&2' ERR
[ "${#writers[@]}" = 0 ] || docker stop -t 30 "${writers[@]}" >/dev/null

started=$(date +%s)
gzip -dc "$src/db.sql.gz" | docker compose exec -T -e PGOPTIONS=--client-min-messages=warning db \
	psql -U alpha -d alpha --single-transaction -v ON_ERROR_STOP=1 -q >/dev/null
echo "ok   database <- $src/db.sql.gz"

for vol in "${vols[@]}"; do
	docker run --rm --entrypoint sh -v "${project}_$vol:/volume" -v "$src:/backup:ro" "$helper" \
		-c 'find /volume -mindepth 1 -delete && tar xzf "/backup/$1.tar.gz" -C /volume' sh "$vol"
	echo "ok   volume ${project}_$vol <- $src/$vol.tar.gz"
done

# agent-init signs web's agent token with the key in agent-secrets, so it runs again on restored keys.
if printf '%s\n' "${vols[@]}" | grep -qx agent-secrets; then
	init=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=agent-init")
	[ -z "$init" ] || docker start -a "$init" >/dev/null
fi
[ "${#writers[@]}" = 0 ] || docker start "${writers[@]}" >/dev/null
trap - ERR
echo "RESTORE DONE in $(($(date +%s) - started)) s from $src"
