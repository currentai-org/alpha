#!/usr/bin/env bash
# Build + validate the agent-service image. Run from a shell WITH docker daemon access (the agent's sandbox
# couldn't — uid not in the docker group). Usage:
#   deploy/build.sh                      # build with the default (public) HERMES_REF
#   HERMES_REF="git+https://…@<sha>" deploy/build.sh   # build against your reachable fork
# A successful run proves: image builds, hermes resolves on PATH, and both app/proxy modules import.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${TAG:-agent-service:demo}"
ARGS=()
[[ -n "${HERMES_REF:-}" ]] && ARGS+=(--build-arg "HERMES_REF=${HERMES_REF}")
# The Dockerfile has carried ARG GIT_SHA -> ENV AGENT_BUILD_SHA since the start, with a comment saying a
# deploy that forgets it must look different from one that has it. Nothing ever passed it, so /healthz has
# reported build:"unknown" on every image ever built — which is exactly the case the comment was written
# for, and the reason "which commit is running" needed `fly image show` and a guess. `-dirty` when the tree
# has uncommitted changes: an image built from a working copy is not the commit it names.
ARGS+=(--build-arg "GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(
    git diff --quiet HEAD 2>/dev/null || echo -dirty)")

echo "==> docker build -t $TAG  (HERMES_REF=${HERMES_REF:-<dockerfile default>})"
docker build "${ARGS[@]}" -f deploy/Dockerfile -t "$TAG" .

echo "==> validate: modules import inside the image"
docker run --rm "$TAG" python -c "import app, proxy, store; print('import OK — app', app.app.version, '| proxy', proxy.app.version)"

echo "==> validate: hermes resolves"
ver="$(docker run --rm "$TAG" hermes --version 2>&1)"; echo "${ver%%$'\n'*}"   # capture (piping to head SIGPIPEs hermes)

# The offline unit suite runs in CI / `make test` against the dev venv, NOT in the runtime image:
# pytest is a dev-only dep (requirements-dev.txt) and the tests are kept out of the image (.dockerignore).
echo "PASS: image builds + hermes present + modules import ($TAG)"
