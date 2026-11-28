import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import { mcpServersEnabled } from "$lib/chat/server/mcp/servers";
import {
	MCP_CONNECT_COOKIE,
	MCP_CONNECT_COOKIE_PATH,
	mcpOAuthCallbackUrl,
	startMcpConnect,
} from "$lib/chat/server/mcp/oauthConnect";
import { getUserMcpServer } from "$lib/chat/server/db/userMcpServers";
import { newState } from "$lib/chat/server/storage/locations/hfOAuth";
import { CONNECT_TTL_SECONDS, sealConnectState } from "$lib/chat/server/storage/locations/connectState";
import { credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";

const CONNECTORS = `${base}/settings/connectors`;

// Connect (or Reconnect) on one of the person's own OAuth MCP servers lands here. The SDK registers
// the client if it has to, starts PKCE and names the provider's consent page; the state and server id
// go into a short-lived cookie bound to the account, and the browser goes to the provider.
export const GET: RequestHandler = async ({ locals, cookies, params, url }) => {
	if (!mcpServersEnabled()) error(404, "Not found");
	const accountId = locals.user?._id?.toString();
	if (!accountId) error(401, "Sign in to connect a server.");
	const row = await getUserMcpServer(accountId, params.id ?? "");
	if (!row || row.authKind !== "oauth") error(404, "Not found");
	const redirectUrl = mcpOAuthCallbackUrl();
	if (!redirectUrl) {
		logger.error("[mcp-oauth] PUBLIC_ORIGIN is unset, so no OAuth MCP server can be connected");
		error(503, "Connecting this server isn't set up here.");
	}
	const state = newState();
	let started: Awaited<ReturnType<typeof startMcpConnect>>;
	try {
		started = await startMcpConnect(row, { redirectUrl, stateParam: state });
	} catch (e) {
		logger.warn(
			{ leg: "mcp-oauth", server: row.name, err: e instanceof Error ? e.message : String(e) },
			"[mcp-oauth] starting a sign-in failed"
		);
		redirect(303, `${CONNECTORS}?mcp_error=failed`);
	}
	if (started.kind === "authorized") redirect(303, `${CONNECTORS}?mcp=connected`);
	cookies.set(MCP_CONNECT_COOKIE, sealConnectState({ state, verifier: "", accountId, serverId: row.id }, credentialSecret()), {
		path: MCP_CONNECT_COOKIE_PATH,
		httpOnly: true,
		secure: url.protocol === "https:",
		// Lax, so the cookie rides the top-level redirect back from the provider.
		sameSite: "lax",
		maxAge: CONNECT_TTL_SECONDS,
	});
	// The consent page is on the provider's origin: SvelteKit 3 refuses an off-origin redirect without this.
	redirect(303, started.url.href, { external: true });
};
