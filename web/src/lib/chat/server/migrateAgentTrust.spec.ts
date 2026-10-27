import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import { deriveAgentSubject } from "$lib/chat/server/endpoints/agent/endpointAgent";

const agentServiceUrl = vi.fn(() => "http://agent.test");
const agentServiceToken = vi.fn(() => "tok");
vi.mock("$lib/chat/server/agentMode", () => ({
	agentServiceUrl: () => agentServiceUrl(),
	agentServiceToken: () => agentServiceToken(),
}));

const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: (...args: unknown[]) => warn(...args), error: vi.fn(), info: vi.fn() },
}));

// Signing in must RAISE a caller's agent-trust ceiling, never zero it. deriveAgentSubject
// switches subject from the anonymous sessionId to the signed-in user's _id, which otherwise resets
// agent-service's caller_history to a fresh "new" tier — migrateAgentTrust is the fix, mirroring
// migrateAnonymousConversations' call sites and best-effort posture. (CUR-761)
import { migrateAgentTrust } from "./migrateAgentTrust";

describe.sequential("migrateAgentTrust", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		agentServiceUrl.mockReturnValue("http://agent.test");
		agentServiceToken.mockReturnValue("tok");
		warn.mockClear();
	});

	it("no-ops with no anonymous session to migrate from", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await migrateAgentTrust(undefined, new ObjectId());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("no-ops when agent-service isn't configured (URL unset)", async () => {
		agentServiceUrl.mockReturnValue("");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await migrateAgentTrust("anon-session-1", new ObjectId());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("no-ops when agent-service auth is disabled (token unset)", async () => {
		agentServiceToken.mockReturnValue("");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await migrateAgentTrust("anon-session-1", new ObjectId());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts the real derived old/new subjects to /callers/migrate", async () => {
		const userId = new ObjectId();
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }) as Response);
		vi.stubGlobal("fetch", fetchMock);
		await migrateAgentTrust("anon-session-1", userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://agent.test/callers/migrate");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
		const body = JSON.parse(init?.body as string);
		// SAME derivation endpointAgent.ts uses for a real turn — a different one here would migrate
		// rows agent-service's own subject derivation would never look for.
		expect(body).toEqual({
			old_subject: deriveAgentSubject("tok", "anon-session-1"),
			new_subject: deriveAgentSubject("tok", userId.toString()),
		});
	});

	it("logs a warning, does not throw, on a non-ok upstream response", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as Response));
		await expect(migrateAgentTrust("anon-session-1", new ObjectId())).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});

	it("logs a warning, does not throw, when agent-service is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("fetch failed");
			})
		);
		await expect(migrateAgentTrust("anon-session-1", new ObjectId())).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});
});
