# Alpha

Alpha is the chat app of [AI Potluck](https://aipotluck.org). It answers with open models, cites its
sources, and shows each answer's provenance. The organisation that trained a model is often not the one
running it for a given request, so Alpha records the maker, the host and every hop the request took. The app is SvelteKit, forked from Hugging Face's
[chat-ui](https://github.com/huggingface/chat-ui), with a separate Python service that runs longer
agent tasks in sandboxes.

A **lane** is one route to a model: the main gateway, Hugging Face's router, or
Mistral's API. **Auto** is the option in the model picker that chooses a model for each message. The
**X-ray** is the panel that opens from the pill under the composer, visible to users, that shows how
an answer was produced.
**Hermes** is the open-source agent loop the agent service runs. To read the code, start with
[How a chat turn flows](#how-a-chat-turn-flows).

Alpha is developed in a private repository that also holds our website, content management system and
deployment setup. This repository is the chat part of it, exported as a single commit and refreshed as
the app changes, so other teams can read how a part works or fork it as a starting point. Because it is
the code we run in production, it is wired to the hosted services we use. Only a model endpoint and
Postgres are needed to boot: [What boot needs](#what-boot-needs) lists the variables the app checks
at startup, and [Hosted services](#hosted-services) says what each of the others adds and what happens
without it. The code is MIT, with the files derived from chat-ui under Apache-2.0 (see
[Licence](#licence)).

The `CUR-` and `SOL-` ids in comments and tests refer to the project's internal issue tracker.

## Run it with Docker Compose

`selfhost/` runs Alpha on one machine: the app, Postgres, and a small open model on CPU, with no key and
none of our hosted services. You need git, `openssl`, and Docker with Compose v2.20 or newer, about 4 GB of free RAM (6 GB once, for
the image build), about 15 GB of free disk, and internet access: the first start pulls images and downloads the model (about
400 MB) from Hugging Face, with no account or token.

<!-- readme-walk:start -->
```sh
git clone https://github.com/currentai-org/alpha.git
cd alpha/selfhost
sed "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env.example > .env
docker compose --profile local up --build --wait
```
<!-- readme-walk:end -->

The `sed` line copies `.env.example` to `.env` with a fresh random `BETTER_AUTH_SECRET`; it is the only
value the local model needs. `up --wait` returns once every service is healthy, which on the first start
takes the image build (about 4 minutes on 8 CPUs) plus the model download. `docker compose logs -f web`
shows the app's log meanwhile.

Then open http://localhost:3000, choose to chat as a guest, and ask anything. Without a browser, this
sends one guest turn and prints the answer (it needs `curl` and `jq`):

<!-- readme-walk-answer:start -->
```sh
SMOKE_NO_UP=1 ./smoke.sh
```
<!-- readme-walk-answer:end -->

[`selfhost/README.md`](selfhost/README.md) covers a hosted model in place
of the local one, sign-in, files, feature flags and TLS. The rest of this README is for running the app
by hand and for reading the code.

## Before you start

### What boot needs

`web/.env.example` lists the app's configuration variables, one line each, and marks the required ones;
`web/config/env-manifest.mjs` is where they are declared, and its `bootRequiredKeys` decides which
ones `web/src/lib/chat/server/env/validate.ts` checks at boot:

| Variable                 | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`        | Base URL of any OpenAI-compatible endpoint, ending in `/v1`                    |
| `OPENAI_API_KEY`         | The key for that endpoint                                                      |
| `DATABASE_URL`           | Postgres connection string                                                     |
| `PUBLIC_ORIGIN`          | The origin the app is served from; sign-in builds its callback URLs from it    |
| `ALPHA_EDITION`          | Only with `DEPLOY_ENV=production`. `selfhost` for your own install; `hosted` is for Current AI's deployments |
| `PUBLIC_CMS_PAYLOAD_URL` | Only with `DEPLOY_ENV` set to `production` or `preview` on a build that serves the site. See the note below. |

A built server refuses to boot without the ones that apply to it. The dev server (`vite dev`) boots
anyway, logs what is missing, and leaves `/chat` degraded (`web/src/hooks.server.ts`, the `catch` after
`validateEnv()`).

`DATABASE_URL` must be set by that name. `web/src/lib/chat/server/db/client.ts` falls back to
`POSTGRES_URL` when it connects, but the boot check does not accept `POSTGRES_URL` in its place.

The content management system is not in this snapshot, and no code here fetches from
`PUBLIC_CMS_PAYLOAD_URL`. `web/sveltekit.config.js` only adds its origin to the content security policy, so
any URL satisfies the check.

Sign-in needs one more: `BETTER_AUTH_SECRET`, 32 or more random bytes. Without it Better Auth uses its
default secret, which it refuses in a production build. Anonymous chat still works then; sign-in does not.

### Which models you get

The model list comes from your endpoint's `GET /models`, narrowed by an allowlist. Off a deployment
(when neither `DEPLOY_ENV` nor `VERCEL_ENV` says `production` or `preview`), `MODEL_ALLOWLIST` is that
allowlist: comma-separated model ids, first one the default, or `*` for every model the endpoint lists.
Left unset, it defaults to `swiss-ai/apertus-v1.5-70b`, and if your endpoint does not serve that id, no
model loads. On a deployment, the lists in `web/config/picker.ts` replace it.

Setting `DEPLOY_ENV` (or `VERCEL_ENV`) to `production` or `preview` changes more than the model list,
so leave it unset unless you mean to run as a deployment:

- the picker comes from `web/config/picker.ts`, and `MODEL_ALLOWLIST` is ignored;
- `TASK_MODEL` must name a registered model, or building the model registry throws
  (`web/src/lib/chat/server/models.ts`);
- unless `ALPHA_EDITION=selfhost`, moderation becomes required: without Coop (or the Shieldstral guard,
  below), the child-safety check fails closed and every turn is declined. With `ALPHA_EDITION=selfhost`
  (which `selfhost/compose.yaml` sets) turns go unscreened instead, and the boot log says
  `SELF-HOST, NO SCREEN` (`web/src/lib/chat/server/guardGate.ts`).

The allowlist alone decides how many models the picker offers (`web/src/lib/chat/server/modelGates.ts`).

### Hosted services

| Service                              | What Alpha uses it for                                  | Variables                                                                                | If unset                                                              |
| ------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| An OpenAI-compatible model gateway   | Every chat answer                                       | `OPENAI_BASE_URL`, `OPENAI_API_KEY`                                                      | A production build refuses to boot                                    |
| Postgres (Neon in production)        | Conversations, accounts, settings                       | `DATABASE_URL`                                                                           | A production build refuses to boot                                    |
| Hugging Face's router                | A backup lane for the same model, and models pinned to one Hugging Face inference provider | `HF_BASE_URL`, `HF_TOKEN`                                 | Each model has one lane                                               |
| Mistral's API                        | Mistral models, on a lane of their own                  | `MISTRAL_BASE_URL`, `MISTRAL_API_KEY`, `MISTRAL_MODELS`; or `MISTRAL_CHAT_BASE_URL` with `MISTRAL_CHAT_API_KEY` | No Mistral lane                                                       |
| PostHog                              | Feature flags and product analytics                     | `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST`                                              | Each flag takes the fallback written at its call site                 |
| Vercel                               | Hosting, and the deployment environment                 | `ADAPTER` (build), `DEPLOY_ENV` (falls back to `VERCEL_ENV`)                             | `ADAPTER` defaults to `vercel`; see [Build it](#build-it)             |
| Firecrawl                            | General web search                                      | `FIRECRAWL_API_KEY`                                                                      | Search still runs on Wikipedia, Wikinews, arXiv and OpenAlex          |
| The agent service (`agent-service/`) | Agent mode                                              | `AGENT_SERVICE_URL`, `AGENT_SERVICE_TOKEN`                                               | Agent mode is withheld                                                |
| A self-hosted E2B install            | The sandbox each agent conversation runs in             | `E2B_API_URL`, `E2B_API_KEY`, `AGENT_GATEWAY_PUBLIC_URL`, `PROXY_ADMIN_KEY` (read by `agent-service/`) | The agent service refuses to boot unless `AGENT_SANDBOX_BACKEND=bwrap` |
| Coop                                 | Content and child-safety moderation                     | `COOP_URL`, `COOP_API_KEY`                                                               | Off a deployment, moderation allows everything. On a deployment, child safety fails closed and every turn is declined, unless the Shieldstral guard is the screen |
| The Shieldstral input guard          | Screens each message against `rules.json` before the model sees it | `GUARD_SHADOW_URL` (and the `guard-primary` flag)                             | With the flag off (the default), Coop is the screen                   |
| Resend                               | Sign-in code emails                                     | `RESEND_API_KEY`                                                                         | `SMTP_URL` sends the codes through your own mail server instead. With neither, `vite dev` logs the codes; a self-host edition offers email-and-password sign-in; anywhere else email sign-in does not work (`web/src/lib/chat/server/mailer.ts`) |
| Hugging Face OIDC                    | Sign-in with a Hugging Face account                     | `OPENID_CLIENT_ID`, `OPENID_CLIENT_SECRET`                                               | Without it, and without the `accounts` flag on, the app shows no sign-in link (`/chat/login` still works if typed) |
| Google and GitHub OAuth              | Sign-in with those accounts                             | `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` and their secrets                                 | That provider is absent from the sign-in screen                       |
| SyftHub                              | Federated retrieval                                     | `SYFTHUB_API_TOKEN` and the other `SYFTHUB_*`                                            | Federated retrieval is off                                            |

`MISTRAL_CHAT_BASE_URL` and `MISTRAL_CHAT_API_KEY`, when both are set, replace `MISTRAL_BASE_URL` and
`MISTRAL_API_KEY` as the Mistral lane (`web/src/lib/chat/server/mistralKey.ts`). Either way,
`MISTRAL_MODELS` names the ids that join the catalog, and the allowlist above still decides which of them
the picker offers.

Whether the app offers sign-in at all is the `accounts` PostHog flag. When PostHog cannot answer, it
falls back to whether `OPENID_CLIENT_ID` is set (`web/src/lib/chat/server/oidcConfig.ts`,
`loginEnabled`), so with neither the account menu has no Log in link.

`web/src/lib/chat/server/rules.json` is the screening policy: its categories, the queries that detect
them, and the copy a declined turn shows. It does not screen anything by itself. The Shieldstral guard
(`guard-primary` on, `GUARD_SHADOW_URL` set) runs its queries; with that flag off, the default, Coop is
the screen and applies its own rules, which live in the Coop service. With neither configured, see the
Coop row above.

To run without PostHog, leave its variables unset. `web/src/lib/chat/server/flagKeys.ts` lists every
flag with the default the code uses when PostHog cannot answer.

## How a chat turn flows

1. The composer posts the message to `web/src/routes/chat/conversation/[id]/+server.ts`. The handler
   runs retrieval and, when the turn needs it, web search, before the model is called.
2. `web/src/lib/chat/server/textGeneration/index.ts` builds the prompt, and
   `web/src/lib/chat/server/textGeneration/generate.ts` calls the model's endpoint.
3. Each model in the registry (`web/src/lib/chat/server/models.ts`) carries its endpoint. Gateway models
   use `web/src/lib/chat/server/endpoints/openai/endpointOai.ts`. The agent model uses
   `web/src/lib/chat/server/endpoints/agent/endpointAgent.ts`.
4. The stream carries `routerMetadata`, a field chat-ui added for its own router. Alpha fills it from
   what the upstream reports for every turn (the model and host that served it), whether or not a
   router chose the model. It is saved on the
   message (`web/src/lib/chat/types/Message.ts`), and the provenance views read it from there.

## Find your way around

### See which model answered and where the request went

The X-ray panel lives in `web/src/lib/chat/components/stack/`.

- `XRayComposerPanel.svelte` is the pill under the composer that opens it, and `StackXRay.svelte` is
  the panel's content. `web/src/lib/chat/stores/stack.ts` holds whether it is open and
  which answer it describes.
- `WhereItWent.svelte` lists each hop of the last message: app server, router, model host, storage.
  The hops come from `web/src/lib/chat/servingRoute.ts`, which reads only what the turn recorded and
  says "not recorded" for anything it did not.
- `StepByStep.svelte` walks through what happened during the turn: searches, tool calls, the model
  that answered.
- `web/src/lib/chat/servingProvenance.ts` derives who serves each model from configuration, so the UI
  text names the right host when the host changes.
- `web/src/lib/chat/messageProvenance.ts` defines the provenance markers stamped on each answer,
  shared by the server and the client.
- `web/src/lib/chat/components/provenance/` holds the per-answer footer and its breakdown.

### Change how Auto picks a model

Auto reads the draft as you type and picks a model before you send.

- `web/src/lib/chat/routing/classifier.ts` defines the contract: a draft goes in, and a typed analysis
  comes out (language, task size, likely skills, each with a confidence).
- `web/src/lib/chat/routing/localClassifier.ts` is the classifier that runs in the browser today.
- `web/src/lib/chat/routing/router.ts` scores each model against that analysis. The header comment
  gives the scoring formula.
- `web/src/lib/chat/routing/benchmarks.ts` and `web/src/lib/chat/routing/data/` hold the numbers it
  scores with. `web/src/lib/chat/routing/catalog.ts` records who makes and who serves each model.
- `web/src/lib/chat/server/autoRoutingGate.ts` turns Auto on with the `auto-routing` PostHog flag.
  Without PostHog the flag falls back to off.

### Follow a web search

- `web/src/lib/chat/search/triggerStrategy.ts` describes how a turn is judged to need a search, and
  `PUBLIC_SEARCH_TRIGGER` picks the strategy. `web/src/lib/chat/server/search/searchDecision.ts` is the
  model-based classifier that two of the strategies use.
- `web/src/lib/chat/server/search/runSearch.ts` runs the search on the server, and
  `web/src/lib/chat/server/search/openSearch.ts` calls the engines: Wikipedia, Wikinews, Firecrawl,
  OpenAlex, arXiv and the Hugging Face Hub. Each engine is one function in that file, so a new engine
  starts as a new function there.
- `web/src/lib/chat/server/textGeneration/searchGrounding.ts` writes the grounding instructions into
  the system prompt.
- `web/src/lib/chat/server/citationGuard.ts` strips citation markers that no retrieved source backs.

### Trace an agent-mode task

Agent mode hands a turn to the agent service. The service runs
[hermes-agent](https://github.com/NousResearch/hermes-agent), an agent loop that plans, calls tools and
reads their results, against the model, and executes its tool calls in a sandbox. The service carries
its own patches to Hermes in `agent-service/deploy/hermes/`.

- `web/src/lib/chat/server/agentMode.ts` decides whether agent mode is on. It needs the `agent-mode`
  flag, `AGENT_SERVICE_URL`, and either a self-host edition (`ALPHA_EDITION=selfhost`) or a deployment
  environment of `preview` or `production` (`DEPLOY_ENV`). A second flag, `agent-mode-access`, decides
  per account who sees the toggle, so turning on `agent-mode` alone can still show nothing. Without
  PostHog, a self-host reads both flags' self-host defaults from `flagKeys.ts`: `agent-mode` is on once
  `AGENT_SERVICE_URL` and `AGENT_SERVICE_TOKEN` are set, and `agent-mode-access` is on. Agent mode is
  offered only to signed-in accounts, and setting `DEPLOY_ENV` has the other effects listed under
  [Which models you get](#which-models-you-get).
- `web/src/lib/chat/server/endpoints/agent/endpointAgent.ts` starts a run on the agent service and
  streams its events back into the chat.
- `agent-service/api/app.py` is the service's API. `agent-service/api/proxy.py` is a separate gateway
  that holds the real model key, so the agent process never sees it, and caps steps and spend per task.
- `agent-service/api/sandbox_e2b.py` gives each conversation its own microVM on a self-hosted
  [E2B](https://github.com/e2b-dev/infra) install. `AGENT_SANDBOX_BACKEND` picks the backend and
  defaults to `e2b`. To run the service without E2B, set it to `bwrap`, which runs each task under
  bubblewrap on the same machine.
- `agent-service/deploy/e2b-template/` builds the sandbox image.

`agent-service/README.md` covers the service's design, its own variables (`MODEL_UPSTREAM_BASE`,
`MODEL_UPSTREAM_TOKEN`) and its unit test suite (`make test`).

### Change the look

The design system is the `@aipotluck/alpha-ds` package in `packages/alpha-ds/`.

- `packages/alpha-ds/src/README.md` explains its layers: tokens, components, layout primitives and page
  patterns.
- `packages/alpha-ds/src/tokens/themes.ts` holds the theme seeds that the colour tokens derive from.
- `web/src/routes/designsystem/` serves a browsable catalogue of every component at `/designsystem`.
- `web/eslint-rules/alpha-ds/` holds the lint rules that keep chat code on the design system.
- `web/src/lib/chat/design-system.md` describes the chat's own visual conventions.

### Change models and configuration

Configuration that is safe to publish is committed in `web/config/`. Secrets and per-deployment values
come from environment variables.

- `web/config/inference.ts` declares which model fills which role, on which provider. A provider names
  the variable that holds its key, never the key.
- `web/config/picker.ts` lists the models each deployed site's picker offers.
- `web/config/env-manifest.mjs` declares the app's configuration variables, and which are required.
  `web/.env.example` lists the same keys with one line each. A few platform and build-time variables,
  such as `VERCEL_ENV`, `ADAPTER` and `POSTGRES_URL`, are read directly and not declared there.
- `web/src/lib/chat/server/flagKeys.ts` lists the PostHog flags, and
  `web/src/lib/chat/server/flags.ts` reads them. A flag that PostHog cannot answer takes the fallback
  its call site passes to `flagEnabledOr`; a per-account flag read through `flagEnabledForUser`, such
  as `agent-mode-access`, counts as off.

## What you can run

The server unit tests are written to run without outside services:

```sh
cd web
pnpm install --frozen-lockfile
pnpm test:ci:fast
```

`.nvmrc` pins Node 24 LTS (`lts/krypton`). The root `package.json` names
the pnpm version in its `packageManager` field.

The agent service has its own unit suite. `make venv` needs Python 3.11+, `uv` and network access to
install the dependencies; the tests themselves call no model. Install bubblewrap (`bwrap`) for a full
pass: without it, the tests that need it skip or fail.

```sh
cd agent-service
make venv
make test
```

### Build it

`web/sveltekit.config.js` picks the SvelteKit adapter from `ADAPTER`: `vercel` (the default), `node` or
`static`. To build for a plain Node host:

```sh
cd web
ADAPTER=node pnpm build
```

### Run the dev server

You need an OpenAI-compatible endpoint and Postgres. Put the values in `web/.env.local`, which
`web/vite.config.ts` loads into `process.env` (the server reads `process.env` directly, so a `web/.env`
file is not enough). A minimal `web/.env.local`:

```sh
OPENAI_BASE_URL=https://your-endpoint.example/v1
OPENAI_API_KEY=...
MODEL_ALLOWLIST=your-model-id
DATABASE_URL=postgres://postgres:postgres@localhost:5432/aipotluck_test
PUBLIC_ORIGIN=http://localhost:5173
PUBLIC_CMS_PAYLOAD_URL=http://localhost:3000
```

Then:

```sh
cd web
pnpm db:start                                     # Postgres in Docker, at the DATABASE_URL above
node --env-file=.env.local scripts/db-migrate.mjs # create the tables
pnpm exec vite dev
```

The migration script reads only `process.env`, so `pnpm db:migrate` on its own finds no connection
string; pass the file with `--env-file` as above, or export the variables in your shell first.

`pnpm dev` is plain `vite dev`, which reads `web/.env.local`.

## What is not in this snapshot

- The content management system that supplies the marketing pages, and the pages themselves.
- The private repository's CI workflows (comments that name a workflow file refer to those) and most
  of its operational tooling. `.github/workflows/ci.yml` here runs the unit suites on every pull
  request. The scripts in `web/scripts/` that are here are the ones the app, its build or its tests
  import; a few (alerting, the audited production database reader) assume the hosted setup above.
- Secrets, deployment settings and account ids.
- Coop's own rules. The Shieldstral guard's policy (`web/src/lib/chat/server/rules.json`) and the
  optional S1 judge's policies (`web/src/lib/chat/server/rules-s1.json`) are here in full.

The browser end-to-end specs in `web/e2e/` are here as a record of what the app is expected to do.
They run against a deployed instance with the hosted services, so they will not pass on a fresh clone.

## How this repository is maintained

This repository is a published snapshot. Development still happens in a private monorepo, and new
versions of this code arrive here as snapshots until development moves here. Issues are welcome; code
pull requests open once this repository becomes the source of truth.
Once it does, work lands on `main` through short-lived pull request branches, and a release is a
semver tag (`v0.x.y`) with a signed image; run a tag, not `main`. `CONTRIBUTING.md` says how,
`SECURITY.md` how to report a vulnerability, and `AGENTS.md` is a map of the
code for a coding agent working in a fork.

## Reading the code

The team's internal tracker is not public. The export strips most of its ticket ids from comments and
test names, but many remain in comments, test tags, flag descriptions and data. They cannot be looked
up from here, and are being removed.

`web/UPSTREAM.md` records the chat-ui commit Alpha forked from and which directories descend from it.

## Licence

The code Current AI wrote is MIT (`LICENSE`). `web/` descends from Hugging Face's chat-ui, and the
derived files stay under Apache-2.0 (`web/LICENSE.chat-ui`). The Hermes patches in
`agent-service/deploy/hermes/` stay under Hermes's MIT licence. The human-evaluation rubric is adapted from the
[Multilingual AI Safety Evaluation Lab by Roya Pakzad](https://github.com/royapakzad/ai-safety-evaluation-lab)
and keeps its MIT licence with attribution
(`web/src/lib/chat/shared/data/eval/LICENSE.multilingual-ai-safety-lab`). `THIRD_PARTY_NOTICES.md` lists every
third-party piece with its source, licence and location.

Other organisations' names and logos, such as the model makers' marks in `web/static/logos/`, belong to
their owners, are used only to identify them, imply no endorsement or affiliation, and are not licensed:
see the Trademarks section of `THIRD_PARTY_NOTICES.md`.
