/**
 * Provision a new "managed" local inference endpoint from the settings page's Pair
 * button — a device behind a firewall/NAT, reached through Pangolin's reverse tunnel instead of a
 * public URL the user types themselves. See the collection route (`../+server.ts`) for the shared
 * auth/gate reasoning and `managedInference/provision.ts` for what provisioning does.
 *
 * Returns the install flags `aipotluck-local-client`'s installer takes directly
 * (`--tunnel-id/--tunnel-secret/--tunnel-endpoint`) -- never a raw shell command, and never shown
 * again after this response. CUR-4110's pairing link (chat/local-inference/pair) provisions the
 * same way and hands the flags to the CLI instead. (CUR-1266)
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { discloseToOwner } from "$lib/chat/server/api/utils/noSecretFields";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { managedInferenceEnabled } from "$lib/chat/server/managedInferenceGate";
import { provisionManagedEndpoint } from "$lib/chat/server/managedInference/provision";

// Same shape and bounds as the collection route's own header schema (../+server.ts) — a header's
// `value` may legitimately be empty, since presence can be what matters.
const headerSchema = z.object({
	name: z.string().trim().min(1, "Header name is required").max(200),
	value: z.string().trim().max(2000).default(""),
});

const createSchema = z.object({
	label: z.string().trim().min(1, "Name is required").max(100),
	// The settings page's advanced options are shared by both add forms, so a managed pair
	// can carry custom headers too. Optional, because every caller before this one sent none. (CUR-3168)
	headers: z.array(headerSchema).max(50).default([]),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	if (!managedInferenceEnabled()) error(404, "Not found");

	const parsed = createSchema.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Invalid request body");
	}

	const { row, installArgs } = await provisionManagedEndpoint({
		userId,
		label: parsed.data.label,
		headers: parsed.data.headers,
	});

	return superjsonResponse(
		{
			id: row.id,
			label: row.label,
			installArgs: {
				tunnelId: installArgs.tunnelId,
				// The owner's installer needs it, and this response is the only time it is shown.
				tunnelSecret: discloseToOwner(installArgs.tunnelSecret),
				tunnelEndpoint: installArgs.tunnelEndpoint,
			},
		},
		{ status: 201 }
	);
};
