/**
 * A turn that names a document nobody gave is answered with a fixed note and no model call
 * (CUR-1835). The turn must carry a FixedReply stamp, so the receipt doesn't credit a model that never ran.
 *
 * Drives the real textGenerationWithoutTitle with the same edge stubs as readAloudHeldClip.spec.ts.
 * `generate` records whether it was reached, so the "no model call" half is checked as well. (CUR-2124)
 */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const state = { generateCalls: 0 };

vi.mock("./generate", () => ({
	generate: async function* (): AsyncGenerator<MessageUpdate> {
		state.generateCalls++;
		yield { type: MessageUpdateType.Stream, token: "model text" };
		yield { type: MessageUpdateType.FinalAnswer, text: "model text", interrupted: false };
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

import { textGenerationWithoutTitle } from "./index";
import type { TextGenerationContext } from "./types";

function ctx(userText: string, harness?: { kind: "native" }): TextGenerationContext {
	return {
		...(harness ? { harness } : {}),
		model: { id: "swiss-ai/Apertus-70B-Instruct", name: "Apertus" },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "t", messages: [], preprompt: "" },
		messages: [
			{ id: crypto.randomUUID(), from: "user", content: userText, createdAt: new Date(), updatedAt: new Date() },
		],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		locals: undefined,
		abortController: new AbortController(),
	} as unknown as TextGenerationContext;
}

async function run(userText: string, harness?: { kind: "native" }): Promise<MessageUpdate[]> {
	const out: MessageUpdate[] = [];
	for await (const u of textGenerationWithoutTitle(ctx(userText, harness), new AbortController())) out.push(u);
	return out;
}

describe("the missing-document reply is stamped as a fixed reply (CUR-2124)", () => {
	it("stamps FixedReply 'missing-document' before the answer, and never calls the model", async () => {
		state.generateCalls = 0;
		const updates = await run("Translate the letter below into French.");
		const types = updates.map((u) => u.type);
		const fixed = updates.find((u) => u.type === MessageUpdateType.FixedReply);
		expect(fixed, "the fixed note went out unstamped, so the receipt credits a model").toEqual({
			type: MessageUpdateType.FixedReply,
			kind: "missing-document",
		});
		expect(types.indexOf(MessageUpdateType.FixedReply)).toBeLessThan(types.indexOf(MessageUpdateType.FinalAnswer));
		expect(state.generateCalls).toBe(0);
	});

	it("a turn with nothing missing is not stamped", async () => {
		state.generateCalls = 0;
		const updates = await run("What is the capital of Peru?");
		expect(updates.some((u) => u.type === MessageUpdateType.FixedReply)).toBe(false);
		expect(state.generateCalls).toBe(1);
	});
});

// The native harness skips the scaffolded pre-passes, so this guard must also run on a native
// turn, or the model writes its own reply to a request for a document nobody gave. (CUR-2275)
describe("the missing-document reply holds on a native turn", () => {
	it("answers with the stamped fixed note and never calls the model", async () => {
		state.generateCalls = 0;
		const updates = await run("Translate the letter below into French.", { kind: "native" });
		expect(updates.find((u) => u.type === MessageUpdateType.FixedReply)).toEqual({
			type: MessageUpdateType.FixedReply,
			kind: "missing-document",
		});
		expect(state.generateCalls).toBe(0);
	});

	it("lets a native turn with nothing missing reach the model", async () => {
		state.generateCalls = 0;
		const updates = await run("What is the capital of Peru?", { kind: "native" });
		expect(updates.some((u) => u.type === MessageUpdateType.FixedReply)).toBe(false);
		expect(state.generateCalls).toBe(1);
	});
});
