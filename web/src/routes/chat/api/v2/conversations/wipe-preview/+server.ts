import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { previewWipe } from "$lib/chat/server/db/wipeScope";
import { logger } from "$lib/chat/server/logger";

/**
 * What "Forget everything" (or `?account=delete`, "Delete account") would remove right now: the same
 * counts the receipt shows, read without deleting anything. Keyed by the caller's own
 * session and user ids only, so it never counts anyone else's rows.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireAuth(locals);
	try {
		const preview = await previewWipe({
			sessionId: locals.sessionId,
			userId: locals.user?._id ? String(locals.user._id) : undefined,
			deleteAccount: url.searchParams.get("account") === "delete",
		});
		return json(preview, { headers: { "cache-control": "no-store" } });
	} catch (e) {
		logger.error({ err: e }, "[GET /api/v2/conversations/wipe-preview] count failed");
		error(503, "Could not count your data right now.");
	}
};
