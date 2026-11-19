import { error } from "@sveltejs/kit";
import { shareLinksEnabled } from "$lib/chat/server/shareLinksGate";
import { readSharedSnapshot } from "$lib/chat/server/share/sharedConversations";
import type { PageServerLoad } from "./$types";

// The read-only viewer for a share link. Signed out is the normal case. It shows the
// snapshot taken when the chat was shared and nothing else: never the live conversation, its files, or
// who shared it. A revoked or unknown link, or any link while `share-links` is off, is a plain 404.
export const load: PageServerLoad = async ({ params, setHeaders }) => {
	// Never cached anywhere, so a revoke takes effect on the next load, and never indexed.
	setHeaders({ "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" });
	if (!shareLinksEnabled()) error(404, "This shared chat isn't available.");
	const snapshot = await readSharedSnapshot(params.shareId);
	if (!snapshot) error(404, "This shared chat isn't available.");
	return { shared: snapshot };
};
