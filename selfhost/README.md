# Self-hosting Alpha

Alpha is the chat app in `web/`. This directory runs it on one machine with Docker Compose: the app,
Postgres, and a model behind one OpenAI-compatible base URL. Nothing here calls a hosted service of
ours. No PostHog, Firecrawl, E2B, Doppler or our model gateway is involved.

## Run it

You need Docker with Compose v2.20 or newer and about 4 GB of free RAM. Building the app image needs
about 6 GB of RAM once.

```sh
cd selfhost
cp .env.example .env
# put a random string in BETTER_AUTH_SECRET:  openssl rand -hex 32
docker compose --profile local up --build
```

Open http://localhost:3000 and chat as a guest. The first start builds the app image (about 4 minutes
on 8 CPUs) and downloads the model (about 400 MB). Later starts take seconds.

`compose.yaml` always builds the app from this checkout and tags it `alpha-selfhost-web`. To run the
published image instead, `ghcr.io/currentai-org/alpha` signed with cosign, add `compose.release.yaml`
(Compose v2.24 or newer). It pins a release tag, never builds, and fails rather than falling back to a
local build when the tag cannot be pulled:

```sh
docker compose -f compose.yaml -f compose.release.yaml --profile local up
```

`ALPHA_IMAGE` in `.env` picks another tag or a digest. `../deploy/README.md` says how to verify the
image's signature. No tag can be pulled until the first release is published.

The default local model is Qwen2.5 0.5B Instruct, chosen so the first answer arrives on a plain CPU,
not for its quality. A CPU reads Alpha's system prompt, about 2,600 tokens, before the first word
appears: on a standard GitHub-hosted Linux runner the 0.5B model reads it in about 30 s and the whole
first answer arrives in under a minute. The self-host CI workflow measures this on every run: its smoke
step (`smoke.sh`) prints llama.cpp's `prompt eval` line. Slower CPUs and larger models take
proportionally longer. Later turns reuse the cached prompt and start in seconds. With a GPU or a fast
CPU, set `LOCAL_MODEL_*` in `.env` to a larger model.

To use a hosted provider in place of the local model, fill in block B of `.env` and start without
the profile:

```sh
docker compose up --build
```

`./smoke.sh` brings the local stack up, sends one chat turn as a guest and checks that an answer
comes back. It exits non-zero on any failure, and the self-host CI's `smoke` job runs it on every pull
request.

## A safety screen (optional)

Out of the box nothing checks a message before the model sees it (Configuration, Moderation, below).
Each option here costs no subscription: it runs on hardware you already have, with open weights.

**The `safety` profile** runs Mistral's Shieldstral-1.0-3B classifier (Apache-2.0) in a second
llama.cpp container on CPU. Add one line to `.env` and start both profiles:

```sh
echo 'GUARD_SHADOW_URL=http://shieldstral:8080' >> .env
docker compose --profile local --profile safety up --build
```

The variable's name is historical: with it set, the screen **enforces**. Every turn is screened
against the rules in `web/src/lib/chat/server/rules.json`, and a block stops the turn before the model
answers (`inputGate.ts`, `guardGate.ts`). The profile alone, without the line, screens nothing.

What to expect:

- **It runs out of time often on CPU, and what happens then depends on the rule.** One short message is 17 classifier calls, one per
  rule. The app gives each call 8 s and the whole screen 20 s (`GUARD_TIMEOUT_MS` in `guardGate.ts`,
  `operationDeadlineMs` in `rules.json`). On an 8-CPU machine under other load, with the classifier
  capped at 4 CPUs, a warm screen took 25 to 36 s and its slowest call 11 to 17 s; the first screen after
  start took 121 s. On CI's 8-CPU runner, the first turn after start ran out of time at 20 s and the
  second, a blocked one, finished in 18 s. Only the child-safety rules fail closed: when one of their
  checks runs out of time, the turn is declined as unchecked. When only content checks (violence,
  self-harm and the rest) run out of time on a short message, the turn is answered without them and
  the web log records a `[failopen]` warning (`guardGate.ts`). A long message whose content checks were
  still waiting when the screen ran out of time is declined as unchecked. So on CPU expect both declined
  turns and turns answered unscreened. A screen that finds a block before it runs out of time still
  blocks. For a usable screen, give it a GPU: set `LLAMACPP_IMAGE` to a CUDA build of the same server.
  The self-host CI's `safety-profile` job prints the times on every pull request. Its chat turns report
  and never fail, because on a CPU runner the screen often runs out of time; only its direct classifier
  check, which does not depend on CPU speed, is a failure of its own (for now it raises a warning).
- **Text only.** No vision projector is loaded, so a turn with a picture cannot be screened and is
  declined, and a stored picture is refused.
- **The weights are a community conversion.** Mistral publishes no GGUF. The profile pins
  `Abiray/Shieldstral-1.0-3B-GGUF`, Q4_K_M, by commit. `SAFETY_MODEL_URL` and `SAFETY_MODEL_FILE` point at another file.
  About 2.1 GB to download, and 2.5 to 4.5 GB of RAM while running.
- **Two side checks turn on with it.** `violence-recheck` and `support-signal-classifier` follow
  `GUARD_SHADOW_URL` (Feature flags, below). Both call your `TASK_MODEL` (unset, the first model `MODEL_ALLOWLIST` offers),
  not the classifier. `ALPHA_FLAGS=-violence-recheck,-support-signal-classifier` turns them off.

**Zentropi S1 on your own GPU**, for text: the model `zentropi-ai/cope-b-s1` (Apache-2.0) served with
Zentropi's `zentropiai/cope-s1-sglang` image, which answers `POST /v1/systemone`. Set
`ZENTROPI_S1_ENDPOINT_URL` to it and `HF_TOKEN` to whatever token it accepts. `s1-safety-judge` turns
on when both are set, and then text goes to S1 alone (`detectors/s1.ts`). This directory does not run
it.

## Agent mode (demo)

Agent mode lets the model run code and write files for the people signed in to your stack. It is off
until you start the stack with its profile, and it needs a model that handles tool calls well: the
default 0.5B CPU model usually fails multi-step tasks, so point `OPENAI_BASE_URL` at a hosted or larger
model first and set `AGENT_MODEL` in `.env` to an id that endpoint serves.

```sh
docker compose --profile agent up --build                   # with a hosted provider (block B)
docker compose --profile local --profile agent up --build   # with the local model
```

The first start builds the agent image (about 5 minutes). Put `DOCKER_SOCK_GID` in `.env` only when the
Docker socket's group is not 999 (`stat -c %g /var/run/docker.sock`). Nothing else is set: the profile
starts agent-service, its model gateway and a socket proxy beside the app, and web finds them.

- **Auth is on and its secret is yours.** The first start generates a random signing key and a random
  gateway key and keeps them in the `agent-secrets` volume. Web gets a token signed with that key, from
  the `agent-token` volume. Agent-service is not published on the host and refuses any call without that
  token. `docker volume rm alpha_agent-secrets alpha_agent-token` makes new ones on the next start. To use
  an agent-service of your own instead, set `AGENT_SERVICE_URL` and `AGENT_SERVICE_TOKEN` in `.env`.
- **The engine is Kilo.** Each task is driven by Kilo (Kilo-Org/kilocode, MIT) over ACP, inside the
  sandbox, pointed at your endpoint through the gateway; it needs no Kilo account.
  `AGENT_ENGINE=hermes` in `.env` runs the previous engine instead.
- **The model is the one chat uses.** The gateway forwards to `OPENAI_BASE_URL` with `OPENAI_API_KEY`. The
  agent's sandbox never holds that key: it holds a one-task grant the gateway honours.
- **What the sandbox isolates.** Each conversation's agent runs in a container of its own: a non-root user,
  every Linux capability dropped, `no-new-privileges`, a read-only root filesystem, a 512 MB in-memory
  home that holds its files, 1 CPU, 1 GB of memory and 256 processes, and no host path mounted. Its network
  has no route out: it reaches the model gateway and nothing else, so it cannot download packages or
  call the internet. Containers are created through a socket proxy (sockguard) that refuses a host bind
  mount, a privileged container, host namespaces, added capabilities and devices. The self-host CI's
  `socket-proxy` job fails when any of these gets through it: a host-root bind (by `-v`, by `--mount`
  or as a local-driver volume), a bind of the Docker socket, a privileged container, an added
  capability, a device, the host PID or IPC namespace, the host network or an unconfined seccomp
  profile.
- **What it does not isolate.** The container shares your host's kernel (runc, no gVisor), so a kernel
  flaw is a way out. The socket proxy's policy is all that stands between agent-service and root on the
  host through the Docker socket: anyone who can reach port 2375 on the compose network can create
  containers within that policy, so do not publish it or attach other services to that network. Tasks are
  not screened for harmful content. One token serves every account on the stack, and agent-service trusts
  web's word for which person a task is for, so it is only as safe as web is. Every signed-in account can
  use agent mode. Files the agent writes live in the sandbox's memory and are gone when it is removed
  (after a while idle, or when agent-service restarts). The agent-service and gateway containers are not
  sandboxed: they hold the signing key and your model key.

Treat it as a demo: run it for yourself or people you trust, not for the public.

## Configuration

Compose reads `.env` next to `compose.yaml`.

| Variable | Default | What it is |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | none, required | Signs session cookies. Any long random string. |
| `OPENAI_BASE_URL` | none, required unless the Open WebUI names below are set | The model endpoint's base, ending in `/v1`. It must answer `GET /models` and `POST /chat/completions`. |
| `OPENAI_API_KEY` | `none` | Sent as `Bearer` to that endpoint. Keyless servers ignore it. |
| `OPENAI_API_BASE_URLS`, `OPENAI_API_KEYS` | none | Open WebUI's names, for an install moving over with its env file. Read only while `OPENAI_BASE_URL` is unset; when both are set, `OPENAI_BASE_URL` wins and the log says so. `;`-separated, one key per URL (an empty key is a keyless endpoint); with fewer keys the rest are keyless and extra keys are dropped, as in Open WebUI, and `OPENAI_API_KEY` stands in when `OPENAI_API_KEYS` is unset. Alpha serves one endpoint, so with several the first is used and the log says how many were ignored. |
| `MODEL_ALLOWLIST` | `*` | Comma-separated model ids from `GET /models` to offer, first one the default. `*` offers all of them. |
| `PORT` | `3000` | The host port, bound to 127.0.0.1. |
| `PUBLIC_ORIGIN` | `http://localhost:3000` | The origin people reach the app at. Set it when you put a proxy in front. |
| `POSTGRES_PASSWORD` | `alpha` | The bundled database's password. |
| `GENERATION_TIMEOUT_MS`, `SILENCE_TIMEOUT_MS` | `150000` | How long a turn may wait for the model before it is ended as an error. The app's own default is 45 s, too short for a CPU model's first turn. |
| `LOCAL_MODEL_REPO`, `LOCAL_MODEL_FILE`, `LOCAL_MODEL_ALIAS`, `LOCAL_MODEL_CTX` | Qwen2.5 0.5B Instruct, Q4_K_M, 16k context | Which GGUF llama.cpp downloads from Hugging Face, and the model id it reports. Keep `MODEL_ALLOWLIST` in step with the alias. |
| `LOCAL_MODELS_DIR` | the `models` volume | A host directory to keep the downloaded GGUF in. CI points it at a cached directory. |
| `LLAMACPP_IMAGE` | llama.cpp's `server` image, pinned by digest | Another llama.cpp server build, such as a CUDA one. The `safety` profile uses it too. |
| `GUARD_SHADOW_URL` | none | A Shieldstral endpoint's base. Set, every turn is screened and a block stops it; with the `safety` profile, `http://shieldstral:8080`. |
| `SAFETY_MODEL_URL`, `SAFETY_MODEL_FILE` | a pinned Shieldstral Q4_K_M GGUF | With `--profile safety`: the GGUF the classifier downloads, and the file name it is kept under. Change both together. |
| `ALPHA_IMAGE` | `ghcr.io/currentai-org/alpha:0.1.0` | With `compose.release.yaml` only: another release tag or a digest of the app image. |
| `SMTP_URL` | none | Your mail server, as `smtp://user:password@host:587` (or `smtps://` on 465). Sign-in codes and workspace invitations go out through it. Unset, people sign in with email and password instead. |
| `SMTP_FROM` | `Alpha <noreply@` your `PUBLIC_ORIGIN` host `>` | The sender address. Set it to one your mail server accepts. |
| `ALPHA_OPEN_SIGNUP` | unset: closed after the first account | With no mailer, password sign-up closes once one account exists. `true` keeps it open to anyone who reaches the stack. Ignored when a mailer is set. |

The app reads many more variables (`web/.env.example` lists every one). Each feature they configure
stays off while its config is unset.

### Feature flags

With `PUBLIC_POSTHOG_KEY` unset (the case here), each flag reads its `selfHost` value from the registry in
`web/src/lib/chat/server/flagKeys.ts`, not its code default (`selfHostDefaultsApply` and `selfHostFlagValue` in
`web/src/lib/chat/server/flags.ts`). Set `ALPHA_FLAGS="+key,-key"` in `.env` to override single flags: `+` turns
one on, `-` turns it off, a bare key counts as `+`, and the last mention wins (`alphaFlagOverrides` in
`web/src/lib/chat/server/flags.ts`). It is read only when PostHog is unset (`selfHostDefaultsApply` in
`web/src/lib/chat/server/flags.ts`). Compose passes it through to the app. An `on when its env is set` flag stays off
until every variable in its last column is set; a flag turned on with `ALPHA_FLAGS` but missing its
config logs a configuration error and stays withheld (`multimodalEnabled` in
`web/src/lib/chat/server/multimodalMode.ts`, `agentModeEnabled` in `web/src/lib/chat/server/agentMode.ts`).

This table is generated from `flagKeys.ts` (`pnpm selfhost:flag-table:write` in `web/`), and CI fails when
it is stale (`pnpm selfhost:flag-table`, in the `web-lint` job).

<!-- selfhost-flag-table:begin -->
| Flag | Self-host default | Env it needs |
| --- | --- | --- |
| `account-rollout-probe` | off | none |
| `accounts` | on | none |
| `agent-auto-mode` | on | none |
| `agent-mode` | on when all of its env is set | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN` |
| `agent-mode-access` | on | none |
| `agent-run-handoff` | on when all of its env is set | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN` |
| `attachment-allowance` | on | none |
| `auto-repick` | on | none |
| `auto-routing` | on | none |
| `chat-agent-handoff` | on when all of its env is set | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN` |
| `clef-routing` | on when all of its env is set | `CLEF_BASE_URL`, `CLEF_API_KEY` |
| `cms-snapshot-seed` | off | none |
| `conversation-expiry` | off | none |
| `conversation-titles` | on | none |
| `crisis-referral-order` | the code's own fallback (on) | none |
| `custodial-storage-view` | on when all of its env is set | `CUSTODIAL_STORAGE_BACKEND` |
| `dictation` | on when all of its env is set | `TRANSCRIPTION_MODEL` |
| `document-attachments` | on | none |
| `document-text-only` | off | none |
| `entity-name-correction` | on | none |
| `folkways-adapter` | on when all of its env is set | `FOLKWAYS_ENABLED`, `FOLKWAYS_URL` |
| `groundcheck` | off | none |
| `guard-history-cap` | off | none |
| `guard-primary` | off | none |
| `hedge-tool-rounds` | on | none |
| `history-key-enrollment` | off | none |
| `history-seal-writes` | off | none |
| `human-eval` | on | none |
| `identity-provider-stamp` | on | none |
| `length-first-brevity` | off | none |
| `local-inference` | on | none |
| `local-inference-managed` | on when all of its env is set | `PANGOLIN_API_URL`, `PANGOLIN_INTEGRATION_TOKEN`, `PANGOLIN_ORG_ID`, `PANGOLIN_DOMAIN_ID`, `PANGOLIN_TUNNEL_ENDPOINT` |
| `loop-cut` | on | none |
| `low-resource-language-fallback` | on | none |
| `low-resource-per-model` | on | none |
| `math-routing` | on when all of its env is set | `ARITHMETIC_ROUTE_MODEL`, `SECOND_OPINION_BASE_URL`, `SECOND_OPINION_API_KEY` |
| `mcp-elicitation` | off | none |
| `mcp-servers` | off | none |
| `mila-sp-output-guard` | off | none |
| `multimodal` | on when all of its env is set | `MULTIMODAL_ENABLED`, `CSAM_SCAN_BASE_URL`, `CSAM_SCAN_TOKEN`; `ALPHA_EDITION=selfhost` stands in for `MULTIMODAL_ENABLED` when it is unset; `CSAM_SCAN=off` (with `ALPHA_EDITION` set to something other than `hosted`) stands in for `CSAM_SCAN_BASE_URL` and `CSAM_SCAN_TOKEN` |
| `new-device-notice` | on when all of its env is set | `RESEND_API_KEY` |
| `one-chat-sandbox` | on when all of its env is set | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN` |
| `past-chat-search` | on | none |
| `provenance-assisted-by` | on | none |
| `provenance-facts-per-turn` | on | none |
| `rag-entity-scope-guard` | on | none |
| `read-aloud` | on when all of its env is set | `READ_ALOUD_BASE_URL` |
| `repetition-guard` | off | none |
| `reply-language-rule` | on | none |
| `report-fanout` | on when all of its env is set | `REPORT_SLACK_WEBHOOK` |
| `router-alias` | on when all of its env is set | `LLM_ROUTER_ROUTES_PATH` |
| `s1-safety-judge` | on when all of its env is set | `ZENTROPI_S1_ENDPOINT_URL`, `HF_TOKEN` |
| `search-query-language` | on | none |
| `self-harm-distress-declines` | off | none |
| `share-links` | off | none |
| `side-call-own-lane` | on when all of its env is set | `MISTRAL_MODELS` |
| `source-credibility-filter` | on | none |
| `storage-locations` | on when all of its env is set | `HF_BUCKETS_TOKEN`, `HF_BUCKETS_REPO` |
| `stream-follow` | on | none |
| `support-signal-classifier` | on when all of its env is set | `GUARD_SHADOW_URL` |
| `thunderbolt-export` | on | none |
| `violence-recheck` | on when all of its env is set | `GUARD_SHADOW_URL` |
| `workspace-org-creation` | on | none |
<!-- selfhost-flag-table:end -->

The app image is `web/Dockerfile`, the definition the published image is built from, with
`APP_SURFACE=chat`, so the chat is served at the root of the host. The map site and its CMS pages are
not part of this build, and a chat build boots without a CMS origin (`PUBLIC_CMS_PAYLOAD_URL`).

People's files (`CUSTODIAL_STORAGE_BACKEND=local`) are kept in the `files` volume. Back it up with the
`db` volume, which holds the files' key objects. To keep them in an S3-compatible bucket instead, fill
in block S of `.env` and start with the `s3` profile, which adds SeaweedFS (Apache-2.0) as the bucket
server, its data in the `objects` volume:

```sh
docker compose --profile local --profile s3 up --build
```

To use your own S3-compatible server or AWS S3, set the same variables without the profile, with
`CUSTODIAL_S3_ENDPOINT` naming your server (unset for AWS). No Hugging Face account or token is involved
on either backend.

My files and chat uploads are on by default. My files needs only a store, any value of
`CUSTODIAL_STORAGE_BACKEND` (compose sets `local`). Uploads need the CSAM scan decision that
`.env.example` makes explicit (see File uploads below), because every upload is refused without one.

**Files are stored in plaintext unless you turn sealing on.** Writes are sealed to their owner's age key
only when `CUSTODIAL_SEAL_WRITES=true` (`sealWritesOn` in `web/src/lib/chat/server/storage/custodialStorage.ts`), and
sealing needs a master key (`masterSet` in `web/src/lib/chat/server/storage/custodialCrypto.ts`). Compose sets neither. To seal new files, generate an age identity, name it
in `.env`, and make it the active one:

```sh
age-keygen -pq        # prints AGE-SECRET-KEY-PQ-1...; keep it somewhere safe, losing it loses the files
```

```
CUSTODIAL_SEAL_WRITES=true
CUSTODIAL_MASTER_IDENTITIES={"k1":"AGE-SECRET-KEY-PQ-1..."}
CUSTODIAL_MASTER_ACTIVE=k1
```

Turning sealing off later leaves already sealed files readable. Files written before you turned it on stay
plaintext. `storage-locations`, which links a person's own Hugging Face bucket as a second place for
their files, still turns on only with `HF_BUCKETS_TOKEN` and `HF_BUCKETS_REPO` set (`flagKeys.ts`, see the
table); without it My files shows your store alone.

## Every service a request passes through

With the files here unchanged and the local profile running, these are all the network services
involved:

| Service | Runs where | When |
| --- | --- | --- |
| `web`, the Alpha app (SvelteKit on Node) | your machine | every request |
| `db`, Postgres 17 | your machine | sessions, conversations, messages |
| `llama`, llama.cpp server | your machine | every model call: the answer, and the search decision |
| huggingface.co | Hugging Face | the `llama` container's first start only, to download the GGUF |
| `seaweedfs`, SeaweedFS's S3 gateway | your machine | only with the `s3` profile and block S: every read and write of a person's files |
| api.openalex.org, export.arxiv.org, huggingface.co/api/models, `<lang>`.wikipedia.org, wikinews.org | third parties | only when a turn searches the web. The composer's search setting defaults to Auto, and the model decides whether to search. Turn search off in the composer to stop this. |
| `sockguard`, `gateway`, `agent`, `agent-init` | your machine | only with the `agent` profile: agent mode's socket proxy, model gateway, task service and one-shot secret maker. The sandbox containers it creates run on your Docker host. |
| icons.duckduckgo.com | DuckDuckGo, through the app's own `/api/favicon` route | to show the favicons of cited sources |

With profile B, the model calls go to the provider you set in place of `llama`.

The browser loads scripts, styles and fonts from the app only. An artifact preview, opened by the user,
can load code from cdn.tailwindcss.com, unpkg.com, cdn.jsdelivr.net and cdnjs.cloudflare.com inside
its sandboxed frame.

## What is not here yet

- **Sign-in.** Guests can chat, and "Log in" in the account menu works on a fresh stack. Which email
  sign-in it offers depends on the mail you set up (`mailer.ts`), checked in this order:
  1. `RESEND_API_KEY`: codes go through Resend's API. This is how our hosted Alpha sends.
  2. `SMTP_URL`: codes go through your SMTP server, from `SMTP_FROM`. Any provider's SMTP relay works.
  3. Neither: there is no way to deliver a code, so people create an account with an email address and a
     password (8 characters or more) and sign in with those. Nobody verifies the address, so sign-up
     closes after the first account, as in Open WebUI: create yours first, and the sign-in page then
     tells everyone else that sign-up is closed. Sign-in with an existing account, and Google,
     GitHub, Hugging Face or your organisation's login when you set them up, still work.
     `ALPHA_OPEN_SIGNUP=true` in `.env` reopens password sign-up to anyone who can reach the stack, under
     any address. Keep the stack private then, or set up mail.
     Accounts made this way keep working after you add mail only through an email code, which then
     replaces the password form.

  Google, GitHub and Hugging Face sign-in need OAuth clients registered against your origin.

  Your organisation's own login (Keycloak, Authentik, Cognito, Entra or any OpenID Connect provider)
  is set from `.env` alone (`orgOidc.ts`). Register a client at your provider with the redirect URI
  `<PUBLIC_ORIGIN>/chat/api/auth/callback/org-oidc`, then set:

  | Variable | Open WebUI alias | What it is |
  | --- | --- | --- |
  | `OIDC_ISSUER` | `OPENID_PROVIDER_URL` | The issuer URL, or its `/.well-known/openid-configuration` URL. Must be `https` (plain `http` only on localhost). |
  | `OIDC_CLIENT_ID` | `OAUTH_CLIENT_ID` | The client id your provider issued. |
  | `OIDC_CLIENT_SECRET` | `OAUTH_CLIENT_SECRET` | That client's secret. |
  | `OIDC_PROVIDER_NAME` | `OAUTH_PROVIDER_NAME` | The name on the sign-in button. Default `SSO`. |
  | `OIDC_SCOPES` | `OAUTH_SCOPES` | Space- or comma-separated scopes. Default `openid email profile`. |

  The aliases let an Open WebUI install move over with its env file; where both names are set, ours win
  field by field. `OPENID_PROVIDER_URL` counts as the issuer only beside `OAUTH_CLIENT_ID`, because the
  Hugging Face provider reads the same variable. With issuer, client id or secret missing, the button is
  not offered and the log names what is missing. The app fetches the discovery document at startup; if
  that fails, it logs the provider and skips it, and every other sign-in method still works.
- **Moderation.** No safety classifier is configured, so nothing checks a message before the model sees
  it. That holds with `DEPLOY_ENV=production` too, because compose sets `ALPHA_EDITION=selfhost`, and the
  boot log then says `SELF-HOST, NO SCREEN`, so the gap is never silent (`selfHostWithoutScreen` in
  `guardGate.ts`). "A safety screen (optional)", above, runs one beside the stack. To screen every turn, name a classifier: a Shieldstral endpoint in
  `GUARD_SHADOW_URL` (`detectors/shieldstral.ts`), which also screens pictures, or Zentropi S1 for text
  with `ZENTROPI_S1_ENDPOINT_URL` and `HF_TOKEN` (`detectors/s1.ts`); `s1-safety-judge` turns on by itself
  when both are set. A configured classifier turns the screen on, and `violence-recheck` and
  `support-signal-classifier` follow `GUARD_SHADOW_URL` as the sign that a screen is configured. Both call your
  `TASK_MODEL`, not the classifier, so on an S1-only stack `ALPHA_FLAGS=+violence-recheck,+support-signal-classifier`
  turns them on. With S1 selected, text goes to S1 alone, so a
  Shieldstral endpoint does not screen text then. Read `web/src/lib/chat/server/guardGate.ts` before you
  open this to the public. The boot log's `SELF-HOST, NO COOP` line is about Coop, the review service,
  which this directory does not run.
- **Status banner.** No incident banner and no "Status page" link (settings, a failed answer) show unless
  `STATUS_PAGE_URL` names your own Better Stack page; with it set, both lead there.
- **Embeddings.** Nothing is embedded unless `RAG_EMBEDDING_BASE_URL` (or a dedicated `*_ENDPOINT_URL`) names
  an embedder, so no text goes to Hugging Face; the features that use embeddings fall back without them.
- **A CSAM scanner for file uploads.** Uploads are on by default (`ALPHA_EDITION=selfhost` stands in for
  `MULTIMODAL_ENABLED`, `multimodalConfigured` in `web/src/lib/chat/server/multimodalMode.ts`; set `MULTIMODAL_ENABLED=false` to turn them off) once you
  make a scan decision: name a CSAM hash-matching scanner (`CSAM_SCAN_PROVIDER`, `CSAM_SCAN_BASE_URL` and
  `CSAM_SCAN_TOKEN`; not part of this directory), which then checks every picture and refuses an upload it
  cannot check, or set `CSAM_SCAN=off`. `.env.example` sets `CSAM_SCAN=off`, so uploads work on first
  start: they are stored with no hash check (each picture logs a line saying so) and you take on detecting
  and reporting CSAM. Remove that line to keep uploads off until a scanner is named. `CSAM_SCAN=off` is honoured only
  when `ALPHA_EDITION` is set to something other than `hosted` (`csamScan.ts`; compose sets `selfhost`).
  PDF and DOCX are a third switch: `document-attachments` is on in self-host (`ALPHA_FLAGS=-document-attachments`
  turns it off). They are offered only while `multimodal` is also on
  (`documentAttachmentsGate.ts`), and their text is screened with the turn by whichever classifier
  Moderation (above) names; with none, it reaches the model unscreened like the rest of the turn.
- **Agent mode** needs `AGENT_SERVICE_URL` and `AGENT_SERVICE_TOKEN` (the agent service in
  `agent-service/`, read by `agentServiceUrl` and `agentServiceToken` in `web/src/lib/chat/server/agentMode.ts`).
  `--profile agent` starts one and sets both (Agent mode (demo), above); together they turn the
  `agent-mode` flag on in self-host (its entry in `FLAG_KEYS` in `web/src/lib/chat/server/flagKeys.ts`). A self-host
  edition (`ALPHA_EDITION=selfhost`, which compose sets) may offer agent mode whatever `DEPLOY_ENV` says
  (`agentModeDeployment` in `web/src/lib/chat/server/agentMode.ts`), and `agent-mode-access` is on in self-host (the
  same registry), so no `ALPHA_FLAGS` entry is needed. A URL with no token logs a warning and stays off
  (`agentModeEnabled` in `web/src/lib/chat/server/agentMode.ts`).
- **Document RAG and the full web search engine** need `RAG_ENABLED` with an embeddings endpoint, and
  `FIRECRAWL_API_KEY`. `FIRECRAWL_BASE_URL` points search and scrape at your own Firecrawl (AGPL, same v2
  API) instead of api.firecrawl.dev.
- **Read-aloud** posts to `READ_ALOUD_BASE_URL` + `/audio/speech`, any OpenAI-compatible speech endpoint (a
  base ending in `/v1`); unset, it uses the Hugging Face router and `HF_TOKEN`. With the base set, no Hugging Face token is needed, and a bearer is sent only if `READ_ALOUD_API_KEY` is set. `READ_ALOUD_MODEL` and `READ_ALOUD_VOICE` set the model and voice names your endpoint expects (one voice for every language); either unset sends the Kokoro value, and the Hugging Face route ignores both.
- **TLS.** The port is bound to 127.0.0.1 and cookies are sent without the Secure flag. Put a TLS
  proxy in front, set `PUBLIC_ORIGIN` to its https origin, and set `ALLOW_INSECURE_COOKIES=false`.
