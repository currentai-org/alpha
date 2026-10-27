import { describe, it, expect } from "vitest";
import { extractTextFromHtml } from "./htmlExtract";

describe("extractTextFromHtml", () => {
	it("pulls the title and visible text, dropping script/style/comments", () => {
		const html = `
			<html><head><title>EPFL launches open LLMs</title>
			<style>.x{color:red}</style></head>
			<body>
				<h1>Meditron</h1>
				<p>The first fully open medical framework.</p>
				<script>analytics('boom');</script>
				<!-- hidden -->
			</body></html>`;
		const { title, text } = extractTextFromHtml(html);
		expect(title).toBe("EPFL launches open LLMs");
		expect(text).toContain("Meditron");
		expect(text).toContain("The first fully open medical framework.");
		expect(text).not.toContain("color:red");
		expect(text).not.toContain("analytics");
		expect(text).not.toContain("hidden");
	});

	it("decodes entities and keeps block boundaries from merging words", () => {
		const html = "<p>Tom &amp; Jerry</p><p>cost &lt; 5</p>";
		const { text } = extractTextFromHtml(html);
		expect(text).toContain("Tom & Jerry");
		expect(text).toContain("cost < 5");
		// blocks separated, not "Jerrycost"
		expect(text).not.toContain("Jerrycost");
	});

	it("decodes numeric and hex character references", () => {
		expect(extractTextFromHtml("<p>caf&#233; &#x2014; ok</p>").text).toBe("café — ok");
	});

	it("decodes common typographic named entities and leaves unknown ones untouched", () => {
		expect(extractTextFromHtml("<p>it&rsquo;s &mdash; done&hellip;</p>").text).toBe("it’s — done…");
		// An unknown named entity is left as-is rather than mangled.
		expect(extractTextFromHtml("<p>A&zzz;B</p>").text).toBe("A&zzz;B");
	});

	it("returns empty strings for empty input and title-less docs", () => {
		expect(extractTextFromHtml("")).toEqual({ title: "", text: "" });
		const { title, text } = extractTextFromHtml("<p>just body</p>");
		expect(title).toBe("");
		expect(text).toBe("just body");
	});

	it("handles plain-ish markup without a body wrapper", () => {
		const { text } = extractTextFromHtml("<div>One</div><div>Two</div>");
		expect(text).toBe("One\nTwo");
	});

	// htmlparser2 parses the page, so markup a tag regex mishandles comes out as text. (CUR-4068)
	it("reads nested inline tags, a numeric entity and a CDATA block as clean text", () => {
		const html =
			"<p>Open <b>models <i>for&#160;all</i></b> &#8212; <a href='/x' title='a > b'>today</a></p><![CDATA[ hidden ]]><p>Next</p>";
		const { text } = extractTextFromHtml(html);
		// &#160; decodes to a no-break space, which the whitespace collapse folds into a plain one.
		expect(text).toBe("Open models for all — today\nNext");
	});

	it("keeps a literal entity written as text on the page, decoding it once", () => {
		expect(extractTextFromHtml("<p>write &amp;lt; for a less-than sign</p>").text).toBe("write &lt; for a less-than sign");
	});

	it("decodes an entity inside the title", () => {
		expect(extractTextFromHtml("<title>Q&amp;A &#8211; part 2</title><p>x</p>").title).toBe("Q&A – part 2");
	});
});
