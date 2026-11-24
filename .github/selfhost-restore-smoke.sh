#!/usr/bin/env bash
# Restore round trip on a running self-host stack, the procedure selfhost/README.md gives ("Back up and
# restore"), end to end: a guest starts a conversation and a file is written to the `files` volume;
# selfhost/backup.sh; `docker compose down -v`; `up`; selfhost/restore.sh. Then every conversation must
# read back byte for byte, the guest must open theirs over HTTP with the cookie they had before, and the
# file must hold what was written, with its owner unchanged and the app still able to write beside it.
#
#   .github/selfhost-restore-smoke.sh                                 # a stack smoke.sh left up
#   RESTORE_PROFILES="--profile local --profile s3" .github/selfhost-restore-smoke.sh
#
# Run after selfhost/smoke.sh, so the database holds a turn. The file is written into the volume from
# inside the web container, as the app's own user; it is not an upload through the app. Prints one
# `ok`/`RESTORE FAIL` line per check and `RESTORE PASS` at the end; exits non-zero on any failure.
# Needs docker compose, curl and jq.
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

# shellcheck disable=SC2206 # split on purpose: "--profile local --profile s3" is four arguments
profiles=(${RESTORE_PROFILES:---profile local})
BASE="http://localhost:${PORT:-3000}"
work=$(mktemp -d)
jar="$work/jar"
trap 'rm -rf "$work"' EXIT
fail() { echo "RESTORE FAIL: $*" >&2; exit 1; }
dc() { docker compose "${profiles[@]}" "$@"; }
sql() { dc exec -T db psql -U alpha -d alpha -Atc "$1"; }
healthy() {
	for _ in $(seq 1 60); do
		[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/healthcheck" || true)" = 200 ] && return 0
		sleep 5
	done
	fail "GET /healthcheck never returned 200 ($1)"
}
# Every conversation row, whole: a count and one digest over ids and documents.
fingerprint() {
	sql "select count(*) || ' conversations, ' || coalesce(sum(case when jsonb_typeof(doc->'messages') = 'array'
		then jsonb_array_length(doc->'messages') else 0 end), 0) || ' messages, md5 '
		|| md5(coalesce(string_agg(id || ':' || doc::text, ',' order by id), '')) from conversations"
}
read_back() { # conversation id -> the id the API returns for the guest, or the HTTP status
	local code
	code=$(curl -s -o "$work/conv" -w '%{http_code}' --max-time 20 -b "$jar" -H "origin: $BASE" "$BASE/api/v2/conversations/$1")
	if [ "$code" = 200 ]; then jq -r '.json.id // empty' < "$work/conv"; else echo "HTTP $code"; fi
}
canary_path=/data/files/restore-smoke/canary.txt
started=$(date +%s)

# 1. A guest conversation and a file.
model=$(curl -sf --max-time 20 "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty')
[ -n "$model" ] || fail "no model advertised"
cid=$(curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
	-d "{\"model\":\"$model\"}" "$BASE/conversation" | jq -r '.conversationId // empty')
[ -n "$cid" ] || fail "POST /conversation returned no conversationId"
got=$(read_back "$cid")
[ "$got" = "$cid" ] || fail "the guest cannot read their new conversation before the backup: $got"
echo "ok   guest conversation $cid reads back over HTTP"
token="restore-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# The web image has no shell or coreutils (distroless), so each step in it is a line of Node.
web_node() { dc exec -T web node "$@"; }
web_stat() { web_node -p 'const s = require("fs").statSync(process.argv[1]); `${s.uid}:${s.gid} ${(s.mode & 0o777).toString(8)}`' "$1"; }
web_node -e 'const fs = require("fs"), p = process.argv[1]; fs.mkdirSync(require("path").dirname(p), { recursive: true }); fs.writeFileSync(p, fs.readFileSync(0))' "$canary_path" <<<"$token"
owner_before=$(web_stat "$canary_path")
echo "ok   wrote $canary_path as uid:gid $(web_node -p 'process.getuid() + ":" + process.getgid()') ($owner_before)"
before=$(fingerprint)
case "$before" in "0 conversations"*) fail "no conversation in the database before the backup" ;; esac
echo "ok   before: $before"

# 2. Back up, wipe, start fresh.
./backup.sh "$work/backup"
ls -l "$work/backup"
dc down -v
dc up -d --wait --wait-timeout 900
# Web has applied the migrations to the empty database once it answers, so restore.sh stops no
# migration halfway.
healthy "fresh stack"
empty=$(sql "select count(*) from conversations")
[ "$empty" = 0 ] || fail "down -v left $empty conversations; the round trip would prove nothing"
if web_node -e 'process.exit(require("fs").existsSync(process.argv[1]) ? 0 : 1)' "$canary_path"; then fail "down -v left $canary_path in place"; fi
echo "ok   fresh stack: 0 conversations, no $canary_path"

# 3. Restore and compare.
./restore.sh "$work/backup"
healthy "after restore.sh"
after=$(fingerprint)
[ "$after" = "$before" ] || fail "the conversations differ after the restore: before '$before', after '$after'"
echo "ok   after: $after (identical)"
got=$(read_back "$cid")
[ "$got" = "$cid" ] || fail "the guest cannot read their conversation after the restore: $got"
echo "ok   guest conversation $cid reads back over HTTP with the same cookie"
content=$(web_node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]))' "$canary_path" 2>/dev/null || true)
[ "$content" = "$token" ] || fail "$canary_path holds '$content' after the restore, not what was written"
owner_after=$(web_stat "$canary_path")
[ "$owner_after" = "$owner_before" ] || fail "$canary_path was $owner_before before and is $owner_after after"
web_node -e 'require("fs").writeFileSync(process.argv[1], "ok\n")' "${canary_path%/*}/after-restore.txt" \
	|| fail "the app's user cannot write to the restored files volume"
echo "ok   $canary_path came back ($owner_after), and the app writes beside it"
echo "RESTORE PASS in $(($(date +%s) - started)) s"
