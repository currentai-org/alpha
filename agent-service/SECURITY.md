# Security Policy

This service runs **model-driven shell commands** on behalf of API callers, so its security
posture is part of its design, not an afterthought. If you find a vulnerability, please report it
privately first.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**, with a description, reproduction steps, and impact. Please do **not** open a public
issue or PR for security reports. We'll acknowledge receipt within **7 days** and aim for an initial
assessment within **30 days**, then coordinate a disclosure timeline with you — defaulting to
**90 days** from the initial report unless circumstances warrant otherwise. The repository's root
`SECURITY.md` covers the rest of the snapshot.

## Security model (what the design already enforces)

- **Two planes, split credentials.** The app (`api/app.py`) is credential-free; it never holds the
  real model token. The proxy/gateway (`api/proxy.py`) holds the upstream token and hands the agent
  only a per-task nonce, swapping in the real secret at the boundary. Server secrets
  (`PROXY_ADMIN_KEY`, `WEBUI_SECRET_KEY`, `MODEL_UPSTREAM_TOKEN`) are scrubbed from the agent subprocess env.
- **Sandbox, fail-closed.** The `/run` path executes inside `bwrap` with the durable store, `$HOME`,
  and app source replaced by empty tmpfs, so one caller's task can't read another's. Deployments set
  `AGENT_SANDBOX_REQUIRED=1`.
- **SSRF guard on webhooks.** Callback URLs are validated and pinned (loopback, link-local/metadata,
  and private ranges blocked, including IPv4-mapped IPv6).
- **No model-supplied shell.** Auto-derived verify specs are declarative-only (`expect_file` /
  `expect_contains`); a model-emitted `check_cmd` is dropped during parsing.
- **Spend + step caps** are enforced gateway-side (defense-in-depth) and clamped server-side, per
  task and per user.

These guarantees are covered by the offline test suite (`make test`) — the budget clamps, secret
scrubbing, SSRF guard, sandbox profile, and store column allowlist all have regression tests.

## Scope

In scope: the agent service code in this repository (`api/`, `deploy/`, `scripts/`).
Out of scope: the upstream model serving stack, Hermes itself, and third-party providers.
