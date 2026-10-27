// The PostHog API host for SERVER-side posthog-node clients (the flag plane, error tracking).
//
// PUBLIC_POSTHOG_HOST is a BROWSER variable. It may be set to a RELATIVE reverse-proxy path like `/rs`
// so posthog-js can dodge client-side adblockers (preview does exactly this). That value is meaningless
// server-side: posthog-node needs an absolute origin, and handed `/rs` it does NOT throw — getAllFlags
// just returns {} and every flag silently pins to its env fallback, so a flagged feature is dead on
// a deployment with a relative host while one with an absolute host works (CUR-87).
//
// So the server ignores a relative or empty host and uses the absolute default. Only an ABSOLUTE
// PUBLIC_POSTHOG_HOST is honored here (e.g. a first-party server-side ingest proxy) — the browser's
// adblock proxy path is not the server's concern and must never become its API host.

import { config } from "$lib/chat/server/config";

const DEFAULT_HOST = "https://us.i.posthog.com";

export function serverPosthogHost(): string {
	const h = ((Reflect.get(config, "PUBLIC_POSTHOG_HOST") as string | undefined) ?? "").trim();
	return h && !h.startsWith("/") ? h : DEFAULT_HOST;
}
