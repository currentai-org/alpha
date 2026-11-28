// Settings → Connectors: the MCP servers this chat reaches, each tool on them, and the
// person's choice for each one. Gated on the same `mcp-servers` read the turn makes, before anything
// else, so the page does not exist where the tools are never offered. Open to a guest, whose choices are
// kept by session like the rest of their settings.
//
// A signed-in person can also add a server of their own by URL with an optional bearer token, and
// remove it. Its token is sealed before it is stored and never comes back to the page. A server added
// without a token that runs the MCP authorization flow is stored as an OAuth server, and the person is
// sent straight on to sign in to it.
import { error, fail, redirect } from "@sveltejs/kit";
import { mcpConnectPath } from "$lib/chat/paths";
import type { Actions, PageServerLoad } from "./$types";
import { configuredMcpServers, mcpServersEnabled } from "$lib/chat/server/mcp/servers";
import { isReadOnly, listServerTools } from "$lib/chat/server/mcp/serverTools";
import { readMcpToolPolicies, serversForRequest } from "$lib/chat/server/mcp/turnKit";
import { checkNewServer, sealServerToken, userServerConfigs } from "$lib/chat/server/mcp/userServers";
import { oauthStateOf, serverUsesOAuth } from "$lib/chat/server/mcp/oauthConnect";
import { mcpOAuthFetchFor } from "$lib/chat/server/mcp/oauthE2eStub";
import {
	createUserMcpServer,
	deleteUserMcpServer,
	listUserMcpServers,
	type UserMcpServerRow,
} from "$lib/chat/server/db/userMcpServers";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import {
	forgetAccessToken,
	GOOGLE_SERVER_NAME,
	googleConnectApp,
	googleConnectorEnabled,
	googleGrantLacksDrive,
	googleServerFor,
} from "$lib/chat/server/connectors/google";
import { deleteUserGoogleConnection, getUserGoogleConnection } from "$lib/chat/server/db/userGoogleConnections";

const accountOf = (locals: App.Locals): string | undefined => locals.user?._id?.toString();

export const load: PageServerLoad = async ({ locals, request }) => {
	// Either flag opens the page: Connect Google is offered without the general MCP servers.
	const mcpServers = mcpServersEnabled();
	const googleOn = googleConnectorEnabled();
	if (!mcpServers && !googleOn) throw error(404, "Not found");
	const faultInjection = await resolveFaultInjection(request);
	const accountId = accountOf(locals);
	const ownRows: UserMcpServerRow[] = accountId && mcpServers ? await listUserMcpServers(accountId) : [];
	// The e2e stub is listed when the request carries its fault, so a spec sees what its turn will use.
	// An OAuth server whose sign-in this listing found no longer working moves to Reconnect below.
	const leftOut = new Set<string>();
	const onReconnectNeeded = (id: string) => void leftOut.add(id);
	const general = mcpServers
		? serversForRequest(faultInjection, userServerConfigs(ownRows, { faultInjection, onReconnectNeeded }))
		: [];
	// Listed with its tools when connected, so the page shows what a turn would offer and each tool's choice.
	const googleServer = googleOn ? await googleServerFor(locals, {}, faultInjection) : null;
	const servers = googleServer ? [...general.filter((s) => s.name !== GOOGLE_SERVER_NAME), googleServer] : general;
	const googleRow = googleOn && accountId ? await getUserGoogleConnection(accountId) : null;
	const ownIdByName = new Map(ownRows.map((r) => [r.name, r.id]));
	// An OAuth server with no tokens yet offers Connect; one whose sign-in stopped working offers
	// Reconnect. Neither is in `general`, which holds only servers a turn can reach.
	const signInOf = (row: UserMcpServerRow): "connect" | "reconnect" | null => {
		if (row.authKind !== "oauth") return null;
		if (!oauthStateOf(row).tokens?.access_token) return "connect";
		return row.needsReconnect || leftOut.has(row.id) ? "reconnect" : null;
	};
	const [tools, policies] = await Promise.all([listServerTools(servers), readMcpToolPolicies(locals)]);
	const listed = new Set(servers.map((s) => s.name));
	const signInRows = ownRows.filter((r) => (!listed.has(r.name) || leftOut.has(r.id)) && signInOf(r) !== null);
	const reachable = servers.filter((s) => !signInRows.some((r) => r.name === s.name));
	return {
		signedIn: Boolean(accountId),
		mcpServers,
		// Null when the flag is off. `available` is false when the operator has not finished setting it up.
		google: googleOn
			? {
					available: googleConnectApp() !== null,
					email: googleRow?.email ?? null,
					// A connection from before Drive, or with Drive unticked: it still serves Gmail and Calendar.
					driveMissing: googleRow ? googleGrantLacksDrive(googleRow.scopes) : false,
				}
			: null,
		servers: [
			...reachable.map((s) => ({
				name: s.name,
				// The host only: a path or query string can carry something an operator would not show.
				host: new URL(s.url).host,
				// Set for a server the person added, which they can remove; absent for the operator's.
				ownId: ownIdByName.get(s.name) ?? null,
				signIn: null as "connect" | "reconnect" | null,
				tools: tools
					.filter((t) => t.server === s.name)
					.map((t) => ({
						fnName: t.fnName,
						name: t.tool,
						description: t.definition.function.description.replace(`[${t.server}] `, ""),
						readOnly: isReadOnly(t),
					})),
			})),
			...signInRows.map((row) => ({
				name: row.name,
				host: new URL(row.url).host,
				ownId: row.id,
				signIn: signInOf(row),
				tools: [] as { fnName: string; name: string; description: string; readOnly: boolean }[],
			})),
		],
		policies,
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		if (!mcpServersEnabled()) throw error(404, "Not found");
		const accountId = accountOf(locals);
		if (!accountId) return fail(401, { error: "Sign in to add a server of your own." });
		const form = await request.formData();
		const input = {
			name: String(form.get("name") ?? ""),
			url: String(form.get("url") ?? ""),
			token: String(form.get("token") ?? ""),
		};
		const own = await listUserMcpServers(accountId);
		const taken = [...configuredMcpServers().map((s) => s.name), ...own.map((r) => r.name), GOOGLE_SERVER_NAME];
		const checked = checkNewServer(input, taken, own.length);
		// The token is never echoed back, even on a refusal.
		if (!checked.ok) return fail(400, { error: checked.error, name: input.name, url: input.url });
		const oauthFetch = mcpOAuthFetchFor(await resolveFaultInjection(request));
		if (!checked.token && (await serverUsesOAuth(checked.url, oauthFetch))) {
			const row = await createUserMcpServer({
				userId: accountId,
				name: checked.name,
				url: checked.url,
				credential: null,
				authKind: "oauth",
			});
			redirect(303, mcpConnectPath(row.id), { external: false });
		}
		await createUserMcpServer({
			userId: accountId,
			name: checked.name,
			url: checked.url,
			credential: checked.token ? sealServerToken(checked.token) : null,
		});
		return { added: checked.name };
	},
	remove: async ({ locals, request }) => {
		if (!mcpServersEnabled()) throw error(404, "Not found");
		const accountId = accountOf(locals);
		if (!accountId) return fail(401, { error: "Sign in to manage your servers." });
		const id = String((await request.formData()).get("id") ?? "");
		if (!(await deleteUserMcpServer(accountId, id))) return fail(404, { error: "That server is already gone." });
		return { removed: id };
	},
	disconnectGoogle: async ({ locals }) => {
		if (!googleConnectorEnabled()) throw error(404, "Not found");
		const accountId = accountOf(locals);
		if (!accountId) return fail(401, { error: "Sign in to manage your Google connection." });
		// Our sealed copy goes, so nothing here can use the grant again. Google keeps the grant itself until
		// the person removes Alpha at their Google account, which the page links to.
		await deleteUserGoogleConnection(accountId);
		forgetAccessToken(accountId);
		return { googleDisconnected: true };
	},
};
