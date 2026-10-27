import { describe, it, expect } from "vitest";
import { isRecencyWindowQuery } from "./recency";

describe("isRecencyWindowQuery", () => {
	it("matches the demo repro and other recent-time-window phrasings", () => {
		for (const q of [
			"What's happened with open-source AI funding or policy in the last month? I need current sources I can check.",
			"any recent developments in open model licensing?",
			"what's new in AI policy this week",
			"summarize AI regulation changes in the past 30 days",
			"latest news on the EU AI Act",
			"what has happened with Llama recently",
		]) {
			expect(isRecencyWindowQuery(q), q).toBe(true);
		}
	});

	it("does NOT trigger on catalog-answerable queries (no recent-window intent)", () => {
		for (const q of [
			"what are the latest open-source vector stores?", // "latest X" alone — catalog can answer
			"what open-source options exist for moderation?",
			"compare open foundation models",
			"which projects cover federated RAG?",
			"current state of the art in open weights", // "current ... " without a time window
		]) {
			expect(isRecencyWindowQuery(q), q).toBe(false);
		}
	});

	it("is safe on empty / undefined input", () => {
		expect(isRecencyWindowQuery("")).toBe(false);
		expect(isRecencyWindowQuery(undefined)).toBe(false);
	});
});
