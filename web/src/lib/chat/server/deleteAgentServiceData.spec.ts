import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "http://agent.test/" as string | undefined, token: "t" as string | undefined }));
vi.mock("$lib/chat/server/agentMode", () => ({
	agentServiceUrl: () => env.url,
	agentServiceToken: () => env.token,
}));
vi.mock("$lib/chat/server/endpoints/agent/endpointAgent", () => ({
	deriveAgentSubject: (_token: string, visitor: string) => `subj-${visitor}`,
}));

import { deleteAgentServiceData, deleteAgentSessions } from "./deleteAgentServiceData";

afterEach(() => {
	vi.unstubAllGlobals();
	env.url = "http://agent.test/";
	env.token = "t";
});

describe("deleteAgentSessions (CUR-4484)", () => {
	it("asks agent-service to delete the conversations' sandboxes under the visitor's own subject", async () => {
		const fetchMock = vi.fn(async () => Response.json({ workdirs_deleted: 1, sandboxes_deleted: 2 }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await deleteAgentSessions("user-1", ["c1", "c2"])).toBe(2);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://agent.test/sessions/delete");
		expect(JSON.parse(init.body as string)).toEqual({ subject: "subj-user-1", session_ids: ["c1", "c2"] });
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
	});

	it("never throws when agent-service is down or refuses: the chat delete still succeeds", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
		expect(await deleteAgentSessions("user-1", ["c1"])).toBeUndefined();
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
		expect(await deleteAgentSessions("user-1", ["c1"])).toBeUndefined();
	});

	it("makes no call when agent mode has no service here or there is nothing to delete", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(await deleteAgentSessions("user-1", [])).toBeUndefined();
		expect(await deleteAgentSessions(undefined, ["c1"])).toBeUndefined();
		env.url = undefined;
		expect(await deleteAgentSessions("user-1", ["c1"])).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("deleteAgentServiceData (CUR-1722)", () => {
	it("asks agent-service to delete the visitor's whole history and returns the task count", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tasks_deleted: 4, workdirs_deleted: 1 }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await deleteAgentServiceData("user-1")).toBe(4);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://agent.test/callers/delete");
		expect(JSON.parse(init.body as string)).toEqual({ subject: "subj-user-1" });
	});
});
