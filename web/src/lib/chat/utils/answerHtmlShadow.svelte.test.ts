import { describe, expect, test, vi } from "vitest";
import purify from "dompurify";
import { ensureKatex, ensureHljs, processTokens } from "./marked";
import {
	reportSanitizerDiff,
	sanitizerDiff
} from "./answerHtmlShadow";

// Runs in the vitest browser project: DOMPurify gets the real DOM it gets in production.

/** What a browser would actually run: live elements and attributes, not escaped text. */
function executable(html: string): string[] {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const found: string[] = [];
	for (const el of doc.body.querySelectorAll("*")) {
		const tag = el.tagName.toLowerCase();
		if (["script", "iframe", "style", "svg", "math", "object", "embed"].includes(tag)) found.push(tag);
		for (const a of el.attributes) {
			if (a.name.startsWith("on")) found.push(`${tag}@${a.name}`);
			if (/^\s*(javascript|vbscript):/i.test(a.value)) found.push(`${tag}@${a.name}=js`);
		}
	}
	return found;
}

async function render(md: string, sources: Array<{ title: string; link: string }> = []) {
	await Promise.all([ensureKatex(), ensureHljs()]);
	const tokens = await processTokens(md, sources);
	return tokens
		.map((t) => (t.type === "text" ? String(t.html) : ""))
		.join("");
}

describe("sanitizerDiff names what DOMPurify would remove, never answer text", () => {
	test("the DOM sanitizer is supported in this test DOM, or every case below proves nothing", () => {
		expect(purify.isSupported).toBe(true);
	});

	test.each([
		["script element", "<p>a</p><script>alert(1)</script>", "tag:script"],
		["onerror handler", '<img src="x" onerror="alert(1)">', "attr:onerror@img"],
		["javascript: href", '<a href="javascript:alert(1)">x</a>', "attr:href@a"],
		["svg onload", '<svg onload="alert(1)"><circle/></svg>', "attr:onload@svg"],
		["style element", "<p>a</p><style>body{background:url(javascript:alert(1))}</style>", "tag:style"],
		["math href javascript", '<math><mi href="javascript:alert(1)">x</mi></math>', "attr:href@mi"],
		["iframe", '<iframe src="https://evil.example"></iframe>', "tag:iframe"]
	])("flags a %s", (_name, html, expected) => {
		expect(sanitizerDiff(html, purify)).toContain(expected);
	});

	test("the report carries tag and attribute names only, not the payload text", () => {
		const diff = sanitizerDiff('<img src=x onerror="alert(SECRET_TOKEN)">', purify).join(",");
		expect(diff).not.toContain("SECRET_TOKEN");
	});
});

describe("what marked.ts renders from hostile markdown: executable markup never reaches the page and the shadow agrees", () => {
	const payloads = [
		"<script>alert(1)</script>",
		'<img src=x onerror="alert(1)">',
		"[x](javascript:alert(1))",
		"[x](JaVaScRiPt:alert(1))",
		"[x](&#106;avascript:alert(1))",
		"![x](javascript:alert(1))",
		'<svg onload="alert(1)"></svg>',
		"<style>*{background:url(javascript:alert(1))}</style>",
		'<math><mi href="javascript:alert(1)">x</mi></math>',
		'<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
		'<iframe src="javascript:alert(1)"></iframe>',
		'<video><source src="javascript:alert(1)"></video>',
		'<div style="x:expression(alert(1))">x</div>'
	];

	test.each(payloads)("payload %s", async (md) => {
		const html = await render(md);
		expect(executable(html)).toEqual([]);
		// Shadow agreement: DOMPurify would remove nothing further from what we already emit.
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});
});

describe("what must survive the final pass: the shadow reports no difference for answers our renderer emits", () => {
	test("KaTeX inline and display math, MathML included", async () => {
		const html = await render("Inline $x^2$ and\n\n$$\\frac{a}{b}$$");
		expect(html).toContain("katex");
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});

	test("highlighted code classes in inline code and fenced blocks keep their markup", async () => {
		const html = await render("Use `npm run build` here.");
		expect(html).toContain('<code translate="no">');
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});

	test("citation markers link to the source with target and rel", async () => {
		const html = await render("Open models matter [1].", [
			{ title: "Source", link: "https://example.org/a" }
		]);
		expect(html).toContain('href="https://example.org/a"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});

	test("ordinary links keep target and rel", async () => {
		const html = await render("[link](https://example.com)");
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});

	test("an unverified link keeps its style, title, and the ? button attributes", async () => {
		const html = await render('[x](https://example.com "unverified")');
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});

	test.each([
		["video", '<video controls src="/chat/conversation/abc/output/v.mp4"></video>', "<video"],
		["audio", '<audio controls src="/chat/conversation/abc/output/a.mp3"></audio>', "<audio"],
		["image", "![pic](data:image/png;base64,AAAA)", "<img"]
	])("an inline %s the renderer allows is not stripped", async (_n, md, tag) => {
		const html = await render(md);
		expect(html).toContain(tag);
		expect(sanitizerDiff(html, purify)).toEqual([]);
	});
});

describe("reportSanitizerDiff sends each distinct difference once and nothing for a clean answer", () => {
	test("a clean answer sends nothing", () => {
		const send = vi.fn();
		reportSanitizerDiff([], send);
		expect(send).not.toHaveBeenCalled();
	});

	test("the same difference is sent once, a different one is sent again", () => {
		const send = vi.fn();
		reportSanitizerDiff(["tag:svg"], send);
		reportSanitizerDiff(["tag:svg"], send);
		reportSanitizerDiff(["attr:style@span"], send);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith("answer_html_sanitizer_diff", { removed: ["tag:svg"] });
	});
});
