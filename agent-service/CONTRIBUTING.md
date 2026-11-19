# Contributing

This is the Public AI agent service — a sovereign Hermes agent API with a
model-boundary proxy, an execution sandbox (an E2B microVM per conversation by default, `bwrap` for
local stacks), and an independent-verify + best-of-N layer that catches the
model's occasional false "task completed" on long-running work.

## Dev setup

Requires Python 3.11+ and [uv](https://github.com/astral-sh/uv).

```
make venv     # creates .venv and installs requirements-dev.txt (runtime + test deps)
make test     # offline test suite — no network, no model, no Docker
make lint     # ruff check
make run      # app role on :8731   (make proxy → proxy role on :8732)
```

`requirements.txt` is the single source of truth for **runtime** deps (the Dockerfile installs from
it). `requirements-dev.txt` adds the test/lint toolchain and is **not** in the image.

## Architecture (the two planes)

- **App** (`api/app.py`) — credential-free request handler. Submits/polls runs, streams SSE, enforces
  per-user budgets. Never sees the real model token.
- **Proxy / gateway** (`api/proxy.py`) — holds the upstream model credential, swaps the per-task
  nonce for the real token, clamps spend/step caps, and can fail over across sovereign providers.
- **ACP front door** (`api/acp_remote.py`) — a local Agent Client Protocol shim for editors (Zed, etc.)
  that forwards to the hosted service; the editor's client runs nothing locally.

See `docs/` for the design, the wire/streaming spec, and the model×host×controller matrix.

## Before you open a PR

- `make test` is green (the suite is offline and deterministic — it must stay that way).
- `make lint` is clean (`ruff`).
- New behavior gets a test. The security-relevant seams (budget clamps, secret scrubbing, SSRF
  guard, sandbox profile, verify-spec parsing) especially must keep their regression coverage.
- Don't commit secrets. Tokens load from a local, gitignored env file or a path you set via env var;
  never hardcode a token or a personal absolute path.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — report privately, not via a public issue.
