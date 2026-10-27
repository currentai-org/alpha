import { describe, it, expect, vi, beforeEach } from "vitest";

// /api/search/classify reaches a real model call (decideWebSearch's deciders) behind only
// requireAuth — the same gap CUR-832 already fixed on its three
// siblings (/api/search, /api/second-opinion, /api/transcribe). These tests prove the SAME limiter now
// gates this route too, keyed the same way, before the decision runs. (CUR-926)

const DEFAULT_MODEL = { id: "swiss-ai/apertus-v1.5-70b", name: "swiss-ai/apertus-v1.5-70b" };
vi.mock("$lib/chat/server/models", () => ({
	models: [DEFAULT_MODEL],
	defaultModel: DEFAULT_MODEL,
	taskModel: DEFAULT_MODEL,
}));

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));

const rateLimitMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimitMock }));

const decideMock = vi.fn(async () => ({
	search: true,
	query: "q",
	preShaped: false,
	decider: "embedding",
}));
vi.mock("$lib/chat/server/search/runSearch", () => ({ decideWebSearch: decideMock }));

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const locals = {} as App.Locals;
const clientAddress = "203.0.113.7";

const call = async (q = "latest AI news today") => {
	const { GET } = await import("./+server");
	return GET({
		locals,
		url: new URL(`http://localhost/chat/api/search/classify?q=${encodeURIComponent(q)}`),
		getClientAddress: () => clientAddress,
	} as Parameters<typeof GET>[0]);
};

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.PUBLIC_SEARCH_TRIGGER = "margin";
	rateLimitMock.mockReset().mockResolvedValue(undefined);
	decideMock.mockClear();
});

describe("GET /chat/api/search/classify — rate limiting (CUR-926)", () => {
	it("keys the limiter on the session id and the real client address, gating before the model call", async () => {
		locals.sessionId = "sess-1";
		await call();
		expect(rateLimitMock).toHaveBeenCalledWith({ userId: "sess-1", clientAddress });
		expect(decideMock).toHaveBeenCalledTimes(1);
	});

	it("propagates a 429 from the limiter and never reaches the decision", async () => {
		rateLimitMock.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
		await expect(call()).rejects.toMatchObject({ status: 429 });
		expect(decideMock).not.toHaveBeenCalled();
	});
});
