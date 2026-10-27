/**
 * A turn that asks for no audio must not run the read-aloud tool. Otherwise "summarise this
 * agenda" can get a TTS result injected and an answer saying "Here is your text read aloud". The plain
 * path (no read-aloud intent) called the tool router with `allowTts: ttsAllowed`, which is true whenever
 * the `read-aloud` flag is on, so the router's own LLM was the only thing deciding against TTS.
 *
 * This drives the real textGenerationWithoutTitle, the same harness as readAloudHeldClip.spec.ts. The
 * stubbed router selects TTS whenever it is allowed to, which is the misfire made deterministic: the
 * contract is that a turn with no read-aloud intent never lets the router reach TTS at all. (CUR-2162)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const CLIP = "https://tts.example.hf.space/file=/tmp/gradio/clip.wav";

vi.mock("./generate", () => ({
	generate: async function* (): AsyncGenerator<MessageUpdate> {
		yield { type: MessageUpdateType.Stream, token: "ok" };
		yield { type: MessageUpdateType.FinalAnswer, text: "ok", interrupted: false };
	},
}));

const routerCalls: { allowTts: boolean | undefined }[] = [];
vi.mock("../mcp", async (importOriginal) => {
	const real = await importOriginal<typeof import("../mcp")>();
	return {
		...real,
		mcpEnabled: () => true,
		maybeRunMcpTool: async (_msg: string, opts?: { allowTts?: boolean; synthesizeText?: string }) => {
			routerCalls.push({ allowTts: opts?.allowTts });
			if (!opts?.allowTts) return null;
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
	return {
		model: { id: "swiss-ai/Apertus-70B-Instruct", name: "Apertus" },
		endpoint: {},
		conv: { _id: new ObjectId(), title: "t", messages: [], preprompt: "" },
		messages: [
			{
				id: crypto.randomUUID(),
				from: "user",
				content: userText,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
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

const ttsUpdates = (updates: MessageUpdate[]) =>
	updates.filter(
		(u) =>
			u.type === MessageUpdateType.Mcp &&
			(("audio" in u && !!u.audio) || ("tool" in u && u.tool === "generate_speech_audio"))
	);

// The message from the CUR-2162 sample, verbatim.
const AGENDA = `Can you summarise this agenda in three bullet points for our board?

1. Welcome and apologies
2. Treasurer's report: the roof repair came in 4,000 over budget
3. Vote on raising membership fees from 20 to 25
4. Summer fete: volunteers needed for the tea tent
5. Any other business`;

beforeEach(() => {
	routerCalls.length = 0;
});

describe("a turn with no read-aloud intent never reaches TTS (CUR-2162)", () => {
	it("never asks for a clip on a summary request, so it gets none (CUR-3989 removed the plain-path router)", async () => {
		const updates = await run(AGENDA);
		expect(routerCalls, "a turn that asked for no audio still called read-aloud").toEqual([]);
		expect(ttsUpdates(updates), "a TTS result reached a turn that asked for no audio").toEqual([]);
	});

	it("still allows TTS on an explicit read-aloud request", async () => {
		const updates = await run("read this aloud: the bread is in the oven");
		expect(routerCalls.some((c) => c.allowTts === true), "the read-aloud path lost TTS").toBe(true);
		expect(ttsUpdates(updates), "an explicit read-aloud turn lost its clip").toHaveLength(1);
	});
});
