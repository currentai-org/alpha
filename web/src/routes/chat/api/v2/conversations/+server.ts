import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { getLayoutConversations } from "$lib/chat/server/layoutData";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import { wipeUserData } from "$lib/chat/server/db/wipeUserData";
import { CustodialWipeError, hubRateLimitedError } from "$lib/chat/server/storage/custodialStorage";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { logger } from "$lib/chat/server/logger";
import { hubBusyResponse } from "$lib/chat/server/storage/hubBusy";
import { WIPE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";

export const GET: RequestHandler = async ({ locals, url, request }) => {
	requireAuth(locals);
	const p = parseInt(url.searchParams.get("p") ?? "0") || 0;
	// Later pages keep the sidebar's workspace scope. (CUR-3023)
	const scope = await workspaceScopeFor(locals, request?.headers);
	return superjsonResponse(await getLayoutConversations(locals, p, scope));
};

export const DELETE: RequestHandler = async ({ locals, url, request }) => {
	requireAuth(locals);

	// No client IP: the wipe keys on the caller's own session/user ids only. Keying on the IP hash
	// deleted other people's rows from the same NAT (see wipeUserData's header).
	// `?account=delete` is the "Delete account" action; without it the wipe is "Forget everything" and
	// a signed-in person keeps their account (CUR-1420).
	try {
		// The `storage_hub_rate_limited` fault (preview only) fails the file delete as a throttled Hub does.
		if ((await resolveFaultInjection(request)) === "storage_hub_rate_limited") {
			throw new CustodialWipeError(0, 0, hubRateLimitedError("https://huggingface.co/api/buckets (fault injection)"));
		}
		const summary = await wipeUserData({
			sessionId: locals.sessionId,
			userId: locals.user?._id ? String(locals.user._id) : undefined,
			deleteAccount: url.searchParams.get("account") === "delete",
		});
		return superjsonResponse(summary);
	} catch (e) {
		// The file delete runs before any row is touched (wipeUserData step 0), so this failure
		// leaves the account whole and a retry can finish the job. Never a silent success.
		if (e instanceof CustodialWipeError) {
			// A Hugging Face throttle is the busy answer with the window's reset, not "try again" now. (CUR-3680)
			const busy = hubBusyResponse(e, WIPE_BUSY_MESSAGE, "wipe");
			if (busy) return busy;
			logger.error({ err: e, cause: e.cause }, "[wipe] custodial storage delete failed");
			error(502, "We couldn't delete your uploaded files, so nothing was cleared. Please try again.");
		}
		logger.error({ err: e }, "[DELETE /api/v2/conversations] wipe failed");
		error(503, "Could not clear your data right now. Please try again.");
	}
};
