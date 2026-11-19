import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { getRequestContext, runWithRequestContext } from "$lib/chat/server/requestContext";

// A scenario run's panel must replay like the turn it checks: every panelist and the aggregator run
// under the request's replay mode, so a recorded panel calls no model. Before this, each run's panel
// went live, and two of its calls were GLM-5.2 on the provider whose concurrency units production
// shares (hfProviderPin.ts).

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: vi.fn(async () => {}) }));
vi.mock("$lib/chat/server/models", () => ({
	models: [
		{ id: "panelist-a", displayName: "Panelist A" },
		{ id: "panelist-b", displayName: "Panelist B" },
		{ id: "aggregator", displayName: "Aggregator" },
	],
}));
vi.mock("$lib/chat/server/config", () => ({
	config: { COMPARE_PANEL: "panelist-a,panelist-b", AGGREGATOR_MODEL: "aggregator" },
}));
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: vi.fn(async () => ({})) }));
vi.mock("$lib/chat/server/chat/conversationWrites", () => ({
	saveConversationMessages: vi.fn(async () => {}),
	snapshotConversation: vi.fn(() => ({})),
}));
// The gate itself (token, environment) is faultInjection.spec.ts's subject; this stands in for a request
// that passed it.
vi.mock("$lib/chat/server/textGeneration/faultInjection", () => ({
	resolveFaultInjection: vi.fn(async () => null),
	resolveReplayMode: vi.fn(async (req: Request) => req.headers.get("x-e2e-replay")),
}));

const CONVERSATION_ID = "6ac791cf57521cfe0678163b";
const messages: Message[] = [
	{ id: "s", from: "system", content: "", ancestors: [], children: ["u1"] },
	{ id: "u1", from: "user", content: "What is the capital of Australia?", ancestors: ["s"], children: ["a1"] },
	{ id: "a1", from: "assistant", content: "Canberra.", ancestors: ["s", "u1"], children: [] },
] as unknown as Message[];
vi.mock("$lib/chat/server/api/utils/resolveConversation", () => ({
	resolveConversation: vi.fn(async () => ({ _id: CONVERSATION_ID, rootMessageId: "s", messages })),
}));

// The replay mode each model call saw, read where endpointOai.ts and openaiClient.ts read it.
const seen: Array<{ model: string; replayMode: unknown }> = [];
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: (opts: { modelId: string }) => {
		seen.push({ model: opts.modelId, replayMode: getRequestContext()?.replayMode });
		return (async function* () {
			yield* [];
			return opts.modelId === "aggregator" ? "AGREES" : "Canberra.";
		})();
	},
}));

async function askPanel(headers: Record<string, string>): Promise<void> {
	const { POST } = await import("./+server");
	await runWithRequestContext(async () => {
		const response = await POST({
			locals: { sessionId: "sess-1" } as App.Locals,
			request: new Request("http://localhost/chat/api/second-opinion", {
				method: "POST",
				headers,
				body: JSON.stringify({ conversationId: CONVERSATION_ID, messageId: "a1" }),
			}),
			getClientAddress: () => "203.0.113.7",
		} as Parameters<typeof POST>[0]);
		await response.text();
	});
}

describe("POST /chat/api/second-opinion — scenario replay", () => {
	beforeEach(() => {
		seen.length = 0;
	});

	it("runs every panelist and the aggregator under the replay mode a scenario request asks for", async () => {
		await askPanel({ "x-e2e-replay": "mock" });
		expect(seen.map((s) => s.model).sort()).toEqual(["aggregator", "panelist-a", "panelist-b"]);
		expect(seen.every((s) => s.replayMode === "mock")).toBe(true);
	}, 90_000);

	it("runs a request that asks for no replay live", async () => {
		await askPanel({});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((s) => s.replayMode === undefined)).toBe(true);
	}, 90_000);
});
