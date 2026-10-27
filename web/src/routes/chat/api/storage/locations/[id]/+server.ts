import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { deleteStorageLocation } from "$lib/chat/server/db/storageLocations";

import { requireLocationsAccess } from "../../guard";

// unlink. Deletes our row and our sealed copy of the token; the files in the person's own
// bucket are theirs and stay where they are. A default that pointed here goes back to Alpha storage. (CUR-2930)
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const accountId = await requireLocationsAccess(locals);
	if (!params.id || !(await deleteStorageLocation(accountId, params.id))) error(404, "Not found");
	return json({ ok: true });
};
