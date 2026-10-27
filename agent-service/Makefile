# agent-service — local dev. Uses uv (fast, matches the house pattern). `make help` for targets.
# Runtime deps live in requirements.txt (the same file the Dockerfile installs from).

VENV    := .venv
PY      := $(VENV)/bin/python
HERMES_VENV ?= $(HOME)/hermes-agent/.venv
# Per-task scratch, off /tmp. On a dev box /tmp is often tmpfs, where a 256MB-per-task sandbox is 256MB of
# RAM the kernel can only push to swap — and a hard-killed run leaves the directory behind, so it
# accumulates. Found at 247MB across 17 abandoned directories on a machine that was OOM-killing processes.
# ~/.cache is real disk. In the Fly container /tmp is ordinary disk and this is unset, by design.
SCRATCH ?= $(HOME)/.cache/agent-service/scratch

.PHONY: help venv test lint typecheck test-live run proxy clean

help:
	@echo "venv       - create $(VENV) and install requirements-dev.txt (uv)"
	@echo "test       - run offline unit tests with coverage (no model/docker needed)"
	@echo "lint       - ruff check the source"
	@echo "typecheck  - pyright over api/ (production code; see [tool.pyright] in pyproject.toml)"
	@echo "test-live  - list the live bash tests (need env: AGENT_DB_PATH, tokens, etc.)"
	@echo "run        - run the app role (uvicorn app:app) on :8731, scratch in $(SCRATCH)"
	@echo "proxy      - run the proxy role (uvicorn proxy:app) on :8732"
	@echo "clean      - remove $(VENV)"

# uv venvs have NO pip — always 'uv pip install', never the venv's pip (it silently no-ops).
# Dev venv pulls the test/lint toolchain too; the Docker image installs runtime-only (requirements.txt).
venv:
	@[ -d $(VENV) ] || uv venv $(VENV)
	uv pip install --python $(PY) -r requirements-dev.txt

test: venv
	$(PY) -m pytest --cov --cov-report=term-missing

# eval/ and scripts/ are linted too: they are where the measurements come from, and they had
# accumulated unflagged findings while `ruff check api` reported clean.
lint: venv
	$(PY) -m ruff check api eval scripts

# CUR-1227. Scope, config and the reason it's pyright rather than ty or mypy all live in
# [tool.pyright] in pyproject.toml — this target is just the invocation. Needs the venv, and not only
# to run: pyright resolves fastapi/pydantic/acp FROM it (venvPath/venv), and without them it reports
# every library's surface as unknown and then has nothing to say about the code using it.
# --warnings because pyright's default exit code ignores them, and a dead statement
# (reportUnusedExpression) is a warning at `standard` — see the same flag in ci.yml (CUR-1228).
typecheck: venv
	$(PY) -m pyright --warnings

# Live/integration tests are bash + need a configured model + env; they are NOT run by `make test`.
# Each takes AGENT_DB_PATH (a temp DB) so it won't touch ~/.agent-service/tasks.db.
test-live:
	@ls *.sh deploy/*.sh 2>/dev/null || true
	@echo "Run individually, e.g.:  AGENT_DB_PATH=$(SCRATCH)/t.db ./gateway-test.sh"
	@echo "ACP frontend probe (needs agent-client-protocol in the Hermes venv):"
	@echo "  uv pip install --python $(HERMES_VENV)/bin/python agent-client-protocol==0.9.0"

run: venv
	@mkdir -p $(SCRATCH)
	cd api && AGENT_SANDBOX_BACKEND=bwrap AGENT_SCRATCH_ROOT=$(SCRATCH) ../$(PY) -m uvicorn app:app --host 0.0.0.0 --port 8731

proxy: venv
	cd api && ../$(PY) -m uvicorn proxy:app --host 0.0.0.0 --port 8732

clean:
	rm -rf $(VENV)
