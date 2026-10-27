import { error, fail, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { thunderboltSyncEnabled } from "$lib/chat/server/dataPortability";
import { disconnectSyncClient, listSyncConnections } from "$lib/chat/server/sync/syncConnections";
import { syncClientById } from "../../../../../../config/thunderbolt";
import type { Actions, PageServerLoad } from "./$types";

// Settings → Connections (CUR-4312): the apps this account lets read and write its conversations.
// Behind thunderbolt-sync; off, the page does not exist.
export const load: PageServerLoad = async ({ locals }) => {
	if (!thunderboltSyncEnabled()) error(404, "Not found");
	const baUser = locals.user?.betterAuthUserId;
	if (!baUser) redirect(303, `${base}/login?next=${encodeURIComponent(`${base}/settings/connections`)}`);
	return { connections: await listSyncConnections(baUser) };
};

export const actions: Actions = {
	disconnect: async ({ locals, request }) => {
		if (!thunderboltSyncEnabled()) error(404, "Not found");
		const baUser = locals.user?.betterAuthUserId;
		if (!baUser) error(401, "Sign in first");
		const clientId = String((await request.formData()).get("clientId") ?? "");
		const client = syncClientById(clientId);
		if (!client || !(await disconnectSyncClient(baUser, clientId))) return fail(404, { disconnected: false as const });
		return { disconnected: true as const, label: client.label };
	},
};
