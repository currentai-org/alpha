import { loadChatShellData } from '$lib/chat/server/chatShellData';
import type { LayoutServerLoad } from './$types';

// 'app:models' lets NoModelsAvailable.svelte re-run just this load (via safeInvalidate)
// to self-heal a cold-boot-empty registry, instead of an invalidateAll() that would also refetch
// settings/conversations/feature-flags for no reason. (CUR-1154)
export const load: LayoutServerLoad = async ({
	locals,
	cookies,
	fetch,
	depends,
	route,
	request,
	untrack
}) => {
	depends('app:models');
	// The workspace settings page re-runs this load after a switch, create or delete, so
	// the account menu's current-workspace line follows without a reload. (CUR-3014)
	depends('app:workspace');
	// The route id only labels a log line, so read it untracked. Reading `route` directly makes this
	// load re-run on every move between chat pages, which refetches the whole shell and flashes the
	// side rail back to its skeleton mid-conversation (CUR-2350).
	const routeId = untrack(() => route.id);
	// `request` carries Accept-Language for the starter shelf (CUR-2323); ensureChatLocalsResolved is
	// a no-op here because the hook already resolved locals.
	return loadChatShellData(locals, cookies, fetch, request, routeId);
};
