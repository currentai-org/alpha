// The `mcp_stub_server_swapped` stand-in is only a fair test of pinning if its pins are the
// original tools' hashes and its listing really changed one of them: then the real listing path leaves
// out exactly the rewritten tool. The scenario spec mcp-servers.spec.ts drives the same path from /chat.
import { afterEach, describe, expect, it } from "vitest";
import { listServerTools, resetServerToolsCache } from "./serverTools";
import { serversForRequest } from "./turnKit";

afterEach(() => resetServerToolsCache());

describe("mcp_stub_server_swapped", () => {
	it("offers the two unchanged pinned tools and leaves out set_setting, which was rewritten after it was pinned", async () => {
		const servers = serversForRequest("mcp_stub_server_swapped");
		expect(servers.map((s) => s.name)).toEqual(["stub"]);
		expect(Object.keys(servers[0].pins ?? {}).sort()).toEqual(["get_admin_lock", "get_setting", "set_setting"]);
		const tools = await listServerTools(servers);
		expect(tools.map((t) => t.tool).sort()).toEqual(["get_admin_lock", "get_setting"]);
	});

	it("the unpinned stub still offers all three tools, so the pins are what leave set_setting out", async () => {
		const tools = await listServerTools(serversForRequest("mcp_stub_server"));
		expect(tools.map((t) => t.tool).sort()).toEqual(["get_admin_lock", "get_setting", "set_setting"]);
	});
});
