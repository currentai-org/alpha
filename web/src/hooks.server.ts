import { sequence } from '@sveltejs/kit/hooks';
import { handleLocale } from '$lib/i18n/server';
import { localizedHref, unlocalizedPath } from '$lib/i18n/routing';
import { building, dev } from '$app/env';
import { redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit, HandleFetch } from '@sveltejs/kit/hooks';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { entityBases } from '$lib/website';
import {
	checkSiteOnlyEnv,
	cmsRedirect,
	gapMapAliasTarget,
	siteOnlyChatTarget,
	startCms
} from '$lib/website.server';
import { APP_SURFACE, CHAT_ROUTE_ROOT, chatRoutePath, isChatRoute } from '$lib/surface';
import { expiredPreviewMessage } from '$lib/server/expiredPreview';
import { deployEnvName } from '$lib/server/runtimeEnv';
import { CSP_REPORT_GROUP, cspReportEndpoint } from '$lib/cspReportEndpoint';
import { cdnCacheFor } from '$lib/cache/cdn';
import { addVaryAccept, negotiateType } from '$lib/acceptNegotiation';
import vercelConfig from '../vercel.json';

// ── Chat's modules, through a seam ───────────────────────────────────────────────────────────────
//
// Chat leaves this repo for the public alpha repo, and the site must build from a tree without chat's
// files. So this shell names no chat module in an import: it loads each through
// `import.meta.glob`, which Vite resolves at build time to an empty object when the file is absent,
// the way the $lib/website* seams load the site. With chat's files present nothing changes: the eager
// globs are the static imports they replace and the lazy ones the dynamic imports. Without them, every
// chat-only branch below is skipped, and the site-only path runs on the site's own code
// ($lib/website/siteOnly.ts, through the website.server seam), with the console as its logger and
// error report. config/product-boundary.mjs lists each glob under SEAM_LOADS_OF_CHAT.
//
// The types are written out here, since even a type import would name chat's module.
const only = <T>(found: Record<string, T>): T | undefined => Object.values(found)[0];
async function loadChat<T>(found: Record<string, () => Promise<T>>): Promise<T | undefined> {
	const loader = only(found);
	return loader ? loader() : undefined;
}

type ChatLogFn = (detail: Record<string, unknown>, message?: string) => void;
type ChatLogger = { info: ChatLogFn; warn: ChatLogFn; error: ChatLogFn };

const chatPaths = only(
	import.meta.glob<{
		CHAT_ALIAS_HOSTS: readonly string[];
		CHAT_ALIAS_PATHS: readonly string[];
		CHAT_HOST: string | null;
		GUEST_HANDOFF_PATH: string;
		chatHome: string;
		chatSurfaceRedirect(pathname: string, method: string): string | null;
		chatSurfaceSiteRedirect(req: {
			pathname: string;
			search: string;
			method: string;
			routeId: string | null;
			vercelEnv: string | undefined;
		}): string | null;
	}>('/src/lib/chat/paths.ts', { eager: true })
);
const chatWwwRedirect = only(
	import.meta.glob<{
		isPageLoad(method: string, headers: Pick<Headers, 'get'>): boolean;
		wwwChatRedirect(
			url: URL,
			method: string,
			headers: Pick<Headers, 'get'>,
			pathname: string
		): string | null;
	}>('/src/lib/chat/wwwChatRedirect.ts', { eager: true })
);
const chatLegacyCookie = only(
	import.meta.glob<{
		expireLegacySessionCookies(cookies: Cookies | undefined, env: typeof process.env): void;
	}>('/src/lib/chat/server/legacySessionCookie.ts', { eager: true })
);
const chatLogger = import.meta.glob<{ logger: ChatLogger }>('/src/lib/chat/server/logger.ts');
const chatFlags = import.meta.glob<{
	flagEnabledOr(key: string, fallback: () => boolean): boolean;
}>('/src/lib/chat/server/flags.ts');
const chatCmsPublish = import.meta.glob<{ cmsPublished(body: unknown): Promise<void> }>(
	'/src/lib/chat/server/cmsPublish.ts'
);
const chatDbClient = import.meta.glob<{ preconnectDb(): unknown }>(
	'/src/lib/chat/server/db/client.ts'
);
const chatEnvValidate = import.meta.glob<{ validateEnv(): void }>(
	'/src/lib/chat/server/env/validate.ts'
);
const chatInit = import.meta.glob<{ initServer(): Promise<void> }>(
	'/src/lib/chat/server/hooks/init.ts'
);
const chatHandle = import.meta.glob<{
	handleRequest(input: Parameters<Handle>[0]): Promise<Response>;
}>('/src/lib/chat/server/hooks/handle.ts');
const chatError = import.meta.glob<{
	handleServerError(input: CaughtServerError): Promise<App.Error & Record<string, unknown>>;
}>('/src/lib/chat/server/hooks/error.ts');
const chatFetch = import.meta.glob<{
	handleFetchRequest(input: Parameters<HandleFetch>[0]): Promise<Response>;
}>('/src/lib/chat/server/hooks/fetch.ts');
const chatErrorTracking = import.meta.glob<{
	captureServerException(
		error: unknown,
		context: { url?: string; routeId?: string | null; status?: number; method?: string }
	): Promise<void>;
}>('/src/lib/chat/server/errorTracking.ts');
const chatGuestHandoff = import.meta.glob<{
	acceptGuestHandoff(
		request: Request,
		cookies: Cookies
	): Promise<{ next: string; outcome: string }>;
}>('/src/lib/chat/server/guestHandoff.ts');
const chatGuestHandoffPage = import.meta.glob<{
	guestHandoffPage(cookies: Cookies, target: URL): Response | null;
}>('/src/lib/chat/server/guestHandoffPage.ts');

// How long the module graph took to load before hooks evaluated, since `performance.now()` counts from
// process start. Each stage logs once per instance, as a
// `leg: 'boot'` line, through chat's logger (already loaded by the time any stage ends).
const hooksLoadedMs = Math.round(performance.now());
let chatPipelineTimed = false;

async function logBootStage(stage: string, startMs: number, extra: Record<string, number> = {}) {
	const ms = Math.round(performance.now() - startMs);
	try {
		const chat = await loadChat(chatLogger);
		chat?.logger.info({ leg: 'boot', stage, ms, ...extra }, '[boot] stage timing');
	} catch {
		// Timing is diagnostic; a logger that failed to load must not fail the request.
	}
}

// A site-only build (www once chat lives on alpha) serves none of chat: its addresses 308 to
// the chat host before anything below runs, and chat's server init, request chain and DB pool never load.
const siteOnly = APP_SURFACE === 'site-only';

// The scheduled jobs vercel.json registers. www and the alpha project build from the same web/, so
// both register them; on a site-only www each answers 404 rather than 308, so www's copy of the cron
// does no work and the alpha project's runs once.
const CRON_PATHS: readonly string[] = (vercelConfig.crons ?? []).map((cron) => cron.path);

// A request belongs to chat: the /chat root or anything under /chat/. On the chat surface
// that is every path `reroute` maps into the /chat route tree, so it reads the mapped path.
const isChatPath = (pathname: string | undefined) => isChatRoute(pathname);

// Retired chat entry paths: each 308s to /chat before the CMS or the catch-all sees it.
const isChatAliasRoot = (pathname: string) =>
	chatPaths?.CHAT_ALIAS_PATHS.includes(pathname) ?? false;

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

// Chat's paths are code-owned, so a CMS redirect entry never applies to them.
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

// ── Accept: text/markdown content negotiation ───────────────────────────────────────
//
// Parsing and q-value precedence live in $lib/acceptNegotiation (RFC 9110 Accept, RFC 7763
// text/markdown, RFC 8288 Link headers).
//
// Deliberately narrow: negotiation only runs for the exact chat root (`/chat`, or `/` on the chat
// surface), the one page with
// a real Markdown sibling today (static/llms.txt). Every other /chat/* path — including the large
// /chat/api/* and /chat/admin/* surfaces, which send their own Accept headers for real reasons —
// is untouched by the 406/markdown branches below. The one thing applied everywhere under /chat is
// Vary: Accept on the root response and a short Markdown 404 when the caller's own
// Accept explicitly prefers Markdown over HTML — never on any other Accept value, so a JSON API
// client hitting a genuine 404 sees no change.
const CHAT_MARKDOWN_TYPES = ['text/html', 'text/markdown'];

async function negotiateChatMarkdown(
	input: Parameters<Handle>[0],
	chatHome: string
): Promise<Response> {
	const { event } = input;
	const routePath = chatRoutePath(event.url.pathname);
	const isChatRoot = routePath === CHAT_ROUTE_ROOT || routePath === `${CHAT_ROUTE_ROOT}/`;
	const accept = event.request.headers.get('accept');
	const chosen = negotiateType(accept, CHAT_MARKDOWN_TYPES);

	if (isChatRoot && chosen === null && accept) {
		const res = new Response('Not Acceptable\n\nAvailable: text/html, text/markdown\n', {
			status: 406,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
		addVaryAccept(res.headers);
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
			addVaryAccept(res.headers);
			return withResponseHeaders(res);
		}
		// llms.txt itself failed to serve — fall through to the normal HTML page below.
	}

	const importStart = performance.now();
	const chat = await loadChat(chatHandle);
	if (!chat) throw new Error("chat's request handler is not in this build");
	if (!chatPipelineTimed) {
		chatPipelineTimed = true;
		void logBootStage('chat-pipeline-import', importStart);
	}
	const response = withResponseHeaders(await chat.handleRequest(input));

	if (isChatRoot) {
		addVaryAccept(response.headers);
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
		addVaryAccept(res.headers);
		return withResponseHeaders(res);
	}

	return response;
}

// robots.txt is static and allow-all, so it ships identically to every preview deployment — this
// header is the only thing that keeps a preview URL out of the index. Reads VERCEL_ENV directly
// rather than the app's own deployEnv: this is a fact about which Vercel environment
// served the request, not one of our PostHog-scoped env conditions, and deployEnv() would pull
// chat's config/logger module chain into every map-only request just to decide a header.
//
// Every response also gets nosniff and an explicit Referrer-Policy, which only a few
// endpoints set before. An endpoint's own value wins, so fetch-url keeps its stricter no-referrer.
const BASELINE_SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// The CSP's report-to directive (sveltekit.config.js) names a Reporting API group, and the
// browser looks the group up in this header. Same env, same URL as the policy's report-uri.
const cspReportUrl = cspReportEndpoint(process.env);
if (cspReportUrl) {
	BASELINE_SECURITY_HEADERS['Reporting-Endpoints'] = `${CSP_REPORT_GROUP}="${cspReportUrl}"`;
}

function withResponseHeaders(response: Response): Response {
	try {
		for (const [name, value] of Object.entries(BASELINE_SECURITY_HEADERS)) {
			if (!response.headers.has(name)) response.headers.set(name, value);
		}
		const environment = deployEnvName();
		if (environment && environment !== 'production') {
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
// `$app/env` must not enter db/client.ts — the plain-tsx verify scripts import that module
// directly. Dynamic-imported (like the rest of chat's server code) so a map-only request
// never pulls postgres.js; non-blocking + non-throwing; `PG_PRECONNECT=off` disables it.
if (!building && !siteOnly) {
	void loadChat(chatDbClient)
		.then((chat) => chat?.preconnectDb())
		.catch(() => {});
}

// Resolves the map, explorer, and claims API — everything outside /chat.
const handleSite: Handle = async ({ event, resolve }) => resolve(event);

export const init: ServerInit = async () => {
	if (building) return;
	const initStart = performance.now();

	// A dropped CMS doc goes to pino so it reaches the aipotluck dataset, where its production
	// alert reads it; the Payload client cannot import the logger itself because it also runs in
	// the browser. Site code gets the same logger and chat's flag reader here, so it imports
	// neither from chat (payload/hostServices.ts). Where chat runs in this app, the site's CMS webhook
	// also hands each publish to chat's side of it; a site-only build forwards it to the
	// chat host instead. In a build without chat's files (www's site-only build strips them), startCms
	// builds the site's own logger and flag reader (website/siteHost.ts), so its lines still reach
	// Axiom and its flags still read PostHog.
	try {
		const [chatLog, chatFlagReader] = await Promise.all([
			loadChat(chatLogger),
			loadChat(chatFlags)
		]);
		const logger = chatLog?.logger;
		await startCms(
			(detail, message) =>
				logger ? logger.error(detail, message) : console.error(message, detail),
			{
				...(logger
					? {
							logger: {
								info: (detail, message) => logger.info(detail, message),
								warn: (detail, message) => logger.warn(detail, message),
								error: (detail, message) => logger.error(detail, message)
							}
						}
					: {}),
				...(chatFlagReader ? { flagEnabledOr: chatFlagReader.flagEnabledOr } : {}),
				...(siteOnly
					? {}
					: {
							onCmsPublish: async (body: unknown) => {
								const chat = await loadChat(chatCmsPublish);
								await chat?.cmsPublished(body);
							}
						})
			}
		);
	} catch (err) {
		console.error('[cms] failed to start the CMS client (dropped-doc sink):', err);
	}

	// A site-only build checks the site's own env and stops: chat's init would demand chat's keys.
	// The check is the site's (website/siteOnly.ts), so it runs the same with chat's files absent, and
	// logs through the logger startCms just registered.
	if (siteOnly) {
		// What SvelteKit loaded (the .env files in dev) and the process environment, which wins.
		await checkSiteOnlyEnv({ ...publicEnv, ...privateEnv, ...process.env }, deployEnvName());
		return;
	}

	// Chat's server boot: fail fast on misconfigured env in production (so a bad deploy
	// rolls back), but in local dev degrade gracefully — the map/explorer must boot even
	// without chat secrets. Chat code is dynamically imported so its import-time side
	// effects (config load, model fetch) don't run unless we actually init it.
	try {
		const [chatEnv, chatServer] = await Promise.all([
			loadChat(chatEnvValidate),
			loadChat(chatInit)
		]);
		if (!chatEnv || !chatServer) throw new Error("chat's server is not in this build");
		chatEnv.validateEnv();
		await chatServer.initServer();
		void logBootStage('init', initStart, {
			hooksLoadedMs,
			initStartMs: Math.round(initStart)
		});
		// Loading chat's request handler takes about 2s on the first /chat request of a cold instance,
		// often long after init has finished. Start it here, unawaited: a /chat request
		// awaits the same in-flight module in negotiateChatMarkdown, and a map request never waits on it.
		void loadChat(chatHandle).catch(() => {});
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
// module loads only when there is a guest cookie to carry.
async function guestHandoff(
	cookies: Cookies | undefined,
	target: string
): Promise<Response | null> {
	if (!cookies || cookies.getAll().length === 0) return null;
	const chat = await loadChat(chatGuestHandoffPage);
	return chat ? chat.guestHandoffPage(cookies, new URL(target)) : null;
}

// Whether this answer is a 308 or the handoff page depends on the request's fetch metadata
// and cookies, so no cache may store it and replay it to a request that should get the other one.
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

// Chat's hosts and its in-app address rules: an alias host
// sends every path to the same place on the chat host, the chat host's bare root opens chat, the chat
// surface moves old `/chat/...` addresses and site pages, and www's /chat page loads move to the chat
// host. A Response or a thrown redirect when one applies, null otherwise. Runs only where chat's files
// are in the build.
async function chatHostRules(
	input: Parameters<Handle>[0],
	req: { pathname: string; method: string; headers: Pick<Headers, 'get'> }
): Promise<Response | null> {
	const paths = chatPaths;
	const www = chatWwwRedirect;
	if (!paths || !www) return null;
	const { pathname, method, headers } = req;
	const { hostname, search } = input.event.url;

	// The chat host takes a guest's session handed over from www or chat. (guestHandoff.ts).
	if (
		!siteOnly &&
		hostname === paths.CHAT_HOST &&
		pathname === paths.GUEST_HANDOFF_PATH &&
		method === 'POST'
	) {
		const [handoff, chatLog] = await Promise.all([
			loadChat(chatGuestHandoff),
			loadChat(chatLogger)
		]);
		if (handoff) {
			const { next, outcome } = await handoff.acceptGuestHandoff(
				input.event.request,
				input.event.cookies
			);
			chatLog?.logger.info({ outcome }, '[guest-handoff] chat host');
			throw redirect(303, next, { external: true });
		}
	}

	if (paths.CHAT_ALIAS_HOSTS.includes(hostname)) {
		const target = `https://${paths.CHAT_HOST}${pathname}${search}`;
		if (method === 'GET' && www.isPageLoad(method, headers)) {
			const handoff = await guestHandoff(input.event.cookies, target);
			if (handoff) return handoff;
		}
		return movedToChatHost(target);
	}
	// On the chat surface the root IS chat, so only the site surface sends it on.
	if (APP_SURFACE === 'site' && hostname === paths.CHAT_HOST && pathname === '/') {
		throw redirect(308, `${paths.chatHome}${search}`, { external: true });
	}
	// On the chat surface, an old `/chat/...` address moves to the same path at the root.
	// Reserved paths (CHAT_RESERVED_PATHS) are served in place, and only a GET or HEAD moves.
	const atRoot = paths.chatSurfaceRedirect(pathname, method);
	if (atRoot !== null) throw redirect(308, `${atRoot}${search}`);
	// On the chat surface, a site page (`/map`, a CMS slug) matches no chat route after
	// `reroute`, so it moves to the same path on the site's host instead of 404ing here.
	const toSite = paths.chatSurfaceSiteRedirect({
		pathname,
		search,
		method,
		routeId: input.event.route?.id ?? null,
		vercelEnv: deployEnvName()
	});
	if (toSite !== null) throw redirect(308, toSite, { external: true });
	// A page load of www's /chat moves to the chat host; API calls keep answering on www.
	const chatHostTarget = www.wwwChatRedirect(input.event.url, method, headers, pathname);
	if (chatHostTarget) {
		const handoff =
			method === 'GET' ? await guestHandoff(input.event.cookies, chatHostTarget) : null;
		if (handoff) return handoff;
		return movedToChatHost(chatHostTarget);
	}

	if (isChatAliasRoot(pathname)) {
		throw redirect(308, `${paths.chatHome}${search}`, { external: true });
	}
	return null;
}

export const handleApplication: Handle = async (input) => {
	if (building) {
		// During prerender/build, neutralize chat's %gaId% placeholder (no-op on map pages).
		return input.resolve(input.event, {
			transformPageChunk: ({ html }) => html.replace('%gaId%', '')
		});
	}
	// Clear production's old apex-wide session cookies wherever a browser still sends them.
	chatLegacyCookie?.expireLegacySessionCookies(input.event.cookies, process.env);
	const pathname = unlocalizedPath(input.event.url.pathname);
	const method = input.event.request?.method ?? 'GET';
	const headers = input.event.request?.headers ?? new Headers();

	// Site-only: every chat address, a page load or an API call of any method, moves to the chat host.
	// A page load still carries a guest's session there first, where chat's handoff is in the build.
	// Where each address goes is the site's own rule (website/siteOnly.ts), so a
	// build without chat's files moves them the same way.
	if (siteOnly) {
		if (CRON_PATHS.includes(pathname)) {
			return new Response(
				'Not found: this deployment runs no scheduled jobs; the chat host does.',
				{
					status: 404,
					headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
				}
			);
		}
		const toChat = await siteOnlyChatTarget({
			url: input.event.url,
			pathname,
			deployEnv: deployEnvName()
		});
		if (toChat !== null) {
			if (
				chatWwwRedirect?.isPageLoad(method, headers) &&
				new URL(toChat).hostname === chatPaths?.CHAT_HOST
			) {
				const handoff = method === 'GET' ? await guestHandoff(input.event.cookies, toChat) : null;
				if (handoff) return handoff;
			}
			return movedToChatHost(toChat);
		}
	}

	// Chat's own host rules, which need chat's files; a build without them has none of these hosts.
	if (chatPaths && chatWwwRedirect) {
		const chatResponse = await chatHostRules(input, { pathname, method, headers });
		if (chatResponse) return chatResponse;
	}

	if (chatPaths && !siteOnly && isChatPath(pathname)) {
		// Chat's full request pipeline (auth, CSRF, CSP) — loaded on demand, wrapped by the
		// Accept: text/markdown negotiation above.
		return negotiateChatMarkdown(input, chatPaths.chatHome);
	}

	if (shouldCheckCmsRedirects(pathname, input.event.request?.method ?? 'GET')) {
		const cmsTarget = await cmsRedirectTarget(pathname);
		if (cmsTarget)
			throw redirect(
				cmsTarget.status,
				localizedHref(cmsTarget.location, input.event.locals?.locale),
				{ external: true }
			);
	}

	const target = await aliasTarget(pathname);
	if (target)
		throw redirect(308, localizedHref(target, input.event.locals?.locale), { external: true });

	const response = await handleSite(input);
	return withResponseHeaders(cdnCacheFor(response, input.event));
};

export const handle: Handle = sequence(handleLocale, handleApplication);

/**
 * A site error reported where chat's error tracking is not in the build: one console line with the
 * request's url, route, status and method and the error's stack, never a request body or header. Never
 * throws, since it runs inside the error handler.
 */
function reportSiteError(
	error: unknown,
	context: { url?: string; routeId?: string | null; status?: number; method?: string }
): void {
	try {
		const detail =
			error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
		console.error('[site-error] unhandled server error', { ...context, error: detail });
	} catch {
		// Reporting is best-effort; the error page still renders.
	}
}

/**
 * An error as the handlers below read it. SvelteKit 3 passes `{ kind, error }`, where the thrown value
 * of an `unknown` error is raw and a `framework` error (a 404 for no route, say) is a plain
 * `{ status, message }`; this is the shape SvelteKit 2 passed, with the status and message beside it.
 */
type CaughtServerError = {
	error: unknown;
	event: RequestEvent;
	status: number;
	message: string;
};

/**
 * `null` for an error thrown with `error(...)` or a remote-function validation failure: SvelteKit 2
 * never passed those to `handleError`, SvelteKit 3 does, and the response they carry is already the
 * one meant for the visitor, so there is nothing to log, report or rewrite.
 */
function caughtError(input: Parameters<HandleServerError>[0]): CaughtServerError | null {
	switch (input.kind) {
		case 'app':
		case 'validation':
			return null;
		case 'framework':
			return {
				error: new Error(input.error.message),
				event: input.event,
				status: input.error.status,
				message: input.error.message
			};
		case 'unknown':
			return { error: input.error, event: input.event, status: 500, message: 'Internal Error' };
	}
}

export const handleError: HandleServerError = async (caughtInput) => {
	const input = caughtError(caughtInput);
	if (!input) return;
	if (building) throw input.error;
	const chatErrors =
		!siteOnly && isChatPath(input.event?.url?.pathname) ? await loadChat(chatError) : undefined;
	if (chatErrors) {
		const result = await chatErrors.handleServerError(input);
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
	// half-coverage that reads as covered. In a build without chat's files the report is a structured
	// console line, which the host's log capture keeps.
	const context = {
		url: input.event?.url?.href,
		routeId: input.event?.route?.id,
		status: input.status,
		method: input.event?.request?.method
	};
	const tracking = await loadChat(chatErrorTracking);
	if (tracking) await tracking.captureServerException(input.error, context);
	else reportSiteError(input.error, context);
	return {
		message:
			expiredPreviewMessage(input.error, process.env) ??
			input.message ??
			(input.status === 404 ? 'Not Found' : 'Internal Error')
	};
};

export const handleFetch: HandleFetch = async (input) => {
	if (building) return input.fetch(input.request);
	const chatFetches =
		!siteOnly && isChatPath(input.event?.url?.pathname) ? await loadChat(chatFetch) : undefined;
	if (chatFetches) return chatFetches.handleFetchRequest(input);
	return input.fetch(input.request);
};
