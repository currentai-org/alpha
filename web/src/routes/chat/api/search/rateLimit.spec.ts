import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));

const rateLimitMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimitMock }));

const openSearchMock = vi.fn(async () => ({
	query: "q",
	sources: [],
	evidence: "",
	asOf: new Date().toISOString(),
}));
vi.mock("$lib/chat/server/search/openSearch", () => ({ openSearch: openSearchMock }));

const contextualizeQueryMock = vi.fn(async (q: string) => q);
vi.mock("$lib/chat/server/search/queryRewrite", () => ({ contextualizeQuery: contextualizeQueryMock }));

const locals = { sessionId: "sess-1" } as App.Locals;
const clientAddress = "203.0.113.7";

beforeEach(() => {
	vi.resetModules();
	rateLimitMock.mockReset().mockResolvedValue(undefined);
	openSearchMock.mockClear();
	contextualizeQueryMock.mockClear();
});

// /api/search runs a rewrite model call (POST with history) plus a search-fanout model call
// (GET and POST both, inside openSearch), and requireAuth alone never metered either — a guest cookie
// could loop this route with zero counter. These tests prove the SAME limiter the chat turn uses now
// gates both handlers, keyed the same way (session id, real client address), and gates BEFORE the
// model spend rather than after it. (CUR-832)
describe("GET /chat/api/search — rate limiting (CUR-832)", () => {
	it("keys the limiter on the session id and the real client address", async () => {
		const { GET } = await import("./+server");
		await GET({
			locals,
			url: new URL("http://localhost/chat/api/search?q=hello"),
			getClientAddress: () => clientAddress,
		} as Parameters<typeof GET>[0]);
		expect(rateLimitMock).toHaveBeenCalledWith({ userId: "sess-1", clientAddress });
	});

	it("propagates a 429 from the limiter and never reaches openSearch", async () => {
		rateLimitMock.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
		const { GET } = await import("./+server");
		await expect(
			GET({
				locals,
				url: new URL("http://localhost/chat/api/search?q=hello"),
				getClientAddress: () => clientAddress,
			} as Parameters<typeof GET>[0])
		).rejects.toMatchObject({ status: 429 });
		expect(openSearchMock).not.toHaveBeenCalled();
	});
});

describe("POST /chat/api/search — rate limiting (CUR-832)", () => {
	it("gates BEFORE contextualizeQuery's rewrite call when history is present", async () => {
		rateLimitMock.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
		const { POST } = await import("./+server");
		const request = new Request("http://localhost/chat/api/search", {
			method: "POST",
			body: JSON.stringify({
				q: "what about it?",
				history: [{ from: "user", content: "tell me about foo" }],
			}),
		});
		await expect(
			POST({ locals, request, getClientAddress: () => clientAddress } as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 429 });
		expect(contextualizeQueryMock).not.toHaveBeenCalled();
		expect(openSearchMock).not.toHaveBeenCalled();
	});

	it("reaches openSearch when the limiter allows the request", async () => {
		const { POST } = await import("./+server");
		const request = new Request("http://localhost/chat/api/search", {
			method: "POST",
			body: JSON.stringify({ q: "hello" }),
		});
		const res = await POST({
			locals,
			request,
			getClientAddress: () => clientAddress,
		} as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		expect(openSearchMock).toHaveBeenCalledTimes(1);
	});
});
