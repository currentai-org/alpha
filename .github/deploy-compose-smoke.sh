#!/usr/bin/env bash
# Boots deploy/compose.yaml as a self-hoster would, with aimock as the model
# (.github/deploy-aimock.compose.yaml), and runs deploy/smoke.sh against it: one guest turn that must come
# back as the mock model's answer, not as an error or a safety decline. Run from the repository root.
#
#   .github/deploy-compose-smoke.sh                       # the image deploy/compose.yaml names
#   ALPHA_IMAGE=ghcr.io/...@sha256:... .github/deploy-compose-smoke.sh
#   ALPHA_EDITION=hosted .github/deploy-compose-smoke.sh  # the hosted edition: must fail, every turn declined
#
# It writes deploy/.env with fresh random keys and takes the stack down with its volumes at the end, so
# never run it on a host whose deploy/ stack is real.
set -euo pipefail
cd deploy
[ ! -f .env ] || { echo "deploy/.env exists; refusing to overwrite a real stack's settings" >&2; exit 2; }
{
	echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
	echo "OPENAI_BASE_URL=http://aimock:4010/v1"
	echo "OPENAI_API_KEY=mock-model-no-key"
	echo "FILES_ACCESS_KEY=$(openssl rand -hex 16)"
	echo "FILES_SECRET_KEY=$(openssl rand -hex 32)"
} > .env
export COMPOSE_FILE="compose.yaml:$PWD/../.github/deploy-aimock.compose.yaml"
cleanup() {
	docker compose logs --no-color web > "${DEPLOY_SMOKE_LOG:-/dev/null}" 2>&1 || true
	docker compose down -v > /dev/null 2>&1 || true
	rm -f .env
}
trap cleanup EXIT
docker compose up -d --wait --wait-timeout 600
docker compose images web
SMOKE_CHAT_PATH="" SMOKE_EXPECT="comes from the mock model" ./smoke.sh
