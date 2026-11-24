#!/usr/bin/env bash
# End-to-end smoke for the self-host stack: bring it up with the local model, then send one chat turn
# as a signed-out guest and require a non-empty answer (deploy/smoke.sh, on the chat surface's root
# paths). Exits non-zero on any failure, so CI can run it.
#
#   selfhost/smoke.sh                # up --build with --profile local, smoke, leave the stack running
#   SMOKE_DOWN=1 selfhost/smoke.sh   # ...and `down -v` afterwards
#   SMOKE_NO_UP=1 selfhost/smoke.sh  # smoke a stack that is already up
#
# Needs docker compose, curl, jq and openssl on the host. Writes .env from .env.example on first run
# (local profile, fresh secret) when there is none.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
	sed "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env.example > .env
	echo "wrote .env from .env.example (local model profile)"
fi

# On failure, the last lines of each service's log, so a CI run shows why without a second step.
logs() {
	code=$?
	# llama.cpp's own timing for each prompt it read, so a change to the first turn's prompt shows as a
	# token count and seconds. Informational: a missing line (another server, a hosted provider) fails nothing.
	echo "--- llama.cpp prompt eval lines" >&2
	docker compose --profile local logs --no-color llama 2>&1 | grep -i 'prompt eval' >&2 || echo "(none)" >&2
	if [ "$code" != 0 ]; then
		docker compose --profile local ps -a >&2 || true
		docker compose --profile local logs --no-color --tail 120 web llama >&2 || true
	fi
	if [ -n "${SMOKE_DOWN:-}" ]; then docker compose --profile local down -v >&2 || true; fi
	exit "$code"
}
trap logs EXIT

if [ -z "${SMOKE_NO_UP:-}" ]; then
	started=$(date +%s)
	docker compose --profile local up -d --build --wait --wait-timeout "${SMOKE_UP_TIMEOUT:-1200}"
	echo "ok   stack up in $(($(date +%s) - started)) s"
fi

# The chat surface serves chat at the root, so deploy/smoke.sh's paths drop their /chat prefix. The
# first turn on a CPU model reads the whole system prompt first; allow for it. The second turn, in the same
# conversation, times the README's claim that later turns reuse the cached prompt; llama.cpp's prompt eval line
# for it (printed on exit) shows how much of the prompt it read again.
SMOKE_CHAT_PATH="" SMOKE_TURN_TIMEOUT="${SMOKE_TURN_TIMEOUT:-300}" \
	SMOKE_SECOND_PROMPT="${SMOKE_SECOND_PROMPT-And of Italy?}" ../deploy/smoke.sh
