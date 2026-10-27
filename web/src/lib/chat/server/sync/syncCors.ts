/**
 * CORS for the registered sync clients (CUR-4312). The client is a browser app on another origin, so
 * the sync routes and the three OAuth endpoints it calls with fetch (discovery, token, revoke) answer
 * that origin by name. Never a reflected Origin, never `Allow-Credentials`, and nothing for any other
 * path: the consent and authorize steps are full-page navigations and need none.
 */
import { AUTH_BASE_PATH, CHAT_API_PATH } from "$lib/chat/paths";
import { chatRoutePath } from "$lib/surface";
import { isSyncClientOrigin } from "../../../../../config/thunderbolt";

/**
 * Paths under /chat a registered client calls cross-origin. Discovery lives outside /chat. Read as the
 * route path, so the chat surface's `/api/...` form (CUR-4448) answers the same as the pinned one.
 */
export function isSyncCorsPath(pathname: string): boolean {
	const p = chatRoutePath(pathname);
	return (
		p.startsWith(`${CHAT_API_PATH}/v2/sync/`) ||
		p === `${AUTH_BASE_PATH}/oauth2/token` ||
		p === `${AUTH_BASE_PATH}/oauth2/revoke`
	);
}

/** The headers to add for `origin`, or none when it is not a registered client's origin. */
export function syncCorsHeaders(origin: string | null): Record<string, string> {
	if (!origin || !isSyncClientOrigin(origin)) return { Vary: "Origin" };
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};
}

/** A preflight's answer: 204 always, with the CORS headers only for a registered origin. */
export function syncPreflight(origin: string | null): Response {
	return new Response(null, { status: 204, headers: syncCorsHeaders(origin) });
}

/** Sets the sync CORS headers on `response`, replacing whatever the generic API branch put there. */
export function applySyncCors(response: Response, origin: string | null): Response {
	const headers = syncCorsHeaders(origin);
	try {
		response.headers.delete("Access-Control-Allow-Origin");
		response.headers.delete("Access-Control-Allow-Credentials");
		for (const [k, v] of Object.entries(headers)) {
			if (k === "Vary") response.headers.append("Vary", v);
			else response.headers.set(k, v);
		}
		return response;
	} catch {
		// Immutable headers (a fetched response): copy into a new one.
		const copy = new Response(response.body, response);
		for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
		return copy;
	}
}
