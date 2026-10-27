import { describe, it, expect, vi, beforeEach } from "vitest";

// What this file exists to prevent: the classifier being asked of a DIFFERENT model than the one that
// will answer the turn. It does not announce itself: a route that drops `servingModel` measures the
// registry default while a real turn measures a substituted checkpoint, and every response still has
// the right SHAPE until the two checkpoints stop sharing a threshold. An omitted optional argument has
// no error surface, so it needs an assertion or nothing can contradict it.
//
// THE CORRECT ARGUMENT IS NO ARGUMENT (CUR-243), and that is a real claim rather than the absence of
// one. Each decide* falls back to `defaultModel`, the registrations are collapsed, so `defaultModel`
// IS what a default turn gets. These tests fail if a serving-model override is ever reintroduced here
// — which is the point: reintroducing one means a substitution came back, and the threshold this route
// measures against is calibrated per model. Update the contract in the same change; do not silence
// the test.

const DEFAULT_MODEL = { id: "swiss-ai/apertus-v1.5-70b", name: "swiss-ai/apertus-v1.5-70b" };

// models.ts runs a live buildModels() at import time (needs OPENAI_BASE_URL + network), so the route
// can only be imported hermetically with this stubbed.
vi.mock("$lib/chat/server/models", () => ({
	models: [DEFAULT_MODEL],
	defaultModel: DEFAULT_MODEL,
	taskModel: DEFAULT_MODEL,
}));

// The parameters are spelled out so `mock.calls[0][3]` is a TYPED read of the serving-model argument.
// With `vi.fn(async () => …)` the call tuple infers as `[]` and indexing it is a compile error — which
// would have pushed this spec toward asserting something weaker than the argument itself.
type ServingModel = { id: string; name?: string } | undefined;
const decideMock = vi.fn(
	async (_q: string, _l: unknown, _recency?: boolean, _m?: ServingModel) =>
		({
			search: true,
			query: "latest AI news today",
			preShaped: false,
			decider: "embedding",
			fallback: undefined,
		}) as {
			search: boolean;
			query: string;
			preShaped: boolean;
			decider: string;
			fallback?: string;
		}
);
vi.mock("$lib/chat/server/search/runSearch", () => ({ decideWebSearch: decideMock }));

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: () => {} }));

// The route now calls enforceRequestRateLimits before any strategy branch — mocked here (not
// exercised for real) since this file's premise is DB-less. See rateLimit.spec.ts for the wiring itself. (CUR-926)
const rateLimitMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimitMock }));

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const call = async (q = "latest AI news today") => {
	const { GET } = await import("./+server");
	const locals = {} as App.Locals;
	return GET({
		locals,
		url: new URL(`http://localhost/chat/api/search/classify?q=${encodeURIComponent(q)}`),
		request: new Request("http://localhost"),
		getClientAddress: () => "203.0.113.7",
	} as Parameters<typeof GET>[0]);
};

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.PUBLIC_SEARCH_TRIGGER = "margin";
	rateLimitMock.mockReset().mockResolvedValue(undefined);
	decideMock.mockClear();
});

describe("GET /chat/api/search/classify — answers with what a chat turn decides", () => {
	it("overrides the serving model with NOTHING, so it resolves the same defaultModel a turn does", async () => {
		await call();
		expect(decideMock).toHaveBeenCalledTimes(1);
		expect(decideMock.mock.calls[0][3]).toBeUndefined();
	});

	it("reports which decider ran and ok:true when it gave a verdict", async () => {
		// verify-prod-config.mjs reads `decider` and `ok` off this surface to prove the configured gate
		// is the one deciding, so both have to be present on the happy path.
		const res = await call();
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			shouldSearch: true,
			decider: "embedding",
			ok: true,
		});
	});

	it("reports the fallback and ok:false when the decider gave no verdict (CUR-2108)", async () => {
		// The case the old route could not express: the regex deciding in the gate's place. Before
		// CUR-2108 a failed completion decider came back as shouldSearch:false with nothing else, which
		// reads exactly like the model declining.
		decideMock.mockResolvedValueOnce({
			search: false,
			query: "q",
			preShaped: false,
			decider: "embedding",
			fallback: "embedding-no-vector",
		});
		const res = await call();
		await expect(res.json()).resolves.toEqual({
			shouldSearch: false,
			decider: "embedding",
			fallback: "embedding-no-vector",
			ok: false,
		});
	});
});
