/**
 * List + create a signed-in user's local (LAN/self-hosted) inference endpoints. Backs the
 * settings "Local Inference" tab — see localModels.ts for how these rows become synthetic "local"
 * models, and localEndpointsGate.ts for the deployment-wide kill switch checked below.
 *
 * Signed-in-only, unlike most of this app's content: there's no guest/session-scoped case for "point
 * MY server at this app" the way there is for conversations, so requireAuth alone (which also accepts
 * a bare session) isn't enough — every handler here additionally requires a real `locals.user`. (CUR-1262)
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { isRefusedLocalBaseUrl, normalizeLocalBaseUrl } from "$lib/chat/server/localModels";
import {
	listLocalEndpointsForUserId,
	createLocalEndpoint,
	type LocalInferenceEndpointRow,
} from "$lib/chat/server/db/localInferenceEndpoints";

/** Never echo `userId` back to the client — it's an internal join key, not something the UI needs.
 *  `kind` MUST be included: the settings UI's status dot, "managed (Pangolin)" label, and status-
 *  polling row filter all key off `server.kind === "managed"` — omitting it here silently downgrades
 *  every managed row back to looking "direct" on every load except the one right after pairing
 *  (where the client appends its own optimistic row with `kind` already set), since `undefined` is
 *  deliberately treated the same as "direct" everywhere else (a pre-CUR-1266 row has no `kind` at
 *  all). Without it a managed row's status dot never renders and the row is silently
 *  excluded from `pollManagedStatuses()`, so its tunnel going offline is invisible in the UI. */
function toClientShape(row: LocalInferenceEndpointRow) {
	return {
		id: row.id,
		label: row.label,
		baseUrl: row.baseUrl,
		headers: row.headers,
		createdAt: row.createdAt,
		kind: row.kind,
	};
}

// A header's `value` may legitimately be empty (a header whose presence matters more than
// its content) — only `name` is required, matching the settings UI's own "Add custom header" button,
// which enables on a name alone. Capped at 50 headers/request as a sanity bound, not a measured limit. (CUR-1291)
const headerSchema = z.object({
	name: z.string().trim().min(1, "Header name is required").max(200),
	value: z.string().trim().max(2000).default(""),
});

const createSchema = z.object({
	label: z.string().trim().min(1, "Name is required").max(100),
	baseUrl: z.string().trim().min(1, "Server URL is required").max(500),
	headers: z.array(headerSchema).max(50).default([]),
});

export const GET: RequestHandler = async ({ locals }) => {
	const userId = requireUserId(locals);
	if (!localInferenceEndpointsEnabled()) error(404, "Not found");

	const rows = await listLocalEndpointsForUserId(userId);
	return superjsonResponse(rows.map(toClientShape));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	if (!localInferenceEndpointsEnabled()) error(404, "Not found");

	const parsed = createSchema.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Invalid request body");
	}

	const baseUrl = normalizeLocalBaseUrl(parsed.data.baseUrl);
	if (!baseUrl) {
		if (isRefusedLocalBaseUrl(parsed.data.baseUrl)) {
			error(
				400,
				"This server can't connect to private or local addresses such as localhost or 192.168.x.x. To use a model on your own machine, add a managed server, which connects through a secure tunnel."
			);
		}
		error(400, "Enter a valid server URL, e.g. http://localhost:11434");
	}

	const row = await createLocalEndpoint({
		userId,
		label: parsed.data.label,
		baseUrl,
		headers: parsed.data.headers,
	});
	return superjsonResponse(toClientShape(row), { status: 201 });
};
