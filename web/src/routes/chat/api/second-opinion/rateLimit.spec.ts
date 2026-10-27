import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));

const rateLimitMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimitMock }));

vi.mock("$lib/chat/server/models", () => ({
	models: [{ id: "test-panelist", displayName: "Test Panelist" }],
}));
vi.mock("$lib/chat/server/config", () => ({ config: { COMPARE_PANEL: "test-panelist" } }));

// getTuning is the first thing the route does once past the rate-limit gate and before the panel
// fanout — making it throw a marker error lets these tests prove the gate ran (and where it sits in
// the sequence) without having to drive the whole streamed fanout, which needs a much heavier mock
// surface (generateFromDefaultEndpoint, model identity, persistence) that this ticket doesn't touch.
const TUNING_REACHED = new Error("tuning-reached");
const getTuningMock = vi.fn(async () => {
	throw TUNING_REACHED;
});
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: getTuningMock }));

const resolveConversationMock = vi.fn(async () => ({
	_id: "6ac791cf57521cfe0678163b",
	rootMessageId: "u1",
	messages: [
		{ id: "u1", from: "user", content: "is this true?", ancestors: [], children: ["a1"] },
		{ id: "a1", from: "assistant", content: "yes", ancestors: ["u1"], children: [] },
	],
}));
vi.mock("$lib/chat/server/api/utils/resolveConversation", () => ({
	resolveConversation: resolveConversationMock,
}));

const locals = { sessionId: "sess-1" } as App.Locals;
const clientAddress = "203.0.113.7";

const call = async (body: Record<string, string> = { conversationId: "6ac791cf57521cfe0678163b", messageId: "a1" }) => {
	const { POST } = await import("./+server");
	const request = new Request("http://localhost/chat/api/second-opinion", {
		method: "POST",
		body: JSON.stringify(body),
	});
	return POST({
		locals,
		request,
		getClientAddress: () => clientAddress,
	} as Parameters<typeof POST>[0]);
};

// Deliberately NOT vi.resetModules() here. Both tests reconfigure the SAME mocked function's return
// value fresh each run (below), not any state on the imported +server module itself, so resetting the
// module cache buys nothing but a second full cold re-import of +server.ts's real (unmocked) import
// tree — database, auth, generateFromDefaultEndpoint, identity — on every single test in this file.
// That's real, avoidable work with no correctness benefit, and this suite is sensitive to
// load-induced timeouts (30s testTimeout under host memory pressure). Removing it doesn't make the
// process immune to host starvation, but it removes one unnecessary source of slowness.
beforeEach(() => {
	rateLimitMock.mockReset().mockResolvedValue(undefined);
	getTuningMock.mockClear();
	resolveConversationMock.mockClear();
});

// A free-text question with no conversation used to go straight to the panel, unscreened. (CUR-3518)
describe("POST /chat/api/second-opinion — the question comes only from the caller's conversation (CUR-3518)", () => {
	it(
		"refuses a question-only request with 400 before the limiter, the conversation lookup or the panel",
		async () => {
			await expect(call({ question: "anything at all" })).rejects.toMatchObject({ status: 400 });
			expect(resolveConversationMock).not.toHaveBeenCalled();
			expect(rateLimitMock).not.toHaveBeenCalled();
			expect(getTuningMock).not.toHaveBeenCalled();
		},
		90_000
	);

	it(
		"refuses with 400 when messageId's parent is not a user turn, so no question text is invented",
		async () => {
			await expect(
				call({ conversationId: "6ac791cf57521cfe0678163b", messageId: "u1" })
			).rejects.toMatchObject({ status: 400 });
			expect(getTuningMock).not.toHaveBeenCalled();
		},
		90_000
	);
});

// One /api/second-opinion request fans out to FOUR model completions (the panel plus the
// aggregator), and requireAuth alone never metered it. These tests prove the chat turn's own limiter
// now gates this route too, keyed the same way, before the panel fanout. (CUR-832)
describe("POST /chat/api/second-opinion — rate limiting (CUR-832)", () => {
	// Explicit per-test timeout, above the project's own 30s default (vite.config.ts) — this file's
	// actual work is a few mocked async calls and finishes in milliseconds under normal load; the
	// margin exists purely to survive host scheduling delays outside the test's control (CUR-981:
	// this test can still hit the 30s default under a load spike even without the cold re-import).
	// There is no slow code here.
	it(
		"keys the limiter on the session id and the real client address, then proceeds past it",
		async () => {
			await expect(call()).rejects.toBe(TUNING_REACHED);
			expect(rateLimitMock).toHaveBeenCalledWith({ userId: "sess-1", clientAddress });
		},
		90_000
	);

	it(
		"propagates a 429 from the limiter and never reaches the panel fanout",
		async () => {
			rateLimitMock.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
			await expect(call()).rejects.toMatchObject({ status: 429 });
			expect(getTuningMock).not.toHaveBeenCalled();
		},
		90_000
	);
});
