import { sequence } from '@sveltejs/kit/hooks';
import { handleLocale } from '$lib/i18n/server';
import { localizedHref, unlocalizedPath } from '$lib/i18n/routing';
import { building, dev } from '$app/environment';
import {
	redirect,
	type Handle,
	type HandleServerError,
	type ServerInit,
	type HandleFetch,
	type Cookies
} from '@sveltejs/kit';
import { entityBases } from '$lib/website';
import { cmsRedirect, gapMapAliasTarget, startCms } from '$lib/website.server';
import {
	CHAT_ALIAS_HOSTS,
	CHAT_ALIAS_PATHS,
	CHAT_HOST,
	GUEST_HANDOFF_PATH,
	chatHome,
	chatSurfaceRedirect,
	chatSurfaceSiteRedirect
} from '$lib/chat/paths';
import { isPageLoad, wwwChatRedirect } from '$lib/chat/wwwChatRedirect';
import { APP_SURFACE, CHAT_ROUTE_ROOT, chatRoutePath, isChatRoute } from '$lib/surface';
import { expiredPreviewMessage } from '$lib/server/expiredPreview';
import { CSP_REPORT_GROUP, cspReportEndpoint } from '$lib/cspReportEndpoint';
import { cdnCacheFor } from '$lib/cache/cdn';
import { expireLegacySessionCookies } from '$lib/chat/server/legacySessionCookie';

// How long the module graph took to load before hooks evaluated, since `performance.now()` counts from
// process start (CUR-2371). Each stage logs once per instance, as a
// `leg: 'boot'` line, through chat's logger (already loaded by the time any stage ends).
const hooksLoadedMs = Math.round(performance.now());
let chatPipelineTimed = false;

async function logBootStage(stage: string, startMs: number, extra: Record<string, number> = {}) {
	const ms = Math.round(performance.now() - startMs);
	try {
		const { logger } = await import('$lib/chat/server/logger');
		logger.info({ leg: 'boot', stage, ms, ...extra }, '[boot] stage timing');
	} catch {
		// Timing is diagnostic; a logger that failed to load must not fail the request.
	}
}

// A request belongs to chat: the /chat root or anything under /chat/. On the chat surface (CUR-4448)
// that is every path `reroute` maps into the /chat route tree, so it reads the mapped path.
const isChatPath = (pathname: string | undefined) => isChatRoute(pathname);

// Retired chat entry paths (CUR-2195): each 308s to /chat before the CMS or the catch-all sees it.
const isChatAliasRoot = (pathname: string) =>
	(CHAT_ALIAS_PATHS as readonly string[]).includes(pathname);

// /map/product/* and /map/org/* were retired when those routes moved to /product/* and /org/*
// (top-level). Every request under the old prefixes must 308 to the new one in a single hop —
// through the rename map first, if the slug was also renamed — rather than redirecting within the
// old prefix and relying on a second hop to reach the new one. The rename map lives in the gap map
// database, so the resolver is imported only for these two prefixes and chat requests never load
// gap map code. A failed lookup falls back to the unrenamed slug: the new route resolves the alias
// itself, so the worst case is a second hop, not a broken link.
const LEGACY_PREFIXES: [string, 'product' | 'org', string | undefined][] = [
	['/map/product/', 'product', entityBases?.product],
	['/map/org/', 'org', entityBases?.org]
];

async function aliasTarget(pathname: string): Promise<string | null> {
	for (const [oldPrefix, kind, newBase] of LEGACY_PREFIXES) {
		// No gap map in this build: nothing to redirect to.
		if (!newBase || !pathname.startsWith(oldPrefix)) continue;
		const slug = pathname.slice(oldPrefix.length);
		let renamed: string | undefined;
		try {
			renamed = await gapMapAliasTarget(kind, slug);
		} catch (err) {
			console.error('[alias-redirect] lookup failed:', err);
		}
		return `${newBase}/${renamed ?? slug}`;
	}
	return null;
}

// Chat's paths are code-owned, so a CMS redirect entry never applies to them (CUR-2195).
const shouldCheckCmsRedirects = (pathname: string, method: string) =>
	(method === 'GET' || method === 'HEAD') && !isChatPath(pathname) && !pathname.startsWith('/api/');

/** Payload-managed redirects — cached list, pathname lookup, fail-open on fetch errors. */
async function cmsRedirectTarget(
	pathname: string
): Promise<{ location: string; status: 301 | 302 } | null> {
	try {
		const match = await cmsRedirect(fetch, pathname);
		if (!match || match.location === pathname) return null;
		return match;
	} catch (err) {
		console.error('[cms-redirect] lookup failed:', err);
		return null;
	}
}

// ── Accept: text/markdown content negotiation (CUR-682, acceptmarkdown.com) ───────────────────
//
// Adapted from acceptmarkdown.com's own SvelteKit recipe (RFC 9110 Accept parsing with q-values,
// RFC 7763 text/markdown, RFC 8288 Link headers) — that site exists specifically to be copied, so
// this ports its parseAccept/preferredType/appendVaryAccept near-verbatim rather than
// reimplementing q-value precedence from scratch.
//
// Deliberately narrow: negotiation only runs for the exact chat root (`/chat`, or `/` on the chat
// surface), the one page with
// a real Markdown sibling today (static/llms.txt). Every other /chat/* path — including the large
// /chat/api/* and /chat/admin/* surfaces, which send their own Accept headers for real reasons —
// is untouched by the 406/markdown branches below. The one thing applied everywhere under /chat is
// Vary: Accept on the root response and a short Markdown 404 (CUR-681) when the caller's own
// Accept explicitly prefers Markdown over HTML — never on any other Accept value, so a JSON API
// client hitting a genuine 404 sees no change.
type AcceptEntry = { type: string; q: number; specificity: number };

function parseAccept(header: string): AcceptEntry[] {
	return header
		.split(',')
		.map((raw) => {
			const parts = raw
				.trim()
				.split(';')
				.map((s) => s.trim());
			const type = (parts[0] ?? '').toLowerCase();
			if (!type) return null;
			let q = 1;
			for (const param of parts.slice(1)) {
				const [name, value] = param.split('=').map((s) => s.trim());
				if (name === 'q') {
					const parsed = Number(value);
					if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed));
				}
			}
			const specificity = type === '*/*' ? 0 : type.endsWith('/*') ? 1 : 2;
			return { type, q, specificity };
		})
		.filter((e): e is AcceptEntry => e !== null);
}

function acceptEntryMatches(entry: AcceptEntry, candidate: string): boolean {
	if (entry.type === '*/*') return true;
	if (entry.type.endsWith('/*')) return candidate.startsWith(entry.type.slice(0, -1));
	return entry.type === candidate;
}

/** The best of `produces` (in preference order) the client's Accept header actually accepts, by
 *  q-value then specificity then `produces` order. Null only when Accept names none of them. */
function preferredType(header: string | null, produces: string[]): string | null {
	if (!header) return produces[0] ?? null;
	const entries = parseAccept(header);
	if (entries.length === 0) return produces[0] ?? null;

	let bestType: string | null = null;
	let bestQ = -1;
	let bestPos = Infinity;
	for (const candidate of produces) {
		let matched: AcceptEntry | null = null;
		let matchedPos = Infinity;
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			if (!acceptEntryMatches(e, candidate)) continue;
			if (
				matched === null ||
				e.specificity > matched.specificity ||
				(e.specificity === matched.specificity && i < matchedPos)
			) {
				matched = e;
				matchedPos = i;
			}
		}
		if (!matched || matched.q <= 0) continue;
		if (matched.q > bestQ || (matched.q === bestQ && matchedPos < bestPos)) {
			bestQ = matched.q;
			bestPos = matchedPos;
			bestType = candidate;
		}
	}
	return bestType;
}

function appendVaryAccept(headers: Headers): void {
	const existing = headers.get('vary');
	if (!existing) {
		headers.set('Vary', 'Accept');
		return;
	}
	const tokens = existing.split(',').map((s) => s.trim().toLowerCase());
	if (!tokens.includes('accept')) headers.set('Vary', `${existing}, Accept`);
}

const CHAT_MARKDOWN_TYPES = ['text/html', 'text/markdown'];

async function negotiateChatMarkdown(input: Parameters<Handle>[0]): Promise<Response> {
	const { event } = input;
	const routePath = chatRoutePath(event.url.pathname);
	const isChatRoot = routePath === CHAT_ROUTE_ROOT || routePath === `${CHAT_ROUTE_ROOT}/`;
	const accept = event.request.headers.get('accept');
	const chosen = preferredType(accept, CHAT_MARKDOWN_TYPES);

	if (isChatRoot && chosen === null && accept) {
		const res = new Response('Not Acceptable\n\nAvailable: text/html, text/markdown\n', {
			status: 406,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
		appendVaryAccept(res.headers);
		return withResponseHeaders(res);
	}

	if (isChatRoot && chosen === 'text/markdown') {
		// llms.txt is a site-root static file, NOT under the chat `/chat` base (paths.ts): /llms.txt
		// answers 200 and /chat/llms.txt 404s.
		const llms = await event.fetch('/llms.txt');
		if (llms.ok) {
			const res = new Response(await llms.text(), {
				headers: { 'content-type': 'text/markdown; charset=utf-8' }
			});
			appendVaryAccept(res.headers);
			return withResponseHeaders(res);
		}
		// llms.txt itself failed to serve — fall through to the normal HTML page below.
	}

	const importStart = performance.now();
	const { handleRequest } = await import('$lib/chat/server/hooks/handle');
	if (!chatPipelineTimed) {
		chatPipelineTimed = true;
		void logBootStage('chat-pipeline-import', importStart);
	}
	const response = withResponseHeaders(await handleRequest(input));

	if (isChatRoot) {
		appendVaryAccept(response.headers);
		if (response.headers.get('content-type')?.includes('text/html')) {
			const link = '</llms.txt>; rel="alternate"; type="text/markdown"';
			const existingLink = response.headers.get('link');
			response.headers.set('link', existingLink ? `${existingLink}, ${link}` : link);
		}
	}

	if (response.status === 404 && chosen === 'text/markdown') {
		const res = new Response(
			'# Not found\n\n' +
				'This page does not exist.\n\n' +
				`- [Chat home](${chatHome})\n` +
				'- [llms.txt](/llms.txt) — what this app is and how to use it\n',
			{ status: 404, headers: { 'content-type': 'text/markdown; charset=utf-8' } }
		);
		appendVaryAccept(res.headers);
		return withResponseHeaders(res);
	}

	return response;
}

// robots.txt is static and allow-all, so it ships identically to every preview deployment — this
// header is the only thing that keeps a preview URL out of the index. Reads VERCEL_ENV directly
// rather than the app's own deployEnv() (CUR-208): this is a fact about which Vercel environment
// served the request, not one of our PostHog-scoped env conditions, and deployEnv() would pull
// chat's config/logger module chain into every map-only request just to decide a header.
//
// Every response also gets nosniff and an explicit Referrer-Policy, which only a few
// endpoints set before. An endpoint's own value wins, so fetch-url keeps its stricter no-referrer. (CUR-3514)
const BASELINE_SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// The CSP's report-to directive (svelte.config.js) names a Reporting API group, and the
// browser looks the group up in this header. Same env, same URL as the policy's report-uri. (CUR-3188)
const cspReportUrl = cspReportEndpoint(process.env);
if (cspReportUrl) {
	BASELINE_SECURITY_HEADERS['Reporting-Endpoints'] = `${CSP_REPORT_GROUP}="${cspReportUrl}"`;
}

function withResponseHeaders(response: Response): Response {
	try {
		for (const [name, value] of Object.entries(BASELINE_SECURITY_HEADERS)) {
			if (!response.headers.has(name)) response.headers.set(name, value);
		}
		if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
			response.headers.set('X-Robots-Tag', 'noindex');
		}
	} catch {
		// A Response passed straight through from fetch() has immutable headers; serving it without
		// these beats failing the request.
	}
	return response;
}

// Cold-instance TTFT: warm the lazy Postgres pool the moment the server bundle loads, so the first
// request's first query doesn't pay the Neon pooler connect on its critical path. Module scope runs
// once per instance at bundle load — the same cold-start window we want to overlap. The `!building`
// guard keeps it out of the prerender/build pass; the guard lives HERE (not in db/client.ts) because
// `$app/environment` must not enter db/client.ts — the plain-tsx verify scripts import that module
// directly. Dynamic-imported (like the rest of chat's server code) so a map-only request
// never pulls postgres.js; non-blocking + non-throwing; `PG_PRECONNECT=off` disables it. See
// docs/plans/ttft-critical-path.md §B.
if (!building) {
	void import('$lib/chat/server/db/client')
		.then(({ preconnectDb }) => preconnectDb())
		.catch(() => {});
}

// Resolves the map, explorer, and claims API — everything outside /chat.
const handleSite: Handle = async ({ event, resolve }) => resolve(event);

export const init: ServerInit = async () => {
	if (building) return;
	const initStart = performance.now();

	// A dropped CMS doc goes to pino so it reaches the aipotluck dataset, where its production
	// alert reads it; the Payload client cannot import the logger itself because it also runs in
	// the browser.
	try {
		const { logger } = await import('$lib/chat/server/logger');
		await startCms((detail, message) => logger.error(detail, message));
	} catch (err) {
		console.error(
			'[cms] failed to start the CMS client (dropped-doc sink, invalidation poller):',
			err
		);
	}

	// Chat's server boot: fail fast on misconfigured env in production (so a bad deploy
	// rolls back), but in local dev degrade gracefully — the map/explorer must boot even
	// without chat secrets. Chat code is dynamically imported so its import-time side
	// effects (config load, model fetch) don't run unless we actually init it.
	try {
		const { validateEnv } = await import('$lib/chat/server/env/validate');
		const { initServer } = await import('$lib/chat/server/hooks/init');
		validateEnv();
		await initServer();
		void logBootStage('init', initStart, {
			hooksLoadedMs,
			initStartMs: Math.round(initStart)
		});
		// Loading chat's request handler takes about 2s on the first /chat request of a cold instance,
		// often long after init has finished (CUR-2371). Start it here, unawaited: a /chat request
		// awaits the same in-flight module in negotiateChatMarkdown, and a map request never waits on it.
		void import('$lib/chat/server/hooks/handle').catch(() => {});
	} catch (err) {
		if (dev) {
			console.warn(
				'[init] chat server not initialized in dev — /chat routes will be degraded:',
				err instanceof Error ? err.message : err
			);
			return;
		}
		throw err;
	}
};

// A guest moving to the chat host from www or chat. carries their session with them; the
// module loads only when there is a guest cookie to carry. (CUR-4439)
async function guestHandoff(
	cookies: Cookies | undefined,
	target: string
): Promise<Response | null> {
	if (!cookies || cookies.getAll().length === 0) return null;
	const { guestHandoffPage } = await import('$lib/chat/server/guestHandoff');
	return guestHandoffPage(cookies, new URL(target));
}

// Whether this answer is a 308 or the handoff page depends on the request's fetch metadata
// and cookies, so no cache may store it and replay it to a request that should get the other one. (CUR-4439)
function movedToChatHost(target: string): Response {
	return new Response(null, {
		status: 308,
		headers: {
			location: target,
			'cache-control': 'private, no-store',
			vary: 'Sec-Fetch-Mode, Sec-Fetch-Dest, Accept, Cookie'
		}
	});
}

export const handleApplication: Handle = async (input) => {
	if (building) {
		// During prerender/build, neutralize chat's %gaId% placeholder (no-op on map pages).
		return input.resolve(input.event, {
			transformPageChunk: ({ html }) => html.replace('%gaId%', '')
		});
	}
	// Clear production's old apex-wide session cookies wherever a browser still sends them. (CUR-4442)
	expireLegacySessionCookies(input.event.cookies, process.env);
	const { hostname, search } = input.event.url;
	const pathname = unlocalizedPath(input.event.url.pathname);

	// Chat's hosts (CUR-1067): an alias host sends every path to the same place on the chat host, and
	// the chat host's bare root opens chat. No other host is affected.
	const method = input.event.request?.method ?? 'GET';
	const headers = input.event.request?.headers ?? new Headers();

	// The chat host takes a guest's session handed over from www or chat. (guestHandoff.ts). (CUR-4439)
	if (hostname === CHAT_HOST && pathname === GUEST_HANDOFF_PATH && method === 'POST') {
		const { acceptGuestHandoff } = await import('$lib/chat/server/guestHandoff');
		const { next, outcome } = await acceptGuestHandoff(input.event.request, input.event.cookies);
		const { logger } = await import('$lib/chat/server/logger');
		logger.info({ outcome }, '[guest-handoff] chat host');
		throw redirect(303, next);
	}

	if ((CHAT_ALIAS_HOSTS as readonly string[]).includes(hostname)) {
		const target = `https://${CHAT_HOST}${pathname}${search}`;
		if (method === 'GET' && isPageLoad(method, headers)) {
			const handoff = await guestHandoff(input.event.cookies, target);
			if (handoff) return handoff;
		}
		return movedToChatHost(target);
	}
	// On the chat surface the root IS chat, so only the site surface sends it on (CUR-4448).
	if (APP_SURFACE === 'site' && hostname === CHAT_HOST && pathname === '/') {
		throw redirect(308, `${chatHome}${search}`);
	}
	// On the chat surface, an old `/chat/...` address moves to the same path at the root.
	// Reserved paths (CHAT_RESERVED_PATHS) are served in place, and only a GET or HEAD moves. (CUR-4448)
	const atRoot = chatSurfaceRedirect(pathname, method);
	if (atRoot !== null) throw redirect(308, `${atRoot}${search}`);
	// On the chat surface, a site page (`/map`, a CMS slug) matches no chat route after
	// `reroute`, so it moves to the same path on the site's host instead of 404ing here. (CUR-4448)
	const toSite = chatSurfaceSiteRedirect({
		pathname,
		search,
		method,
		routeId: input.event.route?.id ?? null,
		vercelEnv: process.env.VERCEL_ENV
	});
	if (toSite !== null) throw redirect(308, toSite);
	// A page load of www's /chat moves to the chat host; API calls keep answering on www. (CUR-4439)
	const chatHostTarget = wwwChatRedirect(input.event.url, method, headers, pathname);
	if (chatHostTarget) {
		const handoff =
			method === 'GET' ? await guestHandoff(input.event.cookies, chatHostTarget) : null;
		if (handoff) return handoff;
		return movedToChatHost(chatHostTarget);
	}

	if (isChatAliasRoot(pathname)) {
		throw redirect(308, `${chatHome}${input.event.url.search}`);
	}

	if (isChatPath(pathname)) {
		// Chat's full request pipeline (auth, CSRF, CSP) — loaded on demand, wrapped by the
		// Accept: text/markdown negotiation above (CUR-681/CUR-682).
		return negotiateChatMarkdown(input);
	}

	if (shouldCheckCmsRedirects(pathname, input.event.request?.method ?? 'GET')) {
		const cmsTarget = await cmsRedirectTarget(pathname);
		if (cmsTarget)
			throw redirect(
				cmsTarget.status,
				localizedHref(cmsTarget.location, input.event.locals?.locale)
			);
	}

	const target = await aliasTarget(pathname);
	if (target) throw redirect(308, localizedHref(target, input.event.locals?.locale));

	const response = await handleSite(input);
	return withResponseHeaders(cdnCacheFor(response, input.event));
};

export const handle: Handle = sequence(handleLocale, handleApplication);

export const handleError: HandleServerError = async (input) => {
	if (building) throw input.error;
	if (isChatPath(input.event?.url?.pathname)) {
		const { handleServerError } = await import('$lib/chat/server/hooks/error');
		const result = await handleServerError(input);
		const expired = expiredPreviewMessage(input.error, process.env);
		return expired ? { ...result, message: expired } : result;
	}
	// A 404 is not an application fault, and reporting it as one makes unroutable-path traffic the
	// loudest thing in error tracking: every miss shares one fingerprint, so
	// the weekly digest headlines whichever path arrived first ("Not found: /wp-admin/install.php")
	// while every other miss hides inside that single row and real bugs sit underneath it.
	// It would also feed the rate counter behind the warm error alert: errorTracking.ts increments
	// BEFORE the client check, so scanner traffic would count toward a signal meant to catch faults.
	//
	// Keyed on STATUS, not on `route.id === null`. `[...slug]` is `prerender = true`, so whether a
	// miss arrives as an unmatched route or as a load-time error(404) depends on what got prerendered
	// at build — the status is 404 under both, the route id is not. The request log still records
	// every 404 with its path, so "is anyone still hitting /app?" stays answerable without an
	// exception report. The chat half skips these too (chat/server/hooks/error.ts returns early when
	// no route matched).
	//
	// EXEMPT: /product/* and /org/* (the live entity routes — /map/product/* and /map/org/* now 308
	// away before ever reaching here). The indexed surface on those two prefixes is about 740 URLs,
	// so a mass retirement there — an alias missing its redirect, a slug renamed without
	// one — is a signal worth keeping, not scanner noise that reads identically to
	// /wp-admin/install.php.
	const ENTITY_PREFIXES = entityBases ? [`${entityBases.product}/`, `${entityBases.org}/`] : [];
	const isEntityPath = ENTITY_PREFIXES.some((prefix) =>
		input.event?.url?.pathname?.startsWith(prefix)
	);
	if (input.status === 404 && !isEntityPath) {
		return { message: input.message ?? 'Not Found' };
	}

	// The SITE half (map, marketing pages) errors here. Reported through the same path as chat's —
	// otherwise "we have error tracking" would silently mean "on /chat only", which is the kind of
	// half-coverage that reads as covered.
	const { captureServerException } = await import('$lib/chat/server/errorTracking');
	await captureServerException(input.error, {
		url: input.event?.url?.href,
		routeId: input.event?.route?.id,
		status: input.status,
		method: input.event?.request?.method
	});
	return {
		message:
			expiredPreviewMessage(input.error, process.env) ??
			input.message ??
			(input.status === 404 ? 'Not Found' : 'Internal Error')
	};
};

export const handleFetch: HandleFetch = async (input) => {
	if (building) return input.fetch(input.request);
	if (isChatPath(input.event?.url?.pathname)) {
		const { handleFetchRequest } = await import('$lib/chat/server/hooks/fetch');
		return handleFetchRequest(input);
	}
	return input.fetch(input.request);
};
