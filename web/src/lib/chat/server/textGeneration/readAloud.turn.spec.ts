// A turn whose model calls its own tools reads aloud the way every turn does, through
// the one read-aloud implementation in textGenerationWithoutTitle. The contract: with read-aloud off
// nothing changes and no clip is made; with "always" the answer's own text is read and the player
// arrives before the answer is final; on a "read this aloud" turn the clip runs alongside the answer,
// the held prose never streams, and a model that declines gets its own words and no clip. (CUR-2734, CUR-2697)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import {
	type MessageUpdate,
	MessageUpdateType,
	MessageUpdateStatus,
	SPEAK_STATUS,
} from "$lib/chat/types/MessageUpdate";

const tts = vi.fn();
const model: { answer: string; final: boolean; preprompts: string[] } = { answer: "", final: true, preprompts: [] };

vi.mock("$lib/chat/server/readAloudGate", () => ({ readAloudEnabled: () => true }));
vi.mock("../mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mcp")>()),
	mcpEnabled: () => true,
	maybeRunMcpTool: (...args: unknown[]) => tts(...args),
}));
vi.mock("$lib/chat/server/flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/flags")>()),
	ensureFlagsPolled: async () => {},
}));
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage: false }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));
vi.mock("./generate", () => ({
	generate: async function* (_ctx: unknown, preprompt: string): AsyncGenerator<MessageUpdate> {
		model.preprompts.push(preprompt);
		yield { type: MessageUpdateType.Stream, token: model.answer };
		if (model.final) yield { type: MessageUpdateType.FinalAnswer, text: model.answer, interrupted: false };
	},
}));

const { textGenerationWithoutTitle } = await import("./index");
const { planFromTricks } = await import("../harness");
const { injectReadAloudJudgment } = await import("../mcp");

const CLIP = "https://tts.example.hf.space/file=clip.wav";
const clip = (text: string) => ({ tool: "tts", space: "https://tts.example.hf.space", args: { text }, result: CLIP });
const LARGE_3 = "mistral-large-2512";

function ctx(userText: string, speakMode: "off" | "auto" | "always") {
	return {
		harness: planFromTricks(new Set()),
		model: { id: LARGE_3, name: LARGE_3, endpoints: [] },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "t", messages: [], preprompt: "" },
		messages: [{ id: "u1", from: "user", content: userText, createdAt: new Date(), updatedAt: new Date() }],
		webSearchMode: "off",
		speakMode,
		promptedAt: new Date(),
		ip: "127.0.0.1",
		locals: undefined,
		abortController: new AbortController(),
	} as never;
}

/** The turn's updates, without the start and phase markers every turn sends. */
async function run(c: never, answer: string, final = true) {
	model.answer = answer;
	model.final = final;
	const out: MessageUpdate[] = [];
	for await (const u of textGenerationWithoutTitle(c, new AbortController())) {
		if (u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.Started) continue;
		if (u.type === MessageUpdateType.Status && u.message === "phase:thinking") continue;
		out.push(u);
	}
	return out;
}

beforeEach(() => {
	tts.mockReset();
	model.preprompts = [];
});

describe("read-aloud off", () => {
	it("passes the turn through untouched and makes no clip", async () => {
		const out = await run(ctx("What is the capital of Peru?", "off"), "Lima.");
		expect(out.map((u) => u.type)).toEqual([MessageUpdateType.Stream, MessageUpdateType.FinalAnswer]);
		expect(tts).not.toHaveBeenCalled();
	});
});

describe("speak mode always", () => {
	// The text does not wait for the clip; the final goes out first and the player follows. (CUR-3810)
	it("reads the answer's text, sending the final answer before the clip so the text never waits for audio", async () => {
		tts.mockResolvedValue(clip("Lima."));
		const out = await run(ctx("What is the capital of Peru?", "always"), "Lima.");
		expect(tts.mock.calls[0][1].synthesizeText).toBe("Lima.");
		const kinds = out.map((u) =>
			u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.KeepAlive ? u.message : u.type
		);
		expect(kinds).toEqual([MessageUpdateType.Stream, MessageUpdateType.FinalAnswer, SPEAK_STATUS, MessageUpdateType.Mcp]);
		expect(out.find((u) => u.type === MessageUpdateType.Mcp)).toMatchObject({ audio: CLIP });
		expect(out.find((u) => u.type === MessageUpdateType.FinalAnswer)).toMatchObject({ text: "Lima." });
	});
	it("says the audio is missing when the Space does not answer in time", async () => {
		tts.mockResolvedValue({ skipped: true, ms: 30_000 });
		const out = await run(ctx("What is the capital of Peru?", "always"), "Lima.");
		expect(out.find((u) => u.type === MessageUpdateType.Mcp)).toMatchObject({ skipped: true, skipMs: 30_000 });
	});
	it("never reads a refusal aloud", async () => {
		const out = await run(ctx("Do something bad", "always"), "I can't help with that.");
		expect(tts).not.toHaveBeenCalled();
		expect(out.at(-1)).toMatchObject({ type: MessageUpdateType.FinalAnswer, text: "I can't help with that." });
	});
});

describe("a read-aloud request", () => {
	it("starts the clip on the inline text before the answer, holds the prose, and shows what was said", async () => {
		tts.mockResolvedValue(clip("hello there"));
		const out = await run(ctx("read this aloud: hello there", "auto"), "Sure, here it is.");
		expect(tts.mock.calls[0][1].synthesizeText).toBe("hello there");
		expect(model.preprompts[0]).toBe(injectReadAloudJudgment(model.preprompts[0].split("\n\nThe user asked")[0]));
		expect(out.some((u) => u.type === MessageUpdateType.Stream)).toBe(false);
		expect(out.filter((u) => u.type === MessageUpdateType.Status && u.message === "phase:writing")).toHaveLength(1);
		expect(out.find((u) => u.type === MessageUpdateType.Mcp)).toMatchObject({ audio: CLIP });
		expect(out.at(-1)).toMatchObject({ type: MessageUpdateType.FinalAnswer, text: "hello there" });
	});
	it("plays nothing when the model declines, and shows its own words", async () => {
		tts.mockResolvedValue(clip("something awful"));
		const out = await run(ctx("read this aloud: something awful", "auto"), "I'm sorry, I won't read that.");
		expect(out.some((u) => u.type === MessageUpdateType.Mcp)).toBe(false);
		expect(out.at(-1)).toMatchObject({ text: "I'm sorry, I won't read that." });
	});
	// With the Space retired, nothing extracts the words from "say … aloud", so the model's own
	// answer is read once it exists, and the model is asked for the answer, not a confirmation. (CUR-3989)
	it("reads the model's answer when the request carries no text to speak", async () => {
		tts.mockResolvedValue(clip("Bonjour."));
		const out = await run(ctx("say good morning in French aloud", "auto"), "Bonjour.");
		expect(tts).toHaveBeenCalledTimes(1);
		expect(tts.mock.calls[0][1].synthesizeText).toBe("Bonjour.");
		expect(model.preprompts[0], "the model was asked to confirm, so its answer would be the confirmation").not.toContain(
			"The user asked to have text read aloud"
		);
		expect(out.find((u) => u.type === MessageUpdateType.Mcp)).toMatchObject({ audio: CLIP });
		expect(out.at(-1)).toMatchObject({ type: MessageUpdateType.FinalAnswer, text: "Bonjour." });
	});
	it("synthesizes nothing when a request with no text to speak gets a decline", async () => {
		const out = await run(ctx("say something awful aloud", "auto"), "I'm sorry, I won't say that.");
		expect(tts).not.toHaveBeenCalled();
		expect(out.at(-1)).toMatchObject({ text: "I'm sorry, I won't say that." });
	});
	it("gives no clip to a turn that never produced a final answer", async () => {
		tts.mockResolvedValue(clip("hi"));
		const out = await run(ctx("read this aloud: hi", "auto"), "partial", false);
		expect(out.some((u) => u.type === MessageUpdateType.Mcp || u.type === MessageUpdateType.FinalAnswer)).toBe(false);
	});
});
