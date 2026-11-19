import { DEPLOYMENT } from '../deployment';
import { APP_SURFACE, CHAT_ROUTE_ROOT, chatRoutePath, type AppSurface } from '../surface';

// Chat-local replacement for `base` from `$app/paths`.
//
// Chat code builds links/fetches/redirects as `${base}/...`. On the site surface (www, develop, PR
// previews) chat is the `/chat` route subtree, so `base` is the literal "/chat" — NOT SvelteKit's
// `paths.base`, which is "" app-wide because the map owns "/". An env-driven `paths.base=/chat` is
// fragile: if the base fails to reach the build, every chat route breaks. On the chat surface
// (APP_SURFACE=chat) chat owns the root, so `base` is "" and hooks.ts's `reroute` maps
// each path onto the same `/chat` route files. See src/lib/surface.ts.
export const base: string = APP_SURFACE === 'chat' ? '' : CHAT_ROUTE_ROOT;

/** Chat's home as a link target: `/chat` on the site surface, `/` on the chat surface. */
export const chatHome: string = base || '/';

/**
 * Paths that keep their `/chat` prefix on the chat surface and are served there in place, never
 * redirected. Each is registered somewhere outside this repo, or called by a client that
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
 * reserved path keeps its prefix. Links from www use it so a click skips the 308.
 */
export function chatHostPath(href: string): string {
	const cut = href.search(/[?#]/);
	const pathname = cut === -1 ? href : href.slice(0, cut);
	const suffix = cut === -1 ? '' : href.slice(cut);
	return `${chatSurfaceRedirect(pathname, 'GET', 'chat') ?? pathname}${suffix}`;
}

/** The site's own production host on a split installation (src/lib/deployment.ts); chat lives on
 *  CHAT_HOST. Null when the installation has no separate site. */
export const WWW_HOST: string | null = DEPLOYMENT.siteHost;
/** The site's develop host, where a chat-surface preview deployment sends them. */
const SITE_DEVELOP_HOST: string | null = DEPLOYMENT.siteDevelopHost;

/** The site origin a chat-surface deployment pairs with: the site host in production, its develop host
 *  otherwise. Null when the installation names none, so nothing leaves for a site that isn't there. */
function siteOriginFor(vercelEnv: string | undefined): string | null {
	const host = vercelEnv === 'production' ? WWW_HOST : SITE_DEVELOP_HOST;
	return host ? `https://${host}` : null;
}

/**
 * Where a chat route that hands a visitor to a site page sends them. On the site surface that is the
 * bare path. On the chat surface the bare path is the chat route itself (chat sits at the root), so a
 * redirect to it loops; the page lives on the site's host instead, and with no site host there is
 * nowhere to send them (null).
 */
export function sitePageHref(
	path: string,
	vercelEnv: string | undefined,
	surface: AppSurface = APP_SURFACE
): string | null {
	if (surface !== 'chat') return path;
	const origin = siteOriginFor(vercelEnv);
	return origin ? `${origin}${path}` : null;
}

/**
 * On the chat surface, where a GET or HEAD of a site page goes: the same path and query on the site's
 * host. A chat-surface host serves only chat, so `/map`, `/about`, `/sitemap.xml` or a CMS
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
	const origin = siteOriginFor(req.vercelEnv);
	return origin ? `${origin}${req.pathname}${req.search}` : null;
}

/** The chat host a site deployment pairs with: CHAT_HOST in production, the chat develop host
 *  otherwise. Null when the installation names none. */
function chatHostFor(vercelEnv: string | undefined): string | null {
	return vercelEnv === 'production' ? CHAT_HOST : CHAT_DEVELOP_HOST;
}

/**
 * Root paths that are chat's on the site surface, outside `/chat`. On the site-only surface each moves
 * to the same path on the chat host, which serves them as themselves (surface.ts lists `/folkways-adapter`
 * among the chat surface's root paths). `/rs` and `/api/cms` stay: the site uses them too.
 */
const SITE_ONLY_CHAT_ROOT_PREFIXES = ['/folkways-adapter'] as const;

/**
 * On the site-only surface (www once chat lives on alpha), where a request for one of chat's
 * addresses goes: the same address on the chat host, for every method and every kind of request,
 * a page load or an API call alike. A 308 keeps the method and body. `/chat/x` maps as a link from
 * www does (`chatHostPath`): `/chat/settings` → `/settings`, while a reserved path such as
 * `/chat/api/models` keeps its prefix, since the chat host serves it in place. A retired chat entry
 * path (CHAT_ALIAS_PATHS) goes to chat's home there. Null on any other surface or for a site path.
 *
 * `pathname` is the unlocalized path, which decides; `url` supplies the visible path and query.
 */
export function siteOnlyChatRedirect(
	req: { url: URL; pathname: string; vercelEnv: string | undefined },
	surface: AppSurface = APP_SURFACE
): string | null {
	if (surface !== 'site-only') return null;
	const chatHost = chatHostFor(req.vercelEnv);
	if (!chatHost) return null;
	const origin = `https://${chatHost}`;
	const { pathname, url } = req;
	if ((CHAT_ALIAS_PATHS as readonly string[]).includes(pathname)) return `${origin}/${url.search}`;
	if (underPrefix(pathname, CHAT_ROUTE_ROOT)) {
		return `${origin}${chatHostPath(url.pathname)}${url.search}`;
	}
	if (SITE_ONLY_CHAT_ROOT_PREFIXES.some((prefix) => underPrefix(pathname, prefix))) {
		return `${origin}${url.pathname}${url.search}`;
	}
	return null;
}

/**
 * Retired chat entry paths. hooks.server.ts answers each with a 308 to chat's home, keeping the query
 * string, so old links and bookmarks still land on chat. `/alpha/chat` was develop's
 * entry while the landing page lived in the CMS; the code-owned `/chat` page replaced it.
 */
export const CHAT_ALIAS_PATHS = ['/alpha/chat'] as const;

/**
 * Chat's own host on a split installation (src/lib/deployment.ts). On the site surface its bare root
 * 308s to `/chat`; every other path is served as on any host, so nothing that works on the site host
 * stops working here. Null when chat has no host of its own.
 */
export const CHAT_HOST: string | null = DEPLOYMENT.chatHost;
/** Chat's develop host, the chat-surface deployment the site's develop pairs with. */
const CHAT_DEVELOP_HOST: string | null = DEPLOYMENT.chatDevelopHost;

/** Alias hosts for chat, older chat hosts. Each 308s to the same path and query on CHAT_HOST. */
export const CHAT_ALIAS_HOSTS: readonly string[] = CHAT_HOST ? DEPLOYMENT.chatAliasHosts : [];

/** Site-root static JSON (`web/static/data/`). Served at `/data/…`, NOT under `/chat`. */
export function staticDataUrl(file: string): string {
	return `/data/${file}`;
}

/** Site-root static asset dir (`web/static/chatui/` etc.). Served at `/chatui/…`, NOT under `/chat`. */
export function staticAssetPath(assetsDir = 'chatui'): string {
	return `/${assetsDir}`;
}
