# PostHog events

Every event below is sent from the browser through the client in `src/lib/analytics.ts`, except
where noted.

## Initialisation

PostHog is a shared singleton in `src/lib/analytics.ts`. The root layout (`src/routes/+layout.svelte`)
and the chat layout (`src/routes/chat/+layout.svelte`) both call `initAnalytics`. The call is
idempotent, so the first layout to mount initialises PostHog and the second call does nothing.

The client is configured with:

- `person_profiles: 'identified_only'`, `autocapture: false` and `disable_session_recording: true`
- `capture_pageview: false`, because the app sends `$pageview` itself on each SvelteKit navigation
- `capture_pageleave: true`, so posthog-js sends `$pageleave`
- `api_host` and `ui_host` from `PUBLIC_POSTHOG_HOST` and `PUBLIC_POSTHOG_UI_HOST`, so you can put a
  first-party reverse proxy in front of PostHog without a code change (see `posthog-reverse-proxy.md`)

## Privacy

With `person_profiles: 'identified_only'` and no call to `identify()` anywhere in the code, PostHog
writes no person rows. Autocapture and session recording are off.

Set two more options in your PostHog project settings, since the code doesn't set them.
`anonymize_ips` hashes IPs, and `cookieless_server_hash_mode: 2` keeps a visitor's id stable across
sessions so retention, stickiness and lifecycle insights work. The unit is a browser. One person on a phone and a laptop
counts as two visitors, and clearing site data starts a new one. Treat these counts as a lower
bound.

Enabling person profiles would add account-level identity. That changes the privacy model, so treat
it as a product decision.

## Internal traffic

Traffic from localhost, or from any URL with `?ph_test=1`, gets the super-property
`is_internal_test: true`. `?ph_test=<label>` also tags the browser with that label. Exclude internal
traffic in PostHog with a test-account filter on `is_internal_test is_not true`.

A host-based filter such as `$host not_icontains localhost` keeps server exceptions visible,
because server-side events have no `$host` and a negative filter passes an unset property. They are
attributed to `aipotluck-server` (`src/lib/chat/server/errorTracking.ts`).

## Pageviews

- **`$pageview`** is sent on every route in the root layout's `afterNavigate`. It carries one custom
  property, `source`.
- **`$pageleave`** is sent by posthog-js and feeds session duration and bounce rate.
- **`source`** (`qr_code`, `link`, `direct` or `from_chat`) classifies how the visitor arrived. It is
  registered once per session as a session super-property (`registerArrivalSource`, which calls
  `posthog.register_for_session`). Add `?source=qr_code` or `?ref=…` to printed QR codes and event
  links. Without one, the value comes from the referrer: a same-origin `/chat` referrer gives
  `from_chat`, any other referrer gives `link`, and no referrer gives `direct`.

posthog-js adds `$current_url`, `$pathname`, `$referrer` and `$utm_*` to every event.

## Chat events

Code under `src/lib/chat/**` and `src/routes/chat/**` calls `trackEvent`. Its events include `session_started`, `message_sent`, `contribution_form_opened`,
`contribution_form_submitted`, `report_problem_clicked`, `tts_activated`, `data_erased`, and the
guided tour events (`tour_started`, `tour_skipped`, `tour_cta_clicked`).

### Generation outcome

`message_sent` fires when the user clicks send, before any network call, so it can't confirm the
turn succeeded. The generation stream returns HTTP 200 even when a turn fails partway (an in-stream
`Status/Error`), so the server's error rate doesn't show these failures. Two events record the
outcome. Exactly one of them fires per turn, from the stream's `finally` block in
`src/routes/chat/conversation/[id]/+page.svelte`, for first messages and follow-ups alike.

- **`response_received`** fires when a final answer arrives. Properties:
  - `latency_ms`: from the send handler's start to the final answer
  - `ttft_ms`: from the start to the first rendered content byte. For a single-shot answer with no
    token streaming, this is about equal to `latency_ms`.
  - `interrupted`: true if the user pressed Stop after a partial answer arrived
  - `logged_in`, `model_requested`, `model_served`
- **`response_error`** fires when the turn ends without a complete answer. The `reason` property
  takes the most specific value that applies:
  - `user_stopped`
  - `capacity_shed`: a 503 from admission control
  - `ttft_timeout`: the first-token watchdog fired
  - `early_5xx`: a cold or killed function invocation, after retries
  - `error`: an in-stream `Status/Error`
  - `incomplete`: the stream started and then dropped
  - `empty`

  It also carries `logged_in`, `model_requested` and `model_served`. Navigating away mid-turn sends
  neither event.

`model_requested` is the model id the turn was sent to. `model_served` comes from the router's
provenance frame (`routerMetadata.model`) and is `null` if the turn ended before a frame arrived. Group TTFT by `model_served`. A row where the two differ is a fallback.

With these events you can chart the `response_error` rate by `reason`, `latency_ms` and `ttft_ms`
percentiles, and the `message_sent` → `response_received` conversion, which is the completion rate.

### Attachments

**`chat_photo_prepared`** fires once for each photo a visitor picks, drops or pastes into the
composer. It's sent from `shrinkImages` in `src/lib/chat/utils/shrinkImage.ts`, after any resizing.
Properties: `type` (MIME type), `originalBytes`, `sentBytes`, and `shrunk` (true when the browser
redrew the image smaller). It carries no file name or content. Photos with `originalBytes` over the
3 MB message limit would have been refused without resizing.
