// The load behind both storage pages: `/chat/storage`, the files, which the chat rail's Files entry
// opens, and `/chat/settings/storage`, the storage settings, which the settings nav's Storage entry
// opens inside the settings pane. Same gate as every storage route: 404 when the flag is off, so a dark
// feature reads as one that was never built rather than confirming it exists.
import type { RequestEvent } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { logger } from "$lib/chat/server/logger";

import { requireSignedInPage } from "$lib/chat/server/signedInPage";
import { listCustodialFiles } from "$lib/chat/server/storage/custodialStorage";
import { hubThrottledUrl, throwIfHubRateLimitFault } from "$lib/chat/server/storage/hubBusy";
import { custodialStorageViewEnabledForUser } from "$lib/chat/server/storage/custodialStorageGate";
import { storageLocationsEnabledForUser } from "$lib/chat/server/storage/locations/gate";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { summarizeLocations, type LocationsSummary } from "$lib/chat/server/storage/locations/registry";

type FilesPageEvent = Pick<RequestEvent, "locals" | "url" | "setHeaders"> & { request?: Request };

export async function loadFilesPage(event: FilesPageEvent) {
	const user = requireSignedInPage(event);
	const accountId = user._id.toString();

	if (!(await custodialStorageViewEnabledForUser(accountId))) {
		throw error(404, "Not found");
	}

	// Null when the `storage-locations` flag is off, so the panel shows Alpha storage only.
	let locations: LocationsSummary | null = null;
	if (await storageLocationsEnabledForUser(accountId, flagEmail(user))) {
		// Logged, not swallowed: the panel then shows Alpha storage only, and the upload route still
		// refuses an unnamed upload under "ask" and still routes to a linked default, so nothing lands
		// silently in the wrong place. The log is how a stuck panel gets noticed.
		locations = await summarizeLocations(accountId).catch((err) => {
			logger.error({ err, accountId }, "[storage-locations] summarizeLocations failed; panel shows Alpha storage only");
			return null;
		});
	}

	try {
		// The `storage_hub_rate_limited` fault (preview only) throttles this listing too.
		if (event.request) await throwIfHubRateLimitFault(event.request);
		const entries = await listCustodialFiles(accountId);
		return { files: entries.map((e) => ({ path: e.path, size: e.size, addedAt: e.uploadedAt })), listUnavailable: false, listBusy: false, locations };
	} catch (e) {
		// Mirrors FilesPanel's failed-list state: nothing was deleted, and the page still renders so
		// the person can retry from FilesPanel's own reload. `listBusy` says it was a Hugging Face throttle.
		return { files: [], listUnavailable: true, listBusy: hubThrottledUrl(e) !== null, locations };
	}
}
