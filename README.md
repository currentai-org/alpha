# Alpha

Alpha is the chat app of [AI Potluck](https://aipotluck.org). It answers with open models, cites its
sources, and shows each answer's provenance. The organisation that trained a model is often not the one
running it for a given request, so Alpha records the maker, the host and every hop the request took. The app is SvelteKit, forked from Hugging Face's
[chat-ui](https://github.com/huggingface/chat-ui), with a separate Python service that runs longer
agent tasks in sandboxes.

A **lane** is one route to a model: the main gateway, Hugging Face's router, or
Mistral's API. **Auto** is the option in the model picker that chooses a model for each message. The
**X-ray** is the panel beside the chat, visible to users, that shows how an answer was produced.
**Hermes** is the open-source agent loop the agent service runs. To read the code, start with
[How a chat turn flows](#how-a-chat-turn-flows).

Alpha is developed in a private repository that also holds our website, content management system and
deployment setup. This repository is the chat part of it, exported as a single commit and refreshed as
the app changes, so other teams can read how a part works or fork it as a starting point. Because it is
the code we run in production, it is wired to the hosted services we use. Only a model endpoint and
Postgres are needed to boot: [What boot needs](#what-boot-needs) lists the five variables the app checks
at startup, and [Hosted services](#hosted-services) says what each of the others adds and what happens
without it. The code is MIT, with the files derived from chat-ui under Apache-2.0 (see
[Licence](#licence)).

## Before you start

### What boot needs

`web/.env.example` lists every variable the app reads and says which are required.
`web/src/lib/chat/server/env/validate.ts` checks five at boot:

| Variable                 | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`        | Base URL of any OpenAI-compatible endpoint, ending in `/v1`                    |
| `OPENAI_API_KEY`         | The key for that endpoint                                                      |
| `DATABASE_URL`           | Postgres connection string                                                     |
| `PUBLIC_ORIGIN`          | The origin the app is served from; sign-in builds its callback URLs from it    |
| `PUBLIC_CMS_PAYLOAD_URL` | The content management system's origin. See the note below.                    |

A production build refuses to boot without all five. The dev server (`vite dev`) boots anyway, logs what
is missing, and leaves `/chat` degraded (`web/src/hooks.server.ts`, the `catch` after `validateEnv()`).

`DATABASE_URL` must be set by that name. `web/src/lib/chat/server/db/client.ts` falls back to
`POSTGRES_URL` when it connects, but the boot check does not accept `POSTGRES_URL` in its place.

The content management system is not in this snapshot, and no code here fetches from
`PUBLIC_CMS_PAYLOAD_URL`. `web/svelte.config.js` only adds its origin to the content security policy, so
any URL satisfies the check.

### Which models you get

The model list comes from your endpoint's `GET /models`, narrowed by an allowlist. Off a deployment
(when neither `DEPLOY_ENV` nor `VERCEL_ENV` says `production` or `preview`), `MODEL_ALLOWLIST` is that
allowlist: comma-separated model ids, first one the default, or `*` for every model the endpoint lists.
Left unset, it defaults to `swiss-ai/apertus-v1.5-70b`, and if your endpoint does not serve that id, no
model loads. On a deployment, the lists in `web/config/picker.ts` replace it.

The picker offers more than the first model only when the `model-picker` PostHog flag is on. Without
PostHog it is off.

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
| A self-hosted E2B install            | The sandbox each agent conversation runs in             | `E2B_API_URL`, `E2B_API_KEY` (read by `agent-service/`)                                  | The agent service refuses to boot unless `AGENT_SANDBOX_BACKEND=bwrap` |
| Coop                                 | Content and child-safety moderation                     | `COOP_URL`, `COOP_API_KEY`                                                               | Moderation allows everything                                          |
| An input guard model                 | Screens each message before the model sees it           | `GUARD_SHADOW_URL` (and the `guard-*` flags)                                             | With its flags off (the default), no guard runs                       |
| Resend                               | Sign-in code emails                                     | `RESEND_API_KEY`                                                                         | Codes are logged instead of sent; sign-in still works                 |
| Google and GitHub OAuth              | Sign-in with those accounts                             | `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` and their secrets                                 | That provider is absent from the sign-in screen                       |
| SyftHub                              | Federated retrieval                                     | `SYFTHUB_API_TOKEN` and the other `SYFTHUB_*`                                            | Federated retrieval is off                                            |

`MISTRAL_CHAT_BASE_URL` and `MISTRAL_CHAT_API_KEY`, when both are set, replace `MISTRAL_BASE_URL` and
`MISTRAL_API_KEY` as the Mistral lane (`web/src/lib/chat/server/mistralKey.ts`). Either way,
`MISTRAL_MODELS` names the ids that join the catalog, and the allowlist above still decides which of them
the picker offers.

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

- `StackXRay.svelte` is the panel. `web/src/lib/chat/stores/stack.ts` holds whether it is open and
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
  PostHog flag, a deployment environment of `preview` or `production` (`DEPLOY_ENV`), and
  `AGENT_SERVICE_URL`. A second flag, `agent-mode-access`, decides per account who sees the toggle,
  so turning on `agent-mode` alone can still show nothing. Without PostHog both are off.
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
`MODEL_UPSTREAM_TOKEN`) and its offline test suite (`make test`).

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
- `web/config/env-manifest.mjs` declares every variable the code reads, and which are required.
  `web/.env.example` lists the same keys with one line each.
- `web/src/lib/chat/server/flagKeys.ts` lists the PostHog flags, and
  `web/src/lib/chat/server/flags.ts` reads them. A flag that PostHog cannot answer takes the fallback
  its call site passes to `flagEnabledOr`.

## What you can run

The server unit tests are written to run without outside services:

```sh
cd web
pnpm install --no-frozen-lockfile
pnpm test:ci:fast
```

`pnpm-lock.yaml` also lists packages from parts of the monorepo this snapshot leaves out, so install
without the frozen lockfile. `.nvmrc` pins Node 24 LTS (`lts/krypton`). The root `package.json` names
the pnpm version in its `packageManager` field.

The agent service has its own offline suite:

```sh
cd agent-service
make venv
make test
```

### Build it

`web/svelte.config.js` picks the SvelteKit adapter from `ADAPTER`: `vercel` (the default), `node` or
`static`. To build for a plain Node host:

```sh
cd web
ADAPTER=node pnpm build
```

### Run the dev server

You need an OpenAI-compatible endpoint and Postgres. A minimal `web/.env`:

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
pnpm db:start     # Postgres in Docker, at the DATABASE_URL above
pnpm db:migrate   # create the tables
pnpm exec vite dev
```

`pnpm dev` wraps Vite in `doppler run`, the secrets manager the maintainers use. If you keep your values
in `web/.env`, start Vite directly as shown.

## What is not in this snapshot

- The content management system that supplies the marketing pages, and the pages themselves.
- CI workflows and most of the repository's operational tooling. The scripts in `web/scripts/` that
  are here are the ones the app, its build or its tests import; a few (alerting, the audited
  production database reader) assume the hosted setup above.
- Secrets, deployment settings and account ids.
- The policies and reference vectors for the optional S1 safety judge. `web/src/lib/chat/server/rules-s1.json`
  and `web/src/lib/chat/server/data/guard-vectors.json` are placeholders; the default safety screen's
  rules (`web/src/lib/chat/server/rules.json`) are here in full.

The browser end-to-end specs in `web/e2e/` are here as a record of what the app is expected to do.
They run against a deployed instance with the hosted services, so they will not pass on a fresh clone.

## How this repository is maintained

Development happens in a private monorepo, and new versions of this code arrive here as snapshots.
Issues are welcome. A pull request cannot merge here directly, but the maintainers read every one and
carry worthwhile changes upstream.
`CONTRIBUTING.md` says how, `SECURITY.md` how to report a vulnerability, and `AGENTS.md` is a map of the
code for a coding agent working in a fork.

## Reading the code

The team's internal tracker is not public, so the ticket references in comments, such as `CUR-123` or
`SOL-45`, cannot be looked up from here.

`web/UPSTREAM.md` records the chat-ui commit Alpha forked from and how its paths map to this tree.

## Licence

The code Current AI wrote is MIT (`LICENSE`). `web/` descends from Hugging Face's chat-ui, and the
derived files stay under Apache-2.0 (`web/LICENSE.chat-ui`). The Hermes patches in
`agent-service/deploy/hermes/` stay under Hermes's MIT licence. The human-evaluation rubric is adapted from the
[Multilingual AI Safety Evaluation Lab by Roya Pakzad](https://github.com/royapakzad/ai-safety-evaluation-lab)
and keeps its MIT licence with attribution
(`web/src/lib/chat/server/data/eval/LICENSE.multilingual-ai-safety-lab`). `THIRD_PARTY_NOTICES.md` lists every
third-party piece with its source, licence and location. Names and logos are not licensed.
