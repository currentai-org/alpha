import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";

import { UploadRateLimitedError } from "$lib/chat/server/storage/custodialStorage";
import { resolveLocation } from "$lib/chat/server/storage/locations/registry";
import {
	SourceNotRemovedError,
	transferFile,
	TransferRefusedError,
	TransferVerifyError,
	type TransferMode,
} from "$lib/chat/server/storage/locations/transfer";

import { rateLimitedResponse, requireLocationsAccess, storageFailure, writeOptions } from "../guard";

// Copy or move one file between two of this account's locations. Both ids go through
// resolveLocation, so another account's location id is a 404 and a path outside a location is a 403,
// exactly as for a download or a delete. (CUR-2931)

type TransferBody = { from?: unknown; to?: unknown; path?: unknown; mode?: unknown; ifNameTaken?: unknown };

function field(body: TransferBody, key: "from" | "to" | "path"): string {
	const v = body[key];
	if (typeof v !== "string" || v === "") error(400, `Expected a \`${key}\` string.`);
	return v;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireLocationsAccess(locals);
	const body = (await request.json().catch(() => error(400, "Expected a JSON body."))) as TransferBody;
	const mode = body.mode;
	if (mode !== "copy" && mode !== "move") error(400, "`mode` must be copy or move.");

	try {
		const from = await resolveLocation(accountId, field(body, "from"));
		const to = await resolveLocation(accountId, field(body, "to"));
		const opts = await writeOptions(request);
		// keepBoth is for moving a batch (CUR-2941): a taken name never stops it or overwrites anything.
		const ifNameTaken = body.ifNameTaken === "keepBoth" ? "keepBoth" : "refuse";
		const { path, outcome } = await transferFile(from, to, field(body, "path"), mode as TransferMode, opts, ifNameTaken);
		return json({ ok: true, location: to.id, path, outcome });
	} catch (e) {
		if (e instanceof TransferRefusedError) error(e.status, e.message);
		// The copy is there and the original is too. 200 with a warning: the thing they asked for half
		// happened, and the list they reload shows both.
		if (e instanceof SourceNotRemovedError) {
			return json({ ok: true, path: e.copiedTo, warning: e.message });
		}
		if (e instanceof TransferVerifyError) error(502, e.message);
		if (e instanceof UploadRateLimitedError) return rateLimitedResponse(e);
		return storageFailure(e);
	}
};
