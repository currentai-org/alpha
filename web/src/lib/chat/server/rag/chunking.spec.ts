import { describe, it, expect } from "vitest";
import { chunkDocumentText } from "./chunking";

describe("chunkDocumentText", () => {
	it("returns [] for empty or whitespace-only input", () => {
		expect(chunkDocumentText("")).toEqual([]);
		expect(chunkDocumentText("   \n\n  \t ")).toEqual([]);
	});

	it("keeps a short document as a single chunk and normalizes whitespace", () => {
		expect(chunkDocumentText("Hello   world.\nSecond line.", 1200)).toEqual([
			"Hello world. Second line.",
		]);
	});

	it("packs multiple short paragraphs into one chunk up to the bound", () => {
		const out = chunkDocumentText("Para one.\n\nPara two.\n\nPara three.", 1200);
		expect(out).toEqual(["Para one. Para two. Para three."]);
	});

	it("never emits a chunk longer than maxChars", () => {
		const big = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} with some words.`).join(
			" "
		);
		const out = chunkDocumentText(big, 80);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(80);
		// No content lost (modulo whitespace): every sentence index appears somewhere.
		const joined = out.join(" ");
		for (let i = 0; i < 40; i++) expect(joined).toContain(`Sentence number ${i} `);
	});

	it("splits an oversized paragraph on sentence boundaries", () => {
		const para = "First sentence here. Second sentence here. Third sentence here.";
		const out = chunkDocumentText(para, 30);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(30);
	});

	it("hard-splits a single oversized sentence with no terminators", () => {
		const word = "x".repeat(250); // one 250-char 'sentence', no . ! ?
		const out = chunkDocumentText(word, 100);
		expect(out).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
	});
});
