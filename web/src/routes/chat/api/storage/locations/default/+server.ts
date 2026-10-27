import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { json } from "$lib/chat/server/api/utils/json";
import { getStorageLocation, setDefaultStorageLocation } from "$lib/chat/server/db/storageLocations";
import { ASK_EVERY_TIME, LAST_USED } from "$lib/chat/server/storage/locations/registry";
import { ALPHA_LOCATION_ID } from "$lib/chat/server/storage/locations/types";

import { requireLocationsAccess } from "../../guard";

// Where new files go, the way a browser sets its download folder. "alpha" is Alpha storage,
// "ask" asks on every upload, "last" (CUR-3077) is wherever the last upload went and is stored as no
// choice at all, and anything else must be one of this account's own linked locations. (CUR-2930)
const Body = z.object({ location: z.string().min(1).max(64) });

export const PUT: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireLocationsAccess(locals);
	const parsed = Body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected a `location`.");
	const { location } = parsed.data;
	if (location !== ALPHA_LOCATION_ID && location !== ASK_EVERY_TIME && location !== LAST_USED) {
		if (!(await getStorageLocation(accountId, location))) error(404, "Not found");
	}
	await setDefaultStorageLocation(accountId, location === LAST_USED ? null : location);
	return json({ ok: true });
};
