import { describe, it, expect, vi } from "vitest";

// Hermetic gate: stub $lib/chat/server/models so importing ./router doesn't trigger models.ts's
// import-time buildModels() live fetch (needs OPENAI_BASE_URL + network).
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));

import { isReadAloudIntent } from "./router";

describe("isReadAloudIntent — fires on real TTS requests, NOT ordinary conversation", () => {
	it("matches genuine read-aloud / TTS requests", () => {
		for (const msg of [
			"Read this aloud: The open stack belongs to everyone.",
			"Please read it aloud",
			"say this out loud",
			"can you repeat that aloud?",
			"say that out loud",
			"read it back to me",
			"play that back",
			"speak this sentence",
			"can you narrate this for me",
			"use text-to-speech on this",
			"TTS this please",
			"repeat the previous answer",
			"read the last message",
		]) {
			expect(isReadAloudIntent(msg)).toBe(true);
		}
	});

	// Regression: these conversational turns must NOT misfire as read-aloud (bare "say that" / "read it"
	// / "repeat that" / "read the following"): a misfire suppresses the written answer and — in auto/always
	// speak mode — autoplays speech with no text.
	it("does NOT match ordinary conversational phrasing", () => {
		for (const msg of [
			"say that again",
			"can you repeat that?",
			"could you say that differently?",
			"I read it yesterday and liked it",
			"you could say that",
			"read the following passage and summarize it",
			"what is open source?",
			"tell me about Apertus",
			"read me the news",
			"that's a fast way to say it",
		]) {
			expect(isReadAloudIntent(msg)).toBe(false);
		}
	});
});
