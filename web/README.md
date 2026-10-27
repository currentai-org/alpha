# web/

The SvelteKit app behind Alpha: the chat UI, the server that talks to the models, and the unit tests
for both. One app serves the pages and the API.

## Where things are

| Path                        | What it holds                                                                  |
| --------------------------- | ------------------------------------------------------------------------------ |
| `src/routes/chat/`          | The chat pages and the conversation API                                        |
| `src/lib/chat/`             | Chat client code; `components/` is the UI                                      |
| `src/lib/chat/server/`      | The server side: model endpoints, routing, search and retrieval, auth, storage |
| `src/routes/designsystem/`  | A browsable catalogue of the design system                                     |
| `../packages/alpha-ds/`     | The design system itself: tokens, components and layout patterns              |
| `config/`                   | Committed configuration: models and roles (`inference.ts`), the model picker   |
| `messages/`                 | UI copy per language, compiled with Paraglide                                  |
| `drizzle/`                  | Postgres migrations                                                            |

`src/lib/chat/design-system.md` describes the chat's visual conventions. `UPSTREAM.md` says what this
app took from Hugging Face's chat-ui.

## Commands

```sh
pnpm install
pnpm check   # svelte-check and the i18n checks
pnpm test    # vitest
pnpm build   # production build
pnpm exec vite dev   # dev server on port 5173
```

## Configuration

The app reads its configuration from environment variables. `.env.example` lists every one of them,
generated from `config/env-manifest.mjs`, with the required ones marked. Each hosted service the app
uses (the model endpoint, the database, analytics, the agent service, search) is named there by the
variable that points at it, so you can see what to provide or swap out. Put your values in `web/.env`
or your shell.
