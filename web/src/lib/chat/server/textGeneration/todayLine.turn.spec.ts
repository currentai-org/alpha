/**
 * Every turn's system prompt names today's date in the person's own zone, searched or not, so
 * "what's today?" never leaves the model guessing from training. Drives the real textGeneration with the
 * edge stubs cannedReply.turn.spec.ts uses, and reads the preprompt `generate` receives. (CUR-2276)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const state = { preprompts: [] as (string | undefined)[] };

vi.mock("./generate", () => ({
	generate: async function* (_ctx: unknown, preprompt?: string): AsyncGenerator<MessageUpdate> {
		state.preprompts.push(preprompt);
		yield { type: MessageUpdateType.FinalAnswer, text: "model text", interrupted: false };
	},
}));
vi.mock("./title", async (importOriginal) => ({
	...(await importOriginal<typeof import("./title")>()),
	generateTitleForConversation: async function* (): AsyncGenerator<MessageUpdate> {
		yield { type: MessageUpdateType.Title, title: "model title", source: "model" };
	},
}));
vi.mock("../mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mcp")>()),
	mcpEnabled: () => false,
}));
vi.mock("./worldModel", async (importOriginal) => ({
	...(await importOriginal<typeof import("./worldModel")>()),
	WORLD_MODEL_PREPASS: false,
	maybeWorldModelNote: async () => null,
}));
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage: false }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../tuning", () => ({ getTuning: async () => ({ decoding: {} }) }));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));
vi.mock("./grounding", async (importOriginal) => ({
	...(await importOriginal<typeof import("./grounding")>()),
	hardenLastUserTurn: async () => undefined,
}));

import { textGeneration } from "./index";
import type { TextGenerationContext } from "./types";

function ctx(modelId: string, timezone: string): TextGenerationContext {
	const question = {
		id: crypto.randomUUID(),
		from: "user",
		content: "What day of the week is it?",
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	return {
		model: { id: modelId, name: modelId },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "New Chat", model: modelId, messages: [question], preprompt: "" },
		messages: [question],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		webSearchMode: "off",
		locals: { timezone } as App.Locals,
		abortController: new AbortController(),
	} as unknown as TextGenerationContext;
}

async function preprompt(modelId: string, timezone: string): Promise<string> {
	state.preprompts = [];
	for await (const _ of textGeneration(ctx(modelId, timezone))) void _;
	expect(state.preprompts.length).toBeGreaterThan(0);
	return state.preprompts[0] ?? "";
}

describe("an unsearched turn's system prompt names today in the person's zone (CUR-2276)", () => {
	// 22:30 UTC on Thursday 1 October is already Friday 2 October in Tokyo.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-01T22:30:00.000Z"));
	});
	afterEach(() => vi.useRealTimers());

	for (const modelId of ["swiss-ai/Apertus-8B-Instruct-2509", "mistral-large-2512"]) {
		it(`${modelId}: says Friday, 2 October in Tokyo, a day ahead of UTC`, async () => {
			expect(await preprompt(modelId, "Asia/Tokyo")).toContain("Friday, 2 October 2026 (Asia/Tokyo)");
		});
	}
});
