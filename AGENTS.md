# AGENTS.md

A guide for coding agents working in a fork of this repository. `README.md` explains what Alpha is, the
hosted services it expects and how a chat turn flows; read its "Find your way around" section first. This
file covers what an agent needs to change the code safely.

## Layout

| Path                                  | What it holds                                                              |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `web/`                                | The SvelteKit app: chat UI, server, API. Most changes land here            |
| `web/src/routes/chat/`                | Chat pages and the conversation API (`conversation/[id]/+server.ts`)       |
| `web/src/lib/chat/server/`            | Model endpoints, routing, search, retrieval, the safety screen, auth, storage |
| `web/src/lib/chat/components/`        | Chat UI components; `stack/` is the X-ray panel                            |
| `web/src/lib/chat/routing/`           | Auto, the per-message model picker                                         |
| `web/config/`                         | Committed configuration: models and roles, the picker, the env manifest   |
| `web/messages/`                       | UI copy per language (Paraglide); `en.json` is the source                  |
| `web/drizzle/`                        | Postgres migrations                                                        |
| `packages/alpha-ds/`                  | The design system (`@aipotluck/alpha-ds`)                                  |
| `agent-service/`                      | The Python service that runs agent-mode tasks in sandboxes                 |

## Commands

Run these from `web/` unless noted.

```sh
pnpm install --no-frozen-lockfile   # the lockfile also lists packages this snapshot leaves out
pnpm check                          # i18n checks and svelte-check
pnpm lint                           # prettier, eslint and the design-system rules
pnpm test:ci:fast                   # server unit tests; no outside services needed
pnpm build                          # production build; ADAPTER=node for a plain Node host
```

`svelte-check` needs about 4 GB of memory. In `agent-service/`: `make venv`, then `make test`.

The browser end-to-end specs in `web/e2e/` run against a deployed instance with the hosted services;
read them for expected behaviour rather than running them on a fresh clone.

## Conventions worth keeping

- **Configuration has three homes.** Secrets and per-deployment values are environment variables, each
  declared in `web/config/env-manifest.mjs` with a one-line description; `web/.env.example` mirrors it.
  Models, roles and tuning are committed in `web/config/`. On/off switches are PostHog feature flags,
  listed in `web/src/lib/chat/server/flagKeys.ts`.
- **A flag decides whether a feature is on; an env var is only what it needs to run.** Never treat a
  variable's presence as an on switch. `web/src/lib/chat/server/agentMode.ts` is the reference: the
  `agent-mode` flag gates it and `AGENT_SERVICE_URL` is just the address.
- **Every flag has a code fallback.** Without PostHog each flag takes the value its call site passes to
  `flagEnabledOr`, so the app runs, with most optional features off. Check that fallback before deciding a
  feature is broken.
- **UI is built from the design system.** Use `@aipotluck/alpha-ds` components and its token utilities
  (`bg-surface-1`, `text-fg-2` and so on), never a hard-coded colour or radius. Change the look in
  `packages/alpha-ds/src/tokens/themes.ts`. `web/src/lib/chat/design-system.md` has the chat's rules.
- **Translated UI copy lives in `web/messages/`** (Paraglide). Add a new string there so it reaches every
  language.
- **Provenance comes only from what the upstream reported.** The model and host that served a turn are
  read from `routerMetadata` on the message. When a value was not recorded, the UI says "not recorded".
- **A test's name states the contract it guards.** Assert on behaviour, never on the source text of the
  code under test. A change to a prompt or a classifier needs a check against a real model as well as unit
  tests, since a unit test cannot show what the model says.

## Things that look wrong but are not

- Comments cite tickets such as `CUR-123` from an internal tracker that is not public. Ignore them.
- `web/` started as Hugging Face's chat-ui. Files derived from it stay under Apache-2.0
  (`web/LICENSE.chat-ui`), and `web/UPSTREAM.md` maps their paths. Keep the licence headers.
- `routerMetadata` keeps chat-ui's name though Alpha fills it on every turn, router or not.
- `web/src/lib/chat/server/rules-s1.json` and `web/src/lib/chat/server/data/guard-vectors.json` are
  placeholders. With them, the optional S1 safety judge has no policies, and the guard examples are
  embedded at run time instead of read from precomputed vectors.
- `pnpm dev` wraps Vite in `doppler run`. If your values are in `web/.env`, run `pnpm exec vite dev`.

## Swapping out a hosted service

Each service is reached through the variables listed in `README.md`, "Hosted services". The model gateway
can be any OpenAI-compatible endpoint (`OPENAI_BASE_URL`); `web/config/inference.ts` assigns models to
roles and names the variable that holds each provider's key. Web search engines are one function each in
`web/src/lib/chat/server/search/openSearch.ts`. The agent sandbox backend is chosen by
`AGENT_SANDBOX_BACKEND` in `agent-service/`.
