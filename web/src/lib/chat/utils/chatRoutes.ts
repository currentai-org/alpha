/**
 * Whether a SvelteKit route id is a model's own page (`/chat/models/[...model]`), which sets its own
 * page-specific og:title/og:url (routes/chat/models/[...model]/+page.svelte) and so must NOT also
 * get ChatShell's generic app-wide social-card tags, which would duplicate/contradict them
 * (ChatShell's og:url always points at the app root, never the model's page).
 *
 * Takes `page.route.id` (the route FILE pattern) rather than `page.url.pathname`, and checks a
 * segment prefix so an unrelated route that merely shares the string (e.g. a hypothetical
 * `/chat/models-comparison`) is not caught.
 */
export function isChatModelsRoute(routeId: string | null | undefined): boolean {
	// eslint-disable-next-line chat-paths/no-chat-path-literal -- a route id, `/chat` on both surfaces
	return routeId?.startsWith("/chat/models/") ?? false;
}
