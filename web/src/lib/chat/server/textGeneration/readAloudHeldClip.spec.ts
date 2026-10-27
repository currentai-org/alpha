/**
 * An explicit "read this aloud: X" turn starts TTS in parallel with generation and holds the
 * clip until the model has answered. When the model never answers (a gateway 503 after exhausted
 * retries, a stream cut off), the route adds "No output was generated" to the bubble. The held clip
 * must not be surfaced next to it: a playable player over an error is a reply that says it both worked
 * and failed (CUR-2022).
 *
 * This drives the real textGenerationWithoutTitle. Only the edges are stubbed: the model call
 * (`generate`), the TTS Space (`maybeRunMcpTool`) and the pre-passes that would otherwise reach a
 * network. isReadAloudIntent, the held-clip logic and the compose step all run for real. (CUR-2045)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const CLIP = "https://tts.example.hf.space/file=/tmp/gradio/clip.wav";

const state: { final: string | null } = { final: null };

// Ends without a FinalAnswer when state.final is null: the shape a turn has after the gateway sheds
// its substituted model until the retries run out.
vi.mock("./generate", () => ({
	generate: async function* (): AsyncGenerator<MessageUpdate> {
		if (state.final === null) return;
		yield { type: MessageUpdateType.Stream, token: state.final };
		yield { type: MessageUpdateType.FinalAnswer, text: state.final, interrupted: false };
	},
}));

const ttsCalls: string[] = [];
vi.mock("../mcp", async (importOriginal) => {
	const real = await importOriginal<typeof import("../mcp")>();
	return {
		...real,
		mcpEnabled: () => true,
		maybeRunMcpTool: async (_msg: string, opts?: { synthesizeText?: string }) => {
			ttsCalls.push(opts?.synthesizeText ?? "");
			return {
				tool: "generate_speech_audio",
				args: { text: opts?.synthesizeText ?? "" },
				result: CLIP,
				space: "https://tts.example.hf.space",
			};
		},
	};
});
vi.mock("$lib/chat/server/readAloudGate", () => ({ readAloudEnabled: () => true }));
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

function ctx(userText: string): TextGenerationContext {
	const message = (from: "user" | "assistant", content: string) => ({
		id: crypto.randomUUID(),
		from,
		content,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return {
		model: { id: "swiss-ai/Apertus-70B-Instruct", name: "Apertus" },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "t", messages: [], preprompt: "" },
		messages: [message("user", userText)],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		locals: undefined,
		abortController: new AbortController(),
	} as unknown as TextGenerationContext;
}

async function run(userText: string): Promise<MessageUpdate[]> {
	const out: MessageUpdate[] = [];
	for await (const u of textGenerationWithoutTitle(ctx(userText), new AbortController())) out.push(u);
	return out;
}

const audioUpdates = (updates: MessageUpdate[]) =>
	updates.filter((u) => u.type === MessageUpdateType.Mcp && "audio" in u && u.audio);

const PROMPT = "read this aloud: the bread is in the oven";

beforeEach(() => {
	state.final = null;
	ttsCalls.length = 0;
});

describe("a held read-aloud clip follows the turn's outcome (CUR-2045)", () => {
	it("surfaces no clip when the turn ends without a final answer", async () => {
		const updates = await run(PROMPT);
		// Precondition: the intent path really fired and synthesized the inline text, so an absent clip
		// below is the gate withholding it rather than the path never running.
		expect(ttsCalls, "the read-aloud intent path never started TTS").toEqual([
			"the bread is in the oven",
		]);
		expect(
			audioUpdates(updates),
			"a clip was surfaced on a turn that produced no answer, so the bubble would show a player over the error"
		).toEqual([]);
		expect(updates.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(false);
	});

	it("still plays the clip when the turn answers", async () => {
		state.final = "the bread is in the oven";
		const updates = await run(PROMPT);
		expect(audioUpdates(updates), "a successful read-aloud turn lost its clip").toHaveLength(1);
		const final = updates.find((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(final, "the composed answer is missing").toBeDefined();
	});
});
