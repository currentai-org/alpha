# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Open-source scaffolding: MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, this changelog,
  and `pyproject.toml` (ruff + pytest + coverage config).
- `requirements-dev.txt` for the test/lint toolchain (kept out of the runtime image).
- GitHub Actions CI running ruff + the offline test suite with coverage.
- Unit coverage for the ACP front doors (`api/acp_remote.py`) — secret
  scrubbing, the bwrap sandbox profile, and the prompt/step helpers.

### Changed
- Migrated the test suite from the bespoke `check()` harness to **pytest** + `pytest-cov`.
- Pinned runtime dependencies in `requirements.txt` for reproducible builds.
- Dev/test scripts resolve the model token and env from documented, overridable env vars instead of
  hardcoded local paths.

### Earlier milestones (pre-changelog)
The service reached a deployed, validated state before this changelog began: a credential-split
app/proxy boundary, per-user budgets, a fail-closed bwrap sandbox, an SSE live event stream, a
multi-provider sovereign compute-router with failover, and the hybrid code-as-controller loop
(including a text-protocol mode for upstreams whose tool-calling serving is broken).
