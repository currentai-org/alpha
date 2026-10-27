# Folkways adapter

This folder holds an OpenAI-compatible base that sits between the chat and its model upstream and
reports to a Folkways control plane. Its routes:

```text
POST /folkways-adapter/v1/chat/completions   OpenAI-compatible; resolve mode applies the bundle, observe mode passes through
GET  /folkways-adapter/v1/chat/completions   health probe; shows the pinned release (resolve) or the mode (observe)
GET  /folkways-adapter/v1/models             catalog passthrough to the real upstream
GET  /folkways-adapter/v1/safety             read-only: the safety rules the host enforces
POST /folkways-adapter/mistral/v1/chat/completions   chat's Mistral lane (Large 3), observe only, byte-for-byte
GET  /folkways-adapter/mistral/v1/chat/completions   health probe for the Mistral lane
```

## Access

Every route returns 404, the same as a route that doesn't exist, unless the adapter is enabled (see
[Feature flag and mode](#feature-flag-and-mode)). Each handler checks this first, at request time.

Every route then requires `Authorization: Bearer <OPENAI_API_KEY>`, the header the host already
sends to its `OPENAI_BASE_URL`, and returns 401 otherwise (`callerAuthorized` in `flag.ts`, a
constant-time compare). The host's own key is the adapter's password, so there is no second secret.
The check stops the adapter from relaying requests to the upstream on the host's key for callers
that don't hold that key.

## Modes

`FOLKWAYS_MODE` selects one of two modes:

- **resolve** (default). On a completion, the adapter resolves the active behavior bundle from the
  Folkways control plane, replaces the system prompt, forces the community-approved model, forwards
  the request to the upstream provider and posts a trace.
- **observe** (`FOLKWAYS_MODE=observe`). The adapter makes no resolve call, doesn't replace the
  prompt and doesn't override the model. The request goes to the upstream provider exactly as the
  host sent it. Instead, it reports the host's stable prompts (persona, grounding, panelist,
  aggregator, search classifier, model preprompt and decoding; see `promptLoader.ts`) as a `prompts`
  host report whenever their hash changes. Each turn's trace carries a hash of the assembled system
  message and the layers detected in it (`layerDetection.ts`), never the text.

In both modes, `/models` proxies the real upstream catalog unchanged.

Following Folkways' adapter guidelines, this folder imports nothing from Folkways core: the wire
types, including the `prompts` host report and the trace's demo-metadata fields, are copied into
`promptLoader.ts` and `observeTrace.ts`. Folkways controls all behavior.

## Mistral lane

Chat sends its Mistral models, including Large 3, to `MISTRAL_CHAT_BASE_URL` with
`MISTRAL_CHAT_API_KEY` (`mistralChatLane` in `$lib/chat/server/mistralKey.ts`). They never reach
`OPENAI_BASE_URL`, so the routes above don't see them. The Mistral route runs the same observe
pipeline (`observe.ts`) against a second upstream:

- **Observe only, whatever `FOLKWAYS_MODE` says.** Resolve mode would force the release's model, a
  gateway model id that Mistral doesn't serve. The trace's `detail.lane` is `"mistral"`.
- **Byte-for-byte in both directions.** The request goes upstream as the exact bytes chat sent, and
  the response body comes back unchanged. Mistral streams `delta.content` as a list of parts (text,
  plus `reference` parts that carry citations) and streams tool calls as deltas. Rewriting the
  content into a string would drop the citations. Response headers follow `passthroughHeaders.ts`,
  which forwards `retry-after` and `retry-after-ms` on a 429.
- **Caller auth.** The bearer must be `MISTRAL_CHAT_API_KEY`, the only key chat sends to this route.
  The same bearer is forwarded upstream.
- **Upstream.** `FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL`, default `https://api.mistral.ai/v1`. Set it to
  the value `MISTRAL_CHAT_BASE_URL` had before you routed it through the adapter, so the key chat
  sends still matches the host it reaches.

To route the lane through the adapter, set:

```text
MISTRAL_CHAT_BASE_URL = https://<app-domain>/folkways-adapter/mistral/v1
MISTRAL_CHAT_API_KEY  = <a Mistral key valid at FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL>
```

`mistralChatLane` uses the pair only when both are set. It ignores them on a per-branch preview
that bills `MISTRAL_API_KEY_CI`. When the upstream is a router, the key is the router's key.

## Safety rules

The adapter runs inside the model call. The host's safety gates run around it: the input gate
before the model call and the output screen after it. No rule can be switched on or off from here,
and Folkways doesn't try to. What the adapter does is report the rules:

- `GET /v1/safety` returns a snapshot with:
  - the rule catalog from `rules.json` (key, label, tier, action, query, decline message)
  - the validated policy's shield settings
  - `rules_hash`, a hash over the enforced rules
  - the live mode: which detector is on (`shieldstral` or `coop`), whether that detector enforces
    `rules.json`, and whether output moderation is on

  Every declared entry is reported, including `guardExempt` entries, which have a label and decline
  copy but no detector query (for example, prompt injection). Those carry `enforcement: "exempt"`
  and the reason given in the file, so the count Folkways shows matches the count the host declares.

- Every trace carries `safety_rules_hash` and `safety_detector`, which tie each request to the rule
  set that was live.
- The adapter pushes the full snapshot to Folkways (`POST /v1/host-reports`) whenever it changes.
  The Folkways console shows it under "Safety rules".

`safetySnapshot.ts` is the only place the adapter reads from the chat library. It reads
`rules.json`, `loadGuardPolicy()` and `resolveTurnPolicy()`, and writes nothing. A declared rule
isn't necessarily active. When the `guard-primary` flag is off, Coop enforces its own rules and
`rules.json` supplies only labels. The snapshot reports this as `rules_json_enforced: false`.

## Route all completions through the adapter

The host takes its serving endpoint from `OPENAI_BASE_URL`. A per-model `MODELS` endpoint override
doesn't change it. Point `OPENAI_BASE_URL` at the adapter:

```text
OPENAI_BASE_URL = https://<app-domain>/folkways-adapter/v1
```

Every completion, streaming included, then flows through Folkways. `/models` still serves the real
catalog, so the UI doesn't change. Set `FOLKWAYS_CATALOG_BASE_URL` to the real upstream (for
example, the previous `OPENAI_BASE_URL`) so the catalog proxy knows where to fetch. Remove any
`MODELS` override that points at the adapter.

### Route one model with `MODELS`

As an alternative, a `MODELS` override sends only the default model through the adapter. Set the
variable to this JSON on one line:

```json
[
	{
		"id": "swiss-ai/apertus-v1.5-70b",
		"endpoints": [{ "type": "openai", "baseURL": "https://<app-domain>/folkways-adapter/v1" }]
	}
]
```

With this override, the model that answers is the one the community activated in Folkways, while
the chat card keeps its label. The Folkways trace records both.

## Feature flag and mode

The PostHog flag `folkways-adapter` gates every route in this folder, like the other gates in
`$lib/chat/server` (`flags.ts`, `flagKeys.ts`). `FOLKWAYS_ENABLED` is the fallback. The app uses it
only while PostHog has never been polled successfully or doesn't define the key. Once PostHog
defines `folkways-adapter`, the flag's value wins.

| Variable                     | Default     | Purpose                                                                                                                                                   |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folkways-adapter` (PostHog) | not defined | `true`: every route in this folder is live. `false`: every route returns 404. Takes precedence once defined.                                              |
| `FOLKWAYS_ENABLED`           | off (`0`)   | Fallback. `1`: live. Unset or `0`: every route returns 404. Used while PostHog has never been polled or doesn't define the key.                           |
| `FOLKWAYS_MODE`              | `resolve`   | `observe`: no resolve, no rewrite, report and trace only. Any other value: resolve and rewrite. This is configuration. Use the flag above for on and off. |

`folkwaysEnabled()` calls `flagEnabledOr` (in `flag.ts`), a synchronous read of a snapshot that the
warm cron refreshes, so a request makes no network call to PostHog. `FOLKWAYS_MODE` is read at
request time from `$env/dynamic/private`, like the `cfg()` helper, so a running instance picks up an
env change without a redeploy.

The flag is evaluated once per deployment against a single fixed `distinctId`. A rollout-percentage
condition would pin the whole deployment to one side and wouldn't split traffic between visitors.
Set it to 0% or 100% only (see `flag.ts`).

## Environment variables

| Variable                             | Default                                    | Purpose                      |
| ------------------------------------ | ------------------------------------------ | ---------------------------- |
| `FOLKWAYS_URL`                       | `http://localhost:4600`                    | Folkways control plane       |
| `FOLKWAYS_TOKEN_GATEWAY`             | `dev-gateway-token`                        | resolve and trace auth       |
| `FOLKWAYS_UPSTREAM_BASE_URL`         | `https://router.huggingface.co/v1`         | real model provider          |
| `FOLKWAYS_UPSTREAM_API_KEY`          | falls back to `HF_TOKEN`, `OPENAI_API_KEY` | provider auth                |
| `FOLKWAYS_UPSTREAM_BILL_TO`          | falls back to `HF_BILL_TO`                 | HF router `X-HF-Bill-To` org |
| `FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL` | `https://api.mistral.ai/v1`                | Mistral lane upstream        |
| `FOLKWAYS_CATALOG_BASE_URL`          | `https://api-internal.publicai.co/v1`      | real catalog for `/models`   |
| `FOLKWAYS_CATALOG_API_KEY`           | falls back to `OPENAI_API_KEY`, `HF_TOKEN` | catalog auth                 |
| `FOLKWAYS_COMMUNITY`                 | `pottsboro-library`                        | deployment context           |
| `FOLKWAYS_DEPLOYMENT`                | `public-chat`                              | deployment context           |
| `FOLKWAYS_ENVIRONMENT`               | `development`                              | deployment context           |
