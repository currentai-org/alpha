# Alpha agent service

The agent service is an HTTP API that runs a [Hermes](https://github.com/NousResearch/hermes-agent)
agent (Nous Research, MIT) on an open model and drives a multi-step task to completion. It keeps the
model credential behind a separate gateway, runs each task's work in a sandbox, and checks each
result against its side effects before it reports success.

The Alpha chat app calls it for agent mode. `web/`'s chat API reaches it at `AGENT_SERVICE_URL` and
authenticates with `AGENT_SERVICE_TOKEN`. Auth and the safety screen come from the chat app. The
agent service's own work is running model-driven tool calls and shell commands, metering spend, and
keeping the model credential away from the agent.

To set up a local environment, run `make venv && make test`. The test suite is offline and needs no
network, model or Docker. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup. `config.yaml.example` and
`compose.yaml` show the configuration.

## Features

- **Model-boundary gateway** (`api/proxy.py`). The app never holds the real model token. The agent
  subprocess gets a per-task nonce. The gateway swaps in the real credential on outbound calls,
  counts model calls against the step cap, sums `usage` tokens against the spend cap, and can fail
  over across an ordered list of providers.
- **Fail-closed sandbox.** With the default `AGENT_SANDBOX_BACKEND=e2b`, each conversation's work
  runs in its own E2B microVM, and a deploy without the E2B config refuses to boot. The host-local
  runner (`AGENT_SANDBOX_BACKEND=bwrap`, for local stacks) runs under `bwrap` with `$HOME`, the
  durable store and the app source replaced by empty tmpfs mounts. With `AGENT_SANDBOX_REQUIRED=1`,
  a broken sandbox refuses to run.
- **Verified results.** Runs are checked without an LLM against an optional declarative `verify`
  spec. A result is reported `verified` only when its side effects confirm it. `AGENT_BEST_OF` runs
  up to N attempts and accepts the first one that verifies, which catches the model's occasional
  false "task completed" on long dependent chains.

## Architecture

The service runs as two planes from one image.

| Plane | File | Holds the token | Role |
|------|------|------------------|------|
| **App** | `api/app.py` | no | `POST /run`, polling, SSE stream, per-user budgets |
| **Gateway** | `api/proxy.py` | yes | swaps the per-task nonce for the real token, enforces step and spend caps, routes the provider chain and the verifier |

Other modules: `api/store.py` is the durable SQLite task store and per-user spend ledger.
`api/acp_remote.py` is the Agent Client Protocol front door for local editors.

### Gateway responsibilities

- **Step cap.** `hermes -z` has no CLI flag for `max_turns`, and the config value reaches only the
  TUI and cron paths. The oneshot path the service spawns (`_execute_attempt` in `api/app.py`)
  therefore has no iteration cap of its own. The gateway counts model calls per nonce
  (`chat_completions` in `api/proxy.py`) and stops a runaway loop. `AGENT_MAX_STEPS` takes effect
  only through the gateway.
- **Spend cap.** The gateway sums streamed `usage` tokens per nonce and rejects calls past
  `max_tokens` (also in `chat_completions`). The wall-clock limit fires only after the tokens are
  spent.
- **Credential boundary.** The deployed transport is ACP (`AGENT_ACP=1`, reported by `/healthz`).
  A per-call permission gate (`request_permission` in `api/acp_client.py`) pauses edit and delete
  calls for a human to confirm. The deployed config sets `ACP_PERMISSION_POLICY=confirm`. `--yolo`
  applies only to the legacy `hermes -z` oneshot fallback, used when `AGENT_ACP` is unset on local
  and dev paths. On both transports, `_model_env` in `api/app.py` gives the subprocess
  `HF_TOKEN=<nonce>` and never a real key, so code the agent runs can't read a credential. When the
  gateway is configured but unreachable, the app fails the task (`_grant_attempt_budget` in
  `api/app.py`). It never falls back to passing the real token through.
- **Provider failover.** `MODEL_PROVIDERS` is a one-element chain (`cscs`). Failing over to a host
  that serves a different model would make the provenance badge wrong, so failover is unused.

### Local passthrough mode

With `AGENT_MODEL_PROXY_URL` unset, the app calls the model directly and `/healthz` reports
`secrets_boundary: "OFF(legacy passthrough)"` (`healthz` in `api/app.py`). This mode has no step
cap and no spend cap, and the agent holds the real key. Use it only for local harness work such as
`gateway-test.sh`. Never expose it.

## Quickstart

```
make venv                                          # .venv + dev deps (uv)
make test                                          # offline suite: pytest + ruff + coverage
cp config.yaml.example ~/.hermes/config.yaml       # one-time Hermes provider config
./smoke.sh                                         # MODEL_UPSTREAM_TOKEN from env or a gitignored .env.local
```

The smoke test prints `PASS: agent counted 3 .py files …`.

### Test the gateway

```
./gateway-test.sh   # starts proxy.py (holds the only real token) and app.py (started without one)
```

A task completes only when the agent was credentialed through the per-task nonce. The test then
checks that the step cap forces a verified failure. To enable the gateway in `app.py`, set
`AGENT_MODEL_PROXY_URL` and `PROXY_ADMIN_KEY`. Per-run `max_steps` and `max_tokens` can only lower
the server ceilings.

## Run the tests

- **`make test`** runs the offline pytest suite with no network or agent. It covers cap clamps,
  failure detection, concurrency slots, verify-spec validation, secret stripping, the durable store
  and per-user budgets, the compute-router failover policy, the SSE event stream, the frozen wire
  contract, and the ACP front-door helpers (secret scrubbing and the bwrap profile). The suite is
  coverage-gated, and CI runs it on every push.
- **`make lint`** runs `ruff`.
- **Live integration scripts** need a funded token and a running model: `gateway-test.sh`,
  `sandbox-test.sh`, `hardening-test.sh`, `load-test.sh`, `persistence-test.sh`,
  `failure-recovery-test.sh`, `long-context-test.sh`, `model-adherence-test.sh` and
  `multi-toolset-test.sh`. They read the token and venv location from env vars defined in
  `scripts/testlib.sh`.

## Models

**Default model.** Apertus-1.5-70B on CSCS drives Hermes' multi-turn loop with the `coding` toolset
and `AGENT_BEST_OF=3`. The released weights are
[`swiss-ai/Apertus-v1.5-70B`](https://huggingface.co/swiss-ai/Apertus-v1.5-70B) (Apache-2.0). The
model id on the wire is `apertus-ai/Apertus-v1.5-70B`, the persistent CSCS deployment of 1.5.

The coding benchmark has 6 realistic multi-file tasks, each run 3 times and graded by a hidden
acceptance test. Across two runs of it, 9 to 11 of the 18 attempts verified, and 1 to 2 tasks passed
all three trials. The bounded smoke fixtures pass 20 of 24. The smoke figure checks the plumbing and
says nothing about capability.

**Dev and CI model.** `Qwen/Qwen3-Next-80B-A3B-Instruct` on HF Inference Providers is a low-cost MoE
that passes the adherence suite. The 32B and 235B variants also pass. The 80B model loses state past
about 32k tokens of context (long-horizon pass^8 = 4/8), where the 235B holds (8/8). Route long tasks
to a model verified for long context.

**Model ids on CSCS.** The CSCS research catalog rotates checkpoints within hours to days.
`scripts/dogfood.py` reads `/v1/models` before every run and fails if the configured id is gone. A
503 `"No provider found for the requested service."` from that gateway means an unrecognized model
id. A bad credential returns 401.

## Hermes pin and patches

The deploy image clones upstream Hermes at a pinned SHA, then applies each patch in `deploy/hermes/`
in filename order. The clone URL points at upstream, and each patch is reviewed as part of this
repository. An upstream bump that breaks a patch fails the image build. `deploy/Dockerfile` can also
build from a fork through `HERMES_GIT_URL` and `HERMES_SHA`. Production doesn't use this. Each patch
has an exit condition recorded in the Dockerfile. `deploy/hermes/UPSTREAM.md` describes how to bump
the pin.

The service writes `HERMES_ACP_TOOLSETS` into each attempt's `config.yaml` as
`platform_toolsets.acp`, which upstream Hermes reads directly. `/healthz` reports the result as
`toolsets_effective`. Upstream Hermes has no `HERMES_LEAN_PROMPT`, so the service doesn't set it.
The model serving token is a gateway secret and never enters the image.

### Execute confirmation patch

`deploy/hermes/0002-acp-confirm-execute.patch` makes `terminal`, `process` and `execute_code` calls
reach `request_permission`. It proposes those tool names from the same code path that edit approval
uses, and it adds no env var. The patch always applies. `_ALWAYS_CONFIRM_KINDS` in
`api/acp_client.py` decides whether the resulting `kind="execute"` proposal pauses.

Two upstream Hermes variables interact with it:

- `HERMES_INTERACTIVE=1` is set by `acp_adapter/server.py` for every ACP session. It routes the
  pattern-matched dangerous-command prompt in `tools.approval.check_dangerous_command` to the
  interactive callback path. The patch's requester runs alongside that mechanism, so a dangerous
  terminal command can raise two separate confirms.
- `HERMES_SESSION_KEY` is set per ACP session in the same block. It scopes per-session caches, such
  as the interactive sudo-password cache in `tools.terminal_tool`, to one ACP session so they don't
  carry over between sessions on a reused executor thread. It doesn't affect the confirm gate.

## Deploy

- **`deploy/`** holds the `Dockerfile` (one image, two roles, selected by the start command),
  `entrypoint.sh` (installs a default-deny egress allowlist, then drops to the unprivileged user),
  `hermes/` (patches applied to the pinned Hermes), `e2b-template/` (the sandbox image) and
  `e2b-link/` (a WireGuard link to a self-hosted E2B). See [`deploy/README.md`](deploy/README.md).
- **`compose.yaml`** runs a local two-plane demo. The proxy holds the token and the app has none.

## Connect an MCP server

Set `AGENT_MCP_SERVERS` to give the agent's Hermes session an MCP server's tools. This requires the
ACP transport (`AGENT_ACP=1`, which `compose.yaml` sets).

```sh
AGENT_MCP_SERVERS='[{"name": "folkways", "url": "https://folkways.example.org/mcp",
                     "headers": {"Authorization": "FOLKWAYS_MCP_AUTH"}}]'
FOLKWAYS_MCP_AUTH='Bearer …'     # a secret; the JSON names this var and never holds the value
```

- **Fields.** `name` uses lowercase letters, digits, `-` or `_`. `url` must use https. `headers` maps
  a header name to the env var its value is read from when each task starts. `transport` is
  optional, and `"http"` (Streamable HTTP) is the only accepted value. The pinned Hermes drops the
  SSE transport on the ACP path, so an SSE server never connects.
- **Tool names.** Hermes lists MCP tools by name and description. The model calls them through its
  `tool_call` bridge (`tools/tool_search.py`) as `mcp__folkways__<tool>`.
- **Permission policy.** Only tasks whose permission policy resolves to `allow` get the servers.
  Under `deny_writes`, `confirm`, or `staged` for a new caller, the servers are left off the
  session, because neither permission gate sees MCP calls.
- **Egress.** In a deployed container, the agent can reach only the hosts in the nftables allowlist
  that `deploy/entrypoint.sh` installs at boot. The entrypoint adds each configured MCP host from
  `AGENT_MCP_SERVERS`, so you don't need to edit `AGENT_EGRESS_ALLOW_HOSTS`. The allowlist is built
  at boot, so a change takes effect on the next machine restart.
- **Config errors.** Malformed JSON or any rejected entry disables all MCP servers, logs
  `mcp.config_invalid`, and reports the reason under `mcp.error` in `/healthz`. Tasks keep running.
  A server whose header env var is unset is skipped for that task (`mcp.server_skipped`).

### Use a local MCP server

`http://localhost`, `127.0.0.1` and `[::1]` are refused unless you also set
`AGENT_MCP_ALLOW_LOCALHOST=1`. Never set it on a deploy.

```sh
AGENT_ACP=1 AGENT_MCP_ALLOW_LOCALHOST=1 \
AGENT_MCP_SERVERS='[{"name": "folkways", "url": "http://127.0.0.1:8000/mcp"}]' make run
```

The Hermes that `make run` launches needs the `mcp` extra, which the image includes:
`uv pip install --python <hermes venv>/bin/python -e '<hermes checkout>[acp,mcp]'`. Without it,
Hermes skips every server without logging an error.

### Check the MCP config

`curl -s $AGENT_URL/healthz | jq .mcp` returns `servers` (names only, never URLs or header values;
absent when the variable is unset), `error`, `missing_header_env`, and `active` (false when
`AGENT_ACP` is off). `scripts/mcp_live_probe.py` runs a real `hermes acp` session against a stub MCP
server with a scripted model, offline. `api/test_mcp_hermes_live.py` wraps it.

## Platform integration

- **Auth.** The chat API sends `Authorization: Bearer <AGENT_SERVICE_TOKEN>` on every call, plus an
  `X-Agent-Subject` header that names the visitor. The service validates the bearer as an HS256 JWT
  signed with `WEBUI_SECRET_KEY` (`require_user` in `api/app.py`), so `AGENT_SERVICE_TOKEN` is a JWT
  minted with that key. The token must carry an `id` or `sub` claim. `exp` is required only with
  `AGENT_AUTH_REQUIRE_EXP=1`. Without `WEBUI_SECRET_KEY`, the service returns 503. A missing or
  malformed token gets 401, and a request for another user's task gets 403. OIDC/JWKS isn't
  implemented: `OIDC_JWKS_URL` is never read, and `require_user` only calls
  `jwt.decode(..., algorithms=["HS256"])`.
- **Moderation.** The service calls the chat app's safety screen endpoint
  (`POST /chat/api/safety/screen`, configured with `SAFETY_SCREEN_URL` and `SAFETY_SCREEN_TOKEN`)
  before and after each run. It fails closed when the endpoint is configured but unreachable. Coop
  (`COOP_URL` and `COOP_API_KEY`, the same instance as `web/src/lib/chat/server/moderation.ts`) is
  review-only. It renders no verdict and receives a `/api/v1/report` submission for human triage
  each time the screen flags a run.
- **Dev overrides.** `AGENT_AUTH_DISABLED` and `AGENT_MODERATION_DISABLED` are for local
  development only. Never set them on a shared deploy.

## License and security

The service is licensed under [MIT](LICENSE). Report vulnerabilities privately as the
root `SECURITY.md` describes. Dev setup and pull request requirements are in
[CONTRIBUTING.md](CONTRIBUTING.md).
