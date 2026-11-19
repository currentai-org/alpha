# Deploy — one image, two roles (Plane A gateway + Plane B execution)

Fly deploys: `../fly/DEPLOY.md`. EC2 deploys beside the E2B hosts: `aws/agent/README.md`.

One image serves both roles:

- **Plane A — `agent-proxy`** (`proxy.py`): holds the real model token, meters step/spend per nonce, and
  is the only role with egress to the upstream model endpoint.
- **Plane B — `agent-app`** (`app.py`): runs the per-task agent **credential-free** (it gets a per-task
  nonce from the proxy), with a durable sqlite store. Code runs in the sandbox `AGENT_SANDBOX_BACKEND`
  names: E2B in production (`e2b-link/`, `e2b-template/`, `aws/e2b/`), bwrap beside the app otherwise.
  `entrypoint.sh` installs default-deny egress (nftables) before dropping privileges, so the agent's
  only outbound is the gateway.

## Demo without a deploy
For showing it off locally, use `../compose.yaml`:
```
echo "PROVIDER_CSCS_TOKEN=<cscs_token_with_a_ceiling>"  >  .env   # compose.yaml's only upstream
echo "PROXY_ADMIN_KEY=$(openssl rand -hex 24)"    >> .env
docker compose up --build            # then drive http://127.0.0.1:8731
```
Mirrors the two-plane topology (proxy holds the token, app credential-free), binds to loopback, caps spend.
It's a **trusted-local** demo (auth off) — don't expose it to the internet as-is. Build/validate the image
first with `deploy/build.sh` (needs docker daemon access; Hermes installs from the public upstream commit —
no fork to set up).
