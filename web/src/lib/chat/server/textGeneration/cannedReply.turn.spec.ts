/**
 * `canned_reply` answers a turn with fixed text and calls no model for the answer or the title,
 * so a scenario spec that checks only our UI costs no model call and cannot fail on what a model wrote.
 *
 * Drives the real textGeneration with the edge stubs missingDocument.turn.spec.ts uses; `generate` and
 * the title generator count their calls, so the "no model call" half is checked too. (SOL-91)
 */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const state = { generateCalls: 0, titleCalls: 0 };

vi.mock("./generate", () => ({
	generate: async function* (): AsyncGenerator<MessageUpdate> {
		state.generateCalls++;
		yield { type: MessageUpdateType.Stream, token: "model text" };
		yield { type: MessageUpdateType.FinalAnswer, text: "model text", interrupted: false };
	},
}));
vi.mock("./title", async (importOriginal) => ({
	...(await importOriginal<typeof import("./title")>()),
	generateTitleForConversation: async function* (): AsyncGenerator<MessageUpdate> {
		state.titleCalls++;
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
import type { FaultInjectionName } from "./faultInjection";

function ctx(faultInjection: FaultInjectionName | null): TextGenerationContext {
	const question = {
		id: crypto.randomUUID(),
		from: "user",
		content: "Which rivers run through Bern and Basel?",
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	return {
		model: { id: "mistral-large-2512", name: "Mistral Large 3" },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "New Chat", model: "mistral-large-2512", messages: [question], preprompt: "" },
		messages: [question],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		locals: undefined,
		abortController: new AbortController(),
		faultInjection,
	} as unknown as TextGenerationContext;
}

async function run(fault: FaultInjectionName | null): Promise<MessageUpdate[]> {
	const out: MessageUpdate[] = [];
	for await (const u of textGeneration(ctx(fault))) out.push(u as MessageUpdate);
	return out;
}

describe("canned_reply answers with fixed text and no model call (SOL-91)", () => {
	it("streams the fixed answer and calls neither the answer model nor the title model", async () => {
		state.generateCalls = 0;
		state.titleCalls = 0;
		const updates = await run("canned_reply");
		const streamed = updates
			.filter((u) => u.type === MessageUpdateType.Stream)
			.map((u) => (u as { token: string }).token)
			.join("");
		const final = updates.find((u) => u.type === MessageUpdateType.FinalAnswer) as { text: string } | undefined;
		expect(final?.text).toMatch(/^This is a canned reply: no model wrote it\./);
		expect(streamed, "the streamed tokens and the final answer disagree").toBe(final?.text);
		expect(final?.text, "a code block would add a second Copy button to every canned answer").not.toContain("```");
		expect(state.generateCalls, "the answer model was called").toBe(0);
		expect(state.titleCalls, "the title model was called").toBe(0);
	});

	it("stamps the turn as a fixed reply ahead of the answer and names no model (CUR-2954)", async () => {
		const updates = await run("canned_reply");
		const types = updates.map((u) => u.type);
		expect(updates.find((u) => u.type === MessageUpdateType.FixedReply)).toEqual({
			type: MessageUpdateType.FixedReply,
			kind: "canned",
		});
		expect(types.indexOf(MessageUpdateType.FixedReply)).toBeLessThan(types.indexOf(MessageUpdateType.FinalAnswer));
		expect(
			updates.find((u) => u.type === MessageUpdateType.RouterMetadata),
			"a routing record would name a model for a reply no model wrote"
		).toBeUndefined();
	});

	it("titles the conversation from the question's first five words", async () => {
		const updates = await run("canned_reply");
		expect(updates.find((u) => u.type === MessageUpdateType.Title)).toEqual({
			type: MessageUpdateType.Title,
			title: expect.stringMatching(/^Which rivers run through Bern/),
			source: "titling-disabled",
		});
	});

	it("leaves a turn with no fault on the model for both", async () => {
		state.generateCalls = 0;
		state.titleCalls = 0;
		await run(null);
		expect(state.generateCalls).toBe(1);
		expect(state.titleCalls).toBe(1);
	});
});

describe("grounded_answer_hedges searches, then hedges with no model call (CUR-4339)", () => {
	it("sends web sources before a one-sentence hedge, the whole-answer bail the sources pointer replaces", async () => {
		state.generateCalls = 0;
		state.titleCalls = 0;
		const updates = await run("grounded_answer_hedges");
		const types = updates.map((u) => u.type);
		const search = updates.find((u) => u.type === MessageUpdateType.WebSearch) as
			| { sources: Array<{ title: string }> }
			| undefined;
		const final = updates.find((u) => u.type === MessageUpdateType.FinalAnswer) as { text: string } | undefined;
		expect(search?.sources.map((s) => s.title), "no sources for the pointer to name").toContain("Tokyo");
		expect(types.indexOf(MessageUpdateType.WebSearch)).toBeLessThan(types.indexOf(MessageUpdateType.Stream));
		expect(final?.text).toBe("I cannot access real-time information right now.");
		expect(state.generateCalls, "the answer model was called").toBe(0);
		expect(state.titleCalls, "the title model was called").toBe(0);
	});
});
