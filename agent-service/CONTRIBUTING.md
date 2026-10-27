# Contributing

This guide covers local setup and the checks a pull request to the agent service must pass.

## Set up a dev environment

The service requires Python 3.11+ and [uv](https://github.com/astral-sh/uv).

```
make venv     # creates .venv and installs requirements-dev.txt (runtime + test deps)
make test     # offline test suite: no network, no model, no Docker
make lint     # ruff check
make run      # app role on :8731   (make proxy → proxy role on :8732)
```

`requirements.txt` lists the runtime dependencies, and the Dockerfile installs from it.
`requirements-dev.txt` adds the test and lint toolchain and isn't installed in the image.

## Architecture

- **App** (`api/app.py`) handles requests without a model credential. It submits and polls runs,
  streams SSE and enforces per-user budgets.
- **Proxy** (`api/proxy.py`) holds the upstream model credential. It swaps the per-task nonce for
  the real token, enforces step and spend caps, and can fail over across providers.
- **ACP front door** (`api/acp_remote.py`) is a local Agent Client Protocol shim for editors such
  as Zed. It forwards to the hosted service, and the editor runs nothing locally.

`README.md` covers the design. `compose.yaml` and `config.yaml.example` show the configuration.

## Check your change

Before you open a pull request:

- Run `make test` and confirm it passes. The suite is offline and deterministic. Keep it that way.
- Run `make lint` (`ruff`) and fix any findings.
- Add a test for new behavior. Keep regression coverage on the security-relevant code: budget
  clamps, secret scrubbing, the SSRF guard, the sandbox profile and verify-spec parsing.
- Don't commit secrets. Load tokens from a gitignored env file or from a path set in an env var.
  Never hardcode a token or an absolute path from your machine.

## Report a security issue

Report vulnerabilities privately through the repository's **Security** tab ("Report a vulnerability"),
as the root `SECURITY.md` describes. Don't open a public issue.
