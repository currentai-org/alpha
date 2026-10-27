# Deploy the agent service

The image in this directory runs as one of two roles. The start command picks the role.

- **Gateway** (`proxy.py`) holds the real model token and meters steps and spend per nonce. It is
  the only role with egress to the upstream model endpoint.
- **App** (`app.py`) runs the per-task agent without a model credential. The agent gets a per-task
  nonce from the proxy. Task state lives in a SQLite store at `AGENT_DB_PATH`. Work runs in an E2B
  microVM (`AGENT_SANDBOX_BACKEND=e2b`, the default) or under `bwrap`
  (`AGENT_SANDBOX_BACKEND=bwrap`).

Other files: `entrypoint.sh` installs the egress allowlist, then drops to the unprivileged user.
`hermes/` holds patches applied to the pinned Hermes. `e2b-template/` is the sandbox image, and
`e2b-link/` is a WireGuard link to a self-hosted E2B. The directory also holds `build.sh`,
`compose.iso.yaml`, `seccomp/` and the smoke scripts.

## Run a local demo

To run without a cluster, registry or sealed secrets, use `../compose.yaml`:

```
echo "PROVIDER_CSCS_TOKEN=<cscs_token_with_a_ceiling>"   >  .env
echo "PROXY_ADMIN_KEY=$(openssl rand -hex 24)"           >> .env
docker compose up --build            # then open http://127.0.0.1:8731
```

In the demo, the proxy holds the token and the app has none. Both bind to loopback, and spend is
capped. Auth is off, so don't expose the demo to the internet. To build and check the image
first, run `deploy/build.sh`. It needs access to the Docker daemon and installs Hermes from the
public upstream commit.

## Build the image

```
cd agent-service
docker build --build-arg HERMES_REF=<git-url>@<sha> -f deploy/Dockerfile -t <image>:<tag> .
```

Start the gateway role with `uvicorn proxy:app` and the app role with the default
`python serve.py`, as `../compose.yaml` does. `deploy/build.sh` wraps the same build.

## Exfiltration controls

1. **Filesystem.** With `AGENT_SANDBOX_BACKEND=bwrap` and `AGENT_SANDBOX=bwrap` (set in the image),
   the agent can't read host secrets or write outside its scratch directory. `../sandbox-test.sh`
   checks this locally. `AGENT_SANDBOX_REQUIRED=1` fails closed. With the default `e2b` backend, work
   runs in a separate microVM.
2. **Network.** `entrypoint.sh` installs a default-deny egress allowlist before it drops
   privileges. The allowlist holds the model gateway, the log sink, and any host named in
   `AGENT_MCP_SERVERS`, so a `--yolo` shell can't send data to an arbitrary host. `bwrap` can't
   enforce this without privileges.

## Configure the integrations

- **Auth.** Set `WEBUI_SECRET_KEY` on the app. It is the HS256 key that validates the bearer token
  (the chat app's `AGENT_SERVICE_TOKEN`). Without it, the app fails closed with 503, unless
  `AGENT_AUTH_DISABLED=1` is set for local development.
- **Moderation.** Set `SAFETY_SCREEN_URL` and `SAFETY_SCREEN_TOKEN` to the chat app's safety screen
  endpoint. `COOP_URL` and `COOP_API_KEY` configure review-only reporting.

## Scale out

- Run one instance of each role unless the task store is shared. The proxy's caps, the app's
  concurrency cap and the SQLite store are all per instance. To scale out, move grants and the task
  store to shared state (Postgres, with the same column shape as `store.py`) and move the gateway
  caps to a shared counter.
- Scrape `/metrics` (Prometheus text format) on the app.
