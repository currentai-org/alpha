#!/usr/bin/env bash
# What each of Open WebUI, LibreChat and Alpha leaves readable in its database after the same ten chats.
#
#   selfhost/db-compare/run.sh [out dir]     # all three; OUT defaults to selfhost/db-compare/out
#   APPS="alpha" selfhost/db-compare/run.sh  # a subset
#   KEEP=1 ...                               # leave the stacks running afterwards
#
# Each app runs on its default store with a fresh account, and gets ten new chats typed into its own chat
# page (chats.mjs). Every message carries a user canary, and the shared stub model (stub.py) answers
# with an answer canary. Then each store is dumped whole and searched two ways:
#   - fields: every table.column (collection.field for MongoDB) holding either canary, with row counts
#   - grep: how many times each canary appears in the dump file
# Results land in OUT: results.md (the table), <app>.dump, <app>-fields.tsv and <app>-chats.json.
#
# Alpha runs from ../compose.yaml as its own compose project (dbcompare-alpha, port 3300), so a stack
# you already run is not touched. It builds this checkout's web image unless ALPHA_IMAGE names a
# published one (compose.release.yaml).
# Needs docker compose v2.24+, openssl, and web/ installed (pnpm install) for Playwright's Chromium.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=$(mkdir -p "${1:-$here/out}" && cd "${1:-$here/out}" && pwd)
apps=${APPS:-open-webui librechat alpha}
USER_CANARY=PLUM-HERON-4471
ANSWER_CANARY=ANSWER-KESTREL-9302
ALPHA_PORT=${ALPHA_PORT:-3300}
alpha_env="$out/alpha.env"         # the web container's environment
alpha_compose_env="$out/alpha.compose.env" # compose's variables: alpha.env plus port, origin, image

OWUI_SECRET_KEY=$(openssl rand -hex 32)
LC_CREDS_KEY=$(openssl rand -hex 32)
LC_CREDS_IV=$(openssl rand -hex 16)
LC_JWT_SECRET=$(openssl rand -hex 32)
LC_JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export OWUI_SECRET_KEY LC_CREDS_KEY LC_CREDS_IV LC_JWT_SECRET LC_JWT_REFRESH_SECRET

dc() { docker compose -f "$here/compose.yaml" "$@"; }
# Alpha's compose reads selfhost/.env (env_file); this run's own copy is mounted over it by the
# override written below, so an operator's .env is never read or changed.
dca() {
	local files=(-f "$root/selfhost/compose.yaml")
	[ -n "${ALPHA_IMAGE:-}" ] && files+=(-f "$root/selfhost/compose.release.yaml")
	docker compose -p dbcompare-alpha "${files[@]}" -f "$out/alpha.override.yaml" --env-file "$alpha_compose_env" "$@"
}

wait_http() { # url, seconds
	for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
	echo "no answer from $1 after $2 s" >&2
	return 1
}

cleanup() {
	[ -n "${KEEP:-}" ] && return
	dc down -v --remove-orphans > /dev/null 2>&1 || true
	[ -f "$alpha_compose_env" ] && dca down -v --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT

chats() { (cd "$root/web" && pnpm exec node "$here/chats.mjs" "$1" "$2" "$out"); }
count() { grep -a -o -F "$1" "$2" | wc -l | tr -d ' '; }

# One app's run, in a subshell with errexit, so one app failing to start, chat or dump is recorded in
# <app>.status and the others still run. Its store's description goes to <app>.store.
run_app() {
	local app=$1 store
	case $app in
	open-webui)
		dc up -d --wait stub open-webui
		wait_http http://127.0.0.1:8080/health 300
		chats open-webui http://127.0.0.1:8080 || echo "chats failed" > "$out/$app.status"
		dc exec -T open-webui python -c 'import sqlite3,sys; [print(l) for l in sqlite3.connect("/app/backend/data/webui.db").iterdump()]' \
			> "$out/open-webui.dump"
		dc exec -T open-webui python - /app/backend/data/webui.db "$USER_CANARY" "$ANSWER_CANARY" \
			< "$here/fields-sqlite.py" > "$out/open-webui-fields.tsv"
		store="SQLite (\`webui.db\`)"
		;;
	librechat)
		dc up -d --wait stub librechat-mongo
		dc up -d librechat
		wait_http http://127.0.0.1:3080/health 300
		chats librechat http://127.0.0.1:3080 || echo "chats failed" > "$out/$app.status"
		dc exec -T librechat-mongo mongodump --quiet --db LibreChat --archive > "$out/librechat.dump"
		dc exec -T librechat-mongo mongosh --quiet LibreChat \
			--eval "const USER='$USER_CANARY', ANSWER='$ANSWER_CANARY';" --file /dev/stdin \
			< "$here/fields-mongo.js" > "$out/librechat-fields.tsv"
		store="MongoDB (\`mongodump\` archive)"
		;;
	alpha)
		sed -e "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" \
			-e "s#^OPENAI_BASE_URL=.*#OPENAI_BASE_URL=http://stub:8000/v1#" \
			-e "s/^MODEL_ALLOWLIST=.*/MODEL_ALLOWLIST=compare-stub/" \
			"$root/selfhost/.env.example" > "$alpha_env"
		# PORT is the host port compose maps to the container's 3000; it must stay out of the container's
		# own environment, where the app would listen on it instead.
		# compose.yaml interpolates the model and auth settings, so its variables are alpha.env plus these.
		{ cat "$alpha_env"; printf 'PORT=%s\nPUBLIC_ORIGIN=http://localhost:%s\n' "$ALPHA_PORT" "$ALPHA_PORT"; } \
			> "$alpha_compose_env"
		if [ -n "${ALPHA_IMAGE:-}" ]; then echo "ALPHA_IMAGE=$ALPHA_IMAGE" >> "$alpha_compose_env"; fi
		cat > "$out/alpha.override.yaml" <<-EOF
			services:
			  web:
			    env_file: !override [$alpha_env]
			  stub:
			    image: docker.io/library/python:3.13-slim@sha256:7249d5587b78209a006dc4a3b5340678f84ea729239193aa559962cd8c1fce50
			    command: ["python", "-u", "/stub.py"]
			    volumes: ["$here/stub.py:/stub.py:ro"]
		EOF
		dca up -d --wait db stub
		if [ -n "${ALPHA_IMAGE:-}" ]; then dca up -d web; else dca up -d --build web; fi
		wait_http "http://127.0.0.1:$ALPHA_PORT/chat/healthcheck" 600
		# Better Auth checks the request's origin against PUBLIC_ORIGIN, so the browser uses that exact host.
		chats alpha "http://localhost:$ALPHA_PORT" || echo "chats failed" > "$out/$app.status"
		dca exec -T db pg_dump -U alpha alpha > "$out/alpha.dump"
		dca exec -T db psql -U alpha -d alpha -X -q -v user="$USER_CANARY" -v answer="$ANSWER_CANARY" \
			< "$here/fields-postgres.sql" > "$out/alpha-fields.tsv"
		if [ -n "${ALPHA_IMAGE:-}" ]; then image=$ALPHA_IMAGE; else image="built from this checkout"; fi
		store="Postgres (\`pg_dump\`), image $image"
		;;
	*)
		echo "unknown app $app" >&2
		return 2
		;;
	esac
	echo "$store" > "$out/$app.store"
}

for app in $apps; do
	echo "== $app"
	echo ok > "$out/$app.status"
	echo "?" > "$out/$app.store"
	set +e
	(
		set -eE
		trap 'echo "$app: failed at run.sh:$LINENO: $BASH_COMMAND" >&2' ERR
		run_app "$app"
	)
	rc=$?
	set -e
	if [ "$rc" != 0 ]; then
		echo "$app: run stopped with exit $rc" >&2
		grep -qx ok "$out/$app.status" && echo "stopped (exit $rc), see the log" > "$out/$app.status"
	fi
done

{
	echo "# What each app leaves readable in its database after the same ten chats"
	echo
	echo "Ten chats per app, one message each, typed into the app's own chat page by \`chats.mjs\`. Every message"
	echo "carries \`$USER_CANARY\`; every model reply (titles included) carries \`$ANSWER_CANARY\`. Written by"
	echo "\`selfhost/db-compare/run.sh\`."
	echo
	echo "| App | Store | Chats | User canary in dump | Answer canary in dump | Fields holding chat text (rows with user · answer canary) |"
	echo "| --- | --- | --- | --- | --- | --- |"
	for app in $apps; do
		dump="$out/$app.dump"
		fields=$(awk -F'\t' '{printf "%s`%s` (%s · %s)", (NR>1?"<br>":""), $1, $2, $3}' "$out/$app-fields.tsv" 2> /dev/null || true)
		[ -f "$dump" ] || : > "$dump"
		echo "| $app | $(cat "$out/$app.store") | $(cat "$out/$app.status") | $(count "$USER_CANARY" "$dump") | $(count "$ANSWER_CANARY" "$dump") | ${fields:-none} |"
	done
} > "$out/results.md"
cat "$out/results.md"
