import { describe, it, expect, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: vi.fn(async () => {}) }));
vi.mock("$lib/chat/server/models", () => ({
	models: [
		{ id: "accepts-none", displayName: "Accepts none" },
		{ id: "refuses-none", displayName: "Refuses none" },
		{ id: "refuses-all", displayName: "Refuses all" },
		{ id: "answers-empty", displayName: "Answers empty" },
		{ id: "aggregator", displayName: "Aggregator" },
	],
}));
vi.mock("$lib/chat/server/config", () => ({
	config: { COMPARE_PANEL: "accepts-none,answers-empty,refuses-all", AGGREGATOR_MODEL: "aggregator" },
}));
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: vi.fn(async () => ({})) }));
const saved: Message[][] = [];
vi.mock("$lib/chat/server/chat/conversationWrites", () => ({
	saveConversationMessages: vi.fn(async (_c: unknown, _s: unknown, update: { messages: Message[] }) => {
		saved.push(update.messages);
	}),
	snapshotConversation: vi.fn(() => ({})),
}));

const CONVERSATION_ID = "6ac791cf57521cfe0678163c";
const messages: Message[] = [
	{ id: "s", from: "system", content: "", ancestors: [], children: ["u1"] },
	{ id: "u1", from: "user", content: "What is the capital of Australia?", ancestors: ["s"], children: ["a1"] },
	{ id: "a1", from: "assistant", content: "Canberra.", ancestors: ["s", "u1"], children: [] },
] as unknown as Message[];
vi.mock("$lib/chat/server/api/utils/resolveConversation", () => ({
	resolveConversation: vi.fn(async () => ({ _id: CONVERSATION_ID, rootMessageId: "s", messages })),
}));

// Each call as the lane saw it. `refuses-none` behaves as Bielik behind the gateway's vLLM does: a 400
// for `reasoning_effort: "none"`, an answer without the field. `refuses-all` refuses either way.
const calls: { modelId: string; reasoningEffort?: string }[] = [];
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: (opts: {
		modelId: string;
		reasoningEffort?: string;
		onFailure?: (kind: "ceiling" | "error", status?: number) => void;
	}) => {
		calls.push({ modelId: opts.modelId, reasoningEffort: opts.reasoningEffort });
		const refused =
			opts.modelId === "refuses-all" || (opts.modelId === "refuses-none" && opts.reasoningEffort === "none");
		if (refused) opts.onFailure?.("error", 400);
		if (opts.modelId === "answers-empty") return (async function* () { yield* []; return ""; })();
		return (async function* () {
			yield* [];
			if (refused) return "";
			return opts.modelId === "aggregator" ? "AGREES" : "Canberra.";
		})();
	},
}));

async function askPanel(): Promise<Record<string, unknown>[]> {
	const { POST } = await import("./+server");
	const response = await POST({
		locals: { sessionId: "sess-1" } as App.Locals,
		request: new Request("http://localhost/chat/api/second-opinion", {
			method: "POST",
			body: JSON.stringify({ conversationId: CONVERSATION_ID, messageId: "a1" }),
		}),
		getClientAddress: () => "203.0.113.7",
	} as Parameters<typeof POST>[0]);
	return (await response.text())
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}

describe("POST /chat/api/second-opinion — a listed panelist that gives no take", () => {
	it(
		"lists every panelist that gave no take, empty or failed, in the done event and on the saved message, so the panel never shows fewer than it listed",
		async () => {
			const events = await askPanel();
			const done = events.find((e) => e.type === "done") as {
				opinions: { model: string }[];
				unanswered?: { model: string; reason: string }[];
			};
			expect(done.opinions.map((o) => o.model)).toEqual(["accepts-none"]);
			expect(done.unanswered).toEqual([
				expect.objectContaining({ model: "answers-empty", reason: "empty" }),
				expect.objectContaining({ model: "refuses-all", reason: "failed" }),
			]);
			const stored = saved.at(-1)?.find((m) => m.id === "a1");
			expect(stored?.unanswered?.map((u) => u.model)).toEqual(["answers-empty", "refuses-all"]);
		},
		90_000
	);
});
