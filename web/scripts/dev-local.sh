#!/usr/bin/env bash
# Local dev server on this machine's own port (default 5199), so it never fights other Vite
# servers for :5173. `pnpm dev` (the team default, :5173) is unchanged — ~20 probe/eval scripts
# assume it; point those at this server with their --base / BASE / PROBE_BASE flags.
#
#   pnpm dev:local                      # :5199, CMS auto-detected
#   ALPHA_DEV_PORT=5280 pnpm dev:local  # another port
#   ALPHA_DEV_CMS=remote pnpm dev:local # force the deployed CMS (read-only content)
#   ALPHA_DEV_CMS=local  pnpm dev:local # force local Payload on :3000
#   ALPHA_DEV_RESTART=1  pnpm dev:local # replace a dev server already running on the port
#   pnpm hma:up && pnpm dev:local       # attaching files on: uploads use the local scanner on :5101
#
# Why the env overrides: Doppler's shared `dev` config pins PUBLIC_ORIGIN to :5173 and
# PUBLIC_CMS_PAYLOAD_URL to a local Payload on :3000, and takes precedence over a plain shell export,
# so they go through `doppler run --preserve-env` (Doppler's inner `doppler run` overwrites an
# outer one's values otherwise). Without a reachable CMS every /chat route 500s (PayloadFetchError: ECONNREFUSED).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ALPHA_DEV_PORT:-5199}"
HOST="${ALPHA_DEV_HOST:-127.0.0.1}"
CMS_MODE="${ALPHA_DEV_CMS:-auto}"
LOCAL_CMS="http://localhost:3000"
REMOTE_CMS="https://cms.aipotluck.org"

# Port already taken? If it's this repo's own dev server, that's success (a macro clicked twice,
# a server left running) — report the URL, or replace it with ALPHA_DEV_RESTART=1. Anything else
# on the port is a real conflict.
WEB_DIR="$(pwd -P)"
PID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$PID" ]]; then
	PID_CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
	if [[ "$PID_CWD" == "$WEB_DIR" ]]; then
		if [[ "${ALPHA_DEV_RESTART:-0}" == "1" ]]; then
			echo "ℹ restarting the Alpha dev server already on :$PORT (pid $PID)…" >&2
			kill "$PID" 2>/dev/null || true
			for _ in 1 2 3 4 5 6 7 8 9 10; do lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
		else
			echo "✓ Alpha dev is already running → http://localhost:$PORT  (pid $PID)" >&2
			echo "  Restart it with ALPHA_DEV_RESTART=1 pnpm dev:local" >&2
			exit 0
		fi
	else
		echo "✗ :$PORT is in use by another process (pid $PID, cwd ${PID_CWD:-unknown})." >&2
		echo "  Pick another port: ALPHA_DEV_PORT=<port> pnpm dev:local" >&2
		exit 1
	fi
fi

case "$CMS_MODE" in
	local) CMS="$LOCAL_CMS" ;;
	remote) CMS="$REMOTE_CMS" ;;
	auto)
		if curl -s -o /dev/null --max-time 2 "$LOCAL_CMS/api/globals/chat-maintenance?depth=0"; then
			CMS="$LOCAL_CMS"
		else
			CMS="$REMOTE_CMS"
			echo "ℹ local Payload (:3000) not running — using the deployed CMS ($REMOTE_CMS, read-only content)." >&2
		fi
		;;
	*) echo "✗ ALPHA_DEV_CMS must be auto | local | remote (got '$CMS_MODE')" >&2; exit 1 ;;
esac

# Local Postgres for /chat: start the shared aipotluck-dev-pg container if it exists but is stopped.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
	if docker ps -a --format '{{.Names}}' | grep -qx 'aipotluck-dev-pg' && ! docker ps --format '{{.Names}}' | grep -qx 'aipotluck-dev-pg'; then
		echo "ℹ starting aipotluck-dev-pg…" >&2
		docker start aipotluck-dev-pg >/dev/null
	fi
fi

# A Postgres running on the host itself (Homebrew, Postgres.app) answers `localhost:5432` ahead of the
# container's published port, and every /chat route then 500s with `role "postgres" does not exist`.
HOST_PG="$(lsof -nP -iTCP:5432 -sTCP:LISTEN -a -c postgres 2>/dev/null | awk 'NR>1 {print $2}' | sort -u | head -1 || true)"
if [[ -n "$HOST_PG" ]]; then
	echo "⚠ a Postgres on this machine (pid $HOST_PG) is listening on :5432 and shadows aipotluck-dev-pg — /chat will 500 with 'role \"postgres\" does not exist'. Stop it, then restart this." >&2
fi

export PUBLIC_ORIGIN="http://localhost:$PORT"
export PUBLIC_CMS_PAYLOAD_URL="$CMS"
export CMS_PAYLOAD_URL="$CMS"
# Lets the account menu's Feature flags (Dev) dialog force flags per browser (fuzz_override cookie).
export FUZZ_OVERRIDE_ENABLED="${FUZZ_OVERRIDE_ENABLED:-true}"

PRESERVE=PUBLIC_ORIGIN,PUBLIC_CMS_PAYLOAD_URL,CMS_PAYLOAD_URL,FUZZ_OVERRIDE_ENABLED
# Every upload is scanned or refused (CUR-2382), and Doppler's `dev` names no scanner, so without one
# Attach files is hidden and every pasted file, photos included, is refused. Use the local HMA stack
# (web/hma/) whenever it is up.
LOCAL_HMA="http://localhost:5101"
if [[ -z "${CSAM_SCAN_BASE_URL:-}" ]] && curl -s -o /dev/null --max-time 2 "$LOCAL_HMA"; then
	export CSAM_SCAN_BASE_URL="$LOCAL_HMA"
fi
if [[ -n "${CSAM_SCAN_BASE_URL:-}" ]]; then
	PRESERVE="$PRESERVE,CSAM_SCAN_BASE_URL"
else
	echo "ℹ no upload scanner, so attaching files is off. Start one with pnpm hma:up, then restart this." >&2
fi

# Opt-in: serve chat from the staging LiteLLM router (CUR-1380) with the user key, so the picker lists
# the router's public models (Mistral Large 3 first, as develop defaults to it). Keys stay in Doppler
# (manual-key-passing/stg) and are read at start, never written to disk. ALPHA_DEV_MODELS overrides the list.
if [[ "${ALPHA_DEV_ROUTER:-}" == 1 ]]; then
	ROUTER_URL="$(doppler secrets get POTLUCK_ROUTER_URL --plain --project manual-key-passing --config stg)"
	OPENAI_BASE_URL="$ROUTER_URL/v1"
	OPENAI_API_KEY="$(doppler secrets get POTLUCK_ROUTER_USER_KEY --plain --project manual-key-passing --config stg)"
	MODEL_ALLOWLIST="${ALPHA_DEV_MODELS:-mistralai/mistral-large-2512,swiss-ai/apertus-v1.5-70b,BSC-LT/ALIA-40b-instruct,aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B,speakleash/Bielik-11B-v3.0-Instruct,zai-org/GLM-5.2}"
	# Auto's hosted draft classifier (clefRoutingGate.ts) on the same router and key. Still off until the
	# clef-routing flag is on (Feature flags (Dev) in the account menu, with auto-routing).
	CLEF_BASE_URL="$ROUTER_URL/v1/cloudflare"
	CLEF_API_KEY="$OPENAI_API_KEY"
	CLEF_MODEL="${ALPHA_DEV_CLEF_MODEL:-clef}"
	export OPENAI_BASE_URL OPENAI_API_KEY MODEL_ALLOWLIST CLEF_BASE_URL CLEF_API_KEY CLEF_MODEL
	PRESERVE="$PRESERVE,OPENAI_BASE_URL,OPENAI_API_KEY,MODEL_ALLOWLIST,CLEF_BASE_URL,CLEF_API_KEY,CLEF_MODEL"
	echo "▶ models via $OPENAI_BASE_URL: $MODEL_ALLOWLIST" >&2
fi

echo "▶ Alpha dev → http://localhost:$PORT  (/chat · /alpha · /designsystem)  CMS: $CMS" >&2
exec doppler run --preserve-env="$PRESERVE" -- \
	./node_modules/.bin/vite dev --port "$PORT" --strictPort --host "$HOST" "$@"
