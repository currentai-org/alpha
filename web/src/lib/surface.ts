/**
 * Which app this build serves (CUR-4448). The same `web/` builds two ways:
 *
 * - `site` (the default: www, develop, PR previews, every build without APP_SURFACE): the site at `/`
 *   and chat under `/chat`, exactly as before.
 * - `chat` (APP_SURFACE=chat, the alpha project): chat at the root of its host. The route files do
 *   not move; `reroute` in hooks.ts maps `/x` to the `/chat/x` route, so `page.route.id` still
 *   starts with `/chat` on both surfaces.
 *
 * Config that names the deployment, like INSTANCE (chat/server/instance.ts); it turns no feature on
 * or off, so no flag gates it. It is fixed at build time by vite.config.ts's `define`, so the server
 * and client bundles always agree, and an unknown value fails the build there.
 *
 * Shared by chat and the site, and free of imports, so hooks.ts, i18n routing and analytics can read
 * it without crossing the chat/site boundary.
 */
export type AppSurface = 'site' | 'chat';

// `typeof` guard: a plain-tsx script that imports this module never went through Vite's define.
export const APP_SURFACE: AppSurface =
	typeof __APP_SURFACE__ === 'undefined' ? 'site' : __APP_SURFACE__;

/** Where chat's route files live, on every surface. Route ids and reserved paths start with it. */
export const CHAT_ROUTE_ROOT = '/chat';

/**
 * Root paths that resolve as themselves on the chat surface, where every other path is chat's. Each
 * is a prefix, matched at a segment boundary:
 *
 * - `/_app` — SvelteKit's own build assets and remote functions.
 * - `/.well-known` — RFC 8414 OAuth discovery for chat's sync clients
 *   (routes/.well-known/oauth-authorization-server), which the spec puts at the origin root.
 * - `/rs` — the PostHog reverse proxy (vercel.json rewrites, routes/rs), which chat's analytics use.
 * - `/folkways-adapter` — chat's OpenAI-compatible adapter, an OPENAI_BASE_URL target for previews.
 * - `/api/cms` — the CMS publish webhook; it re-syncs chat's policy pages (rag/policyPageSync.ts).
 *   Chat's own API answers under `/api/*` here too: no chat API route is named `cms`.
 *
 * Deliberately NOT here, so they fall through to chat (and 404 there): the site's pages (`/alpha`,
 * `/org`, `/product`, `/updates`, `/designsystem`, the CMS catch-all), its other `/api/*` routes
 * (favicon, lottie, data-freshness), which chat never calls, and `/sitemap.xml`, which would list
 * site pages at a host that does not serve them. `/roadmap-v2` is prerendered, so the CDN serves it
 * as a static file before reroute ever runs; it is unlinked either way.
 */
const CHAT_SURFACE_ROOT_PREFIXES = [
	'/_app',
	'/.well-known',
	'/rs',
	'/folkways-adapter',
	'/api/cms'
] as const;

/**
 * Top-level directories of `web/static`, served by the CDN as themselves. A root-level file (any
 * single segment with an extension, such as `/favicon.ico` or `/llms.txt`) is matched by shape
 * instead; `surface.spec.ts` checks every entry in `web/static` against both.
 */
const STATIC_ROOT_DIRS = [
	'chatui',
	'data',
	'e2e',
	'fonts',
	'huggingchat',
	'images',
	'logos'
] as const;

// A root file: one segment with an extension. `/sitemap.xml` has that shape and is a route, so it is
// named out (see CHAT_SURFACE_ROOT_PREFIXES).
const ROOT_FILE = /^\/[^/]+\.[a-z0-9]+$/i;
const ROUTED_ROOT_FILES = ['/sitemap.xml'];

function underPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True when `pathname` resolves as itself on the chat surface rather than as a chat route. */
function isChatSurfaceRootPath(pathname: string): boolean {
	if (underPrefix(pathname, CHAT_ROUTE_ROOT)) return true;
	if (CHAT_SURFACE_ROOT_PREFIXES.some((prefix) => underPrefix(pathname, prefix))) return true;
	if (STATIC_ROOT_DIRS.some((dir) => underPrefix(pathname, `/${dir}`))) return true;
	return ROOT_FILE.test(pathname) && !ROUTED_ROOT_FILES.includes(pathname);
}

/**
 * The route path a request path resolves to: the path itself on the site surface; on the chat
 * surface, `/x` becomes `/chat/x` (and `/` becomes `/chat`) unless it is a root path above. This is
 * the whole of `reroute`, and the one way server code asks "which chat route is this?", because a
 * chat-surface request may name the same route either way (`/api/x` or the reserved `/chat/api/x`).
 */
export function chatRoutePath(pathname: string, surface: AppSurface = APP_SURFACE): string {
	if (surface !== 'chat' || isChatSurfaceRootPath(pathname)) return pathname;
	return pathname === '/' ? CHAT_ROUTE_ROOT : `${CHAT_ROUTE_ROOT}${pathname}`;
}

/** True when `pathname` is served by chat's route tree: `/chat`, or anything under it once rerouted. */
export function isChatRoute(
	pathname: string | undefined,
	surface: AppSurface = APP_SURFACE
): boolean {
	if (pathname === undefined) return false;
	return underPrefix(chatRoutePath(pathname, surface), CHAT_ROUTE_ROOT);
}
