import { APP_SURFACE, CHAT_ROUTE_ROOT, chatRoutePath, type AppSurface } from '../surface';

// Chat-local replacement for `base` from `$app/paths`.
//
// Chat code builds links/fetches/redirects as `${base}/...`. On the site surface (www, develop, PR
// previews) chat is the `/chat` route subtree, so `base` is the literal "/chat" — NOT SvelteKit's
// `paths.base`, which is "" app-wide because the map owns "/". An env-driven `paths.base=/chat` is
// fragile: if the base fails to reach the build, every chat route breaks. On the chat surface
// (APP_SURFACE=chat, CUR-4448) chat owns the root, so `base` is "" and hooks.ts's `reroute` maps
// each path onto the same `/chat` route files. See src/lib/surface.ts.
export const base: string = APP_SURFACE === 'chat' ? '' : CHAT_ROUTE_ROOT;

/** Chat's home as a link target: `/chat` on the site surface, `/` on the chat surface. */
export const chatHome: string = base || '/';

/**
 * Paths that keep their `/chat` prefix on the chat surface and are served there in place, never
 * redirected (CUR-4448). Each is registered somewhere outside this repo, or called by a client that
 * would not follow a redirect with its method and body:
 *
 * - `/chat/api` — Vercel crons, the agent service's SAFETY_SCREEN_URL, API clients, and Better Auth's
 *   endpoints with every OAuth callback registered at Google, GitHub and Hugging Face.
 * - `/chat/.well-known` — the client ID metadata document Hugging Face fetches by its exact URL.
 * - `/chat/login/callback` — the Hugging Face OIDC redirect URI.
 * - `/chat/healthcheck` — Better Stack monitors and the deploy smoke probes.
 * - `/chat/guest-handoff` — the sealed POST from www carrying a guest's session (guestHandoff.ts).
 *
 * The same route also answers at the stripped path (`/api/x`), which is what `${base}` builds there.
 */
export const CHAT_API_PATH = '/chat/api';
export const AUTH_BASE_PATH = `${CHAT_API_PATH}/auth`;
export const HF_LOGIN_CALLBACK_PATH = '/chat/login/callback';
export const CIMD_PATH = '/chat/.well-known/oauth-cimd';
export const GUEST_HANDOFF_PATH = '/chat/guest-handoff';
export const CHAT_RESERVED_PATHS = [
	CHAT_API_PATH,
	'/chat/.well-known',
	HF_LOGIN_CALLBACK_PATH,
	'/chat/healthcheck',
	GUEST_HANDOFF_PATH
] as const;

function underPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True for a path under one of CHAT_RESERVED_PATHS. */
function isChatReservedPath(pathname: string): boolean {
	return CHAT_RESERVED_PATHS.some((prefix) => underPrefix(pathname, prefix));
}

/**
 * On the chat surface, where a GET or HEAD of an old `/chat/...` address goes instead: the same path
 * without `/chat` (`/chat` itself becomes `/`), so bookmarks and links made while chat lived under
 * `/chat` keep working. Null when nothing moves: the site surface, any other method, a path outside
 * `/chat`, or a reserved path. The caller keeps the query string.
 */
export function chatSurfaceRedirect(
	pathname: string,
	method: string,
	surface: AppSurface = APP_SURFACE
): string | null {
	if (surface !== 'chat') return null;
	if (method !== 'GET' && method !== 'HEAD') return null;
	if (!underPrefix(pathname, CHAT_ROUTE_ROOT) || isChatReservedPath(pathname)) return null;
	return pathname.slice(CHAT_ROUTE_ROOT.length) || '/';
}

/**
 * A root-relative chat href (`/chat…` with any query or fragment) as it is addressed on CHAT_HOST, which
 * is always the chat surface: `/chat/settings?x` becomes `/settings?x` and `/chat` becomes `/`, while a
 * reserved path keeps its prefix (CUR-4449). Links from www use it so a click skips the 308.
 */
export function chatHostPath(href: string): string {
	const cut = href.search(/[?#]/);
	const pathname = cut === -1 ? href : href.slice(0, cut);
	const suffix = cut === -1 ? '' : href.slice(cut);
	return `${chatSurfaceRedirect(pathname, 'GET', 'chat') ?? pathname}${suffix}`;
}

/** The site's own host. Chat moved off it to CHAT_HOST (CUR-4439); www keeps the CMS site. */
export const WWW_HOST = 'www.aipotluck.org';
/** The site's develop host, where a chat-surface preview deployment (alpha-develop) sends them. */
const SITE_DEVELOP_HOST = 'develop.aipotluck.org';

/** The site origin a chat-surface deployment pairs with: www in production, develop otherwise. */
function siteOriginFor(vercelEnv: string | undefined): string {
	return `https://${vercelEnv === 'production' ? WWW_HOST : SITE_DEVELOP_HOST}`;
}

/**
 * Where a chat route that hands a visitor to a site page sends them. On the site surface that is the
 * bare path. On the chat surface the bare path is the chat route itself (chat sits at the root), so a
 * redirect to it loops; the page lives on the site's host instead.
 */
export function sitePageHref(
	path: string,
	vercelEnv: string | undefined,
	surface: AppSurface = APP_SURFACE
): string {
	return surface === 'chat' ? `${siteOriginFor(vercelEnv)}${path}` : path;
}

/**
 * On the chat surface, where a GET or HEAD of a site page goes: the same path and query on the site's
 * host (CUR-4448). A chat-surface host serves only chat, so `/map`, `/about`, `/sitemap.xml` or a CMS
 * slug would otherwise 404 there. `reroute` maps each of them into the `/chat` tree, where no chat
 * route matches and the site's `[...slug]` catch-all (or nothing) does: `routeId` is what SvelteKit
 * matched for the rerouted path, so a chat route that 404s by itself (an unknown conversation id)
 * keeps its 404 here. Null when nothing moves: the site surface, any other method, a matched chat
 * route, chat's API at either address, an old `/chat/...` address (chatSurfaceRedirect moves those
 * first), or a root path that resolves as itself (`/_app`, static files).
 */
export function chatSurfaceSiteRedirect(
	req: {
		pathname: string;
		search: string;
		method: string;
		routeId: string | null;
		vercelEnv: string | undefined;
	},
	surface: AppSurface = APP_SURFACE
): string | null {
	if (surface !== 'chat') return null;
	if (req.method !== 'GET' && req.method !== 'HEAD') return null;
	if (req.routeId !== null && underPrefix(req.routeId, CHAT_ROUTE_ROOT)) return null;
	if (underPrefix(req.pathname, CHAT_ROUTE_ROOT)) return null;
	const routePath = chatRoutePath(req.pathname, surface);
	if (!underPrefix(routePath, CHAT_ROUTE_ROOT) || underPrefix(routePath, CHAT_API_PATH)) return null;
	return `${siteOriginFor(req.vercelEnv)}${req.pathname}${req.search}`;
}

/**
 * Retired chat entry paths. hooks.server.ts answers each with a 308 to chat's home, keeping the query
 * string, so old links and bookmarks still land on chat (CUR-2195). `/alpha/chat` was develop's
 * entry while the landing page lived in the CMS; the code-owned `/chat` page replaced it.
 */
export const CHAT_ALIAS_PATHS = ['/alpha/chat'] as const;

/**
 * Chat's own host (CUR-1067, alpha since CUR-4439). On the site surface its bare root 308s to `/chat`;
 * every other path is served as on any host, so nothing that works on www stops working here.
 */
export const CHAT_HOST = 'alpha.aipotluck.org';

/** Alias hosts for chat. Each 308s to the same path and query on CHAT_HOST. chat. was the chat host before. */
export const CHAT_ALIAS_HOSTS = ['chat.aipotluck.org'] as const;

/** Site-root static JSON (`web/static/data/`). Served at `/data/…`, NOT under `/chat`. */
export function staticDataUrl(file: string): string {
	return `/data/${file}`;
}

/** Site-root static asset dir (`web/static/chatui/` etc.). Served at `/chatui/…`, NOT under `/chat`. */
export function staticAssetPath(assetsDir = 'chatui'): string {
	return `/${assetsDir}`;
}
