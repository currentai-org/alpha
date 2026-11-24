#!/usr/bin/env bash
# The daily cleanup on a running self-host stack, as selfhost/README.md describes it ("Expired guest
# data"): the web server deletes expired guest conversations on its own timer, with no cron. Two guest
# conversations are started over HTTP; one is aged 40 days in the database, past the 30-day retention.
# The web service is then recreated with DAILY_CLEANUP_FIRST_RUN_DELAY_MS=5000 in selfhost/.env, so its
# first run comes 5 seconds after boot instead of 1 to 10 minutes. The aged conversation must be gone,
# the fresh one must remain, and the web log must carry `[cleanup] daily cleanup finished`.
#
# Guest files get the same check when the web service stores files on local disk: two files under one
# guest's folder in the `files` volume, one with its mtime set 40 days back (the local backend dates a
# file by its mtime). The aged one must be gone and the fresh one kept. An S3 store dates an object by
# its upload and nothing can backdate it, so on that backend the file check prints a skip line; the
# local-profile runs (selfhost.yml, image.yml) cover it.
#
#   .github/selfhost-cleanup-smoke.sh                                 # a stack smoke.sh left up
#   CLEANUP_PROFILES="--profile local --profile s3" .github/selfhost-cleanup-smoke.sh
#
# Prints one `ok`/`CLEANUP FAIL` line per check and `CLEANUP PASS` at the end; exits non-zero on any
# failure. Leaves the delay setting out of selfhost/.env again on exit. Needs docker compose, curl and jq.
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

# shellcheck disable=SC2206 # split on purpose: "--profile local --profile s3" is four arguments
profiles=(${CLEANUP_PROFILES:---profile local})
BASE="http://localhost:${PORT:-3000}"
KNOB=DAILY_CLEANUP_FIRST_RUN_DELAY_MS
work=$(mktemp -d)
jar="$work/jar"
restore_env() { [ -f .env ] && sed -i "/^$KNOB=/d" .env; rm -rf "$work"; }
trap restore_env EXIT
fail() { echo "CLEANUP FAIL: $*" >&2; exit 1; }
dc() { docker compose "${profiles[@]}" "$@"; }
sql() { dc exec -T db psql -U alpha -d alpha -Atc "$1"; }
rows() { sql "select count(*) from conversations where id = '$1'"; }
started=$(date +%s)

# 1. Two guest conversations; one aged past retention.
model=$(curl -sf --max-time 20 "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty')
[ -n "$model" ] || fail "no model advertised"
new_conversation() {
	curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
		-d "{\"model\":\"$model\"}" "$BASE/conversation" | jq -r '.conversationId // empty'
}
expired=$(new_conversation)
fresh=$(new_conversation)
[ -n "$expired" ] && [ -n "$fresh" ] || fail "POST /conversation returned no conversationId"
guest=$(sql "select count(*) from conversations where id in ('$expired', '$fresh') and user_id is null")
[ "$guest" = 2 ] || fail "expected 2 guest conversations, found $guest"
sql "update conversations set created_at = now() - interval '40 days', updated_at = now() - interval '40 days'
	where id = '$expired'" >/dev/null
age=$(sql "select extract(day from now() - updated_at)::int from conversations where id = '$expired'")
[ "$age" -ge 30 ] || fail "the aged conversation is $age days old, not past the 30-day retention"
echo "ok   guest conversation $expired aged $age days; $fresh left fresh"

# 1b. Two guest files on a local store; one aged past retention. Written inside the web container, as
# the user that owns the volume, under a guest id shaped like a real one (sha256 hex of a cookie).
backend=$(dc exec -T web node -p 'process.env.CUSTODIAL_STORAGE_BACKEND ?? ""' | tr -d '\r')
files_checked=""
if [ "$backend" = local ]; then
	gid=$(openssl rand -hex 32)
	dir="guests/$gid/conversations/$(openssl rand -hex 12)"
	dc exec -T -e DIR="$dir" web node -e '
		const fs = require("fs"), path = require("path");
		const d = path.join(process.env.CUSTODIAL_LOCAL_DIR, process.env.DIR);
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, "aged.txt"), "aged guest file");
		fs.writeFileSync(path.join(d, "fresh.txt"), "fresh guest file");
		const t = new Date(Date.now() - 40 * 24 * 3600 * 1000);
		fs.utimesSync(path.join(d, "aged.txt"), t, t);
	'
	files_checked=1
	echo "ok   guest files $dir/aged.txt aged 40 days and $dir/fresh.txt left fresh"
else
	echo "skip guest files: the web service stores files on '${backend:-unset}', whose upload date cannot be set back"
fi

# 2. Recreate web with a 5-second first run.
sed -i "/^$KNOB=/d" .env
echo "$KNOB=5000" >> .env
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps --force-recreate --wait --wait-timeout 300 web
echo "ok   web recreated with $KNOB=5000"

# 3. Wait for the run, then read what it left.
line=""
for _ in $(seq 1 36); do
	logs=$(dc logs --no-color --no-log-prefix --since "$since" web 2>&1 || true)
	if grep -q '\[cleanup\] daily cleanup failed' <<<"$logs"; then
		fail "the run logged: $(grep -m1 '\[cleanup\] daily cleanup failed' <<<"$logs" | cut -c1-400)"
	fi
	line=$(grep -m1 '\[cleanup\] daily cleanup finished' <<<"$logs" || true)
	[ -n "$line" ] && break
	sleep 5
done
[ -n "$line" ] || fail "no '[cleanup] daily cleanup finished' line within 180 s of the recreate"
grep -q '\[cleanup\] daily cleanup scheduled in this process' <<<"$logs" \
	|| fail "the run finished but the boot line '[cleanup] daily cleanup scheduled in this process' is missing"
echo "ok   web log: $(cut -c1-400 <<<"$line")"
[ "$(rows "$expired")" = 0 ] || fail "the aged guest conversation $expired is still in the database"
echo "ok   aged guest conversation $expired deleted"
[ "$(rows "$fresh")" = 1 ] || fail "the fresh guest conversation $fresh was deleted too"
echo "ok   fresh guest conversation $fresh kept"

if [ -n "$files_checked" ]; then
	present() {
		dc exec -T -e F="$dir/$1" web node -p \
			'require("fs").existsSync(require("path").join(process.env.CUSTODIAL_LOCAL_DIR, process.env.F))' | tr -d '\r'
	}
	[ "$(present aged.txt)" = false ] || fail "the aged guest file $dir/aged.txt is still in the files volume"
	echo "ok   aged guest file deleted from the files volume"
	[ "$(present fresh.txt)" = true ] || fail "the fresh guest file $dir/fresh.txt was deleted too"
	echo "ok   fresh guest file kept"
fi

echo "CLEANUP PASS in $(( $(date +%s) - started )) s"
