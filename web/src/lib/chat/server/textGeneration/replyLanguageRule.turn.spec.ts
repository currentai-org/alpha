/**
 * The reply-language sentence in the fenced user turn (CUR-1430) can send Mistral Large 3 into
 * French on an English question, so a Large 3 turn goes out without it. Apertus is where the sentence
 * helps, and it must not change at all.
 *
 * This drives the real textGenerationWithoutTitle and captures the messages handed to `generate`, which
 * is the turn the model actually receives. "Before" is the same run with the per-model check forced
 * open, which is exactly the behaviour before this change, so the comparison is between two real
 * prompts rather than against a stored copy of one. (CUR-2294)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

let lastUserTurn: string | undefined;
vi.mock("./generate", () => ({
	generate: async function* (ctx: { messages: { from: string; content?: string }[] }): AsyncGenerator<MessageUpdate> {
		lastUserTurn = ctx.messages.findLast((m) => m.from === "user")?.content;
		yield { type: MessageUpdateType.FinalAnswer, text: "ok", interrupted: false };
	},
}));

let behaveAsBefore = false;
vi.mock("../harnessProfiles", async (importOriginal) => {
	const real = await importOriginal<typeof import("../harnessProfiles")>();
	return {
		...real,
		replyLanguageRuleFits: (id: string | undefined) => behaveAsBefore || real.replyLanguageRuleFits(id),
	};
});

vi.mock("../mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mcp")>()),
	mcpEnabled: () => false,
}));
vi.mock("$lib/chat/server/flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/flags")>()),
	ensureFlagsPolled: async () => {},
}));
vi.mock("../localitySemantic", () => ({ isLocalityQuerySemantic: async () => false }));
vi.mock("./worldModel", async (importOriginal) => ({
	...(await importOriginal<typeof import("./worldModel")>()),
	WORLD_MODEL_PREPASS: false,
	maybeWorldModelNote: async () => null,
}));
let preference = true;
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage: preference }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../tuning", () => ({ getTuning: async () => ({ decoding: {} }) }));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));

import { textGenerationWithoutTitle } from "./index";
import type { TextGenerationContext } from "./types";

const RULE = "Write your ENTIRE reply in the same language as the message inside the markers above";
const IDENTITY = "Do not restate your identity or maker unless the user actually asks";
const APERTUS = "swiss-ai/apertus-v1.5-70b";
const LARGE_3 = "mistral-large-2512";

/** The user turn the model receives, with the per-turn random fence name made stable. */
async function modelTurn(modelId: string, userText: string): Promise<string> {
	lastUserTurn = undefined;
	const ctx = {
		model: { id: modelId, name: modelId },
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
	for await (const _ of textGenerationWithoutTitle(ctx, new AbortController()));
	// Assigned inside the mocked generate, which control-flow narrowing cannot see.
	const turn = lastUserTurn as string | undefined;
	if (turn === undefined) throw new Error("the turn never reached generate");
	return turn.replace(/Q_[0-9a-f]{8}/g, "Q_FENCE");
}

async function beforeAndAfter(modelId: string, userText: string) {
	behaveAsBefore = true;
	const before = await modelTurn(modelId, userText);
	behaveAsBefore = false;
	const after = await modelTurn(modelId, userText);
	return { before, after };
}

beforeEach(() => {
	preference = true;
	behaveAsBefore = false;
});

describe("the reply-language sentence follows the model it misfires on (CUR-2294)", () => {
	it("an Apertus turn reaches the model byte for byte as it did before, with the sentence", async () => {
		for (const text of ["Who are you?", "Qui es-tu ?"]) {
			const { before, after } = await beforeAndAfter(APERTUS, text);
			expect(before, "precondition: the Apertus turn carried the sentence before").toContain(RULE);
			expect(after, `the Apertus turn for "${text}" changed`).toBe(before);
		}
	});

	it("a Large 3 turn loses only the sentence and keeps the rest of the guard", async () => {
		const { before, after } = await beforeAndAfter(LARGE_3, "Who are you?");
		expect(before, "precondition: the Large 3 turn carried the sentence before").toContain(RULE);
		expect(after, "the Large 3 turn still carries the reply-language sentence").not.toContain(RULE);
		expect(after, "the identity rule went with it").toContain(IDENTITY);
		expect(after.length, "more than the sentence was removed").toBeGreaterThan(before.length - 600);
	});

	it("an account that turned the rule off still gets no sentence on Apertus", async () => {
		preference = false;
		expect(await modelTurn(APERTUS, "Who are you?")).not.toContain(RULE);
	});
});
