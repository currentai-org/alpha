#!/usr/bin/env bash
# Boots deploy/compose.yaml with the aimock overlay (aimock.compose.yaml), and compose.two-web.yaml when
# TWO_WEB is set, and waits until the web service answers. Used by .github/workflows/load.yml; run from the repository root. It writes
# deploy/.env with fresh random keys, so never run it on a host whose deploy/.env is real.
set -euo pipefail
cd deploy
if [ ! -f .env ]; then
	{
		echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
		echo "OPENAI_BASE_URL=http://aimock:4010/v1"
		echo "OPENAI_API_KEY=mock-model-no-key"
		echo "FILES_ACCESS_KEY=$(openssl rand -hex 16)"
		echo "FILES_SECRET_KEY=$(openssl rand -hex 32)"
	} > .env
fi
# TWO_WEB=1 adds compose.two-web.yaml: two web processes behind a proxy on the same port.
export COMPOSE_FILE="compose.yaml${TWO_WEB:+:compose.two-web.yaml}:$PWD/loadtest/aimock.compose.yaml"
echo "COMPOSE_FILE=$COMPOSE_FILE" >> "${GITHUB_ENV:-/dev/null}"
docker compose up -d --wait --wait-timeout 600
for _ in $(seq 1 60); do
	curl -fsS -o /dev/null http://localhost:3000/healthcheck && break
	sleep 5
done
curl -fsS http://localhost:3000/api/models | jq -c '[.[]? | .id // .name] // .' | cut -c1-300
docker compose images web
echo "$(nproc) CPUs, $(free -g | awk '/^Mem:/ {print $2}') GiB"
