# The /alpha demo

The demo on `/alpha` (an inert preview) and `/alpha/demo` (full screen, "Try the demo") runs the chat
app's own `ChatShell` and `ChatWindow` on sample data, so it has no separate copy of the UI. Keep two
things in sync with the app: the data the demo is fed, and what the sample conversations say about
how Alpha works.

## Data sources

| What                                                                                           | Where                                                                      | Read by                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The payload `/chat`'s layout load returns (copy, serving line, prompt examples, feature gates) | `demo-page-data.ts`, delivered as `page.data` by `routes/alpha/+layout.ts` | Chat components that read `page.data` (greeting, retention badge, notices)        |
| The same payload plus the sample sidebar                                                       | `demo-shell-data.ts`                                                       | `ChatShell` (`bind:data`)                                                         |
| Messages, served models, the conversation's model                                              | `demo-conversation.ts`, `demo-models.ts`                                   | `ChatWindow` props (`AlphaDemoClient.svelte`)                                     |
| API calls the app makes on its own                                                             | `demo-api-interceptor.ts`                                                  | Fetches under `/chat/api/v2`                                                      |
| Clicks that need the full app                                                                  | `EmbeddedIntent` → `onEmbeddedNavigate`                                    | Settings, accounts, the routing lab, Contribute: a quiet note, never a navigation |

Sending a message is the one action that asks for sign-up.

## Checks that keep the demo in sync

- **`DemoShellData` is typed from `loadChatShellData`.** When you add a field to that loader,
  `pnpm check` fails in `demo-page-data.ts` until the demo supplies it. Gates that need a backend
  stay off in the demo.
- **`demo.spec.ts`** pins the payload (production's serving line and retention note, the shared starter
  pool). It also checks that every sample answer names a model the demo serves, that no answer cites a
  source it doesn't carry, and that each recorded model is the one Auto would pick for its question
  (staying on the last model mid-chat). A router or benchmark change that contradicts a sample fails
  this spec.
- Models come from `routing/catalog.ts` and links from `chat/contribute.ts`, so a rename or a moved page
  fails at import instead of going stale.

## Update the demo when the app changes

| App change                                      | Update                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A new payload field or feature gate             | `demo-page-data.ts`. Turn the gate on only if it needs no backend                                 |
| Routing, benchmarks or the classifier           | The "How Alpha picks a model" thread, `demo.spec.ts` and `docs/guides/auto-model-routing.md`      |
| A new answer-level feature or message field     | Add it to a sample turn (`extra`) so it shows                                                     |
| A link from a chat component to a full-app page | Intercept it with `embeddedDemo` and an `EmbeddedIntent`, or it takes the visitor out of the demo |
| A new endpoint the app calls on its own         | `demo-api-interceptor.ts`                                                                         |
| Copy about how Alpha works                      | `copy.ts` (the language feature, the FAQ) and the sample threads                                  |

## Behavior notes

- The demo runs on the same origin as the app and shares its localStorage keys
  (`alpha:model-choice`, `alpha:dismissed-language-gaps`, `alpha:mode`, `alpha:theme`). A model
  picked in the demo is the model the app opens with.
- The dark stage around `/alpha/demo` is a plain token scope. It has no `ThemeProvider`, so the
  light app inside it never sits under a `.dark` ancestor, which legacy `dark:` classes would match.
- Copy edited in the admin CMS doesn't reach the demo. The demo shows each string's default.
- The demo leaves out the sidebar's "Get involved" card (`NavMenu` skips it), settings, dictation,
  agent mode and read-aloud.
