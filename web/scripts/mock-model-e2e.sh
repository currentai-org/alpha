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
# Run it from a checkout with no web/.env.local: sveltekit.config.js loads that file with override.
#
#   DATABASE_URL=postgres://... web/scripts/mock-model-e2e.sh
#   MOCK_E2E_GREP='@mock-model' web/scripts/mock-model-e2e.sh e2e/scenarios/chat-at-root.spec.ts
#
# MOCK_E2E_IMAGE=<image> serves the app from that container image (web/Dockerfile built with
# APP_SURFACE=chat, as the published self-host image is) instead of a build of this tree, with the same
# environment, the same mock model and the same scenarios. web-image.yml runs it against the image it
# just built. The container shares the host network, so it reaches the mock and Postgres on localhost.
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
	echo "mock-model-e2e: $WEB_DIR/.env.local exists and sveltekit.config.js loads it with override; run from a clean checkout" >&2
	exit 1
fi
mkdir -p "$LOG_DIR"

# The names exported below are the app's environment; an image run passes exactly those, and not the
# runner's PATH, HOME and the rest, into the container.
ENV_BEFORE="$(compgen -e | sort)"

export DEPLOY_ENV=development
export APP_SURFACE=chat
# What selfhost/compose.yaml sets: an operator's own copy, which runs with no safety classifier and no
# Coop by choice, so a turn reaches the model instead of failing closed on a screen nobody configured.
export ALPHA_EDITION=selfhost
# Uploads as selfhost/.env.example and compose.yaml set them: stored unscanned (CSAM_SCAN=off, the
# operator's own decision) in a local directory. A path under /tmp exists both on the runner and inside
# the image, where the app runs as a non-root user.
export CSAM_SCAN=off
export CUSTODIAL_STORAGE_BACKEND=local
export CUSTODIAL_LOCAL_DIR=/tmp/mock-model-e2e-files
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
# Connect Google, configured as an operator would (selfhost/.env.example), which turns its flag on under
# the self-host defaults. Nothing here reaches Google or a connector: google-drive-connect.spec.ts asks
# for the `google_connector_stub` fault, which answers both inside the app, and these placeholders
# only make Settings → Connectors offer Connect Google.
export GOOGLE_CONNECT_CLIENT_ID=mock-model-e2e.apps.googleusercontent.com
export GOOGLE_CONNECT_CLIENT_SECRET=mock-model-no-secret
export GOOGLE_CONNECTOR_URL=https://google-connector.e2e.invalid/mcp
# A fault token for this run alone, so a spec can ask for a named fault (DEPLOY_ENV=development above is
# a test deployment, the other half of the gate in faultInjection.ts). It reaches Playwright only as
# MOCK_E2E_FAULT_TOKEN: under its own name every spec would arm the fixtures that read it
# (helpers/test.ts's preview screen stub, canned replies), which the other @mock-model specs never asked for.
E2E_FAULT_INJECT_TOKEN="$(openssl rand -hex 32)"
export E2E_FAULT_INJECT_TOKEN

cleanup() {
	local code=$?
	docker logs mock-model-e2e-aimock > "$LOG_DIR/aimock.log" 2>&1 || true
	curl -s --max-time 5 "http://127.0.0.1:$MOCK_PORT/__aimock/journal?limit=500" > "$LOG_DIR/aimock-journal.json" 2>/dev/null || true
	docker rm -f mock-model-e2e-aimock > /dev/null 2>&1 || true
	if [ -n "${MOCK_E2E_IMAGE:-}" ]; then
		docker logs mock-model-e2e-app > "$LOG_DIR/app.log" 2>&1 || true
		docker rm -f mock-model-e2e-app > /dev/null 2>&1 || true
	fi
	[ -n "${APP_PID:-}" ] && kill -- "-$APP_PID" 2>/dev/null || true
	# A failed run prints the app's warnings and errors, since the job keeps no artifact of app.log.
	if [ "$code" != 0 ] && [ -f "$LOG_DIR/app.log" ]; then
		echo "::group::app.log warnings and errors (last 40)"
		grep -E '"level":"?(warn|error|fatal|40|50|60)"?' "$LOG_DIR/app.log" | cut -c1-800 | tail -n 40 || true
		echo "::endgroup::"
	fi
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

if [ -n "${MOCK_E2E_IMAGE:-}" ]; then
	APP_ENV_NAMES="$( (comm -13 <(printf '%s\n' "$ENV_BEFORE") <(compgen -e | sort); printf '%s\n' DATABASE_URL) | sort -u)"
	docker_env=(-e PORT="$APP_PORT" -e ORIGIN="$PUBLIC_ORIGIN")
	while IFS= read -r name; do docker_env+=(-e "$name"); done <<< "$APP_ENV_NAMES"
	docker rm -f mock-model-e2e-app > /dev/null 2>&1 || true
	docker run -d --name mock-model-e2e-app --network host "${docker_env[@]}" "$MOCK_E2E_IMAGE" > "$LOG_DIR/container-id.txt"
else
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
fi

ready=""
for _ in $(seq 1 90); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_ORIGIN/" || true)
	if [ "$code" = "200" ]; then ready=1; break; fi
	sleep 2
done
if [ -z "$ready" ]; then
	echo "mock-model-e2e: $PUBLIC_ORIGIN/ never answered 200 (last: ${code:-none}); see $LOG_DIR/app.log" >&2
	[ -n "${MOCK_E2E_IMAGE:-}" ] && docker logs mock-model-e2e-app > "$LOG_DIR/app.log" 2>&1
	tail -n 60 "$LOG_DIR/app.log" >&2 || true
	exit 1
fi

cd "$WEB_DIR"
# E2E_REPLAY_MODE=off: every model call reaches the mock, none is answered by the replay layer.
# SCENARIO_SKIP_LIVE_MODEL=1 leaves out the specs that need a real model's answer.
env -u E2E_FAULT_INJECT_TOKEN \
	MOCK_E2E_FAULT_TOKEN="$E2E_FAULT_INJECT_TOKEN" \
	E2E_REPLAY_MODE=off \
	SCENARIO_MOCK_MODEL=1 \
	SCENARIO_CHAT_SURFACE=1 \
	SCENARIO_SKIP_LIVE_MODEL=1 \
	SCENARIO_BASE_URL="$PUBLIC_ORIGIN" \
	SCENARIO_DATABASE_URL="$DATABASE_URL" \
	pnpm exec playwright test -c e2e/playwright.config.ts --project=chromium --grep "${MOCK_E2E_GREP:-@mock-model}" "$@"
