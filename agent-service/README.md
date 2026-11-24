# Public AI Agent Service

A developer-facing API that runs a [Hermes](https://github.com/NousResearch/hermes-agent) agent
(Nous Research, MIT) on an open / sovereign model and drives a multi-step task end-to-end — with a
**credential-split boundary**, an **execution sandbox**, and an **independent-verify + best-of-N**
layer that catches the model's occasional false "task completed".

It's a component of the [Public AI](https://aipotluck.org) stack that builds and deploys separately
from the web app. It *consumes* the platform's shared auth and moderation rather than rebuilding
them; its own novel work is the **execution delta** — running model-driven tool calls and shell safely,
metering spend, and keeping the model credential off the agent.

> **Local dev:** `make venv && make test` (offline test suite, no network/model/Docker). The longer
> setup notes, the streaming/ACP design and the model trade-off write-up are internal documents and
> are not part of the public repository.
>
> **In the public snapshot:** `docs/`, `fly/` and `deploy/aws/` hold the hosted deployment's notes and
> config and are left out, so the paths under them named in this README are not in that copy.

## Why it's interesting

- **Model-boundary gateway** (`api/proxy.py`) — the app never holds the real model token. The agent
  subprocess gets a per-task *nonce*; the gateway swaps in the real credential outbound, counts model
  calls (step cap) and sums `usage` tokens (spend cap), and can fail over across an ordered,
  sovereign-first list of providers.
- **Fail-closed sandbox** — by default (`AGENT_SANDBOX_BACKEND=e2b`) each conversation's work runs in its
  own E2B microVM, and a deploy missing the E2B config refuses to boot. The host-local runner
  (`AGENT_SANDBOX_BACKEND=bwrap`, for local stacks) executes under `bwrap` with `$HOME`, the durable store,
  and the app source replaced by empty tmpfs; with `AGENT_SANDBOX_REQUIRED=1` a broken sandbox refuses to
  run rather than leaking.
- **Honest results** — runs are verified LLM-free against an optional declarative `verify` spec; a
  result is reported `verified` only if its side-effects confirm it. `AGENT_BEST_OF` retries up to N
  self-grounded attempts and accepts the first one that verifies — closing the model's occasional false
  "task completed" on long dependent chains.

## Architecture — two planes

| Plane | File | Holds the token? | Role |
|------|------|------------------|------|
| **App** | `api/app.py` | no | `POST /run`, polling, SSE stream, per-user budgets — credential-free |
| **Gateway** | `api/proxy.py` | yes | swaps the per-task nonce for the real token, clamps step/spend caps, routes the provider chain and the verifier |

Other surfaces: `api/store.py` (durable sqlite task store + per-user spend ledger),
`api/acp_remote.py` (Agent Client Protocol front door for local editors).

**Why a separate gateway plane, and whether it still earns its keep.** Three of its four jobs have no
substitute anywhere else in the system:

- **It is the only step cap that exists.** Hermes' `max_turns` setting does not reach the `hermes -z`
  oneshot path (see the comment above `MODEL_PROXY_URL` in `api/app.py`). The gateway counts model calls
  per nonce and refuses the next one once the cap is reached (`chat_completions` in `api/proxy.py`), and
  that count is what stops a runaway loop on every transport. Without it `AGENT_MAX_STEPS` would do
  nothing.
- **It is the only spend cap.** The gateway sums the streamed `usage` tokens per nonce and refuses
  further calls past `max_tokens` (`chat_completions` in `api/proxy.py`). The wall clock is the only
  other bound, and it fires after the money is spent.
- **It is the credential boundary, and that matters because of what the agent is.** The deployed
  transport is ACP (`AGENT_ACP=1`), with a per-call permission gate (`request_permission` in
  `api/acp_client.py`). `ACP_PERMISSION_POLICY` sets what that gate does: `allow`, `deny_writes`,
  `confirm` or `staged`, and production runs `staged`. The `--yolo` flag belongs to the legacy
  `hermes -z` oneshot transport, used only when `AGENT_ACP` is unset, which local and development paths
  still support. On either transport `_model_env` in `api/app.py` hands the subprocess `HF_TOKEN=<nonce>`
  and never a real key, so nothing the agent runs can read a model credential. When the gateway is
  configured but cannot grant an attempt its budget, that attempt does not run
  (`_grant_attempt_budget` in `api/app.py`); the app never falls back to passing the real token through.

The fourth job, multi-provider failover, is unused in production: `MODEL_PROVIDERS` is a one-element
chain (`mistral` in `deploy/env/gateway.toml`). That is deliberate. Failing over to a host that serves a
different model would make the model a response reports untrue, so a provider outage fails the task
instead. The nonce, cap and credential layer beneath the router is what the gateway is for.

Running without the gateway is supported and reported rather than silent. Leave `AGENT_MODEL_PROXY_URL`
unset and `/healthz` reports `secrets_boundary: "OFF(legacy passthrough)"`. That path has no step cap
and no spend cap, and the agent holds the real key. It exists for local harness work, not for anything
exposed.

## Quickstart

```
make venv                                          # .venv + dev deps (uv)
make test                                          # offline suite: pytest + ruff + coverage
cp config.yaml.example ~/.hermes/config.yaml       # one-time Hermes provider config
./smoke.sh                                          # MODEL_UPSTREAM_TOKEN from env or a gitignored .env.local
```
Expect: `PASS: agent counted 3 .py files …`.

### The gateway interlocks (secrets-at-boundary + step/spend caps)
```
./gateway-test.sh   # starts proxy.py (holds the ONLY real token) + app.py (started WITHOUT one)
```
A task can only complete if the agent was credentialed via the per-task nonce — that *is* the secrets
boundary. The test then proves the step cap forces a verified failure. Enable the gateway in `api/app.py`
with `AGENT_MODEL_PROXY_URL` + `PROXY_ADMIN_KEY`; per-run `max_steps`/`max_tokens` can only tighten the
server ceilings. (A gateway, rather than Hermes' own cap, because the `hermes -z` one-shot path doesn't
enforce config `max_turns` — so the cap, secrets, and spend metering all live at one owned chokepoint.)

## Testing

- **`make test`** — offline pytest suite (no network/agent): cap clamps, honest-failure detection,
  concurrency slots, verify-spec validation, secret stripping, the durable store + per-user budgets,
  the compute-router failover policy, the SSE event stream, the frozen wire contract, and the ACP
  front-door helpers (secret scrub + bwrap profile). Coverage-gated; CI runs it on every push.
- **`make lint`** — `ruff`.
- **Live integration scripts** (need a funded token + a running model): `gateway-test.sh`,
  `sandbox-test.sh`, `hardening-test.sh`, `load-test.sh`, `persistence-test.sh`,
  `failure-recovery-test.sh`, `long-context-test.sh`, `model-adherence-test.sh`,
  `multi-toolset-test.sh`. They resolve the token + venv from overridable env vars (see
  `scripts/testlib.sh`).

## Models

**Production:** the default executor is Mistral Large 4 (`AGENT_MODEL = "mistral-large-2610"` in
`deploy/env/agent.toml`), served through Public AI's inference router as a single-provider chain
(`MODEL_PROVIDERS = "mistral"` in `deploy/env/gateway.toml`). A task runs on the model the chat names for
it when `PROVIDER_MISTRAL_MODEL_MAP` lists that model, and is refused when it does not; the default
applies only when the chat names none. Hermes drives its own multi-turn loop over ACP with the
`file,terminal,todo,code_execution` toolsets and `AGENT_BEST_OF=3`. On chat turns a separate verifier model,
set at deploy time through `AGENT_VERIFIER_MODEL`, judges whether the result satisfies the task. The
proxy config keeps two rollback routes configured: GLM-5.2 through Hugging Face's router, and
Apertus-1.5-70B served at CSCS.

**Dev/CI path:** `Qwen/Qwen3-Next-80B-A3B-Instruct` on HF Inference Providers — a cheap MoE that
passes the adherence suite; 32B and 235B also pass, pick on cost. **A measured caveat:** the cheap 80B
drops state past ~32k context (long-horizon pass^8 = 4/8) where the 235B holds (8/8) — route long
tasks to a long-context-verified model.

**A caution about the CSCS route:** CSCS's research catalog rotates checkpoints on an hours-to-days
timescale, so `scripts/dogfood.py` snapshots `/v1/models` before every run and fails loudly if the
configured id has moved. A 503 `"No provider found for the requested service."` from that endpoint
means an unrecognized model id, not a bad credential; a bad credential returns 401.

The model × host × controller matrix and the reliability measurements behind these choices are in an
internal write-up that is not part of the public repository.

The Hermes harness is pinned (so "it works" survives drift): the deploy image clones stock upstream at a
pinned SHA, then applies everything in `deploy/hermes/` on top, in filename order. This is deliberately
not a fork — the clone URL still points at stock upstream, each patch stays reviewable in our own code
review, and an upstream bump that invalidates one fails the **build** rather than drifting quietly.
`deploy/Dockerfile` also supports building from a fork via `HERMES_GIT_URL`/`HERMES_SHA`; production does
not use it. Every patch there carries a stated exit condition in the Dockerfile, or the collection
becomes a fork by accumulation.

`HERMES_ACP_TOOLSETS` needs no patch at the pinned version: the agent service writes it into each
attempt's `config.yaml` as `platform_toolsets.acp`, which upstream Hermes reads itself. `/healthz`'s
`toolsets_effective` reports the toolsets a running deploy actually hands Hermes. `HERMES_LEAN_PROMPT`
is different: neither upstream Hermes nor the patches in `deploy/hermes/` implement it, and production
never sets it, so treat anything measured with it as an experiment. The model serving token never lands
in the image; it is a gateway secret.

`deploy/hermes/0002-acp-confirm-execute.patch` introduces no env-var knob of its own — it
closes the gap where a `terminal`/`process`/`execute_code` call never reached `request_permission` at
all, by proposing those tool names from the same chokepoint edit approval already uses. It runs
unconditionally: `api/acp_client.py`'s `_ALWAYS_CONFIRM_KINDS` is what decides whether the resulting
`kind="execute"` proposal actually pauses. Stock Hermes's own `HERMES_INTERACTIVE=1` (set by
upstream Hermes's `acp_adapter/server.py` for the duration of every ACP session, pre-dating this
patch) is what already routes `tools.approval.check_dangerous_command`'s pattern-matched dangerous-command prompt to the
interactive/callback path instead of auto-approving — this patch's requester binds beside that
mechanism, not through it, so a genuinely dangerous terminal command can now surface two separate
confirms rather than one. Stock Hermes's `HERMES_SESSION_KEY` (also pre-dating this patch, set per ACP
session in the same `server.py` block) scopes per-session caches — e.g. `tools.terminal_tool`'s
interactive sudo-password cache — to the ACP session rather than leaking across sessions that land on
the same reused executor thread; unrelated to the confirm gate itself, named here only because it now
sits in this patch's own diff context.

## Deploy

- **`deploy/`** — `Dockerfile` (single image, two roles): the Plane A proxy is the only role with upstream
  egress and the Plane B app is credential-free. `entrypoint.sh` installs default-deny egress so the
  agent's only outbound is the gateway (the network half of the exfil control). `deploy/aws/` stands the
  pair up on EC2 beside the E2B hosts.
- **`deploy/env/`** — `agent.toml` and `gateway.toml`, each role's runtime settings (the `[env]` table).
  The AWS deploy (`deploy/aws/agent/render_env.py`) renders each container's env from them plus Doppler.
- **`fly/`** — scripts kept from when the service ran on Fly. No Fly app runs it now; the AWS deploy still
  uses `fly/verify-deploy.sh`.

## Giving agent mode an MCP server

Set one env var and the agent's Hermes session gets that server's tools. It needs the ACP
transport (`AGENT_ACP=1`, already on in `deploy/env/agent.toml`).

```sh
AGENT_MCP_SERVERS='[{"name": "folkways", "url": "https://folkways.example.org/mcp",
                     "headers": {"Authorization": "FOLKWAYS_MCP_AUTH"}}]'
FOLKWAYS_MCP_AUTH='Bearer …'     # a secret; the JSON names this var and never holds the value
```

- **Fields.** `name` is lowercase letters, digits, `-` or `_`. `url` must be https. `headers` maps a header
  name to the env var its value is read from when each task starts. `transport` may be omitted, and
  `"http"` (Streamable HTTP) is the only accepted value: the pinned Hermes drops the SSE transport on the
  ACP path, so an SSE server would never connect. Use a Streamable HTTP endpoint.
- **What the model sees.** Hermes lists MCP tools by name and description and the model calls them through
  its `tool_call` bridge (`tools/tool_search.py`), as `mcp__folkways__<tool>`.
- **Who gets it.** Only tasks whose permission policy resolves to `allow`. Under `deny_writes`, `confirm`,
  or a new caller under `staged`, the servers are left off the session, because neither permission gate
  ever sees an MCP call.
- **Egress.** On Fly the agent can reach only the hosts in the nftables allowlist that
  `deploy/entrypoint.sh` installs at boot. Each configured MCP host is added to it automatically from
  this same variable, so no separate `AGENT_EGRESS_ALLOW_HOSTS` edit is needed. The allowlist is resolved
  at boot, so a change to the variable takes effect on the next machine restart.
- **Bad config.** Malformed JSON or any invalid entry means no MCP servers at all, a
  `mcp.config_invalid` log line, and the reason under `mcp.error` in `/healthz`. Tasks keep running.
  A server whose header env var is unset is skipped for that task (`mcp.server_skipped`).

**Local development against a server on your machine.** `http://localhost`, `127.0.0.1` and `[::1]` are
refused unless you also set `AGENT_MCP_ALLOW_LOCALHOST=1`. Never set that on a deploy.

```sh
AGENT_ACP=1 AGENT_MCP_ALLOW_LOCALHOST=1 \
AGENT_MCP_SERVERS='[{"name": "folkways", "url": "http://127.0.0.1:8000/mcp"}]' make run
```

The Hermes that `make run` launches needs the `mcp` extra, as the image has: `uv pip install --python
<hermes venv>/bin/python -e '<hermes checkout>[acp,mcp]'`. Without it Hermes skips every server quietly.

**Checking it.** `curl -s $AGENT_URL/healthz | jq .mcp` shows `servers` (names only, never URLs or header
values; the field is absent when the variable is unset), `error`, `missing_header_env`, and `active` (false when `AGENT_ACP` is off).
`scripts/mcp_live_probe.py` runs a real `hermes acp` session against a stub MCP server with a scripted
model, offline; `api/test_mcp_hermes_live.py` wraps it.

## Platform integration

To run in production the service plugs into the Public AI platform rather than reimplementing it:

- **Auth** — a shared JWT, `WEBUI_SECRET_KEY` HS256 against the same secret OpenWebUI signs session
  tokens with (`require_user` in `api/app.py`); the token must carry a user id. Verified: 401 on missing/bad, 200
  valid, 403 cross-user. An OIDC/JWKS alternative is named in a code comment in `api/app.py` but not
  implemented — `OIDC_JWKS_URL` is read nowhere, and `require_user` only ever calls
  `jwt.decode(..., algorithms=["HS256"])`. Don't point a deployment at OIDC on the strength of this doc.
- **Moderation** — ONE detector: chat's own web screen endpoint (`SAFETY_SCREEN_URL`/`SAFETY_SCREEN_TOKEN`,
  `POST /chat/api/safety/screen`) called pre/post run, fail-closed when configured-but-unreachable. Coop
  (`COOP_URL`/`COOP_API_KEY`, same instance as `web/src/lib/chat/server/moderation.ts`) is REVIEW-ONLY here
  — it renders no verdict, it only receives a hit-only `/api/v1/report` submission for human triage
  whenever the guard actually fires.
- Dev-only escape hatches (`AGENT_AUTH_DISABLED`, `AGENT_MODERATION_DISABLED`) fail closed and are
  never for a shared deploy.

## License · Security · Contributing

[MIT](LICENSE) · report vulnerabilities privately per [SECURITY.md](SECURITY.md) · dev setup
and PR expectations in [CONTRIBUTING.md](CONTRIBUTING.md).
