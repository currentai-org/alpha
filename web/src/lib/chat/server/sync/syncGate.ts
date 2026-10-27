/**
 * The gate every /chat/api/v2/sync/* route opens with (CUR-4312). A request reaches a sync route
 * authenticated by a sync access token or not at all (auth.ts `authenticateSyncRequest`); a session
 * cookie never counts here. Order: no or bad token 401, a token without the scope 403, then the
 * thunderbolt-sync flag for the token's account, off answering 404 as if the route did not exist.
 */
import { thunderboltSyncEnabled } from "$lib/chat/server/dataPortability";

export type SyncCaller = { user: NonNullable<App.Locals["user"]>; clientId: string };

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function syncGate(locals: App.Locals): SyncCaller | Response {
	const sync = locals.sync;
	if (sync?.error === "not_permitted") return json(403, { error: "not_permitted" });
	if (!sync || sync.error || !locals.user || !sync.clientId) return json(401, { error: "unauthenticated" });
	if (!thunderboltSyncEnabled()) return json(404, { error: "not_found" });
	return { user: locals.user, clientId: sync.clientId };
}

export { json as syncJson };
