#!/usr/bin/env bash
# The scenario suite against a mock model, with no secret anywhere: the app, its model and Postgres
# all run on this machine from the checked-out tree, and the @mock-model scenarios drive them.
#
# The model is aimock (MIT, github.com/CopilotKit/aimock), an OpenAI-compatible server that answers
# from web/e2e/mock-model/fixtures.json: it streams chat completions and scripts tool calls, so a
# scenario can check a tool round (the calculate tool) end to end without a real model. It runs as a
# container pinned by digest. Every other model call gets the catch-all fixture's fixed answer.
#
# The app is built the way the self-host image builds it (APP_SURFACE=chat, adapter-node), so chat is
# served at the root, as on a self-hosted install.
#
# Needs DATABASE_URL naming a migrated Postgres this run may write to (CI gives it a service
# container), docker, and Playwright's chromium. Arguments after the script name go to Playwright.
# Run it from a checkout with no web/.env.local: svelte.config.js loads that file with override.
#
#   DATABASE_URL=postgres://... web/scripts/mock-model-e2e.sh
#   MOCK_E2E_GREP='@mock-model' web/scripts/mock-model-e2e.sh e2e/scenarios/chat-at-root.spec.ts
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$WEB_DIR/test-results/mock-model-e2e}"
# Not on the Fetch standard's blocked-port list: Node's fetch refuses those.
APP_PORT="${APP_PORT:-4173}"
MOCK_PORT="${MOCK_PORT:-4010}"
# aimock 1.48.0, the multi-arch index. Bump the digest and the version together.
AIMOCK_IMAGE="${AIMOCK_IMAGE:-ghcr.io/copilotkit/aimock@sha256:51d8e426ff99f42fa8050bb06548ff541adef2d759e5f83a33bdbf1b47a5f29d}"
# The id the fixtures list at /v1/models. A row in the model catalog declares its tool calls, so the
# app offers it tools as it would the real model.
MOCK_MODEL_ID="${MOCK_MODEL_ID:-mistral-large-2610}"

: "${DATABASE_URL:?DATABASE_URL must name a migrated Postgres this run may write to}"
if [ -f "$WEB_DIR/.env.local" ]; then
	echo "mock-model-e2e: $WEB_DIR/.env.local exists and svelte.config.js loads it with override; run from a clean checkout" >&2
	exit 1
fi
mkdir -p "$LOG_DIR"

export DEPLOY_ENV=development
export APP_SURFACE=chat
# What selfhost/compose.yaml sets: an operator's own copy, which runs with no safety classifier and no
# Coop by choice, so a turn reaches the model instead of failing closed on a screen nobody configured.
export ALPHA_EDITION=selfhost
export PUBLIC_ORIGIN="http://localhost:$APP_PORT"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}"
export OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1"
export OPENAI_API_KEY=mock-model-no-key
export MODEL_ALLOWLIST="$MOCK_MODEL_ID"
export TASK_MODEL="$MOCK_MODEL_ID"
# The committed boot snapshot lists the hosted gateway's models; this run lists the mock's.
export MODELS_BOOT_SNAPSHOT=off
# The same mock again as a direct model host (modelsCatalog.ts, withDirectModels): a model served
# from one is offered tools, where a model listed only by OPENAI_BASE_URL's /models is not unless its
# harness profile declares tool calls. No MISTRAL_CHAT_MODEL_MAP, so the wire id is ours.
export MISTRAL_CHAT_BASE_URL="$OPENAI_BASE_URL"
export MISTRAL_CHAT_API_KEY=mock-model-no-key
export MISTRAL_MODELS="$MOCK_MODEL_ID"

cleanup() {
	docker logs mock-model-e2e-aimock > "$LOG_DIR/aimock.log" 2>&1 || true
	curl -s --max-time 5 "http://127.0.0.1:$MOCK_PORT/__aimock/journal?limit=500" > "$LOG_DIR/aimock-journal.json" 2>/dev/null || true
	docker rm -f mock-model-e2e-aimock > /dev/null 2>&1 || true
	[ -n "${APP_PID:-}" ] && kill -- "-$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

docker rm -f mock-model-e2e-aimock > /dev/null 2>&1 || true
docker run -d --name mock-model-e2e-aimock -p "127.0.0.1:$MOCK_PORT:4010" \
	-v "$WEB_DIR/e2e/mock-model:/fixtures:ro" "$AIMOCK_IMAGE" \
	--fixtures /fixtures/fixtures.json --host 0.0.0.0 --validate-on-load > /dev/null
models=""
for _ in $(seq 1 30); do
	models=$(curl -s --max-time 3 "$OPENAI_BASE_URL/models" || true)
	[ -n "$models" ] && break
	sleep 1
done
if ! printf '%s' "$models" | grep -q "\"$MOCK_MODEL_ID\""; then
	echo "mock-model-e2e: aimock does not list $MOCK_MODEL_ID at $OPENAI_BASE_URL/models (got: ${models:-nothing})" >&2
	docker logs mock-model-e2e-aimock >&2 || true
	exit 1
fi

(cd "$WEB_DIR" && ADAPTER=node pnpm exec vite build) > "$LOG_DIR/build.log" 2>&1 || {
	echo "mock-model-e2e: the build failed; see $LOG_DIR/build.log" >&2
	echo "::group::last 80 lines of build.log"
	tail -n 80 "$LOG_DIR/build.log"
	echo "::endgroup::"
	exit 1
}

# Its own process group, so cleanup stops the whole tree.
(cd "$WEB_DIR" && PORT="$APP_PORT" ORIGIN="$PUBLIC_ORIGIN" exec setsid node build) > "$LOG_DIR/app.log" 2>&1 &
APP_PID=$!

ready=""
for _ in $(seq 1 90); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_ORIGIN/" || true)
	if [ "$code" = "200" ]; then ready=1; break; fi
	sleep 2
done
if [ -z "$ready" ]; then
	echo "mock-model-e2e: $PUBLIC_ORIGIN/ never answered 200 (last: ${code:-none}); see $LOG_DIR/app.log" >&2
	tail -n 60 "$LOG_DIR/app.log" >&2 || true
	exit 1
fi

cd "$WEB_DIR"
# E2E_REPLAY_MODE=off: every model call reaches the mock, none is answered by the replay layer.
# SCENARIO_SKIP_LIVE_MODEL=1 leaves out the specs that need a real model's answer.
E2E_REPLAY_MODE=off \
	SCENARIO_CHAT_SURFACE=1 \
	SCENARIO_SKIP_LIVE_MODEL=1 \
	SCENARIO_BASE_URL="$PUBLIC_ORIGIN" \
	SCENARIO_DATABASE_URL="$DATABASE_URL" \
	pnpm exec playwright test -c e2e/playwright.config.ts --project=chromium --grep "${MOCK_E2E_GREP:-@mock-model}" "$@"
