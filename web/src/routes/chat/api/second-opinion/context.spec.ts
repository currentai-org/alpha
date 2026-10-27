import { describe, it, expect, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: vi.fn(async () => {}) }));
vi.mock("$lib/chat/server/models", () => ({
	models: [
		{ id: "panelist-a", displayName: "Panelist A" },
		{ id: "aggregator", displayName: "Aggregator" },
	],
}));
vi.mock("$lib/chat/server/config", () => ({
	config: { COMPARE_PANEL: "panelist-a", AGGREGATOR_MODEL: "aggregator" },
}));
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: vi.fn(async () => ({})) }));
vi.mock("$lib/chat/server/chat/conversationWrites", () => ({
	saveConversationMessages: vi.fn(async () => {}),
	snapshotConversation: vi.fn(() => ({})),
}));

// A Swiss-cantons turn, then the follow-up the panel is asked about. With only the follow-up, a
// panelist answers about Germany's Bundesrat instead.
const CONVERSATION_ID = "6ac791cf57521cfe0678163b";
const messages: Message[] = [
	{ id: "s", from: "system", content: "", ancestors: [], children: ["u1"] },
	{ id: "u1", from: "user", content: "Wie viele Kantone hat die Schweiz?", ancestors: ["s"], children: ["a1"] },
	{ id: "a1", from: "assistant", content: "Die Schweiz hat 26 Kantone.", ancestors: ["s", "u1"], children: ["u2"] },
	{ id: "u2", from: "user", content: "Wer wählt den Bundesrat?", ancestors: ["s", "u1", "a1"], children: ["a2"] },
	{
		id: "a2",
		from: "assistant",
		content: "Die Bundesversammlung wählt den Bundesrat.",
		ancestors: ["s", "u1", "a1", "u2"],
		children: [],
	},
] as unknown as Message[];
vi.mock("$lib/chat/server/api/utils/resolveConversation", () => ({
	resolveConversation: vi.fn(async () => ({ _id: CONVERSATION_ID, rootMessageId: "s", messages })),
}));

const calls: { modelId: string; messages: { from: string; content: string }[] }[] = [];
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: (opts: { modelId: string; messages: { from: string; content: string }[] }) => {
		calls.push({ modelId: opts.modelId, messages: opts.messages });
		return (async function* () {
			yield* [];
			return opts.modelId === "aggregator" ? "AGREES" : "Die Bundesversammlung.";
		})();
	},
}));

async function askPanel() {
	const { POST } = await import("./+server");
	const response = await POST({
		locals: { sessionId: "sess-1" } as App.Locals,
		request: new Request("http://localhost/chat/api/second-opinion", {
			method: "POST",
			body: JSON.stringify({ conversationId: CONVERSATION_ID, messageId: "a2" }),
		}),
		getClientAddress: () => "203.0.113.7",
	} as Parameters<typeof POST>[0]);
	await response.text();
}

describe("POST /chat/api/second-opinion — earlier turns (CUR-3319)", () => {
	it(
		"sends each panelist and the aggregator the earlier turns, so a follow-up is judged in context",
		async () => {
			await askPanel();
			const panelist = calls.find((c) => c.modelId === "panelist-a");
			const aggregator = calls.find((c) => c.modelId === "aggregator");
			expect(panelist?.messages).toEqual([
				{ from: "user", content: "Wie viele Kantone hat die Schweiz?" },
				{ from: "assistant", content: "Die Schweiz hat 26 Kantone." },
				{ from: "user", content: "Wer wählt den Bundesrat?" },
			]);
			expect(aggregator?.messages).toHaveLength(1);
			expect(aggregator?.messages[0].content).toContain("Wie viele Kantone hat die Schweiz?");
			expect(aggregator?.messages[0].content).toContain("QUESTION:\nWer wählt den Bundesrat?");
		},
		90_000
	);
});
