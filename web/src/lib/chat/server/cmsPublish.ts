import { clearCmsReads } from "$lib/website.server";
import { runInBackground } from "$lib/chat/server/vercelBackground";

/**
 * Chat's side of a CMS publish, given the body Payload sent (payload/src/hooks/notifyWebCache.ts).
 *
 * Clears this instance's cached CMS reads that the publish changed (the maintenance banner, the
 * `/chat` page's SEO fields), and when the publish is a Trust & Safety, Privacy or Terms page, refreshes
 * chat's retrieval copy of it in the background. Returns the cache-key prefixes cleared.
 *
 * Two callers, one per way chat is deployed:
 * - chat's own webhook route, `routes/chat/api/cms/invalidate`, when chat runs on a host of its own:
 *   the alpha host, which www forwards every publish to;
 * - the site's webhook route, through the handler `hooks.server.ts` registers, when the site and chat
 *   share one app.
 */
export async function cmsPublished(body: unknown): Promise<(readonly unknown[])[]> {
	const cleared = await clearCmsReads(body);
	const path = policyPagePathOf(body);
	if (path !== undefined) {
		// Loaded here, not at the top, so the hook that registers this handler stays off chat's
		// retrieval writes until a publish needs them.
		const { isPolicyPagePath, syncPolicyPageLogged } = await import("$lib/chat/server/rag/policyPageSync");
		if (isPolicyPagePath(path)) await runInBackground(syncPolicyPageLogged(path));
	}
	return cleared;
}

/** The page path of a published (not draft) page save, or undefined for anything else. */
function policyPagePathOf(body: unknown): string | null | undefined {
	if (!body || typeof body !== "object") return undefined;
	const { collection, doc } = body as { collection?: unknown; doc?: unknown };
	if (collection !== "pages" || !doc || typeof doc !== "object") return undefined;
	const page = doc as { _status?: unknown; breadcrumbs?: unknown };
	if (page._status === "draft") return undefined;
	const breadcrumbs = Array.isArray(page.breadcrumbs) ? (page.breadcrumbs as Array<{ url?: string | null }>) : [];
	return breadcrumbs.at(-1)?.url;
}
