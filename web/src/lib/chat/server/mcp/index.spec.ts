/**
 * MCP entry-point coverage:
 *  - extractMediaUrls: pulls media asset URLs out of a tool result so generation can surface them
 *    deterministically when the model drops them.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// Mutable mocked config so each test can set its own token sources. Stub the transport/router too so
// importing index.ts doesn't drag in models.ts (which throws on unset OPENAI_BASE_URL at module load).
const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as Record<string, string | undefined> }));
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));
vi.mock("$lib/chat/server/mcp/client", () => ({ connectMcp: vi.fn() }));

import {
	extractMediaUrls,
	stripMediaUrls,
	stripSpaceMediaUrls,
	isAudioUrl,
	extractToolInputText,
	isReadPriorAloud,
	isModelDecline,
	capForSpeech,
	stripCitationsForSpeech,
} from "$lib/chat/server/mcp/index";

beforeEach(() => {
	for (const k of Object.keys(mockConfig)) delete mockConfig[k];
});

describe("extractMediaUrls", () => {
	const WAV = "https://x.hf.space/gradio_api/file=/tmp/gradio/abc/audio.wav";

	it("extracts a media URL from a bare result", () => {
		expect(extractMediaUrls(WAV)).toEqual([WAV]);
	});

	it("extracts a media URL wrapped in quotes/prose", () => {
		expect(extractMediaUrls(`Here you go: '${WAV}' enjoy`)).toEqual([WAV]);
	});

	it("matches image and video extensions too, with query strings", () => {
		expect(extractMediaUrls("https://x.hf.space/a.png?token=1")).toEqual([
			"https://x.hf.space/a.png?token=1",
		]);
		expect(extractMediaUrls("https://x.hf.space/clip.mp4#t=2")).toEqual([
			"https://x.hf.space/clip.mp4#t=2",
		]);
	});

	it("ignores non-media URLs and plain text", () => {
		expect(extractMediaUrls("see https://huggingface.co/docs for details")).toEqual([]);
		expect(extractMediaUrls("You have exceeded your ZeroGPU quota. Try again.")).toEqual([]);
		expect(extractMediaUrls("")).toEqual([]);
	});

	it("dedups repeated URLs", () => {
		expect(extractMediaUrls(`${WAV} and again ${WAV}`)).toEqual([WAV]);
	});
});

describe("stripMediaUrls — removes model-emitted media URLs so OUR player append is the only surfacing", () => {
	const WAV = "https://x.hf.space/gradio_api/file=/tmp/gradio/abc/audio.wav";

	it("strips a bare URL the model echoed", () => {
		expect(stripMediaUrls(`Here is your audio: ${WAV}`, [WAV])).toBe("Here is your audio");
	});

	it("strips a URL the model wrapped in square brackets (renders as a bare link, no player)", () => {
		// The model can emit `[<url>]`, which markdown turns into a plain
		// link, not an <audio> player. Strip it so our deterministic append is the only media surfacing.
		expect(stripMediaUrls(`Here is the audio: [${WAV}]`, [WAV])).toBe("Here is the audio");
	});

	it("collapses a markdown link [label](url) to just its label", () => {
		expect(stripMediaUrls(`Listen [here](${WAV}) please`, [WAV])).toBe("Listen here please");
	});

	it("strips an angle-bracket-wrapped URL", () => {
		expect(stripMediaUrls(`audio <${WAV}>`, [WAV])).toBe("audio");
	});

	it("leaves prose without the URL untouched", () => {
		expect(stripMediaUrls("Here is your text read aloud.", [WAV])).toBe(
			"Here is your text read aloud."
		);
		expect(stripMediaUrls("", [WAV])).toBe("");
		expect(stripMediaUrls("no urls here", [])).toBe("no urls here");
	});

	it("strips only the given URLs, not other media links in the text", () => {
		const OTHER = "https://x.hf.space/gradio_api/file=/tmp/gradio/xyz/other.wav";
		expect(stripMediaUrls(`${WAV} and ${OTHER}`, [WAV])).toBe(`and ${OTHER}`);
	});

	it("stripSpaceMediaUrls removes ephemeral Space URLs (fresh, duplicate-gen, or stale-echoed)", () => {
		// Live failures it guards: (1) the model emitted a DIFFERENT valid .wav than the one we appended
		// (duplicate-gen edge); (2) on a turn where NO tool ran, the model echoed an old Space URL from
		// history (provenance "from training"). Both are .hf.space file URLs → both get stripped.
		const A = "https://resembleai-x.hf.space/gradio_api/file=/tmp/gradio/aaa/audio.wav";
		const B = "https://resembleai-x.hf.space/gradio_api/file=/tmp/gradio/bbb/audio.wav";
		expect(stripSpaceMediaUrls(`Here is the audio: [${B}]`)).toBe("Here is the audio");
		expect(stripSpaceMediaUrls(`one ${A} two ${B}`)).toBe("one two");
		expect(stripSpaceMediaUrls("plain prose, no urls")).toBe("plain prose, no urls");
		// Leaves NON-Space media URLs alone (e.g. a legitimate image link from web search).
		const web = "https://example.org/photo.png";
		expect(stripSpaceMediaUrls(`see ${web}`)).toBe(`see ${web}`);
	});
});

describe("isAudioUrl", () => {
	it("recognizes audio extensions and rejects image/video", () => {
		expect(isAudioUrl("https://x.hf.space/a/audio.wav")).toBe(true);
		expect(isAudioUrl("https://x.hf.space/a/clip.mp3?t=1")).toBe(true);
		expect(isAudioUrl("https://x.hf.space/a/pic.png")).toBe(false);
		expect(isAudioUrl("https://x.hf.space/a/clip.mp4")).toBe(false);
	});
});

describe("extractToolInputText — the verbatim transcript shown as a read-aloud turn's body", () => {
	it("prefers a text-ish key (the TTS spoken text) over short knobs", () => {
		expect(
			extractToolInputText({ text_input: "Hello from the open stack.", language_id_input: "en" })
		).toBe("Hello from the open stack.");
	});

	it("falls back to the longest string when no key looks text-ish", () => {
		expect(extractToolInputText({ a: "en", b: "the longest value wins here" })).toBe(
			"the longest value wins here"
		);
	});

	it("ignores non-string and blank args; returns undefined when there's no text", () => {
		expect(extractToolInputText({ steps: 30, seed: 0, flag: true })).toBeUndefined();
		expect(extractToolInputText({ text: "   " })).toBeUndefined();
		expect(extractToolInputText({})).toBeUndefined();
	});
});

describe("isReadPriorAloud — a bare 'repeat that aloud' means read the PREVIOUS answer", () => {
	it("matches bare read-the-prior-answer commands (the live miss)", () => {
		for (const m of [
			"can you repeat that aloud?",
			"say that out loud",
			"read it back to me",
			"please read that aloud",
			"repeat the previous answer",
			"read the last response aloud",
		]) {
			expect(isReadPriorAloud(m)).toBe(true);
		}
	});

	it("does NOT match when the text to read is inline (colon payload or a long quote)", () => {
		expect(isReadPriorAloud("Read this aloud: Open weights win.")).toBe(false);
		expect(isReadPriorAloud('say this aloud "the open stack belongs to everyone"')).toBe(false);
	});

	it("does NOT match ordinary messages", () => {
		expect(isReadPriorAloud("what is open source?")).toBe(false);
		expect(isReadPriorAloud("")).toBe(false);
	});

	// Voice desync: an unanchored regex matches any turn that merely contains say/speak/play/it/this/
	// answer, so auto-read would synthesize the prior answer over the current one (voice ≠ text).
	it("does NOT misfire on substantive queries that merely contain speak/say/play/answer", () => {
		for (const m of [
			"can you speak to how this open model handles edge cases?",
			"say more about it",
			"play devil's advocate on that topic",
			"what's your answer on the EU AI Act?",
			"what makes you different, and where do you actually run?",
		]) {
			expect(isReadPriorAloud(m), m).toBe(false);
		}
	});
});

describe("isModelDecline — honor a model refusal (hold the audio) on a read-aloud turn", () => {
	it("detects refusals that lead the answer (the live frog-blast cases)", () => {
		for (const t of [
			"I'm sorry, but I can't assist with that request.",
			"I can't help you with dangerous activities.",
			"I cannot comply with this request.",
			"Unfortunately, I'm unable to help with that.",
			"I'm afraid I can't do that.",
			"I must respectfully decline.",
			'"I won\'t be able to read that aloud."',
		]) {
			expect(isModelDecline(t)).toBe(true);
		}
	});

	it("does NOT flag a compliant answer", () => {
		expect(isModelDecline("Open source belongs to everyone.")).toBe(false);
		expect(isModelDecline("Sure — here it is, read aloud.")).toBe(false);
		expect(isModelDecline("I think open weights win, and here's why.")).toBe(false); // "I think", not a refusal
		expect(isModelDecline("")).toBe(false);
	});
});

describe("capForSpeech — bound the text sent to a TTS Space so a long answer doesn't choke it", () => {
	it("returns short text unchanged", () => {
		expect(capForSpeech("Short answer.", 100)).toBe("Short answer.");
	});

	it("trims to the last sentence end within the cap (no mid-word cut)", () => {
		const text =
			"First sentence here. Second sentence here. Third sentence goes well beyond the cap.";
		const out = capForSpeech(text, 45);
		expect(out).toBe("First sentence here. Second sentence here.");
		expect(out.length).toBeLessThanOrEqual(45);
	});

	it("falls back to a whole-word boundary + ellipsis when no sentence end is near", () => {
		const text = "supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultra";
		// cap lands inside "expialido…"; it backs up to the previous space → the last WHOLE word, + ellipsis.
		expect(capForSpeech(text, 30)).toBe("supercalifragilistic…");
	});

	it("strips inline citation markers so the TTS Space never reads them aloud", () => {
		expect(capForSpeech("Apertus is open-weight [3] and Swiss-made [4][5].", 200)).toBe(
			"Apertus is open-weight and Swiss-made."
		);
	});

	// An agent turn's finalAnswer still carries its <think>…</think> step-narration block — the client
	// hides it from the rendered markdown, but nothing server-side stripped it before TTS, so the Space
	// read the opening tag as the bare word "think" ahead of the real answer.
	it("strips an agent turn's <think> step-narration block before it reaches TTS", () => {
		const text = "<think>\nPlanned 1 step(s)\n→ step 1: edit\n</think>\nThe file is ready.";
		expect(capForSpeech(text, 200)).toBe("The file is ready.");
	});

	it("drops an unclosed trailing <think> (token cap fired mid-reasoning) rather than reading raw reasoning aloud", () => {
		const text = "<think>\nStill working on it, considering options a, b";
		expect(capForSpeech(text, 200)).toBe("");
	});
});

describe("stripCitationsForSpeech — keep '[3]' out of the spoken copy (on-screen citations untouched)", () => {
	it("removes single, adjacent-run, and comma-list markers, tidying spacing", () => {
		expect(stripCitationsForSpeech("Open weights [3] and a Swiss lab [4][5].")).toBe(
			"Open weights and a Swiss lab."
		);
		expect(stripCitationsForSpeech("Per the sources [1, 2], it is open.")).toBe(
			"Per the sources, it is open."
		);
	});

	it("never touches markdown links — '[label](url)' is text, not a citation marker", () => {
		const md = "See [the model card](https://huggingface.co/swiss-ai) for details.";
		expect(stripCitationsForSpeech(md)).toBe(md);
	});

	it("leaves citation-free text unchanged", () => {
		expect(stripCitationsForSpeech("Just a plain sentence.")).toBe("Just a plain sentence.");
	});
});
