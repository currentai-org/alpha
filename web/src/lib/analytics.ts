import posthog from 'posthog-js';
import { browser } from '$app/environment';
import { isChatRoute } from '$lib/surface';
import { DEPLOYMENT } from '$lib/deployment';

// Chat's own host, which serves chat at its root (src/lib/deployment.ts). A link to it is a click to chat.
const CHAT_HOST = DEPLOYMENT.chatHost;

let initialized = false;

// ---- Custom event vocabulary (catalog in web/docs/posthog-events.md) ----
// Pageviews are PostHog-NATIVE — `$pageview` (manual, capturePageview) + `$pageleave` (auto) — so
// the built-in Web Analytics, Paths, and bounce/session-duration work out of the box. The list
// below is the CUSTOM events the site emits on top of that. The chat imports this same module for
// its own P0 events (session_started, message_sent, …), so there is one PostHog instance and one
// `initialized` guard across both surfaces.
export type SiteEvent =
	| 'click_to_chat'
	| 'click_to_map'
	| 'click_to_contribute'
	| 'click_to_about'
	| 'click_to_partners'
	| 'map_node_clicked'
	| 'contribution_email_submitted'
	| 'contribution_cta_clicked'
	| 'newsletter_signup';

// Specced but NOT wired yet — the site has no UI to attach them to. Each is one edit away once
// its surface ships; the intended trigger/props are recorded here:
//   sentiment_submitted  — { response }                 post-session "did this feel different?" widget
//   api_access_requested —                              an "API access" link (builder path)
//   share_button_clicked —                              a site-side share button
//   map_zoomed           — { direction }                the /map grid scrolls; it has no zoom control
//   raise_hand_clicked   — { node_id }                  lives on the CHAT gap map, not the /map grid
//   contribution_form_*  — { contribution_type, node_id } the contribute FORM lives in /chat
// NB: click_to_partners IS wired below (hrefToClickEvent) — it simply never fires until a
// /partners link exists, at which point it auto-instruments. That is deliberate.
// -----------------------------------------------------------------------------------------------

// No autocapture (would log raw DOM interactions/clicks we haven't audited) and no session
// recording (this app's privacy stance is HMAC-hashed IPs / no raw PII; recording screens is a
// different commitment that needs its own consent/masking review before it's on the table).
//
// capture_exceptions is separate from both of the above — it's unhandled errors and promise
// rejections, not interaction data or screen content, and the server side already makes this same
// no-new-vendor argument (errorTracking.ts). With it off, a client-side crash would be recorded
// nowhere: the analytics would see only the $pageview.
//
// The default host is the same-origin /rs proxy (routes/rs/[...path]), which every deployment serves
// and which forwards to POSTHOG_INGEST_HOST. PUBLIC_POSTHOG_HOST overrides it; set
// PUBLIC_POSTHOG_UI_HOST (e.g. https://eu.posthog.com) so the toolbar / "view in PostHog" links resolve
// while the API host is a proxy.
//
// legacyKey is PUBLIC_POSTHOG_LEGACY_KEY, the previous project token while a region move settles; see
// legacyDistinctId below.
export function initAnalytics(
	key: string | undefined,
	host: string | undefined,
	uiHost?: string | undefined,
	legacyKey?: string | undefined
) {
	if (!browser || !key || initialized) return;
	const distinctID = legacyDistinctId(key, legacyKey, browserStore());
	posthog.init(key, {
		api_host: host || '/rs',
		...(uiHost ? { ui_host: uiHost } : {}),
		...(distinctID ? { bootstrap: { distinctID } } : {}),
		person_profiles: 'identified_only',
		autocapture: false,
		// SvelteKit SPA best practice: capture_pageview OFF and fire $pageview MANUALLY from the root
		// layout's afterNavigate (posthog-js's history-based auto-capture mis-times against SvelteKit's
		// client router). $pageleave stays ON so PostHog gets native session-duration + bounce.
		capture_pageview: false,
		capture_pageleave: true,
		disable_session_recording: true,
		capture_exceptions: true,
		// web_vitals only — network_timing is a session-replay companion (works WITH replay
		// to correlate slow requests to a recording), useless while disable_session_recording stays
		// true above, and pure overhead if it were ever turned on.
		capture_performance: { web_vitals: true },
		// No browser code reads a flag: every flag is evaluated on the server, locally. Without
		// this, each page load makes a billed /flags request whose answer nobody reads.
		advanced_disable_feature_flags: true,
		before_send: (event) => (!event || isBrowserNoise(event) ? null : scrubRouteIds(event))
	});
	initialized = true;
}

// Moving the project to another region comes with a new project token, and posthog-js keys
// its storage by token (`ph_<token>_posthog`, a cookie and a localStorage entry), so every returning
// visitor would arrive as someone new. While PUBLIC_POSTHOG_LEGACY_KEY names the old token, a browser
// with nothing stored under the new token starts from the distinct_id it had under the old one. Only
// then: posthog-js applies a bootstrap id on every load, so once the new token has storage of its own
// it is left alone. Unset, or equal to the current token, it does nothing. Remove it with the legacy key.
export type PersistenceStore = { cookie: string; getItem(name: string): string | null };

/** posthog-js's storage name for a token (posthog-persistence.js parseName). */
function persistenceName(token: string): string {
	return `ph_${token.replace(/\+/g, 'PL').replace(/\//g, 'SL').replace(/=/g, 'EQ')}_posthog`;
}

function cookieValue(cookie: string, name: string): string | null {
	for (const part of cookie.split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

function parsedDistinctId(raw: string | null, decode: boolean): string | undefined {
	if (!raw) return undefined;
	try {
		const value: unknown = JSON.parse(decode ? decodeURIComponent(raw) : raw);
		const id = value && typeof value === 'object' ? Reflect.get(value, 'distinct_id') : undefined;
		return typeof id === 'string' && id !== '' && !id.startsWith('$') ? id : undefined;
	} catch {
		return undefined;
	}
}

function storedDistinctId(token: string, store: PersistenceStore): string | undefined {
	const name = persistenceName(token);
	return (
		parsedDistinctId(cookieValue(store.cookie, name), true) ??
		parsedDistinctId(store.getItem(name), false)
	);
}

export function legacyDistinctId(
	key: string,
	legacyKey: string | undefined,
	store: PersistenceStore
): string | undefined {
	const legacy = legacyKey?.trim();
	if (!legacy || legacy === key) return undefined;
	if (storedDistinctId(key, store)) return undefined;
	return storedDistinctId(legacy, store);
}

function browserStore(): PersistenceStore {
	return {
		cookie: globalThis.document?.cookie ?? '',
		getItem: (name) => {
			try {
				return globalThis.localStorage?.getItem(name) ?? null;
			} catch {
				return null; // storage blocked
			}
		}
	};
}

// Chrome raises "ResizeObserver loop completed with undelivered notifications" (older
// builds: "ResizeObserver loop limit exceeded") when an observer's callback changes layout within
// the same frame. It reports no fault and carries no stack, so it is dropped here and never
// sent. An exception is dropped only when every entry in it is this warning, so a real error that
// arrives alongside one is still sent.
const BROWSER_NOISE = /^ResizeObserver loop /;

export function isBrowserNoise(event: {
	event?: string;
	properties?: Record<string, unknown>;
}): boolean {
	if (event.event !== '$exception') return false;
	const list = event.properties?.$exception_list;
	if (!Array.isArray(list) || list.length === 0) return false;
	return list.every(
		(entry) => typeof entry?.value === 'string' && BROWSER_NOISE.test(entry.value as string)
	);
}

// PostHog keeps events for years and can't be told to shorten that, while "Forget
// everything" deletes the conversation itself. So no event may carry a conversation id: every
// URL-shaped property ($current_url, $pathname, $referrer, $prev_pageview_*, $initial_* in
// $set_once) has the id segment of the routes below replaced with ":id". The pattern matches
// our own route shapes only, never free text. The walk descends into nested objects and arrays,
// because `$web_vitals_*_event` carries its own `$current_url` and `navigationURL` one level down.
// On the chat surface the same routes live at the root (`/conversation/<id>`), and a site
// event's `$referrer` can name one from alpha. So the shape matches either form on BOTH surfaces: the
// `/chat`-prefixed one anywhere, as before, and the root one only where a URL's path begins — the
// whole string (a `$pathname`) or straight after `//host` — never mid-path or in free text.
const ROUTE_ID =
	/((?:\/chat|^|\/\/[^/?#\s]+)\/(?:conversation|admin\/reports|workspace\/accept)\/)[^/?#\s]+/g;

function scrubValue(value: unknown): unknown {
	if (typeof value === 'string') return value.replace(ROUTE_ID, '$1:id');
	if (Array.isArray(value)) return value.map(scrubValue);
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return scrubBag(value as Record<string, unknown>);
	}
	return value;
}

function scrubBag<T extends Record<string, unknown> | undefined>(bag: T): T {
	if (!bag) return bag;
	return Object.fromEntries(
		Object.entries(bag).map(([key, value]) => [key, scrubValue(value)])
	) as T;
}

export function scrubRouteIds<
	E extends {
		properties?: Record<string, unknown>;
		$set?: Record<string, unknown>;
		$set_once?: Record<string, unknown>;
	}
>(event: E): E {
	return {
		...event,
		properties: scrubBag(event.properties),
		$set: scrubBag(event.$set),
		$set_once: scrubBag(event.$set_once)
	};
}

// Dogfood/dev-traffic marker — a super-property (posthog.register persists it in this browser's
// localStorage), stamped onto every event from here forward. Deliberately NOT retroactive: an
// event already sent before this ran keeps no such property, so visiting ?ph_test=1 later can't
// reclassify earlier "real" testing as internal (or vice versa) — unlike PostHog's own
// person-property/cohort filtering, which re-evaluates against the person's CURRENT properties at
// query time and would relabel a browser's entire history. No dev/prod split exists here (single
// deployed environment) — localhost is the only automatic signal; ?ph_test=1 is the manual opt-in
// for dogfooding the real prod URL.
// Pure decision (extracted for unit coverage, like detectSource — the rest of markInternalIfNeeded is
// thin posthog delegation): given the browser's hostname + query string, which super-properties mark
// this as internal/tester traffic, or null if it's not internal.
// ?ph_test=1 → internal marker only. ?ph_test=<label> → ALSO tag this browser with that label, so two
// internal browsers can be told apart in event attribution. Registered as a PostHog super-property,
// which is client-side and per-browser.
//
// It is a LABEL and nothing more. Server-side feature-flag targeting does not read it, because a
// string the visitor types is not an identity; see the note in chat/server/flags.ts.
export function internalTrafficProps(
	hostname: string,
	search: string
): Record<string, unknown> | null {
	const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);
	const phTest = new URLSearchParams(search).get('ph_test');
	if (!isLocalhost && !phTest) return null;
	const props: Record<string, unknown> = { is_internal_test: true };
	if (phTest && phTest !== '1') props.tester = phTest;
	return props;
}

export function markInternalIfNeeded() {
	if (!browser || !initialized) return;
	const props = internalTrafficProps(window.location.hostname, window.location.search);
	if (props) posthog.register(props);
}

// PostHog's native $pageview (powers Web Analytics, Paths, bounce). posthog-js auto-enriches every
// event with $current_url, $pathname, $referrer, and $utm_*, and fires the matching $pageleave
// itself (capture_pageleave). So this is all the site does per navigation.
export function capturePageview() {
	if (!browser || !initialized) return;
	posthog.capture('$pageview');
}

// `source` (qr_code / link / direct / from_chat) is an ARRIVAL attribute, not a per-page one — so
// register it once per session as a session-scoped super-property (posthog then stamps it on every
// event incl. $pageview/$pageleave). The sessionStorage guard makes it first-touch: a mid-session
// refresh of an internal page can't overwrite how the visitor originally arrived.
export function registerArrivalSource(url: URL) {
	if (!browser || !initialized) return;
	if (sessionStorage.getItem('ph:arrivalSource')) return;
	sessionStorage.setItem('ph:arrivalSource', '1');
	posthog.register_for_session({ source: detectSource(url) });
}

export function trackEvent(name: SiteEvent | (string & {}), properties?: Record<string, unknown>) {
	if (!browser || !initialized) return;
	posthog.capture(name, properties);
}

// `source` for $pageview — the arrival classification PostHog can't derive (spec vocabulary:
// qr_code / link / direct / from_chat). Printed-QR and event links should carry ?source=qr_code
// (or ?ref=…) so QR arrivals are attributable; otherwise it's derived from the referrer. (Raw UTM
// params are NOT re-emitted — posthog-js already captures $utm_* natively on every event.)
// Exported for unit tests.
export function detectSource(url: URL): string {
	const p = url.searchParams;
	const explicit = p.get('source') ?? p.get('ref');
	if (explicit) return explicit;
	const um = (p.get('utm_medium') ?? '').toLowerCase();
	const us = (p.get('utm_source') ?? '').toLowerCase();
	if (um.includes('qr') || us.includes('qr')) return 'qr_code';
	if (browser && document.referrer) {
		try {
			const ref = new URL(document.referrer);
			if (ref.origin === window.location.origin) {
				return isChatRoute(ref.pathname) ? 'from_chat' : 'link';
			}
			return 'link';
		} catch {
			/* malformed referrer → fall through to direct */
		}
	}
	return 'direct';
}

// Maps a nav/CTA href to its spec click_to_* event. Centralised so a NEW link (e.g. a future
// /partners CTA) auto-instruments the moment it appears — no per-component wiring. Returns null
// for hrefs that aren't a tracked destination. Matches both real paths ('/chat') and the CMS
// `destination` keys some markdoc buttons resolve from ('chat', 'map', …).
export function hrefToClickEvent(href: string | undefined | null): SiteEvent | null {
	if (!href) return null;
	const h = href.toLowerCase();
	if (h.includes('/chat') || h === 'chat' || (CHAT_HOST !== null && h.includes(CHAT_HOST)))
		return 'click_to_chat';
	if (h.includes('/map') || h === 'map') return 'click_to_map';
	if (h.includes('/contribute') || h === 'contribute') return 'click_to_contribute';
	if (h.includes('/about') || h === 'about') return 'click_to_about';
	if (h.includes('/partners') || h === 'partners') return 'click_to_partners';
	return null;
}

export function trackNavClick(
	href: string | undefined | null,
	trigger: 'cta' | 'nav' | 'partner_card'
) {
	const name = hrefToClickEvent(href);
	if (name) trackEvent(name, { trigger });
}
