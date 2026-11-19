/**
 * maybeRunMcpTool — the `allowTts` gate (speak = "off" must suppress TTS end-to-end), and the two
 * read-aloud faults (canned clip, Space down) that e2e uses in place of real synthesis.
 */
import { ObjectId } from "bson";

/** The conversation a read-aloud clip is sealed to; the speech route plays it only for its owner. */
const CONV = new ObjectId();
import { describe, expect, it, beforeEach, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as Record<string, string | undefined> }));
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));
// router.ts reads defaultModel at import; stub models so importing it doesn't trigger a live fetch.
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));
/** Fresh module instance so module state starts clean. */
async function freshModule() {
	vi.resetModules();
	return import("./index");
}

beforeEach(() => {
	for (const k of Object.keys(mockConfig)) delete mockConfig[k];
	mockConfig.BETTER_AUTH_SECRET = "test-secret-for-sealing-clips";
});

describe("maybeRunMcpTool — synthesizeText can't bypass off (finding #1)", () => {
	it("off + explicit read-aloud payload synthesizes nothing", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("Read this aloud: hi", { conversationId: CONV,
			allowTts: false,
			synthesizeText: "hi",
		});

		expect(res).toBeNull();
	});
});

describe("maybeRunMcpTool — the tts_canned_clip fault answers without the Space", () => {
	const CLIP = "https://pr-preview.example/e2e/canned-read-aloud.wav";

	it("canned clip set + TTS allowed → returns the canned clip", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("Read this aloud: hi", { conversationId: CONV, synthesizeText: "hi", cannedClipUrl: CLIP });

		expect(res).toMatchObject({ result: CLIP, args: { text: "hi" } });
	});

	it("canned clip set + speak off → still null: the fault never gives audio to a turn that may not speak", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("Read this aloud: hi", { conversationId: CONV,
			allowTts: false,
			synthesizeText: "hi",
			cannedClipUrl: CLIP,
		});

		expect(res).toBeNull();
	});

	it("no canned clip → a real read-aloud clip, never the canned one (the fault is the only way in)", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("say that aloud", { conversationId: CONV, synthesizeText: "hi" });

		expect(res).toMatchObject({ tool: "read_aloud", result: expect.stringMatching(/^\/chat\/api\/speech\//) });
	});
});

describe("maybeRunMcpTool — the tts_space_down fault skips as a timed-out Space does", () => {
	it("space down + TTS allowed → a skip marker", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("Read this aloud: hi", { conversationId: CONV, synthesizeText: "hi", spaceDown: true });

		expect(res).toEqual({ skipped: true, ms: 0 });
	});

	it("space down + speak off → null, so a turn that may not speak never shows a read-aloud note", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("Read this aloud: hi", { conversationId: CONV,
			allowTts: false,
			synthesizeText: "hi",
			spaceDown: true,
		});

		expect(res).toBeNull();
	});
});

describe("maybeRunMcpTool — read-aloud shows the answer and speaks its words", () => {
	const ANSWER = "Le **CDD** est un contrat à durée déterminée.\n\n```js\nconst x = 1;\n```\n\nVoir [Service public](https://www.service-public.fr) pour le détail [1].";

	it("keeps the Markdown in the transcript the visitor sees, and seals only the speakable words", async () => {
		const { maybeRunMcpTool } = await freshModule();
		const { openSpeechClip } = await import("./readAloudSpeech");

		const res = await maybeRunMcpTool("lis-le à voix haute", { conversationId: CONV, synthesizeText: ANSWER });

		expect(res).toMatchObject({ tool: "read_aloud" });
		const { args, result: url } = res as unknown as { args: { text: string }; result: string };
		const shown = args.text;
		expect(shown).toContain("**CDD**");
		expect(shown).toContain("const x = 1;");
		const clip = openSpeechClip(url.split("/").pop() ?? "");
		expect(clip?.text).not.toContain("**");
		expect(clip?.text).not.toContain("const x");
	});

	// The voice reads an emoji as a sound, a laugh for 😂. This follows an emoji answer from
	// the turn to the request the voice receives: the speech route opens the clip and hands it to
	// synthesizeSpeech, so the `input` here is exactly what is read aloud.
	it("sends the voice the answer's words with every emoji removed, while the visitor's transcript keeps them", async () => {
		mockConfig.HF_TOKEN = "hf_test_token";
		const { maybeRunMcpTool } = await freshModule();
		const { openSpeechClip, synthesizeSpeech } = await import("./readAloudSpeech");
		const answer =
			"Great question 😂! The bread 🍞 is in the oven 👩🏽‍🍳, and France 🇫🇷 bakes it best ❤️.\n\n- Step 1️⃣: knead the dough 👍";
		const sent: { input: string }[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(new Uint8Array([1, 2, 3]));
		});
		try {
			const res = await maybeRunMcpTool("read it aloud", { conversationId: CONV, synthesizeText: answer });
			expect(res).toMatchObject({ tool: "read_aloud" });
			const { args, result: url } = res as unknown as { args: { text: string }; result: string };
			expect(args.text, "the transcript the visitor sees lost its emoji").toContain("😂");

			const clip = openSpeechClip(url.split("/").pop() ?? "");
			expect(clip, "the sealed clip did not open").not.toBeNull();
			await synthesizeSpeech(clip!);

			expect(sent).toHaveLength(1);
			const input = sent[0].input;
			expect(input, "the voice was sent an emoji, which it reads as a sound").not.toMatch(
				/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️|⃣/u
			);
			expect(input).toContain("Great question");
			expect(input).toContain("The bread is in the oven");
			expect(input).toContain("France bakes it best");
			expect(input).toContain("Step 1: knead the dough");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("skips, rather than sealing an empty clip, when the answer is only a code block", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("read it aloud", { conversationId: CONV, synthesizeText: "```sh\nls -la\n```" });

		expect(res).toMatchObject({ skipped: true });
		expect(res).not.toHaveProperty("result");
	});

	it("seals no clip without a conversation, since the speech route plays a clip only for its owner", async () => {
		const { maybeRunMcpTool } = await freshModule();

		const res = await maybeRunMcpTool("read it aloud", { synthesizeText: "The bread is in the oven." });

		expect(res).toMatchObject({ skipped: true, failed: true });
		expect(res).not.toHaveProperty("result");
	});
});
