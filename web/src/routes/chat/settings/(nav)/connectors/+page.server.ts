// Settings → Connectors (CUR-3984): the MCP servers this chat reaches, each tool on them, and the
// person's choice for each one. Gated on the same `mcp-servers` read the turn makes, before anything
// else, so the page does not exist where the tools are never offered. Open to a guest, whose choices are
// kept by session like the rest of their settings.
//
// A signed-in person can also add a server of their own by URL with an optional bearer token, and
// remove it (CUR-4016). Its token is sealed before it is stored and never comes back to the page.
import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { configuredMcpServers, mcpServersEnabled } from "$lib/chat/server/mcp/servers";
import { isReadOnly, listServerTools } from "$lib/chat/server/mcp/serverTools";
import { readMcpToolPolicies, serversForRequest } from "$lib/chat/server/mcp/turnKit";
import { checkNewServer, sealServerToken, userServerConfigs } from "$lib/chat/server/mcp/userServers";
import {
	createUserMcpServer,
	deleteUserMcpServer,
	listUserMcpServers,
	type UserMcpServerRow,
} from "$lib/chat/server/db/userMcpServers";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";

const accountOf = (locals: App.Locals): string | undefined => locals.user?._id?.toString();

export const load: PageServerLoad = async ({ locals, request }) => {
	if (!mcpServersEnabled()) throw error(404, "Not found");
	const faultInjection = await resolveFaultInjection(request);
	const accountId = accountOf(locals);
	const ownRows: UserMcpServerRow[] = accountId ? await listUserMcpServers(accountId) : [];
	// The e2e stub is listed when the request carries its fault, so a spec sees what its turn will use.
	const servers = serversForRequest(faultInjection, userServerConfigs(ownRows, { faultInjection }));
	const ownIdByName = new Map(ownRows.map((r) => [r.name, r.id]));
	const [tools, policies] = await Promise.all([listServerTools(servers), readMcpToolPolicies(locals)]);
	return {
		signedIn: Boolean(accountId),
		servers: servers.map((s) => ({
			name: s.name,
			// The host only: a path or query string can carry something an operator would not show.
			host: new URL(s.url).host,
			// Set for a server the person added, which they can remove; absent for the operator's.
			ownId: ownIdByName.get(s.name) ?? null,
			tools: tools
				.filter((t) => t.server === s.name)
				.map((t) => ({
					fnName: t.fnName,
					name: t.tool,
					description: t.definition.function.description.replace(`[${t.server}] `, ""),
					readOnly: isReadOnly(t),
				})),
		})),
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
		const taken = [...configuredMcpServers().map((s) => s.name), ...own.map((r) => r.name)];
		const checked = checkNewServer(input, taken, own.length);
		// The token is never echoed back, even on a refusal.
		if (!checked.ok) return fail(400, { error: checked.error, name: input.name, url: input.url });
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
};
