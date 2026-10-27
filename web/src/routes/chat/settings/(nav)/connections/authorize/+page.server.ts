import { error, redirect } from "@sveltejs/kit";
import { thunderboltSyncEnabled } from "$lib/chat/server/dataPortability";
import { signInForAuthorize } from "$lib/chat/server/sync/authorizeResume";
import { SYNC_SCOPE, syncClientById } from "../../../../../../../config/thunderbolt";
import type { PageServerLoad } from "./$types";

// The OAuth consent step (CUR-4312). The oauth-provider plugin sends a signed-in person here with a
// signed copy of the authorize request in the query; Allow or Deny posts that query back to
// /chat/api/auth/oauth2/consent, which answers with the redirect_uri to send the browser to.
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!thunderboltSyncEnabled()) error(404, "Not found");
	if (!locals.user?.betterAuthUserId) redirect(303, signInForAuthorize(url.searchParams));
	const client = syncClientById(url.searchParams.get("client_id"));
	const scopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
	if (!client || !scopes.includes(SYNC_SCOPE)) return { client: null };
	return { client: { label: client.label, host: new URL(client.origin).host } };
};
