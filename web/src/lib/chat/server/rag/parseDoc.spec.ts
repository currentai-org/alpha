import { describe, it, expect } from "vitest";
import { parseDocContent, stripHtml } from "./parseDoc";

describe("stripHtml", () => {
	it("removes tags and collapses whitespace", () => {
		expect(stripHtml("<p>Hello   <b>world</b></p>\n\nagain")).toBe("Hello world again");
	});

	it("is safe on empty/undefined-ish input", () => {
		expect(stripHtml("")).toBe("");
		expect(stripHtml(undefined as unknown as string)).toBe("");
	});
});

describe("parseDocContent", () => {
	it("extracts title/url and strips HTML from a JSON article", () => {
		const content = JSON.stringify({
			title: "EPFL launches open medical LLMs",
			subtitle: "<p>MeditronFO is the first fully open framework.</p>",
			url: "https://actu.epfl.ch/news/x",
		});
		const [src] = parseDocContent(content);
		expect(src.title).toBe("EPFL launches open medical LLMs");
		expect(src.url).toBe("https://actu.epfl.ch/news/x");
		expect(src.snippet).not.toContain("<p>");
		expect(src.snippet).toContain("MeditronFO");
	});

	it("expands a JSON array of articles into multiple sources", () => {
		const content = JSON.stringify([
			{ title: "A", text_snippet: "first" },
			{ title: "B", text_snippet: "second" },
		]);
		expect(parseDocContent(content)).toHaveLength(2);
	});

	it("falls back to raw text (and the given fallback title) when content is not JSON", () => {
		const [src] = parseDocContent("just a plain string", "MySource");
		expect(src.snippet).toBe("just a plain string");
		expect(src.title).toBe("MySource");
	});

	it("returns [] for empty content", () => {
		expect(parseDocContent("")).toEqual([]);
	});
});
