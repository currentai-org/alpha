# PostHog reverse proxy

Ad and tracker blockers (uBlock Origin, Safari ITP lists, EasyPrivacy) block requests to
`*.i.posthog.com`. Routing analytics through your own origin makes the requests first-party, so
blockers don't drop them. With a same-origin proxy, a Content-Security-Policy of `connect-src 'self'`
also covers analytics.

The app includes the proxy. Turning it on is a configuration change.

## How it works

PostHog has two upstreams:

- **Assets.** The bundle, recorder and surveys are at `us-assets.i.posthog.com/static/*`. Remote
  config is at `us-assets.i.posthog.com/array/*`.
- **Ingestion.** Events, decide and flags are at `us.i.posthog.com/*` (`/e`, `/i/v0/e`, `/decide`,
  `/flags`, …).

`src/routes/rs/[...path]/+server.ts` forwards `/rs/*` to the matching upstream. It works on any
SvelteKit adapter and in `pnpm dev`. The endpoint:

- hardcodes both upstream hosts, so it can't be used for SSRF
- sets `trailingSlash: 'ignore'`, so posthog-js's `/rs/e/` isn't redirected with a 308
- forwards the exact path from `url.pathname`
- removes `cookie` and `host` from the forwarded request
- removes `content-encoding` and `content-length` from the response, because undici decodes gzip
- accepts GET, POST, OPTIONS and HEAD

The upstreams are US cloud. For an EU project, change them to `eu.i.posthog.com` and
`eu-assets.i.posthog.com`. Your dashboard URL (`us.posthog.com` or `eu.posthog.com`) shows which
region your project is in.

### Path name

EasyList and EasyPrivacy block `/ingest/` and other well-known PostHog proxy paths, so pick a
path that isn't on those lists. The app uses `/rs`. To rename it, change the route directory, any edge rewrites, and
`PUBLIC_POSTHOG_HOST`.

### Optional: Vercel edge rewrite

On Vercel, you can serve `/rs/*` at the edge and skip the function. Add these rewrites to
`web/vercel.json`. Put the specific rules before the catch-all:

```json
{
	"rewrites": [
		{ "source": "/rs/static/:path*", "destination": "https://us-assets.i.posthog.com/static/:path*" },
		{ "source": "/rs/array/:path*", "destination": "https://us-assets.i.posthog.com/array/:path*" },
		{ "source": "/rs/:path*", "destination": "https://us.i.posthog.com/:path*" }
	]
}
```

`/static/*` (recorder, surveys) and `/array/*` (the remote config `config.js`) go to the assets host.
Everything else goes to ingestion. With `@sveltejs/adapter-vercel`, top-level `vercel.json` rewrites
don't always merge into the build output. Requests that the edge doesn't handle fall through to the
endpoint, so they're still proxied.

## Enable the proxy

Set these environment variables:

```
PUBLIC_POSTHOG_HOST=/rs
PUBLIC_POSTHOG_UI_HOST=https://us.posthog.com
```

Use the relative path `/rs`, as PostHog recommends. posthog-js resolves it against the current
origin, loads config and assets from `/rs/array/*` and `/rs/static/*`, and sends events to `/rs/*`.
`PUBLIC_POSTHOG_UI_HOST` keeps the toolbar and "view in PostHog" links pointing at the PostHog app.
`initAnalytics(key, host, uiHost)` in `src/lib/analytics.ts` already passes both values, and
`api_host` accepts a relative path.

Set the variables on a preview deployment first. Each Vercel environment holds its own values.
Production needs a deployment that includes the `/rs` route before you point it at `/rs`, or
analytics requests fail.

## Check the proxy

1. Deploy a preview with the variables set.
2. In DevTools → Network, confirm analytics requests go to `<your-origin>/rs/e/…` and
   `/rs/static/…`, with no requests to `*.i.posthog.com`, and all return 200. Events appear in
   PostHog's live view.
3. Turn on uBlock Origin or the browser's built-in tracker blocking and reload. The requests still
   succeed.
4. Confirm the PostHog toolbar still opens, which shows `ui_host` works.
5. Set the variables in production.

## Roll back

To send events directly to PostHog again, unset `PUBLIC_POSTHOG_HOST` and
`PUBLIC_POSTHOG_UI_HOST`. posthog-js falls back to the `us.i.posthog.com` default after the rebuild
that the environment change triggers.
