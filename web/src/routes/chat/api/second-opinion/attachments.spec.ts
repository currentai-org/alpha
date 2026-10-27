import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

vi.mock("$lib/chat/server/api/utils/requireAuth", () => ({ requireAuth: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: vi.fn(async () => {}) }));
// One panel model that reads images (Gemma 4, by the HF router's listing) and one that doesn't (GLM-5.2,
// by the routing catalog), so each half of the contract has a real model id behind it.
const VISION = "google/gemma-4-31B-it";
const TEXT_ONLY = "zai-org/GLM-5.2";
vi.mock("$lib/chat/server/models", () => ({
	models: [
		{ id: "google/gemma-4-31B-it", displayName: "Gemma" },
		{ id: "zai-org/GLM-5.2", displayName: "GLM" },
		{ id: "aggregator", displayName: "Aggregator" },
	],
}));
vi.mock("$lib/chat/server/config", () => ({
	config: { COMPARE_PANEL: "google/gemma-4-31B-it,zai-org/GLM-5.2", AGGREGATOR_MODEL: "aggregator" },
}));
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: vi.fn(async () => ({})) }));
vi.mock("$lib/chat/server/chat/conversationWrites", () => ({
	saveConversationMessages: vi.fn(async () => {}),
	snapshotConversation: vi.fn(() => ({})),
}));
const gate = vi.hoisted(() => ({ multimodal: true }));
vi.mock("$lib/chat/server/textOnly", () => ({ multimodalEnabled: () => gate.multimodal }));

const IMAGE_BYTES = Buffer.from("not-really-a-png");
const prepareTurnMedia = vi.hoisted(() => vi.fn());
vi.mock("$lib/chat/server/chat/prepareTurnMedia", () => ({ prepareTurnMedia }));

const CONVERSATION_ID = "6ac791cf57521cfe0678163b";
let messages: Message[] = [];
const conversation = (question: Partial<Message>) =>
	[
		{ id: "s", from: "system", content: "", ancestors: [], children: ["u1"] },
		{ id: "u1", from: "user", content: "What is funny about this meme?", ancestors: ["s"], children: ["a1"], ...question },
		{ id: "a1", from: "assistant", content: "The cat is wearing a tie.", ancestors: ["s", "u1"], children: [] },
	] as unknown as Message[];
vi.mock("$lib/chat/server/api/utils/resolveConversation", () => ({
	resolveConversation: vi.fn(async () => ({ _id: CONVERSATION_ID, rootMessageId: "s", messages, userId: "u-1" })),
}));

type Sent = { from: string; content: string; files?: { value: string; mime: string }[] };
const calls: { modelId: string; messages: Sent[]; isMultimodal?: boolean }[] = [];
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: (opts: { modelId: string; messages: Sent[]; isMultimodal?: boolean }) => {
		calls.push({ modelId: opts.modelId, messages: opts.messages, isMultimodal: opts.isMultimodal });
		return (async function* () {
			yield* [];
			return opts.modelId === "aggregator" ? "AGREES" : "A cat in a tie.";
		})();
	},
}));

async function askPanel() {
	const { POST } = await import("./+server");
	const response = await POST({
		locals: { sessionId: "sess-1" } as App.Locals,
		request: new Request("http://localhost/chat/api/second-opinion", {
			method: "POST",
			body: JSON.stringify({ conversationId: CONVERSATION_ID, messageId: "a1" }),
		}),
		getClientAddress: () => "203.0.113.7",
	} as Parameters<typeof POST>[0]);
	await response.text();
}

const question = (modelId: string) => calls.find((c) => c.modelId === modelId)?.messages.at(-1);
const CANNOT_SEE = /attached a file .* that you cannot see\. Do not say that nothing was attached/;

describe("POST /chat/api/second-opinion — the question's attachments reach the panel (CUR-4670)", () => {
	beforeEach(() => {
		calls.length = 0;
		gate.multimodal = true;
		prepareTurnMedia.mockReset();
		prepareTurnMedia.mockImplementation(async () => ({
			messages: new Map([
				["u1", { finalText: "", attachedText: "", images: [{ sha: "sha-1", mime: "image/png", source: IMAGE_BYTES }] }],
			]),
		}));
	});

	it(
		"sends the attached image to a panel model that reads images, and tells a text-only one and the aggregator it cannot see it",
		async () => {
			messages = conversation({ files: [{ type: "hash", value: "sha-1", mime: "image/png", name: "meme.png" }] } as Partial<Message>);
			await askPanel();

			const vision = calls.find((c) => c.modelId === VISION);
			expect(vision?.isMultimodal).toBe(true);
			expect(question(VISION)?.files).toEqual([
				{ type: "base64", value: IMAGE_BYTES.toString("base64"), mime: "image/png", name: "sha-1" },
			]);
			expect(question(VISION)?.content).toBe("What is funny about this meme?");

			expect(question(TEXT_ONLY)?.files).toBeUndefined();
			expect(question(TEXT_ONLY)?.content).toMatch(CANNOT_SEE);
			expect(question("aggregator")?.content).toMatch(CANNOT_SEE);
			// Read from the conversation owner's own copy, the way the turn read it.
			expect(prepareTurnMedia.mock.calls[0][2]).toMatchObject({ ownerId: "u-1" });
		},
		90_000
	);

	it("tells even an image-reading model it cannot see the image when the multimodal gate is closed for this request", async () => {
		gate.multimodal = false;
		messages = conversation({ files: [{ type: "hash", value: "sha-1", mime: "image/png", name: "meme.png" }] } as Partial<Message>);
		await askPanel();
		expect(question(VISION)?.files).toBeUndefined();
		expect(question(VISION)?.content).toMatch(CANNOT_SEE);
	});

	it("still tells the panel about an attachment that would not read back, rather than sending the question as if there were none", async () => {
		prepareTurnMedia.mockRejectedValueOnce(new Error("bucket down"));
		messages = conversation({ files: [{ type: "hash", value: "sha-1", mime: "image/png", name: "meme.png" }] } as Partial<Message>);
		await askPanel();
		expect(question(VISION)?.content).toMatch(CANNOT_SEE);
		expect(question(TEXT_ONLY)?.content).toMatch(CANNOT_SEE);
	});

	it("sends a question with no attachment as plain text, with no image and no cannot-see line, and reads no files", async () => {
		messages = conversation({});
		await askPanel();
		for (const id of [VISION, TEXT_ONLY]) {
			expect(question(id)).toEqual({ from: "user", content: "What is funny about this meme?" });
		}
		expect(question("aggregator")?.content).not.toMatch(CANNOT_SEE);
		expect(prepareTurnMedia).not.toHaveBeenCalled();
	});
});
