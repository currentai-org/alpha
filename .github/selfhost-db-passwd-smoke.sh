#!/usr/bin/env bash
# selfhost/db-passwd.sh on a running self-host stack, the way selfhost/README.md gives it ("Changing the
# database password"), then the lock-out the README warns about and its way back.
#
#   .github/selfhost-db-passwd-smoke.sh                        # a stack smoke.sh left up
#   COMPOSE_PROFILES=local,s3 .github/selfhost-db-passwd-smoke.sh
#
# 1. A guest starts a conversation, and a TCP login with the current password works.
# 2. db-passwd.sh sets a new password: the old one is refused over TCP, the new one accepted. POSTGRES_PASSWORD
#    goes into selfhost/.env and `docker compose up -d` recreates the app, which must come back healthy, let
#    the guest open their conversation with the same cookie, and start a new one.
# 3. .env gets another password without the script, as someone who skipped the README would do, and
#    `up -d`: the database must log a password failure for alpha and the app must not come up healthy.
#    db-passwd.sh with that password and a restart of web must bring it back, conversation and all.
# Rewrites POSTGRES_PASSWORD in selfhost/.env. Prints one ok/DB PASSWD FAIL line per check and
# DB PASSWD PASS at the end; exits non-zero on any failure. Needs docker compose, curl, jq and openssl.
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

export COMPOSE_PROFILES="${COMPOSE_PROFILES:-local}"
BASE="http://localhost:${PORT:-3000}"
work=$(mktemp -d)
jar="$work/jar"
trap 'rm -rf "$work"' EXIT
fail() { echo "DB PASSWD FAIL: $*" >&2; exit 1; }
healthy() { # what for, tries (5 s apart)
	for _ in $(seq 1 "${2:-60}"); do
		[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/healthcheck" || true)" = 200 ] && return 0
		sleep 5
	done
	return 1
}
read_back() { # conversation id -> the id the API returns for the guest, or the HTTP status
	local code
	code=$(curl -s -o "$work/conv" -w '%{http_code}' --max-time 20 -b "$jar" -H "origin: $BASE" "$BASE/api/v2/conversations/$1")
	if [ "$code" = 200 ]; then jq -r '.json.id // empty' < "$work/conv"; else echo "HTTP $code"; fi
}
new_conversation() {
	local model
	model=$(curl -sf --max-time 20 "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty')
	[ -n "$model" ] || return 1
	curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
		-d "{\"model\":\"$model\"}" "$BASE/conversation" | jq -r '.conversationId // empty'
}
# A login over TCP to the db service's network address, which pg_hba.conf checks with scram-sha-256 (the
# local socket and loopback are trusted, so they would accept any password). Prints `1` or psql's error.
tcp_login() {
	docker compose exec -T -e PGPASSWORD="$1" db psql -h db -U alpha -d alpha -Atc 'select 1' 2>&1 || true
}
set_env_password() {
	sed -i '/^POSTGRES_PASSWORD=/d' .env
	echo "POSTGRES_PASSWORD=$1" >> .env
}
started=$(date +%s)

# 1. Before.
healthy "before" || fail "GET /healthcheck is not 200 before the change; start the stack first"
old=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tail -n 1)
old="${old:-alpha}"
cid=$(new_conversation) || true
[ -n "$cid" ] || fail "POST /conversation returned no conversationId before the change"
[ "$(read_back "$cid")" = "$cid" ] || fail "the guest cannot read their new conversation before the change"
echo "ok   guest conversation $cid reads back before the change"
[ "$(tcp_login "$old")" = 1 ] || fail "a TCP login with the current password fails before the change: $(tcp_login "$old")"
echo "ok   a TCP login with the current password works"

# 2. The README's procedure.
new=$(openssl rand -hex 24)
NEW_POSTGRES_PASSWORD="$new" ./db-passwd.sh > "$work/out" 2>&1 || { cat "$work/out"; fail "db-passwd.sh exited non-zero"; }
sed 's/^/     db-passwd.sh: /' "$work/out"
grep -qF "$new" "$work/out" && fail "db-passwd.sh printed a password it was given"
if ! grep -q 'POSTGRES_PASSWORD' "$work/out" || ! grep -q 'docker compose up -d' "$work/out"; then
	fail "db-passwd.sh did not say to update POSTGRES_PASSWORD in .env and run docker compose up -d"
fi
echo "ok   db-passwd.sh says to set POSTGRES_PASSWORD in .env and run docker compose up -d"
refused=$(tcp_login "$old")
case "$refused" in
	*"password authentication failed"*) echo "ok   the old password is refused: $refused" ;;
	*) fail "the old password is not refused after db-passwd.sh: $refused" ;;
esac
[ "$(tcp_login "$new")" = 1 ] || fail "the new password is refused after db-passwd.sh: $(tcp_login "$new")"
echo "ok   the new password logs in"
set_env_password "$new"
docker compose up -d --wait --wait-timeout 300
healthy "after up -d" 60 || fail "GET /healthcheck never returned 200 after .env and up -d"
web_url_pw=$(docker compose exec -T web node -p "process.env.DATABASE_URL ?? ''" | sed -n 's|^postgres://alpha:\([^@]*\)@.*|\1|p')
[ "$web_url_pw" = "$new" ] || fail "the recreated web service does not connect with the new password"
got=$(read_back "$cid")
[ "$got" = "$cid" ] || fail "the guest cannot read their conversation after the change: $got"
cid2=$(new_conversation) || true
[ -n "$cid2" ] || fail "POST /conversation returned no conversationId after the change"
echo "ok   the app reconnects: web uses the new password, conversation $cid reads back with the same cookie, $cid2 is new"

# 3. The lock-out, and the way back.
locked=$(openssl rand -hex 24)
set_env_password "$locked"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d
seen=""
for _ in $(seq 1 30); do
	# A variable, not a pipe: under pipefail grep -q closes the pipe on a match and fails the test.
	if grep -q 'password authentication failed for user "alpha"' <<<"$(docker compose logs --no-color --since "$since" db 2>&1)"; then
		seen=1
		break
	fi
	sleep 3
done
[ -n "$seen" ] || fail "with only .env changed, the database logged no password failure for alpha"
if healthy "locked out" 4; then fail "with only .env changed, the app still came up healthy"; fi
echo "ok   lock-out reproduced: with only .env changed the database refuses the app and /healthcheck is not 200"
NEW_POSTGRES_PASSWORD="$locked" ./db-passwd.sh > "$work/out" 2>&1 || { cat "$work/out"; fail "db-passwd.sh exited non-zero in the lock-out"; }
docker compose restart web
healthy "after the lock-out fix" 60 || fail "GET /healthcheck never returned 200 after db-passwd.sh and a restart of web"
got=$(read_back "$cid")
[ "$got" = "$cid" ] || fail "the guest cannot read their conversation after the lock-out fix: $got"
echo "ok   db-passwd.sh with the .env value and a restart of web bring the app back; $cid reads back"
echo "DB PASSWD PASS in $(($(date +%s) - started)) s"
