import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import { mcpServersEnabled } from "$lib/chat/server/mcp/servers";
import {
	finishMcpConnect,
	MCP_CONNECT_COOKIE,
	MCP_CONNECT_COOKIE_PATH,
	mcpOAuthCallbackUrl,
} from "$lib/chat/server/mcp/oauthConnect";
import { getUserMcpServer } from "$lib/chat/server/db/userMcpServers";
import { checkConnectState } from "$lib/chat/server/storage/locations/connectState";
import { credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";

const CONNECTORS = `${base}/settings/connectors`;

function back(outcome: "connected" | "denied" | "failed"): never {
	redirect(303, outcome === "connected" ? `${CONNECTORS}?mcp=connected` : `${CONNECTORS}?mcp_error=${outcome}`);
}

// The provider sends the browser back here after its consent screen. Check the sealed state against
// the account, find the server it was for, let the SDK trade the code for tokens, and go back to
// Connectors, which reads `mcp` or `mcp_error` and says what happened.
export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	if (!mcpServersEnabled()) error(404, "Not found");
	const accountId = locals.user?._id?.toString();
	if (!accountId) error(401, "Sign in to connect a server.");
	const sealed = cookies.get(MCP_CONNECT_COOKIE);
	cookies.delete(MCP_CONNECT_COOKIE, { path: MCP_CONNECT_COOKIE_PATH });
	if (url.searchParams.get("error") === "access_denied") back("denied");
	const checked = checkConnectState(sealed, url.searchParams.get("state"), accountId, credentialSecret());
	if (!checked.ok || !checked.serverId) {
		logger.warn({ leg: "mcp-oauth", reason: checked.ok ? "no-server" : checked.reason }, "[mcp-oauth] callback refused");
		back("failed");
	}
	const row = await getUserMcpServer(accountId, checked.serverId);
	const redirectUrl = mcpOAuthCallbackUrl();
	const code = url.searchParams.get("code");
	if (!row || row.authKind !== "oauth" || !redirectUrl || !code) back("failed");
	try {
		await finishMcpConnect(row, { redirectUrl, code, iss: url.searchParams.get("iss") ?? undefined });
	} catch (e) {
		logger.warn(
			{ leg: "mcp-oauth", server: row.name, err: e instanceof Error ? e.message : String(e) },
			"[mcp-oauth] the code exchange failed"
		);
		back("failed");
	}
	logger.info({ leg: "mcp-oauth", server: row.name }, "[mcp-oauth] a server connected");
	back("connected");
};
