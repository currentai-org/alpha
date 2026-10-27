/**
 * Whether a sidebar conversation's id matches the active route's `[id]` param — i.e. whether this
 * row should render as the currently-open conversation.
 *
 * `ConvSidebar.id` is typed `ObjectId | string`, and it genuinely IS an ObjectId instance for
 * conversations loaded via the sidebar's infinite-scroll pagination (NavMenu.svelte's
 * handleVisible → GET /api/v2/conversations). That response round-trips through superjson, whose
 * custom ObjectId transformer (APIClient.ts) deserializes any 24-hex-char id back into a
 * bson-objectid instance rather than a plain string — unlike the initial SSR page, which
 * stringifies every id up front (layoutData.ts's mapConversationsForSidebar). `routeParamId` is
 * always a plain string (SvelteKit route params), so a bare `===` silently and permanently fails
 * for every conversation loaded via pagination: its sidebar row never renders as active, even
 * while its own page is open. `String(id)` closes that gap the same way
 * NavConversationItem's own delete handler already does (`conv.id.toString()`).
 */
export function isActiveConversationId(id: unknown, routeParamId: string | undefined): boolean {
	if (routeParamId === undefined) return false;
	return String(id) === routeParamId;
}
