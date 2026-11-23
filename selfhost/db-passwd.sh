#!/usr/bin/env bash
# Change the bundled database's password on a stack that has already started once.
#
#   ./db-passwd.sh                                   # makes a new random password and prints it
#   NEW_POSTGRES_PASSWORD='<password>' ./db-passwd.sh   # sets the one you give, without printing it
#
# Postgres reads POSTGRES_PASSWORD only when it creates the database in an empty `db` volume. After that,
# changing it in .env changes only the password the app connects with, and the app is locked out. This
# script changes it inside the database with ALTER USER, over the db container's local socket, which
# needs no password. Then put the same value in .env and run `docker compose up -d`, which recreates
# the app with it. Supabase's utils/db-passwd.sh works the same way.
#
# Locked out already, because .env holds a new password the database never got? Run this with
# NEW_POSTGRES_PASSWORD set to the value in .env, then `docker compose restart web`.
#
# The app puts the password in a connection URL, so it may hold only letters, digits and . _ ~ -.
# Needs docker compose and openssl, and the db service running (`docker compose up -d db`).
set -euo pipefail
cd "$(dirname "$0")"

new="${NEW_POSTGRES_PASSWORD:-}"
generated=""
if [ -z "$new" ]; then
	new=$(openssl rand -hex 24)
	generated=1
fi
case "$new" in
	*[!A-Za-z0-9._~-]*)
		echo "db-passwd: the password may hold only letters, digits and . _ ~ - (the app puts it in a URL)" >&2
		exit 2
		;;
esac

if ! docker compose ps --status running --services db 2>/dev/null | grep -qx db; then
	echo "db-passwd: the db service is not running. Start it with: docker compose up -d db" >&2
	exit 1
fi

# On stdin, so the password is in no process's argument list.
printf "ALTER USER alpha WITH PASSWORD '%s';\n" "$new" \
	| docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U alpha -d alpha

echo "Changed the database password for user alpha."
if [ -n "$generated" ]; then
	echo "The new password: $new"
fi
cat <<'EOF'
The app still connects with the old one until you:
  1. set POSTGRES_PASSWORD to the new password in .env (one line, replacing any POSTGRES_PASSWORD line)
  2. run docker compose up -d, with the same -f and --profile flags you start the stack with
Until then, a restart of the web service cannot reach the database.
EOF
