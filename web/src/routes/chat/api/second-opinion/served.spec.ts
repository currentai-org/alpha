import { describe, it, expect, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

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
const saved: { messages: Message[] }[] = [];
vi.mock("$lib/chat/server/chat/conversationWrites", () => ({
	saveConversationMessages: vi.fn(async (_filter: unknown, _snap: unknown, update: { messages: Message[] }) => {
		saved.push(update);
	}),
	snapshotConversation: vi.fn(() => ({})),
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

// Panelist A's response carries a routing record, as a gateway or HF router call does; panelist B's
// carries none.
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: (opts: {
		modelId: string;
		onServed?: (s: { requestedModel?: string; backend?: string; provider?: string }) => void;
	}) => {
		opts.onServed?.({ requestedModel: opts.modelId });
		if (opts.modelId === "panelist-a") opts.onServed?.({ backend: "router.huggingface.co", provider: "scaleway" });
		return (async function* () {
			yield* [];
			return opts.modelId === "aggregator" ? "AGREES" : "Canberra.";
		})();
	},
}));

async function askPanel(): Promise<{ opinions?: Message["opinions"] }> {
	const { POST } = await import("./+server");
	const response = await POST({
		locals: { sessionId: "sess-1" } as App.Locals,
		request: new Request("http://localhost/chat/api/second-opinion", {
			method: "POST",
			body: JSON.stringify({ conversationId: CONVERSATION_ID, messageId: "a1" }),
		}),
		getClientAddress: () => "203.0.113.7",
	} as Parameters<typeof POST>[0]);
	const lines = (await response.text()).trim().split("\n").map((l) => JSON.parse(l));
	return lines.find((l) => l.type === "done") ?? {};
}

describe("POST /chat/api/second-opinion — where each take ran (CUR-3563)", () => {
	it(
		"stores each take with the host its own call reported, and no host for a call that reported none",
		async () => {
			const done = await askPanel();
			const byModel = new Map((done.opinions ?? []).map((o) => [o.model, o]));
			expect(byModel.get("panelist-a")).toMatchObject({ backend: "router.huggingface.co", provider: "scaleway" });
			expect(byModel.get("panelist-b")?.backend).toBeUndefined();
			expect(byModel.get("panelist-b")?.provider).toBeUndefined();

			const stored = saved.at(-1)?.messages.find((m) => m.id === "a1")?.opinions ?? [];
			expect(stored.find((o) => o.model === "panelist-a")).toMatchObject({ provider: "scaleway" });
		},
		90_000
	);
});
