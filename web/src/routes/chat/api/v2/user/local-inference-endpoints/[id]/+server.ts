/** Remove one of the signed-in user's local inference endpoints. See the collection route (CUR-1262)
 *  (../+server.ts) for the shared auth/gate reasoning. */
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import {
	deleteLocalEndpoint,
	getLocalEndpointForUserAndId,
} from "$lib/chat/server/db/localInferenceEndpoints";
import { revokeManagedEndpoint } from "$lib/chat/server/managedInference/revoke";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const userId = requireUserId(locals);
	if (!localInferenceEndpointsEnabled()) error(404, "Not found");

	const id = params.id ?? "";
	const row = await getLocalEndpointForUserAndId(userId, id);

	// best-effort revoke on the tunnel side before deleting our own row -- never block the
	// delete on Pangolin's API succeeding (same fail-soft posture as prewarmLocalModel). (CUR-1266)
	if (row?.kind === "managed" && row.managedConfig) {
		await revokeManagedEndpoint(row.managedConfig, id);
	}

	// deleteLocalEndpoint scopes the delete to (userId, id) together — a caller can never delete a row
	// that isn't theirs by guessing/reusing another user's id, and "not mine" and "doesn't exist" both
	// come back as the same 404 (a caller has no business telling those apart).
	const deleted = await deleteLocalEndpoint(userId, id);
	if (!deleted) error(404, "Not found");

	return superjsonResponse({ success: true });
};
