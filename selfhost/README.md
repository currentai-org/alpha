# Self-hosting Alpha

Alpha is the chat app in `web/`. This directory runs it on one machine with Docker Compose: the app,
Postgres, and a model behind one OpenAI-compatible base URL. Nothing here calls a hosted service of
ours. No PostHog, Firecrawl, E2B, Doppler or our model gateway is involved.

## Run it

You need git, `openssl`, and Docker with Compose v2.20 or newer, and about 4 GB of free RAM. Building the
app image needs about 6 GB of RAM once, and the images, build cache and model take about 15 GB of disk. The first start needs internet access to pull images and
download the model from Hugging Face, with no account or token. From a clone of the repo:

```sh
cd selfhost
sed "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env.example > .env
docker compose --profile local up --build --wait
```

`up --wait` returns once every service is healthy. Open http://localhost:3000 and chat as a guest, or
run `SMOKE_NO_UP=1 ./smoke.sh` to send one guest turn and print the answer without a browser. The first start builds the app image (about 4 minutes
on 8 CPUs) and downloads the model (about 400 MB). Later starts take seconds.

`compose.yaml` always builds the app from this checkout and tags it `alpha-selfhost-web`. To run the
published image instead, `ghcr.io/currentai-org/alpha` signed with cosign, add `compose.release.yaml`
(Compose v2.24 or newer). It pins a release tag, never builds, and fails rather than falling back to a
local build when the tag cannot be pulled:

```sh
docker compose -f compose.yaml -f compose.release.yaml --profile local up
```

`ALPHA_IMAGE` in `.env` picks another tag or a digest; pin one, never `main`. `../deploy/README.md` says how to verify the
image's signature. The release tags are listed on the repo's Releases page.

The default local model is Qwen2.5 0.5B Instruct, chosen so the first answer arrives on a plain CPU,
not for its quality. A CPU reads Alpha's system prompt, 2,613 tokens, before the first word appears:
on a standard GitHub-hosted Linux runner the 0.5B model read it in 18 to 32 s across three runs, and
the whole first answer arrives in under a minute. The self-host CI workflow measures this on every run:
its smoke step (`smoke.sh`) prints each turn's time to first word and llama.cpp's `prompt eval` lines.
Slower CPUs and larger models take proportionally longer. Later turns reuse the cached prompt: on an
8-vCPU CI runner a follow-up turn read 146 new tokens, not 2,613, and its first word came after 0.9 s,
against 20 s for the first turn. With a GPU or a fast CPU, set `LOCAL_MODEL_*` in `.env` to a larger model.

**On an NVIDIA GPU**, add `compose.gpu.yaml`. It needs the NVIDIA driver and the
[NVIDIA Container Toolkit](https://github.com/NVIDIA/nvidia-container-toolkit) on the host. It swaps in
llama.cpp's CUDA build of the same release, asks Docker for every GPU, and puts every layer on it
(`LLAMA_ARG_N_GPU_LAYERS=all`; set a number in `.env` when the model does not fit in VRAM). It covers
the `safety` profile's screen too:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml --profile local up --build
```

GPU use is untested in CI, because no runner has a GPU: the self-host CI's `gpu-config` job checks only
that the merged config requests the device. AMD (llama.cpp's `server-rocm` image) and Vulkan
(`server-vulkan`) are untested, and this file does not set them up.

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

**The `safety` profile** runs two classifiers in llama.cpp containers on CPU: Qwen's
Qwen3Guard-Gen-0.6B (Apache-2.0) and Mistral's Shieldstral-1.0-3B (Apache-2.0). Add two lines to `.env`
and start both profiles:

```sh
printf 'GUARD_SHADOW_URL=http://shieldstral:8080\nQWEN3GUARD_URL=http://qwen3guard:8080\n' >> .env
docker compose --profile local --profile safety up --build
```

The first variable's name is historical: with it set, the screen **enforces**. Every turn is screened
against the rules in `web/src/lib/chat/server/rules.json`, and a block stops the turn before the model
answers (`inputGate.ts`, `guardGate.ts`). The profile alone, without the lines, screens nothing.

**`SAFETY_SCREEN` picks who screens.** A self-host reads `qwen3guard` when it is unset; Current AI's own
deployments read `shieldstral` (`web/config/safetyScreen.ts`). One value per row, and no value falls back
to another:

| `SAFETY_SCREEN` | Who answers | Needs |
| --- | --- | --- |
| `qwen3guard` (self-host default) | Qwen3Guard answers 13 rules from one call per turn. Shieldstral answers four rules on every turn: both child rules, self-harm method and anthro, and every rule of a picture. | both URLs |
| `shieldstral` | Shieldstral answers every rule, 17 calls per turn. Too slow for CPU, right for a GPU. | `GUARD_SHADOW_URL` |
| `qwen3guard-only` | Qwen3Guard answers everything it can. For very weak hardware, never the default. | `QWEN3GUARD_URL` |

To switch to Shieldstral alone, add one line to `.env` (the Qwen3Guard container then sits idle):

```sh
echo 'SAFETY_SCREEN=shieldstral' >> .env
```

For `qwen3guard-only`, set `SAFETY_SCREEN=qwen3guard-only` and `QWEN3GUARD_URL`, and start
`--profile safety-qwen3guard-only` in place of `--profile safety`.

**What Qwen3Guard routes coarsely.** Its fixed taxonomy does not match our rules one to one. In the
default pairing these are the 13 rules it answers, and where it reads a rule coarsely:

- **Self-harm other than method.** Eating, and any other self-harm label, fires `self-harm-eating`. It
  has no label for intent, passive ideation ("everyone would be better off without me") or hedged
  distress, so those three rules (which only log) never fire from it, and a turn that carries only that
  passes the screen.
- **Hate, harassment and toxic language** are all its "Unethical Acts" label, so one hit fires all four
  rules: the person sees the generic decline whichever rule is named.
- **Fraud, drugs.** Both read "Non-violent Illegal Acts". The fraud rule's allowance for made-up sample
  data is lost: a request for fake test records can be declined as illegal or as PII.
- **"Politically Sensitive Topics", "Copyright Violation" and "Jailbreak"** are ignored. They are not in
  our rules (injection defense is structural), and the first would decline political questions.
- **"Controversial"** is read as safe: only "Unsafe" blocks. An "Unsafe" with no category it recognises
  is unknown, and an unknown screen declines the turn.
- **Pictures** are not read by Qwen3Guard; the pairing sends them to Shieldstral, as before.
- **Long messages.** A message of about 1,000 tokens took about 12 s on a loaded 4-CPU laptop against the
  8 s per-call limit, so a long paste can run out of time and be declined.

Only the four rules Shieldstral answers keep our policy text. **In `qwen3guard-only` mode these are
lost:** self-harm method gets the generic decline in place of the crisis message (an overdose question
reads as "illegal acts"); the two child rules cannot fail closed from a child-specific verdict (a Sexual
Content or Unethical Acts label makes them unknown, so the turn is declined, but grooming that reads
neither passes); and anthropomorphism ("do you really love me") is not screened. Use the default pairing
unless the machine cannot run the 3B model.

What to expect:

- **It runs out of time often on CPU, and what happens then depends on the rule.** In the default
  pairing a short message is one Qwen3Guard call plus four Shieldstral calls, for the two child-safety
  rules, the self-harm method rule and anthropomorphism (`detectors/safetyScreen.ts`); on a loaded 4-CPU
  laptop that was estimated at 1.2 to 8 s, not measured as a run of the pairing. With
  `SAFETY_SCREEN=shieldstral` it is 11 Shieldstral calls, where hosted Alpha makes 17, one per rule: the
  child-safety rules and six others are asked one by one, and for the other nine three grouped
  questions are asked first, and a group's rules only when its answer is yes (`web/config/selfhostScreen.mjs`).
  The app sends at most 4 calls at once, one per classifier slot, and gives the whole screen at least
  20 s (`operationDeadlineMs` in `rules.json`), 5 s more per extra round of 4 calls. In that mode, on an
  8-CPU machine under other load with the classifier capped at 4 CPUs, a warm screen took 25 to 36 s and
  the first screen after start took 121 s. Only the child-safety rules fail closed: when one of their
  checks runs out of time, the turn is declined as unchecked. When only content checks (violence,
  self-harm and the rest) run out of time on a short message, the turn is answered without them and
  the web log records a `[failopen]` warning (`guardGate.ts`). A long message whose content checks were
  still waiting when the screen ran out of time is declined as unchecked. A screen that finds a block
  before it runs out of time still blocks. For a usable screen, give it a GPU: add `compose.gpu.yaml`
  ("On an NVIDIA GPU", above). The self-host CI's `safety-profile` job prints the times on every pull
  request. Its chat turns report and never fail, because on a CPU runner the screen often runs out of
  time.
- **Text.** No vision projector is loaded, so Shieldstral cannot read a picture here: a turn with a
  picture is declined, and a stored picture is refused.
- **The weights are community conversions.** Neither maker publishes a GGUF. The profile pins
  `QuantFactory/Qwen3Guard-Gen-0.6B-GGUF` (Q8_0, about 0.8 GB) and `Abiray/Shieldstral-1.0-3B-GGUF`
  (Q4_K_M, about 2.1 GB) by commit. `QWEN3GUARD_MODEL_URL` and `QWEN3GUARD_MODEL_FILE`, or
  `SAFETY_MODEL_URL` and `SAFETY_MODEL_FILE`, point at another file. Together they need about 3 GB to
  download and 3 to 5 GB of RAM while running.
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
- **The model is the one chat uses.** The gateway forwards to `OPENAI_BASE_URL` with `OPENAI_API_KEY`, or,
  with those unset, to the first URL and key of Open WebUI's `OPENAI_API_BASE_URLS` / `OPENAI_API_KEYS`
  (`agent-service/api/openwebui_env.py`). Chat offers every URL's models; the agent uses the first. The agent's sandbox never holds that key:
  it holds a one-task grant the gateway honours.
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

## Connect Google (optional)

With this on, a signed-in person can connect their own Google account in Settings → Connectors and ask
chat about their Gmail, Calendar and Drive ("what's on my calendar tomorrow", "find my budget
spreadsheet"). Access is read-only: nothing on this stack can send mail, change an event, edit a file or
delete anything. It needs a Google OAuth client of your
own, because Google shows its name on the consent screen and holds you to its terms.

1. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project and enable
   the **Gmail API**, the **Google Calendar API** and the **Google Drive API** for it.
2. Configure its consent screen (Google Auth Platform → Branding and Audience) and pick the user
   type that fits who will connect:
   - **Internal**, if the project sits in a Google Workspace organization and only its members
     connect. No verification, no test-user list, and connections don't expire after a week. Your
     Workspace admin may still have to allow the app to read Gmail.
   - **Personal**, if only you connect. It allows just the account that created the project, needs
     no verification, and can't be changed to another type later.
   - **External** for anyone else. While its publishing status is **Testing**, only the test users you
     list (up to 100) can connect, and each connection lasts seven days before it must be made again.
     Publishing it needs Google's verification, and because Gmail and Drive read access are restricted
     scopes, that includes a security review.

   Google's [Manage App Audience](https://support.google.com/cloud/answer/15549945) page defines the
   three types.
3. Create an OAuth client ID of type **Web application**, with this authorized redirect URI:
   `<PUBLIC_ORIGIN>/chat/api/connectors/google/callback`. On a local stack that is
   `http://localhost:3000/chat/api/connectors/google/callback`.
4. Put its two values in `.env` and start the stack with the profile:

   ```sh
   # in .env
   GOOGLE_CONNECT_CLIENT_ID=<the client id>
   GOOGLE_CONNECT_CLIENT_SECRET=<the client secret>
   ```

   ```sh
   docker compose --profile local --profile google up --build
   ```

The profile runs the connector, [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
(MIT), on the compose network, unpublished, fixed to read-only Gmail, Calendar and Drive. The web service does
the OAuth: it keeps each person's refresh token sealed in Postgres, the way it keeps their own servers'
tokens, and on each turn hands the connector a short-lived access token for that person only. The
connector holds no client secret and stores nothing. `GOOGLE_CONNECTOR_URL` points web at a connector of
your own instead.

Drive reads every file the person can see (`drive.readonly`), since the narrower `drive.file` scope sees
only files the app made and could not answer "find my budget spreadsheet". A person may untick Drive on
Google's screen and still connect Gmail and Calendar. Someone who connected before Drive was added keeps
Gmail and Calendar, and Settings → Connectors offers them a reconnect for Drive.

- **Disconnect** in Settings → Connectors deletes the stored token, and so does **Forget everything**.
  Google keeps the grant itself until the person removes it at
  [their Google account](https://myaccount.google.com/connections).
- Agent mode tasks do not reach Google yet; only chat turns do.
- Our CI boots the connector and checks that it asks Google for nothing
  wider than read-only. A real connect needs a person at Google's consent screen, so CI does not walk it.

## Web search with sources (optional)

A turn that searches the web cites a page only after a reranker has scored it as relevant to the
question. With no reranker, the search still runs, but the answer has no sources: nothing vouches that
the pages it found are about the question. `--profile rerank` adds one, BAAI's bge-reranker-v2-m3
(Apache-2.0, multilingual), served on CPU by the same llama.cpp image as the local model. It is the
reranker our hosted Alpha uses. Its GGUF, about 640 MB, downloads on the first start. Then set these
three lines in `.env`:

```sh
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_ENDPOINT_URL=http://rerank:8080
RERANK_SCORES=logits   # llama.cpp returns raw scores; the app turns them into a 0-1 relevance
```

```sh
docker compose --profile local --profile rerank up --build
```

Search itself goes to the open engines in the table under "Every service a request passes through",
and to Firecrawl if you set `FIRECRAWL_API_KEY` (and `FIRECRAWL_BASE_URL` for your own). A page scoring
under 0.02 is dropped, and when none is left the turn answers without sources. If the reranker
is down or slower than `RERANK_TIMEOUT_MS`, the turn answers without sources, never with unscored ones.

On CPU the reranker is the slow part, and compose's defaults assume 4 cores. On 4 cores it scores
about 1,000 characters in 0.74 s, so compose gives it 12 documents of 600 characters a search (about
5.3 s) and waits up to 8 s, where the hosted Alpha's reranker gets 32 of 1,200 (about 28.5 s on 4
cores). `RERANK_MAX_DOCS`, `RERANK_DOC_CHARS` and `RERANK_TIMEOUT_MS` change the three; a search's
whole retrieval stops at 15 s.

On 2 cores the defaults take about 22 s, past the deadline, so every search answers without sources.
Add these two lines to `.env` on a 2-core machine:

```sh
RERANK_MAX_DOCS=6
RERANK_DOC_CHARS=300
```

On 2 cores that takes 3.7 to 5.6 s. Six shorter documents give the answer fewer sources to choose
from, but it still cites them. On 2 cores, 1,000 characters take about 3.1 s, so 8 documents of 400 (9.9 s) or 6 of 400 (7.4 s) already miss or crowd the 8 s deadline. A
search that misses it logs `[rerank] timed out` with the three settings to change.

Any other reranker that serves llama.cpp's or Hugging Face TEI's `/rerank` works at the same URL; leave
`RERANK_SCORES` unset for one that returns 0-1 scores, as TEI does, and raise the three for a GPU one. The
bundled `rerank` service's 1,024-token micro-batch holds the question and one document, about 1,200
characters of Latin-script text but fewer in Chinese, Japanese or other scripts that take a token or
more per character. A document past that makes llama.cpp refuse the call, and the search answers
without sources, so keep `RERANK_DOC_CHARS` at 600 or below for those languages.

### Open-web search without a Firecrawl key: SearXNG

Without `FIRECRAWL_API_KEY`, search reaches only Wikipedia, Wikinews, OpenAlex, arXiv and Hugging Face,
so a question about a recent event or an ordinary website has little to cite. `--profile searxng` runs
SearXNG (AGPL-3.0), a metasearch engine that asks Brave, DuckDuckGo, Google, Startpage and others from
your machine, so they see your machine's address and never the person's. Alpha reads its JSON API. Turn
it on with one line in `.env`:

```sh
SEARXNG_URL=http://searxng:8080
```

```sh
docker compose --profile local --profile rerank --profile searxng up --build
```

Search still cites only what the reranker scored as relevant, so run it with `--profile rerank`. With
`FIRECRAWL_API_KEY` set, Firecrawl keeps the open-web slot and SearXNG is never asked. Its port is not
published, and its settings, at the end of `compose.yaml`, turn the bot limiter off because only the web
service reaches it. Your own SearXNG elsewhere works too, at its URL, if its settings file lists `json`
under `search.formats` (the default is `html` only, and SearXNG answers 403 to a JSON request then) and
its limiter lets this server through. Public SearXNG instances usually refuse server-to-server calls, so
run your own. Our CI boots the profile's image with a stand-in engine and checks that a turn's search
goes through it and cites its page.

## Configuration

Compose reads `.env` next to `compose.yaml`.

| Variable | Default | What it is |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | none, required | Signs session cookies and seals the tokens people save in Settings → Connectors. Any long random string. |
| `OPENAI_BASE_URL` | none, required unless the Open WebUI names below are set | The model endpoint's base, ending in `/v1`. It must answer `GET /models` and `POST /chat/completions`. |
| `OPENAI_API_KEY` | `none` | Sent as `Bearer` to that endpoint. Keyless servers ignore it. |
| `OPENAI_API_BASE_URLS`, `OPENAI_API_KEYS` | none | Open WebUI's names, for an install moving over with its env file. Read only while `OPENAI_BASE_URL` is unset; when both are set, `OPENAI_BASE_URL` wins and the log says so. `;`-separated, one key per URL (an empty key is a keyless endpoint); with fewer keys the rest are keyless and extra keys are dropped, as in Open WebUI, and `OPENAI_API_KEY` stands in when `OPENAI_API_KEYS` is unset. Chat offers the models of every URL, each sent to its own endpoint with its own key; an id two endpoints both list goes to the earlier one, and the log names it. |
| `MODEL_ALLOWLIST` | `*` | Comma-separated model ids from `GET /models` to offer, first one the default. `*` offers all of them. |
| `ALPHA_MODELS_FILE` | none | A model list file of your own, read in place of the five model settings above. See [Your own model list](#your-own-model-list). |
| `PORT` | `3000` | The host port, bound to 127.0.0.1. |
| `PUBLIC_ORIGIN` | `http://localhost:3000` | The origin people reach the app at. Set it when you put a proxy in front. |
| `BRAND_ORGANISATION_NAME`, `BRAND_PRODUCT_NAME` | `Current AI`, `AI Potluck` | Who runs this install and what the app is called. The header, sidebar, page title, data and privacy notes and sign-in email show them, and the model says it answers inside your app, run by you. Credits to the upstream project keep its own name. `WEBUI_NAME` is read as the product name when `BRAND_PRODUCT_NAME` is unset. Read at start, so a change needs `docker compose up -d`, not a rebuild. |
| `BRAND_ASSISTANT_NAME` | none | A name the assistant answers to. It still says which model it runs on. The model has to follow its system prompt for this: the default Qwen2.5 0.5B does not, and answers "what are you called?" without the name. CI checks the name on a hosted model. |
| `POSTGRES_PASSWORD` | `alpha` | The bundled database's password. Set it before the first start: Postgres reads it only when it creates the database in an empty `db` volume. Changed later, it changes only what the app connects with, and the app is locked out. To change it later, run `./db-passwd.sh`, then put the new value here and run `docker compose up -d`. Already locked out? Run `NEW_POSTGRES_PASSWORD=<the value here> ./db-passwd.sh`, then `docker compose restart web`. Letters, digits and `. _ ~ -` only: the app puts it in a URL. |
| `GENERATION_TIMEOUT_MS`, `SILENCE_TIMEOUT_MS` | `150000` | How long a turn may wait for the model before it is ended as an error. The app's own default is 45 s, too short for a CPU model's first turn. |
| `LOCAL_MODEL_REPO`, `LOCAL_MODEL_FILE`, `LOCAL_MODEL_ALIAS`, `LOCAL_MODEL_CTX` | Qwen2.5 0.5B Instruct, Q4_K_M, 16k context | Which GGUF llama.cpp downloads from Hugging Face, and the model id it reports. Keep `MODEL_ALLOWLIST` in step with the alias. |
| `LOCAL_MODELS_DIR` | the `models` volume | A host directory to keep the downloaded GGUF in. CI points it at a cached directory. |
| `LLAMACPP_IMAGE` | llama.cpp's `server` image, pinned by digest; its `server-cuda` build with `compose.gpu.yaml` | Another llama.cpp server build. The `safety` profile uses it too. |
| `LLAMA_ARG_N_GPU_LAYERS` | `all`, with `compose.gpu.yaml` only | How many of the model's layers llama.cpp puts on the GPU: a number, `auto` or `all`. |
| `GUARD_SHADOW_URL` | none | A Shieldstral endpoint's base. Set, every turn is screened and a block stops it; with the `safety` profile, `http://shieldstral:8080`. |
| `QWEN3GUARD_URL` | none | A Qwen3Guard-Gen-0.6B endpoint's base, read when `SAFETY_SCREEN` is `qwen3guard` or `qwen3guard-only`; with the `safety` profile, `http://qwen3guard:8080`. |
| `SAFETY_SCREEN` | `qwen3guard` on a self-host | `qwen3guard`, `shieldstral` or `qwen3guard-only` (A safety screen, above). |
| `SAFETY_MODEL_URL`, `SAFETY_MODEL_FILE` | a pinned Shieldstral Q4_K_M GGUF | With `--profile safety`: the GGUF the classifier downloads, and the file name it is kept under. Change both together. |
| `ALPHA_IMAGE` | `ghcr.io/currentai-org/alpha:0.3.0-preview.2` | With `compose.release.yaml` only: another release tag or a digest of the app image. | <!-- x-release-please-version -->
| `SMTP_URL` | none | Your mail server, as `smtp://user:password@host:587` (or `smtps://` on 465). Sign-in codes and workspace invitations go out through it. Unset, people sign in with email and password instead. |
| `SMTP_FROM` | `Alpha <noreply@` your `PUBLIC_ORIGIN` host `>` | The sender address. Set it to one your mail server accepts. |
| `ALPHA_OPEN_SIGNUP` | unset: closed after the first account | With no mailer, password sign-up closes once one account exists. `true` keeps it open to anyone who reaches the stack. Ignored when a mailer is set. |
| `LOCAL_INFERENCE_INTERNAL_ADDRESSES` | unset: refused | `allow` lets people add a local model endpoint (Settings, `local-inference`) at a private address, such as an Ollama on `localhost` or your LAN. Unset, only public addresses are accepted, whatever `DEPLOY_ENV` says, because on a shared install a private address reaches this host's network: its databases, and on a cloud VM the instance credentials. Set it only when everyone who can sign in may reach that network, as on a single-user install. Cloud-metadata addresses (`169.254.0.0/16`, `fd00:ec2::254`) stay refused either way. |

The app reads many more variables (`web/.env.example` lists every one). Each feature they configure
stays off while its config is unset.

### Your own model list

To choose which models Alpha offers, and which model does each job, from one file of your own instead of
env settings:

1. Copy `config/models.example.json` to a file named models.json in the same directory (git ignores it) and edit that copy.
2. Set `ALPHA_MODELS_FILE=/config/models.json` in `.env`. Compose mounts `config/` into the web container read-only.
3. Restart: `docker compose up -d web`.

The file holds `providers` (a base URL, and `api_key_env`, the name of the env var that holds the key,
never the key), `model_list` (each model's id and provider) and `roles`: `default_chat`, and optionally
`picker` (the models offered, in order, starting with `default_chat`; every listed model when left out),
`task` (titles and other side calls), `arithmetic_route`, `compare_panel` and `aggregator`. The shape is
the one hosted Alpha's own `web/config/inference.ts` validates, which follows LiteLLM's `model_list`.

With the file set, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, the Open WebUI names, `MODEL_ALLOWLIST`, `TASK_MODEL`
and the other role settings in `.env` are ignored, and the log names any that held a value. `OPENAI_BASE_URL` may then be left unset. The web
service refuses to start, with the file's path in the error, when the file is not valid JSON, when a role
names a model the file does not list, when the models it offers sit on more than one provider (Alpha
serves one endpoint), when `model_name` differs from the id the server reports, or when the provider's
key variable is unset (set `OPENAI_API_KEY=none` for a keyless server).

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
| `google-connector` | on when all of its env is set | `GOOGLE_CONNECT_CLIENT_ID`, `GOOGLE_CONNECT_CLIENT_SECRET`, `GOOGLE_CONNECTOR_URL` |
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
| `mcp-servers` | on | none |
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

People's files (`CUSTODIAL_STORAGE_BACKEND=local`) are kept in the `files` volume, beside each
person's key object under `_keys/` (`ownerKeyPath` in `web/src/lib/chat/server/storage/custodialCrypto.ts`).
`backup.sh` copies it (see Back up and restore). To keep them in an S3-compatible bucket instead, fill
in block S of `.env` and start with the `s3` profile, which adds SeaweedFS (Apache-2.0) as the bucket
server, its data in the `objects` volume:

```sh
docker compose --profile local --profile s3 up --build
```

SeaweedFS refuses to start while `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is blank, and its log
says how to make the secret (`openssl rand -hex 32`). `FILES_ACCESS_KEY` and `FILES_SECRET_KEY`, the
names `deploy/.env.example` uses, work in their place. Without the `s3` profile neither key is needed.

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

## Expired guest data

The web server deletes expired data itself, once a day: guest conversations untouched for 30 days, guest
files 30 days after upload, and the other short-lived records `cleanupExpired` in
`web/src/lib/chat/server/db/cleanup.ts` lists. It needs no cron, no extra container and no `CRON_SECRET`.
The first run comes a few minutes after the server starts, then one every 24 hours. Each replica runs its
own, and a second run deletes nothing the first already did. The `deploy/compose.yaml` stack runs the same
image and gets the same cleanup, whatever `ALPHA_EDITION` says. Only a server running on Vercel skips it,
because a Vercel cron calls `/chat/api/cleanup` there instead.

To confirm it ran, look for its lines in the web log:

```sh
docker compose logs web | grep '\[cleanup\]'
```

`[cleanup] daily cleanup scheduled in this process` appears at start, and
`[cleanup] daily cleanup finished` after each run, with `total` (rows deleted), `guestConversations`,
`guestFilesDeleted`, and `expiredConversations` (what the `conversation-expiry` flag's sweep deleted; with
that flag on, guest conversations are counted there instead of under `guestConversations`). A failed run logs `[cleanup] daily cleanup failed`, and the next day's run goes ahead.

## When a service crashes

Every long-running service in `compose.yaml` has `restart: unless-stopped`. When one crashes, is killed
for running out of memory, or the machine reboots, Docker starts it again by itself, with no compose
command, as long as the Docker daemon starts at boot (`systemctl enable docker` on most Linux
distributions). Only `docker compose stop` or `down` keeps a service down. The one-shot `agent-init`
runs once per `up` and is not restarted.

A service that is still running but no longer answers is not restarted. Its healthcheck turns it
`unhealthy`, which `docker compose ps` shows, and it stays that way until you restart it:

```sh
docker compose ps                  # STATUS says (healthy) or (unhealthy) for each service
docker compose restart web         # or whichever service is unhealthy
```

The web service's health is `GET /healthcheck`, which answers 200 only when the app can serve a chat
turn. Public CI kills llama and web with SIGKILL, then restarts the Docker daemon, and requires every
service to come back healthy on its own (`.github/selfhost-crash-restart-smoke.sh`).

## Back up and restore

`backup.sh` writes one directory, by default `backups/<UTC time>/` beside this file (git and the image
build both ignore it):

```sh
./backup.sh                 # or ./backup.sh /path/to/backups/today
```

It holds `db.sql.gz`, a `pg_dump --clean --if-exists` of the database taken while the app serves, and a
tarball of each of these volumes the stack has: `files`, `objects` (the `s3` profile), `agent-secrets`
and `agent-data` (the `agent` profile). The services that write to those volumes stop for the seconds
the copy takes, then start again. The `models` volume is not copied: the model downloads again. Run it
from cron for a nightly copy, and keep copies somewhere other than this machine.

To restore, start a fresh stack from the same release with the profiles you run, then load the backup:

```sh
docker compose --profile local down -v          # deletes every volume of this stack, the model cache too
docker compose --profile local up -d --wait
./restore.sh backups/20261122T030000Z
```

`restore.sh` loads the dump with `psql --single-transaction -v ON_ERROR_STOP=1`, so a failed restore
changes nothing in the database. It replaces each volume it has a tarball for, and refuses to start when
the backup holds a volume the running stack lacks (add that profile and run it again). It needs the same
`.env` the backup was taken under. The self-host CI's `smoke` job runs this round trip on every pull
request: a guest conversation and a file in the `files` volume, `backup.sh`, `down -v`, `up`,
`restore.sh`, then the conversation and the file must come back unchanged
(`.github/selfhost-restore-smoke.sh`).

### What to keep safe

| What | Where | What you lose without it |
| --- | --- | --- |
| The database | `db.sql.gz` from `backup.sh` | Every account, conversation, setting and workspace. |
| People's files | `files.tar.gz`, or `objects.tar.gz` on the `s3` profile | Every file in My files and every chat upload. Each person's file key lives here too, under `_keys/`. |
| `CUSTODIAL_MASTER_IDENTITIES` | `.env` only; `backup.sh` never copies it | With sealing on, every sealed file: each person's file key is encrypted to this master, and there is no other copy. |
| `BETTER_AUTH_SECRET` | `.env` only | Everyone is signed out, guests without a saved conversation start over, a linked Hugging Face bucket asks to be reconnected, and every server people added in Settings → Connectors stops being offered until they add its token again; the log says why (`sealedSecret.ts`). |
| `agent-secrets` | `agent-secrets.tar.gz`, `agent` profile only | Nothing lasting: delete it and `agent-token`, and the next start makes new keys (see Agent mode). |

Keep `.env` in a password manager or another place apart from the backups. A copy of the backups plus
`.env` is everything: whoever holds both can read every file, sealed or not.

## Upgrade

Web applies the database migrations every time it starts (the image's start,
`web/scripts/serve.mjs`), and they only go forward: starting an older release does not undo them. So every
upgrade begins with a backup, and rolling back means the older release plus that backup.

1. Read the release notes for each version between yours and the new one, and compare `.env.example`
   with your `.env` for new keys.
2. `./backup.sh`
3. Move to the new version and start it:
   - From source (`compose.yaml` alone): `git fetch --tags && git checkout <tag>`, then
     `docker compose --profile local up -d --build`.
   - The published image (`compose.release.yaml`): verify the new tag (`../deploy/README.md`), set
     `ALPHA_IMAGE=ghcr.io/currentai-org/alpha:<tag>` in `.env`, then
     `docker compose -f compose.yaml -f compose.release.yaml --profile local pull` and the same command
     with `up -d`.
4. `SMOKE_NO_UP=1 ./smoke.sh` sends one guest turn to the running stack.

No release has been tagged yet, so today there is no tag to check out or pull: the source path follows
`main`, which can change on any commit. `git checkout <commit>` pins one, so you choose when to move.

To roll back, go back to the previous tag or commit (or `ALPHA_IMAGE`), then restore the backup from
step 2 into a fresh stack, as above:

```sh
docker compose --profile local down -v
git checkout <previous tag>
docker compose --profile local up -d --build --wait
./restore.sh backups/<the backup from step 2>
```

Anything written after that backup is lost. The image-only stack in `../deploy/` upgrades the same way;
its README has the commands.

## Use a service you already run

Every service the stack bundles or calls can be one you already run, set in `.env` with no change to
`compose.yaml`:

| Service | `.env` keys | Without them |
| --- | --- | --- |
| The model | `OPENAI_BASE_URL`, `OPENAI_API_KEY` | `llama` with the `local` profile (block A of `.env.example`) |
| Postgres | `DATABASE_URL`, and `BUNDLED_DB=0` so the bundled one does not start | `db`, Postgres 17 in the `db` volume |
| File storage | `CUSTODIAL_STORAGE_BACKEND=s3` and `CUSTODIAL_S3_*` (block S) | the `files` volume |
| Search reranker | `RERANK_ENDPOINT_URL` | none, or `rerank` with the `rerank` profile |
| Safety screen | `GUARD_SHADOW_URL` | none, or `shieldstral` with the `safety` profile |
| Picture scanner | `CSAM_SCAN_PROVIDER`, `CSAM_SCAN_BASE_URL`, `CSAM_SCAN_TOKEN` | none |
| Moderation (Coop) | `COOP_URL`, `COOP_API_KEY` | none |
| Agent mode | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN` | none, or `agent` with the `agent` profile |
| Google connector | `GOOGLE_CONNECTOR_URL` | none, or `google` with the `google` profile |

With your own Postgres, the app creates its tables there on first start, as it does in the bundled one.
`DATABASE_URL` takes the form `postgres://<user>:<password>@<host>:5432/<database>`; the user needs to
create tables in that database. `backup.sh` and `restore.sh` then skip the database, saying so, and
still copy and restore the file volumes: back that database up on its own server. Take that backup
at the same time as `backup.sh`, with nobody using the app between the two, and restore both from the
same moment. The database lists every stored file and who owns it, so a database from another moment
can point at files the restored volume lacks, or leave files that nothing points to.

## Every service a request passes through

With the files here unchanged and the local profile running, these are all the network services
involved:

| Service | Runs where | When |
| --- | --- | --- |
| `web`, the Alpha app (SvelteKit on Node) | your machine | every request |
| `db`, Postgres 17 | your machine | sessions, conversations, messages |
| `llama`, llama.cpp server | your machine | every model call: the answer, and the search decision |
| huggingface.co | Hugging Face | the `llama` and `rerank` containers' first start only, to download each GGUF |
| `rerank`, llama.cpp server with bge-reranker-v2-m3 | your machine | only with the `rerank` profile: every turn that searches, to score the pages it found |
| `seaweedfs`, SeaweedFS's S3 gateway | your machine | only with the `s3` profile and block S: every read and write of a person's files |
| api.openalex.org, export.arxiv.org, huggingface.co/api/models, `<lang>`.wikipedia.org, wikinews.org | third parties | only when a turn searches the web. The composer's search setting defaults to Auto, and the model decides whether to search. Turn search off in the composer to stop this. |
| `sockguard`, `gateway`, `agent`, `agent-init` | your machine | only with the `agent` profile: agent mode's socket proxy, model gateway, task service and one-shot secret maker. The sandbox containers it creates run on your Docker host. |
| icons.duckduckgo.com | DuckDuckGo, through the app's own `/api/favicon` route | to show the favicons of cited sources |

With profile B, the model calls go to the provider you set in place of `llama`.

The browser loads scripts, styles and fonts from the app only. An artifact preview, opened by the user,
can load code from cdn.tailwindcss.com, unpkg.com, cdn.jsdelivr.net and cdnjs.cloudflare.com inside
its sandboxed frame.

## Scanning the image

The app image runs on distroless Node (`gcr.io/distroless/nodejs24-debian13`): Node, glibc and CA
certificates, with no shell, package manager or coreutils. Its base images are pinned by digest in
`web/Dockerfile`.

A release is built only if Grype finds no high or critical vulnerability that has a fixed version,
in the image's own packages or in the Debian base. The release workflow's run summary lists every
finding, split into those with a fix and those without. A scan of your own, for example
`grype ghcr.io/currentai-org/alpha:<tag>`, will still report findings with no fix upstream yet, in
the libraries Node links against: OpenSSL, glibc and the GCC runtime. Each one is in the run summary, by package. The
repository's `.grype.yaml` lists any finding the release ignores, each with its reason.

With no shell in the container, run a command in it through Node, for example
`docker compose exec web node -p process.env.APP_SURFACE`. For a shell beside it, start a
throwaway container in its namespaces:
`docker run --rm -it --pid=container:<web container> --network=container:<web container> busybox sh`.

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
  boot log then says `SELF-HOST, NO SCREEN`, so the gap is never silent (`guardGate.ts`,
  `selfHostWithoutScreen`). "A safety screen (optional)", above, runs one beside the stack. To screen every turn, name a classifier: the bundled pairing (a Shieldstral endpoint in
  `GUARD_SHADOW_URL`, which also screens pictures, and a Qwen3Guard endpoint in `QWEN3GUARD_URL`;
  `detectors/safetyScreen.ts`), or Zentropi S1 for text
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
  API) instead of api.firecrawl.dev. With `--profile rerank`, RAG scores its top five passages
  with the bundled reranker and waits `RAG_RERANK_TIMEOUT_MS` (compose's 6000) for it: on 2 cores that takes 4.3 s
  at the median and 5.8 s at p95, so keep it at 6000 or above there. A RAG rerank that misses it answers
  from the embedder's similarity ranking alone, without the reranker's relevance check. A passage is kept
  at `RAG_RERANK_MIN_SCORE` (compose's 0.005) when it also scores `RAG_RERANK_RELATIVE_RATIO` (0.05) of
  the best one: the reranker scores French, Spanish and German right passages lower than English ones, and
  on the committed eval set this kept 38 of 45 of them against 28 at the app's 0.02 alone, with none of 32
  questions about a similarly named organisation grounding on its page.
- **Read-aloud** posts to `READ_ALOUD_BASE_URL` + `/audio/speech`, any OpenAI-compatible speech endpoint (a
  base ending in `/v1`); unset, it uses the Hugging Face router and `HF_TOKEN`. With the base set, no Hugging Face token is needed, and a bearer is sent only if `READ_ALOUD_API_KEY` is set. `READ_ALOUD_MODEL` and `READ_ALOUD_VOICE` set the model and voice names your endpoint expects (one voice for every language); either unset sends the Kokoro value, and the Hugging Face route ignores both.
- **TLS.** The port is bound to 127.0.0.1 and cookies are sent without the Secure flag. Put a TLS
  proxy in front, set `PUBLIC_ORIGIN` to its https origin, and set `ALLOW_INSECURE_COOKIES=false`.
