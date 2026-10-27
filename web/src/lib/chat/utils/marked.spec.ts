import { describe, expect, test, vi } from "vitest";
import { processBlocksSync, processTokensSync } from "./marked";
import { UNVERIFIED_TITLE } from "$lib/chat/constants/unverifiedHref";
import { detectFabricatedUrls } from "$lib/chat/server/urlGuard";
import { groundcheckEmptiedText } from "$lib/chat/server/groundcheck";

function renderHtml(md: string): string {
	const tokens = processTokensSync(md, []);
	const textToken = tokens.find((token) => token.type === "text");
	if (!textToken || textToken.type !== "text") return "";
	return typeof textToken.html === "string" ? textToken.html : "";
}

function renderHtmlWithSources(
	md: string,
	sources: Array<{ title: string; link: string }>
): string {
	const tokens = processTokensSync(md, sources);
	const textToken = tokens.find((token) => token.type === "text");
	if (!textToken || textToken.type !== "text") return "";
	return typeof textToken.html === "string" ? textToken.html : "";
}

// Full pipeline render (block splitting + optional streaming repairs), as used by MarkdownRenderer
function renderBlocksHtml(md: string, streaming: boolean): string {
	return processBlocksSync(md, [], streaming)
		.flatMap((block) => block.tokens)
		.map((token) => (token.type === "text" && typeof token.html === "string" ? token.html : ""))
		.join("");
}

describe("marked basic rendering", () => {
	test("renders bold text", () => {
		const html = renderHtml("**bold**");
		expect(html).toContain("<strong>bold</strong>");
	});

	test("renders links", () => {
		const html = renderHtml("[link](https://example.com)");
		expect(html).toContain('<a href="https://example.com"');
		expect(html).toContain("link</a>");
	});

	test("renders paragraphs", () => {
		const html = renderHtml("hello world");
		expect(html).toContain('<p dir="ltr">hello world</p>');
	});

	test("renders an unverified-sentinel link as a non-navigating, ?-marked reference", () => {
		const html = renderHtml("See [github.com/swissai/Apertus](unverified:) for details.");
		// not a navigating anchor
		expect(html).not.toContain('href="unverified:"');
		expect(html).not.toContain("<a ");
		// styled span carrying the label + a "?" superscript marker + tooltip
		expect(html).toContain('class="uv-link"');
		expect(html).toContain("github.com/swissai/Apertus");
		expect(html).toContain('class="uv-mark"');
		expect(html).toContain("?</sup>");
		expect(html).toContain("title=");
	});

	test("renders an unverified-TITLE link as a CLICKABLE, marked link (a11y)", () => {
		const html = renderHtml(
			`See [github.com/swissai/Apertus](https://github.com/swissai/Apertus "${UNVERIFIED_TITLE}") for details.`
		);
		// still a real, navigating anchor to the real URL
		expect(html).toContain('<a class="uv-link" href="https://github.com/swissai/Apertus"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		// visually marked: dotted underline + a "?" button outside the anchor
		expect(html).toContain("underline dotted");
		expect(html).toContain('class="uv-mark"');
		expect(html).toContain("data-uv-mark");
		expect(html).toContain("?</sup>");
		// a11y: status conveyed non-visually + an accurate (no longer "isn't clickable") button label
		expect(html).toContain("sr-only");
		expect(html).toContain("(unverified link)");
		expect(html).not.toContain("isn't clickable");
		// the sentinel must never leak into the visible href/title
		expect(html).not.toContain(`href="https://github.com/swissai/Apertus ${UNVERIFIED_TITLE}`);
	});

	test("guard→render composition: a flagged URL always renders a locatable '?' in the body", () => {
		// The invariant: whenever
		// the URL guard flags a link — so the urlNotice footer fires — the SAME cleaned text it emits must
		// render a locatable "?" marker in the answer body. detectFabricatedUrls (server) → renderHtml
		// (client) is the exact path a real turn takes, so composing them here proves the footer can never
		// point at a marker that isn't in the rendered answer. A stray "?" footer therefore means a copy
		// drift (the trace/footer wording), not a missing marker.
		// A NON-self-referential fabrication (github.com/octo-org/… isn't one of our canonical entities),
		// so it takes the "?"-marker path rather than being rewritten to a canonical link — that's the path
		// this test exercises. (Apertus/SNAI links now resolve to canonical; see urlGuard.spec.)
		const answer = "The repo is at https://github.com/octo-org/example-repo — worth a look.";
		const guarded = detectFabricatedUrls(answer, { grounded: false });
		expect(guarded.flagged).toBe(true); // the footer WILL fire: urlNotice.count > 0
		expect(guarded.urls).toHaveLength(1);
		const html = renderHtml(guarded.cleaned);
		// the exact "?" that the footer's "(? above)" points at, present + keyboard-locatable in the body
		expect(html).toContain("data-uv-mark");
		expect(html).toContain("?</sup>");
	});
});

describe("inline web-search citations", () => {
	const sources = [
		{ title: "First", link: "https://a.example/page" },
		{ title: "Second", link: "https://b.example/page" },
	];

	test("turns [n] into a baseline bracketed link to the matching source (not a superscript)", () => {
		const html = renderHtmlWithSources("The capital is Bern [1].", sources);
		expect(html).not.toContain("<sup>");
		expect(html).toContain('<a href="https://a.example/page"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain("[1]</a>");
		expect(html).toContain("vertical-align: baseline");
	});

	test("links each citation to its own source", () => {
		const html = renderHtmlWithSources("See [1] and also [2].", sources);
		expect(html).toContain('href="https://a.example/page"');
		expect(html).toContain('href="https://b.example/page"');
		expect(html).toContain("[1]</a>");
		expect(html).toContain("[2]</a>");
	});

	test("a grouped marker like [1,3] links each number to its own source, rather than staying plain text (CUR-3246)", () => {
		const three = [...sources, { title: "Third", link: "https://c.example/page" }];
		for (const marker of ["[1,3]", "[1, 3]"]) {
			const html = renderHtmlWithSources(`Rigi has panoramic views ${marker}.`, three);
			expect(html).toContain('href="https://a.example/page"');
			expect(html).toContain('href="https://c.example/page"');
			expect(html).toContain("[1]</a>");
			expect(html).toContain("[3]</a>");
			expect(html).not.toContain(marker);
		}
	});

	test("a grouped bracket that more words follow stays prose, while one ending its clause still links (CUR-3299)", () => {
		for (const prose of ["The interval [1, 2] is closed.", "Take the row [1,2] from the matrix."]) {
			const html = renderHtmlWithSources(prose, sources);
			expect(html, prose).not.toContain("<a href");
			expect(html, prose).toContain(prose.match(/\[[^\]]+\]/)![0]);
		}
		for (const cited of ["Paris is the capital [1, 2].", "Paris is the capital [1, 2]", "Paris [1, 2]; Rome [1]."]) {
			const html = renderHtmlWithSources(cited, sources);
			expect(html, cited).toContain("[1]</a>");
			expect(html, cited).toContain("[2]</a>");
		}
		// A lone marker links mid-sentence as it always has.
		expect(renderHtmlWithSources("Paris [1] is the capital.", sources)).toContain("[1]</a>");
		// A list item's leading group is moved to the item's end before linking, so it still links.
		expect(renderHtmlWithSources("1. [1, 2] The official EU AI Act text", sources)).toContain("[2]</a>");
	});

	// Mistral Large 3 cites in Pandoc's caret shapes. Each line below is a develop answer. (CUR-3551)
	test("a caret citation like Tokyo^1,2^ links each number instead of printing the carets (CUR-3551)", () => {
		for (const answer of [
			"La capitale du Japon est Tokyo^1,2^.",
			"and a detector benchmark leaderboard ^1,2^.",
			"La capitale de l'Australie est **Canberra**. [^1^][^2^]",
		]) {
			const html = renderHtmlWithSources(answer, sources);
			expect(html, answer).toContain("[1]</a>");
			expect(html, answer).toContain("[2]</a>");
			expect(html, answer).not.toContain("^");
		}
	});

	// "Tokyo[1]-4." must link [1] and leave no stray "-4".
	test("a citation range like Tokyo[1]-4 or [1-2] links each number and prints no dash (CUR-3551)", () => {
		for (const answer of ["La capitale du Japon est Tokyo[1]-4.", "Tokyo [1-2].", "Tokyo [1–2]", "Tokyo^1-2^."]) {
			const html = renderHtmlWithSources(answer, sources);
			expect(html, answer).toContain("[1]</a>");
			expect(html, answer).toContain("[2]</a>");
			expect(html, answer).not.toMatch(/\]\s*[-–]|[-–]\s*\d|\^/);
		}
		// A bracketed interval in prose keeps its dash: it has more words after it on the line.
		expect(renderHtmlWithSources("Pick a value in [1-2] for the weight.", sources)).toContain("[1-2]");
		// A reversed or very long range is not a citation.
		expect(renderHtmlWithSources("Tokyo [2-1].", sources)).toContain("[2-1]");
		expect(renderHtmlWithSources("Tokyo [1-400].", sources)).toContain("[1-400]");
	});

	// "problemas**[1][2][3][4][6][7]**." is a develop answer in Spanish; marked can't open bold before
	// "[" after a letter, so it printed both pairs of asterisks (CUR-2393).
	test("bold or italic wrapped round citation markers links them and prints no asterisks (CUR-2393)", () => {
		for (const answer of [
			"Ayuda a resolver problemas**[1][2]**.",
			"Ayuda a resolver problemas **[1][2]**.",
			"Ayuda a resolver problemas*[1, 2]*.",
			"Ayuda a resolver problemas __[1]__ y más.",
		]) {
			const html = renderHtmlWithSources(answer, sources);
			expect(html, answer).toContain("[1]</a>");
			expect(html, answer).not.toMatch(/\*|__|_\[|\]_/);
			expect(html, answer).not.toMatch(/<(strong|em)>/);
		}
		// Bold on words keeps working, with a citation beside it or inside it.
		expect(renderHtmlWithSources("La capital es **Canberra** [1].", sources)).toContain("<strong>Canberra</strong>");
		expect(renderHtmlWithSources("Es **Canberra [1]**.", sources)).toMatch(/<strong>Canberra .*\[1\]<\/a>.*<\/strong>/);
		// With no sources, asterisks round brackets are left as written.
		expect(renderHtmlWithSources("x**[1]**", [])).toContain("**[1]**");
	});

	// "in Qatar \[1,3,4\]." is a develop answer; "\[" opens display math, so the markers
	// showed as a dim monospace "1,3,4" line with the full stop under it (CUR-3551).
	test("backslash-escaped citation brackets link each source and open no math block (CUR-3551)", () => {
		for (const answer of ["Hosted in Qatar \\[1,2\\].", "Hosted in Qatar \\[1\\]\\[2\\]."]) {
			const tokens = processTokensSync(answer, sources);
			const html = tokens.map((t) => (t.type === "text" && typeof t.html === "string" ? t.html : "")).join("");
			expect(html, answer).toContain("[1]</a>");
			expect(html, answer).toContain("[2]</a>");
			expect(html, answer).not.toContain("data-katex-pending");
			// The full stop stays in the sentence's paragraph rather than on a line of its own.
			expect(html, answer).toMatch(/Qatar .*\]<\/a>(<\/span>)?\.<\/p>/);
		}
		// Real display math, and escaped brackets with no sources, stay math.
		expect(renderBlocksHtml("\\[x^2 + 1\\]", false)).toContain("data-katex-pending");
		const noSources = processTokensSync("Qatar \\[1,2\\].", []);
		expect(JSON.stringify(noSources)).toContain("data-katex-pending");
	});

	test("a caret footnote definition reads as a bracketed note, not raw markup (CUR-3551)", () => {
		const html = renderHtmlWithSources("[^1^]: Australian Government site", sources);
		expect(html).not.toContain("^");
		expect(html).toContain("Australian Government site");
	});

	test("carets with no sources, in code, or in math stay as written (CUR-3551)", () => {
		expect(renderHtmlWithSources("Tokyo^1^.", [])).toContain("Tokyo^1^.");
		const tokens = processTokensSync("```\nx^1,2^\n```", sources);
		const code = tokens.find((token) => token.type === "code");
		expect(code?.type === "code" ? code.rawCode : "").toBe("x^1,2^");
		expect(renderHtmlWithSources("Use `a^1^` here.", sources)).toContain("a^1^");
	});

	test("places leading list citations at the end of the item text", () => {
		const html = renderHtmlWithSources("1. [1] The official EU AI Act text (europa.eu)", sources);
		const textIndex = html.indexOf("The official EU AI Act text");
		const citationIndex = html.indexOf("[1]</a>");
		expect(textIndex).toBeGreaterThan(-1);
		expect(citationIndex).toBeGreaterThan(textIndex);
		expect(html).not.toMatch(/<li[^>]*>\s*<span[^>]*>\s*&#8202;<a[^>]*>\[1\]/);
	});

	test("moves leading list citations before terminal punctuation", () => {
		const html = renderHtmlWithSources("1. [1] The Act is in force.", sources);
		expect(html).toContain("[1]</a></span>.</li>");
	});

	test("does not move leading list citations inside fenced code", () => {
		const tokens = processTokensSync("```\n1. [1] literal\n```", sources);
		const code = tokens.find((token) => token.type === "code");
		expect(code?.type).toBe("code");
		expect(code?.type === "code" ? code.rawCode : "").toBe("1. [1] literal");
	});

	test("does not linkify bracketed numbers inside inline code", () => {
		const html = renderHtmlWithSources("Use `items[1]` and cite the claim [1].", sources);
		expect(html).toContain('<code translate="no">items[1]</code>');
		expect(html).toContain('href="https://a.example/page"');
		expect(html).toContain("[1]</a>");
	});

	test("does not nest citation anchors inside ordinary markdown links", () => {
		const html = renderHtmlWithSources("[read section [1]](https://docs.example). Then cite [1].", sources);
		expect(html).toContain(
			'<a href="https://docs.example" target="_blank" rel="noreferrer">read section [1]</a>'
		);
		expect(html.match(/href="https:\/\/a\.example\/page"/g)).toHaveLength(1);
	});

	test("does not linkify bracketed numbers inside image attributes", () => {
		// A relative path, because a remote image renders as a link and has no alt attribute (CUR-1898).
		const html = renderHtmlWithSources("![chart [1]](/chat/conversation/abc/output/pic.png) cite [1].", sources);
		expect(html).toContain('alt="chart [1]"');
		expect(html.match(/href="https:\/\/a\.example\/page"/g)).toHaveLength(1);
	});

	test("leaves [n] literal when the index is out of range", () => {
		const html = renderHtmlWithSources("Citing [3] here.", sources);
		expect(html).not.toContain('<a href="https://a.example/page"');
		expect(html).toContain("[3]");
	});

	test("leaves [0] literal (no zero-th source)", () => {
		const html = renderHtmlWithSources("Footnote [0].", sources);
		expect(html).not.toContain("<a href=");
		expect(html).toContain("[0]");
	});

	test("leaves [n] literal when there are no sources", () => {
		const html = renderHtmlWithSources("No web search [1].", []);
		expect(html).not.toContain("<a href=");
		expect(html).toContain("[1]");
	});

	test("shows the document name (not a bare [n]) as a non-link marker for a source with no url", () => {
		// RAG / local-knowledge sources often have no public URL — the marker must NOT be a dead
		// <a href="">[n]</a> that looks clickable but goes nowhere, AND must not be a bare [n] that
		// reads as a broken citation. It shows the document NAME so the reader knows the source.
		const html = renderHtmlWithSources("From the catalog [1].", [
			{ title: "Catalog entry", link: "" },
		]);
		expect(html).not.toContain('href=""');
		expect(html).not.toContain("<a ");
		expect(html).toContain("[Catalog entry]"); // document name, not the bare index
		expect(html).toContain("<span"); // non-link marker
	});

	test("escapes HTML in a url-less source's title", () => {
		const html = renderHtmlWithSources("See [1].", [{ title: "A <script> & doc", link: "" }]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("escapes special characters in the source URL", () => {
		const html = renderHtmlWithSources("Ref [1].", [
			{ title: "Q", link: "https://x.example/?a=1&b=2" },
		]);
		expect(html).toContain("&amp;");
		expect(html).not.toContain('?a=1&b=2"');
	});
});

// The link renderer in ./marked.ts interpolates the link's TEXT straight into HTML in four branches
// (inert streaming anchor, unverified-title, legacy unverified sentinel, ordinary anchor). That is
// only safe because the value marked hands over is already-parsed inline HTML, escaped on the way in.
//
// marked moved WHERE that escaping happens — v15's "escape html in renderers instead of tokenizers
// for all tokens" — and v13 changed the renderer signature from (href, title, text) to a single token,
// which means the override now has to DERIVE the text itself. Deriving it via
// `this.parser.parseInline(token.tokens)` keeps the escaping; reaching for `token.text` instead is raw
// markdown source and would emit whatever the model wrote, on the one surface that renders untrusted
// model output to a user.
//
// So: every branch, with a payload. These pass on marked 12 as written — they are here to fail if the
// migration takes the wrong field, not to describe new behaviour.
describe("link renderer escapes its text (all four branches)", () => {
	const PAYLOAD = "<img src=x onerror=alert(1)>";

	// Asserts the INVARIANT, not one spelling of it. Two branches currently double-escape (see the
	// note at the end of this block), so pinning "&lt;img" exactly would encode a cosmetic quirk as
	// the contract and go red for the wrong reason. What must hold is that the payload never reaches
	// the page as markup, and that it is present as escaped text rather than silently dropped —
	// dropping it would pass a naive "no <img" check while losing the user's content.
	function expectNeutralized(html: string) {
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("onerror=alert(1)>");
		expect(html).toMatch(/(&amp;lt;|&lt;)img src=x onerror=alert\(1\)(&amp;gt;|&gt;)/);
	}

	test("an ordinary link", () => {
		const html = renderHtml(`[${PAYLOAD}](https://example.com)`);
		expect(html).toContain('<a href="https://example.com"');
		expectNeutralized(html);
	});

	test("an unverified-TITLE link (the clickable, flagged branch)", () => {
		const html = renderHtml(`[${PAYLOAD}](https://example.com "${UNVERIFIED_TITLE}")`);
		expect(html).toContain("uv-link");
		expectNeutralized(html);
	});

	test("the legacy unverified sentinel (href overwritten, text preserved)", () => {
		const html = renderHtml(`See [${PAYLOAD}](unverified:) for details.`);
		expect(html).toContain("uv-link");
		expectNeutralized(html);
	});

	test("the inert anchor for a link whose URL is still streaming", () => {
		const html = renderBlocksHtml(`[${PAYLOAD}](https://exa`, true);
		expectNeutralized(html);
	});

	test("a link whose href is rejected by sanitizeHref falls back to escaped text", () => {
		const html = renderHtml(`[${PAYLOAD}](javascript:alert(1))`);
		expect(html).not.toContain("javascript:");
		expectNeutralized(html);
	});

	// The browser's URL parser drops tab/newline anywhere and leading C0 controls, so a
	// scheme check on the raw string let `java\tscript:` through. Only http, https, mailto and
	// relative links may render as anchors. (CUR-3515)
	test("renders no anchor for a script scheme hidden behind a tab, a control character, or vbscript:", () => {
		for (const md of [
			"[x](<java\tscript:alert(1)>)",
			"[x](<JaVa\tScRiPt:alert(1)>)",
			"[x](<\u0001javascript:alert(1)>)",
			"[x](<\u0000javascript:alert(1)>)",
			"[x](vbscript:msgbox(1))",
			"[x](data:text/html,<script>alert(1)</script>)",
		]) {
			const html = renderHtml(md);
			expect(html, md).not.toContain("<a ");
			// eslint-disable-next-line no-control-regex -- stripping controls the way the browser does is the point
			expect(html.toLowerCase().replace(/[\u0000-\u001f]/g, ""), md).not.toMatch(
				/href="[^"]*script:/
			);
		}
	});

	test("still renders http, https, mailto, relative and #anchor links as anchors", () => {
		for (const [md, href] of [
			["[x](https://example.com/a)", "https://example.com/a"],
			["[x](http://example.com)", "http://example.com"],
			["[x](mailto:hi@example.org)", "mailto:hi@example.org"],
			["[x](/chat/settings)", "/chat/settings"],
			["[x](#section)", "#section"],
		]) {
			expect(renderHtml(md), md).toContain(`<a href="${href}"`);
		}
	});

	test("image alt text is neutralized too (the image renderer takes the same shape)", () => {
		const html = renderHtml(`![${PAYLOAD}](https://example.com/pic.png)`);
		expect(html).toContain('<a href="https://example.com/pic.png"');
		expectNeutralized(html);
	});

	// Escapes EXACTLY once, everywhere. Escaping twice (the rejected-href fallback and the image alt running
	// escapeHTML() over a value marked had already escaped) shows the user the literal text `&lt;img src=x
	// onerror=alert(1)&gt;` instead of the tag they typed: safe but wrong, and invisible to a test that only
	// asks "is the payload inert". The renderer receives the token, so the parsed HTML and the raw text are
	// separate values and each sink gets the one it wants. Pinned so a change that reintroduces a redundant
	// escape shows up as entity text in a diff, not in a bug report.
	test("escapes exactly once — no double-escaped entity text", () => {
		for (const md of [
			`[${PAYLOAD}](https://example.com)`,
			`[${PAYLOAD}](javascript:alert(1))`,
			`![${PAYLOAD}](https://example.com/pic.png)`,
		]) {
			expect(renderHtml(md)).not.toContain("&amp;lt;");
			expect(renderHtml(md)).toContain("&lt;img src=x onerror=alert(1)&gt;");
		}
	});
});

// This renderer draws model output, and a page the model read can steer that output. A
// remote <img>/<video>/<audio> is fetched the moment the answer renders, carrying whatever the model
// put in its URL, so nothing remote loads without a click. Our own relative paths and inline data:
// media still render in place. (CUR-1898)
describe("marked image renderer — nothing remote loads without a click (CUR-1898)", () => {
	test("a remote image renders as a link, never an <img> the browser fetches unasked", () => {
		const html = renderHtml("![chart](https://evil.example/x.png?d=secret)");
		expect(html).not.toMatch(/<img\b/i);
		expect(html).toContain('<a href="https://evil.example/x.png?d=secret"');
		expect(html).toContain(">chart</a>");
	});

	test("a remote video or audio file renders as a link, not a player that preloads it", () => {
		for (const url of ["https://example.com/clip.mp4?token=abc", "https://example.com/clip.mp3"]) {
			const html = renderHtml(`![](${url})`);
			expect(html).not.toMatch(/<(video|audio|source)\b/i);
			expect(html).toContain(`<a href="${url.replace("&", "&amp;")}"`);
		}
	});

	test("a plain link to a media file stays a link and is not promoted to a player", () => {
		const html = renderHtml("[the clip](https://example.com/clip.mp4)");
		expect(html).not.toMatch(/<(video|img|source)\b/i);
		expect(html).toContain('<a href="https://example.com/clip.mp4"');
	});

	test("a protocol-relative image is remote too, so it renders no <img>", () => {
		expect(renderHtml("![x](//evil.example/x.png)")).not.toMatch(/<img\b/i);
	});

	// Two same-origin routes forward a request off-site — /rs to PostHog with whatever
	// project key the URL names, fetch-url to any public host — so "relative" does not mean "ours". (CUR-3389)
	test.each([
		"/rs/e/?data=eyJhcGlfa2V5IjoicGhjX2F0dGFja2VyIn0",
		"/rs/i/v0/e/",
		"/chat/api/fetch-url?url=https://evil.example/?d=secret",
		"/chat/conversation/abc/output/def.png?d=secret",
		"/chat/conversation/abc/output/../../../rs/e/",
		"/chat/settings",
	])("a relative URL that is not a conversation's own file loads nothing without a click: %s", (url) => {
		expect(renderHtml(`![x](${url})`)).not.toMatch(/<(img|video|audio|source)\b/i);
		const player = renderHtml(`<video controls poster="${url}"><source src="${url}"></video>`);
		expect(player).not.toContain(`src="${url}"`);
		expect(player).not.toContain(`poster="${url}"`);
	});

	test("an agent artifact path still renders in place", () => {
		expect(renderHtml("![](/chat/conversation/abc/agent-artifact/chart.png)")).toContain(
			'<img src="/chat/conversation/abc/agent-artifact/chart.png"'
		);
	});

	test("our own relative image path and an inline data: image still render in place", () => {
		expect(renderHtml("![](/chat/conversation/abc/output/def.png)")).toContain(
			'<img src="/chat/conversation/abc/output/def.png"'
		);
		expect(renderHtml("![](data:image/png;base64,iVBORw0KGgo=)")).toContain(
			'<img src="data:image/png;base64,iVBORw0KGgo="'
		);
	});

	test("a relative video path still renders as <video>", () => {
		const html = renderHtml("![](/chat/conversation/abc/output/clip.mp4)");
		expect(html).toContain("<video controls");
		expect(html).toContain('<source src="/chat/conversation/abc/output/clip.mp4">');
	});
});

describe("marked html video tag support", () => {
	test("allows raw <video> tags with controls and a relative src", () => {
		const html = renderHtml('<video controls src="/chat/conversation/abc/output/video.mp4"></video>');
		expect(html).toContain("<video");
		expect(html).toContain("controls");
		expect(html).toContain('src="/chat/conversation/abc/output/video.mp4"');
	});

	test("keeps nested <source> tags inside the player they were written in", () => {
		// marked hands each tag over separately; closing <video> early left the source outside it.
		const html = renderHtml(
			'<video controls><source src="/chat/conversation/abc/output/video.webm" type="video/webm"></video>'
		);
		expect(html).toContain(
			'<video controls><source src="/chat/conversation/abc/output/video.webm" type="video/webm"></video>'
		);
	});

	// An unclosed player made the browser read the rest of its block as fallback content, so the
	// reader never saw that text (CUR-2901).
	test.each([
		["inline, own src", 'Here is the clip: <video controls src="/chat/conversation/abc/output/v.mp4"> and the text after it.'],
		["inline, nested source", 'Listen <audio controls><source src="/chat/conversation/abc/output/a.mp3"> then read on.'],
		["block, then text", '<video controls src="/chat/conversation/abc/output/v.mp4">\nThe text after it.'],
	])("an unclosed player still leaves the text after it outside the player (%s)", (_, md) => {
		const html = renderHtml(md);
		const tag = /<(video|audio)\b/.exec(html)?.[1];
		expect(tag, html).toBeTruthy();
		const close = html.indexOf(`</${tag}>`);
		expect(close, html).toBeGreaterThan(-1);
		const after = md.includes("read on") ? "read on" : "the text after it";
		expect(html.toLowerCase().indexOf(after.toLowerCase()), html).toBeGreaterThan(close);
	});

	test("a later player's own close does not stand in for an earlier unclosed one", () => {
		const html = renderHtml(
			'First <video controls src="/chat/conversation/abc/output/a.mp4"> lost text, then <video controls src="/chat/conversation/abc/output/b.mp4"></video> end.'
		);
		const firstClose = html.indexOf("</video>");
		expect(firstClose, html).toBeGreaterThan(-1);
		expect(html.indexOf("lost text"), html).toBeGreaterThan(firstClose);
		expect(html.match(/<\/video>/g)?.length, html).toBe(2);
	});

	test.each([
		["a player with nothing it may play", '<video controls src="/x.webm">Pelicans can hold three gallons of water.</video>'],
		["a player that plays", '<video controls src="/chat/conversation/abc/output/v.mp4">Pelicans can hold three gallons of water.</video>'],
		["a player with a nested source", '<audio controls><source src="/chat/conversation/abc/output/a.mp3">Pelicans can hold three gallons of water.</audio>'],
	])("a sentence an answer wraps in a closed player is shown to the reader, outside any player (CUR-2901: %s)", (_, md) => {
		const html = renderHtml(md);
		const at = html.indexOf("Pelicans can hold three gallons of water.");
		expect(at, html).toBeGreaterThan(-1);
		const before = html.slice(0, at);
		expect((before.match(/<(video|audio)\b/g) ?? []).length, html).toBe((before.match(/<\/(video|audio)>/g) ?? []).length);
	});

	test("a raw player whose only sources are remote becomes a link to each, never an empty player (CUR-1898)", () => {
		const html = renderHtml(
			'<video controls poster="https://evil.example/p.png?d=secret"><source src="https://evil.example/v.webm"></video>'
		);
		expect(html).not.toMatch(/<(video|source)\b/i);
		expect(html).toContain('<a href="https://evil.example/v.webm" target="_blank" rel="noreferrer">');
		expect(html).not.toContain("p.png");
	});

	test("a raw player with a relative source keeps playing it and drops the remote one (CUR-1898)", () => {
		const html = renderHtml(
			'<audio controls><source src="https://evil.example/a.mp3"><source src="/chat/conversation/abc/output/a.mp3"></audio>'
		);
		expect(html).toContain('<source src="/chat/conversation/abc/output/a.mp3">');
		expect(html).not.toContain("evil.example");
		expect(html).not.toContain("data-blocked-src");
	});

	test("a raw player with only a javascript: src renders nothing, not a player or a link", () => {
		const html = renderHtml('<video controls src="javascript:alert(1)"></video>');
		expect(html).not.toMatch(/<(video|a)\b/i);
	});

	test("strips disallowed attributes from video tags", () => {
		const html = renderHtml('<video onclick="alert(1)" src="/chat/conversation/abc/output/v.mp4"></video>');
		expect(html).toContain("<video");
		expect(html).not.toContain("onclick");
	});

	test("strips javascript: URLs from media sources", () => {
		const html = renderHtml('<video controls src="javascript:alert(1)"></video>');
		expect(html).not.toContain("javascript:");
	});

	test("escapes disallowed html tags", () => {
		const html = renderHtml("<script>alert(1)</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("allows <audio> tags with controls", () => {
		const html = renderHtml(
			'<audio controls><source src="/chat/conversation/abc/output/audio.mp3" type="audio/mpeg"></audio>'
		);
		expect(html).toContain("<audio");
		expect(html).toContain("<source");
		expect(html).toContain('type="audio/mpeg"');
	});
});

// WHAT THESE DO AND DO NOT COVER — read before adding a case here expecting it to guard the
// parser. marked tokenizes inline HTML ONE TAG AT A TIME, so sanitizeHtmlForMultimedia is never
// handed a nested or multi-tag string. Nothing else reaches htmlparser2: every input that gets there
// is a single well-formed media tag: "<video controls>", "</video>",
// "<source src=... type=...>".
//
// Two consequences:
//   1. A disallowed tag arrives as its own token, fails MULTIMEDIA_HTML_REGEX (marked.ts:500),
//      and is escaped at the gate — htmlparser2 never sees it. So `hasDisallowedTag` and the
//      children recursion in serializeMediaNode do not fire on this pipeline, and a test cannot
//      reach them from renderHtml. Adding "iframe" to MULTIMEDIA_TAGS leaves every case below
//      green, which is the proof: these do not pin the allowlist.
//   2. htmlparser2 upgrades are correspondingly low-risk here — v12's WHATWG changes are about
//      raw-text tags, foreign content, implicit close and bogus comments, none of which can
//      apply to input that is one media tag.
//
// What they DO pin is the user-visible contract: disallowed HTML in a chat message reaches the
// DOM as inert text, never as a live tag, while legitimate media beside it still renders. That
// is worth a regression net regardless of which layer enforces it. Note the escaping is what makes an inert
// `onerror=` show up in the output — its presence is not a finding; a LIVE tag is.
describe("chat markdown — disallowed HTML alongside allowed media", () => {
	const cases: Array<[string, string]> = [
		["sibling script", '<video src="/chat/conversation/abc/output/v.mp4"></video><script>alert(1)</script>'],
		["nested script", '<video src="/chat/conversation/abc/output/v.mp4"><script>alert(1)</script></video>'],
		// htmlparser2 12 made <iframe>/<noembed>/<plaintext> raw-text tags — their contents stop
		// being parsed as HTML. The tag itself still has to trip the allowlist.
		[
			"iframe wrapper",
			'<video src="/chat/conversation/abc/output/v.mp4"></video><iframe><script>alert(1)</script></iframe>',
		],
		[
			"noembed wrapper",
			'<video src="/chat/conversation/abc/output/v.mp4"></video><noembed><img src=x onerror=alert(1)></noembed>',
		],
		// htmlparser2 12 disables special-tag detection inside foreign content and case-adjusts
		// SVG tag names; <svg> must still trip the allowlist rather than open a hole.
		[
			"svg foreign content",
			'<video src="/chat/conversation/abc/output/v.mp4"></video><svg><script>alert(1)</script></svg>',
		],
		// htmlparser2 12 rewrites <image> to <img> outside foreign content. Neither is allowed.
		[
			"image rewritten to img",
			'<video src="/chat/conversation/abc/output/v.mp4"></video><image src=x onerror=alert(1)>',
		],
		// recognizeSelfClosing is on, so <script/> stays a script node rather than entering a
		// raw-text state that would swallow the rest of the document.
		["self-closing script", '<video src="/chat/conversation/abc/output/v.mp4"></video><script/>alert(1)'],
		["audio with sibling script", '<audio controls></audio><script>alert(1)</script>'],
	];

	for (const [name, input] of cases) {
		test(`disallowed markup reaches the DOM as inert text — ${name}`, () => {
			const html = renderHtml(input);
			// no live tag outside the {video, source, audio} allowlist reaches the DOM
			expect(html).not.toMatch(/<(script|iframe|svg|image|img|noembed|plaintext|object|embed)\b/i);
			expect(html).not.toMatch(/<\/\s*(script|iframe|svg|noembed)\b/i);
			// and it was escaped rather than silently dropped, which would hide the input
			expect(html).toContain("&lt;");
		});
	}

	test("allowed media in the same message still renders — the escape is per-chunk, not a blanket refusal", () => {
		const html = renderHtml(
			'<video controls><source src="/chat/conversation/abc/output/v.webm" type="video/webm"></video>'
		);
		expect(html).toContain("<video");
		expect(html).toContain("<source");
		expect(html).not.toContain("&lt;video");
	});
});

describe("streaming incomplete markdown", () => {
	test("incomplete link renders as inert anchor, not a dead clickable link", () => {
		const html = renderBlocksHtml("Check [the docs](https://exam", true);
		expect(html).toContain("<a data-incomplete-link>the docs</a>");
		expect(html).not.toContain("streamdown:incomplete-link");
		expect(html).not.toContain("target=");
	});

	test("an image whose URL is still streaming renders nothing: no img, no alt text, no placeholder", () => {
		for (const input of ["before ![alt words](https://exa", "before ![alt words](streamdown:incomplete-image)"]) {
			const html = renderBlocksHtml(input, true);
			expect(html).toContain("before");
			expect(html).not.toContain("<img");
			expect(html).not.toContain("alt words");
			expect(html).not.toContain("streamdown:");
		}
	});

	test("incomplete link text renders as inert anchor", () => {
		const html = renderBlocksHtml("Check [the doc", true);
		expect(html).toContain("<a data-incomplete-link>the doc</a>");
	});

	test("complete links keep their href", () => {
		const html = renderBlocksHtml("Check [the docs](https://example.com)", true);
		expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">');
		expect(html).not.toContain("data-incomplete-link");
	});

	test("incomplete bold renders as bold", () => {
		const html = renderBlocksHtml("Some **important tex", true);
		expect(html).toContain("<strong>important tex</strong>");
	});

	test("incomplete inline code renders as code", () => {
		const html = renderBlocksHtml("Run `npm insta", true);
		// translate="no": inline code is opted out of browser auto-translate (DE/FR readers)
		// so identifiers/commands aren't rewritten into the target language.
		expect(html).toContain('<code translate="no">npm insta</code>');
	});

	test("partial trailing HTML tag does not flash as raw text", () => {
		const html = renderBlocksHtml("Some text <video contro", true);
		expect(html).toContain("Some text");
		expect(html).not.toContain("video contro");
	});

	test("lone dash while a list streams in does not flash previous text as heading", () => {
		const html = renderBlocksHtml("Shopping list:\n-", true);
		expect(html).not.toContain("<h2>");
		expect(html).toContain("Shopping list:");
	});

	test("single tilde ranges do not flash as strikethrough", () => {
		const html = renderBlocksHtml("Heat to 20~25°C", true);
		expect(html).not.toContain("<del>");
		expect(html).toContain("20~25°C");
	});

	test("comparison operator in list items does not render a blockquote", () => {
		const html = renderBlocksHtml("- > 25: expensive", true);
		expect(html).not.toContain("<blockquote>");
		expect(html).toContain("&gt; 25: expensive");
	});
});

describe("completed message finalization (finalizeMarkdown)", () => {
	test("a trailing setext heading still renders as a heading", () => {
		// Regression: neither remend's setext flash guard nor finalizeMarkdown may
		// rewrite completed content — a setext heading is a `heading` token, which
		// finalizeMarkdown emits verbatim.
		const html = renderBlocksHtml("Title\n-", false);
		expect(html).toContain('<h2 dir="ltr">Title</h2>');
	});

	test("the same trailing setext heading is guarded while streaming", () => {
		const html = renderBlocksHtml("Title\n-", true);
		expect(html).not.toContain("<h2>");
	});

	test("a completed dangling bold is repaired, not left as a literal **", () => {
		// The fix: finalizeMarkdown closes an unclosed ** at completion so bold that
		// showed while streaming doesn't "settle" back to raw literal markdown.
		const html = renderBlocksHtml("Some **truncated outpu", false);
		expect(html).toContain("<strong>truncated outpu</strong>");
		expect(html).not.toContain("**truncated");
	});

	test("a completed run-on `N. **` list is rebuilt into a real <ol> with bold labels", () => {
		const content =
			"Here are topics: 1. **Climate Change: rising temps. " +
			"2. **Space Exploration: new missions. 3. **Quantum Computing: faster.";
		const html = renderBlocksHtml(content, false);
		expect(html).toMatch(/<ol[\s>]/);
		expect(html).toContain("<strong>Climate Change: rising temps.</strong>");
		expect(html).toContain("<strong>Space Exploration: new missions.</strong>");
		expect(html).not.toContain("**");
	});

	test("an ordered list whose later item runs its siblings on is rebuilt into one <ol>", () => {
		// Items 1-2 are real list items; item 2's text runs on with 3./4./5. (item 3
		// has no bold label). Anchored at the item marker, so it splits into 5 items.
		const content =
			"1. **Global Politics**: tensions.\n\n" +
			"2. **Economy**: digital growth. 3. Privacy concerns remain a focus. 4. **Environment**: sustainability.";
		const html = renderBlocksHtml(content, false);
		expect((html.match(/<li[\s>]/g) || []).length).toBe(4);
		expect(html).toContain("Privacy concerns remain a focus.");
	});

	test("that same run-on list is left alone while streaming (remend owns streaming)", () => {
		const content = "Here are topics: 1. **Climate Change: rising temps. 2. **Space Exploration: new missions.";
		const html = renderBlocksHtml(content, true);
		expect(html).not.toMatch(/<ol[\s>]/);
	});

	test("incomplete links in completed content render literally", () => {
		const html = renderBlocksHtml("Check [the docs](https://exam", false);
		expect(html).not.toContain("data-incomplete-link");
		// Bracket syntax stays literal text (the bare URL may still be autolinked by GFM)
		expect(html).toContain("[the docs](");
	});
});

describe("processBlocksSync streaming behavior", () => {
	test("a caret citation still arriving shows no stray caret mid-stream (CUR-3551)", () => {
		for (const partial of [
			"The capital of Japan is Tokyo^",
			"The capital of Japan is Tokyo^1,2",
			"Canberra [^1",
			"Tokyo[1]-",
		]) {
			const blocks = processBlocksSync(partial, [{ title: "First", link: "https://a.example/page" }], true);
			expect(blocks.at(-1)?.content, partial).not.toMatch(/\^|\][-–]\s*$/);
		}
	});

	test("a caret citation that just closed links mid-stream, never painting raw ^1,2,5 (CUR-4124)", () => {
		const sources = [1, 2, 3, 4, 5].map((n) => ({ title: `Source ${n}`, link: `https://s${n}.example/page` }));
		const partial = "The capital of Japan is Tokyo.^1,2,5^";
		const streaming = processBlocksSync(partial, sources, true).at(-1)?.content ?? "";
		expect(streaming).not.toMatch(/\^[\d,]+$/);
		expect(streaming).toBe(processBlocksSync(partial, sources, false).at(-1)?.content);
		const nextGroup = processBlocksSync("The capital of Japan is Tokyo.^1^ ^2", sources, true).at(-1)?.content;
		expect(nextGroup).toBe("The capital of Japan is Tokyo.^1^");
	});

	test("regex character classes in code do not collapse the document into one block", () => {
		const content = [
			"Match whitespace:",
			"",
			"```js",
			"const re = /[^\\s>]+/;",
			"```",
			"",
			"And some trailing explanation.",
		].join("\n");
		const blocks = processBlocksSync(content, []);
		expect(blocks.length).toBeGreaterThan(1);
	});

	test("block ids of completed blocks are stable while streaming and after completion", () => {
		const full = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
		// Final render: completed message, no streaming repairs
		const fullIds = processBlocksSync(full, [], false).map((b) => b.id);
		// Mid-stream render: third paragraph still arriving, repairs active
		const partialIds = processBlocksSync(`${full.slice(0, -10)}`, [], true).map((b) => b.id);
		expect(partialIds.slice(0, -1)).toEqual(fullIds.slice(0, partialIds.length - 1));
	});
});

// ── Lazy heavy-render path ──────────────────────────────────────────────────────────────────
// processBlocks (async) is what the worker uses. It dynamically loads highlight.js / KaTeX only
// when the content needs them, then renders full-fidelity — the upgrade over the readable
// sync fallback. These assert the lazy load actually wires up correctly.
import { processBlocks, highlightCode, ensureHljs, ensureKatex } from "./marked";

describe("lazy full-render (processBlocks async)", () => {
	test("sync code render is plain+readable BEFORE highlight.js loads", async () => {
		// ISOLATED, because this test's name is a claim about module state and it can only be observed
		// on a module that has not loaded highlight.js yet. `ensureHljs()` in the next test latches the
		// import for the rest of the process, so under any order but the default one this ran against an
		// ALREADY-highlighted module.
		//
		// Fresh module state isn't guaranteed across the suite, and under shuffled order this runs against
		// an already-highlighted module. Highlighted output is `<span class="hljs-keyword">const</span> x = …`,
		// so the literal `const x = 1;` is not contiguous there; the assertion therefore needs a fresh module.
		vi.resetModules();
		const fresh = await import("./marked");
		const tokens = fresh.processTokensSync("```js\nconst x = 1;\n```", []);
		const code = tokens.find((t) => t.type === "code");
		expect(code && code.type === "code" && code.code).toContain("const x = 1;");
	});

	test("async render highlights code (loads highlight.js on demand)", async () => {
		await ensureHljs();
		expect(highlightCode("const x = 1;", "javascript")).toContain("hljs-");
		const blocks = await processBlocks("```js\nconst x = 1;\n```", []);
		const code = blocks.flatMap((b) => b.tokens).find((t) => t.type === "code");
		expect(code && code.type === "code" && code.code).toContain("hljs-");
	});

	test("async render produces KaTeX HTML for math (loads katex on demand)", async () => {
		await ensureKatex();
		const blocks = await processBlocks("energy $E=mc^2$ today", []);
		const htmls = await Promise.all(
			blocks
				.flatMap((b) => b.tokens)
				.filter((t) => t.type === "text")
				.map((t) => (t.type === "text" ? t.html : ""))
		);
		expect(htmls.join(" ")).toContain('class="katex"');
	});

	// Regression: dollar AMOUNTS in prose ("$1 more, together $1.10") were parsed as $...$ inline math
	// and rendered garbled (italicised, spaces stripped → "1morethanthe..."). The currency-safe rule
	// must leave them as literal text. A math token renders the <code data-katex-pending> sync fallback,
	// so its absence proves the amounts weren't treated as math.
	test("dollar amounts are NOT parsed as inline math (currency-safe)", () => {
		const html = renderHtml("the ball is $0.05, the bat $1.05, together $1.10");
		expect(html).toContain("$0.05");
		expect(html).toContain("$1.10");
		expect(html).not.toContain("data-katex-pending");
	});

	// (Real inline math still works is covered by the "$E=mc^2$" async test above — the currency-safe
	// regex matches that expression unchanged; it only rejects $-amounts.)
});

// CUR-2647 (upstream 91123d1f): highlight.js and KaTeX run synchronously, so a huge block held the
// thread rendering it. Past the caps it renders as escaped text; normal content still highlights.
describe("oversized code and math render as escaped text, normal ones still highlight (CUR-2647)", () => {
	test("a labeled block over 50k chars is escaped, not highlighted", async () => {
		await ensureHljs();
		const big = "const x = 1; // <b>\n".repeat(3_000);
		const out = highlightCode(big, "javascript");
		expect(out).not.toContain("hljs-");
		expect(out).toContain("&lt;b&gt;");
	});

	test("a 1 MB labeled block renders in well under a second, because the cap skips highlight.js", async () => {
		await ensureHljs();
		const big = "const x = { a: [1, 2, 3], b: 'two' }; // <b>\n".repeat(23_000);
		const start = performance.now();
		const out = highlightCode(big, "javascript");
		expect(performance.now() - start).toBeLessThan(250);
		expect(out).not.toContain("hljs-");
	});

	test("an unlabeled block over 5k chars skips auto-detect and is escaped", async () => {
		await ensureHljs();
		const out = highlightCode("const x = 1;\n".repeat(600));
		expect(out).not.toContain("hljs-");
	});

	test("a labeled block just under 50k chars still highlights", async () => {
		await ensureHljs();
		expect(highlightCode("const x = 1;\n".repeat(3_500), "javascript")).toContain("hljs-");
	});

	test("math over 10k chars renders its raw source escaped, not through KaTeX", async () => {
		await ensureKatex();
		const blocks = await processBlocks(`$$${"x+".repeat(6_000)}1$$`, []);
		const htmls = await Promise.all(
			blocks
				.flatMap((b) => b.tokens)
				.filter((t) => t.type === "text")
				.map((t) => (t.type === "text" ? t.html : ""))
		);
		expect(htmls.join(" ")).not.toContain('class="katex"');
	});

	// The server render has no fallback. A warm server instance has highlight.js and KaTeX loaded and
	// runs them too, so the caps above are what bound its work: past them a block costs a parse and a
	// sanitize (a 200 KB code block measured 6 ms).
	test("the server render formats a long answer in full, with no plain-text fallback", () => {
		const content = Array.from({ length: 700 }, (_, i) => `Paragraph ${i} with **bold** text.`).join("\n\n");
		const blocks = processBlocksSync(content, []).filter((b) => b.content.trim());
		expect(blocks).toHaveLength(700);
		for (const b of blocks) {
			const html = b.tokens.map((t) => (t.type === "text" ? String(t.html) : "")).join("");
			expect(html).toContain("<strong>bold</strong>");
		}
	});

	test("the server render keeps a 200k-char code block a code token", () => {
		const blocks = processBlocksSync("intro\n\n```js\nconst a = 1;\n" + "x".repeat(200_000) + "\n```", []);
		expect(blocks).toHaveLength(3);
		expect(blocks[2].tokens[0].type).toBe("code");
	});

	// The answer e2e/scenarios/oversized-code-block.spec.ts seeded into a real conversation (SOL-206):
	// a normal python block, 400 paragraphs of formatted prose, and a 200 KB unlabeled block whose lines
	// carry markup. The server renders with processBlocksSync on an instance that has highlight.js
	// loaded; the browser's markdown worker renders with processBlocks. Both have to hold the caps.
	// e2e-moved: scenarios/oversized-code-block.spec.ts › a 200 KB code block is served formatted and never run through highlight.js; a normal block still highlights
	test.each([
		["the warm server render (processBlocksSync)", (md: string) => Promise.resolve(processBlocksSync(md, [], false))],
		["the browser worker render (processBlocks)", (md: string) => processBlocks(md, [], false)],
	])("%s of a 200 KB unlabeled block next to normal content: prose formatted to the end, python highlighted, the big block escaped and plain", async (_name, renderBlocks) => {
		await ensureHljs();
		const prose = Array.from(
			{ length: 400 },
			(_, i) => `Paragraph ${i} carries **long-answer-${i}** and enough plain prose to read like a real reply.`
		).join("\n\n");
		const oversized = "```\n" + "x = 1  # <b>not bold</b>\n".repeat(8_000) + "```";
		const seeded = `Here you go.\n\n\`\`\`python\ndef add(a, b):\n    return a + b\n\`\`\`\n\n${prose}\n\n${oversized}\n`;

		const started = performance.now();
		const tokens = (await renderBlocks(seeded)).flatMap((b) => b.tokens);
		const html = (await Promise.all(tokens.map((t) => (t.type === "text" ? t.html : "")))).join("");
		// A server render of 15 s or more means the big block held the thread (CUR-2647).
		// In process it takes well under a second, so 5 s leaves CI room and still catches a regex or
		// KaTeX pass that goes quadratic on the big block.
		expect(performance.now() - started, "rendering the answer took 5 s or more").toBeLessThan(5_000);
		expect(html, "the long prose was not formatted all the way through").toContain(
			"<strong>long-answer-399</strong>"
		);
		const code = tokens.filter((t) => t.type === "code");
		expect(code).toHaveLength(2);
		expect(code[0].type === "code" && code[0].code, "the normal python block lost its highlighting").toContain(
			"hljs-"
		);
		const big = code[1].type === "code" ? code[1].code : "";
		expect(big, "the oversized block was run through highlight.js").not.toContain("hljs-");
		expect(big, "the oversized block lost its markup escaping").toContain("# &lt;b&gt;not bold&lt;/b&gt;");
	});
});

// The first client render runs before highlight.js loads and draws code plain. That block
// went into blockCache, and the full render read it back, so a reopened chat's code never got colours. (CUR-2647)
describe("a block drawn before highlight.js loads is not reused by the full render (CUR-2647)", () => {
	test("processBlocks highlights code the sync render drew plain", async () => {
		vi.resetModules();
		const fresh = await import("./marked");
		const content = "```python\ndef add(a, b):\n    return a + b\n```";
		const plain = fresh.processBlocksSync(content, []);
		const before = plain[0].tokens[0];
		expect(before.type === "code" ? before.code : "").not.toContain("hljs-");
		await fresh.ensureHljs();
		const full = await fresh.processBlocks(content, []);
		const after = full[0].tokens[0];
		expect(after.type === "code" ? after.code : "").toContain("hljs-");
	});
});

// Arabic, Urdu and Pashto answers were laid out left to right because nothing carried a dir.
// Every block gets an explicit direction from the majority of its letters (textDirection.ts). Never
// dir="auto": it takes the first letter, and skips children with their own dir, and CI caught both — an
// Urdu <ul dir="auto"> resolved ltr, and an Arabic paragraph opening "AI Potluck" resolved ltr. (CUR-1917)
describe("answer blocks take their direction from their own text (CUR-1917)", () => {
	test("an Arabic paragraph that opens with a Latin name is right to left", () => {
		expect(renderBlocksHtml("AI Potluck هو المحادثة المفتوحة من Current AI.", false)).toMatch(
			/<p dir="rtl">AI Potluck/
		);
	});

	test("an Arabic heading and paragraph are right to left; nothing is left as dir=auto", () => {
		const html = renderBlocksHtml("## عنوان\n\nفقرة.", false);
		expect(html).toMatch(/<h2 dir="rtl"/);
		expect(html).toMatch(/<p dir="rtl">فقرة\.<\/p>/);
		expect(html).not.toContain('dir="auto"');
	});

	test("an Urdu list and its items are right to left", () => {
		const html = renderBlocksHtml("- کم توانائی والے LED لیمپس\n- آلات کو پلگ سے نکال دیں", false);
		expect(html).toMatch(/<ul dir="rtl">/);
		expect(html.match(/<li dir="rtl">/g)).toHaveLength(2);
	});

	test("an English list stays left to right, and an ordered list's start= is not read as its text", () => {
		expect(renderBlocksHtml("- one\n- two", false)).toMatch(/<ul dir="ltr">/);
		expect(renderBlocksHtml("5. پانچ\n6. چھ", false)).toMatch(/<ol start="5" dir="rtl">|<ol dir="rtl" start="5">/);
	});

	test("a loose Arabic list, its paragraphs and a blockquote are right to left", () => {
		const html = renderBlocksHtml("- أولاً\n\n- ثانياً\n\n> اقتباس", false);
		expect(html).toMatch(/<li dir="rtl">\s*<p dir="rtl">أولاً/);
		expect(html).toMatch(/<blockquote dir="rtl">/);
	});

	test("an English answer quoting an Arabic paragraph lays out only that paragraph right to left", () => {
		const html = renderBlocksHtml("The sign reads:\n\n> مرحبا بكم في المكتبة العامة", false);
		expect(html).toMatch(/<p dir="ltr">The sign reads:/);
		expect(html).toMatch(/<blockquote dir="rtl">/);
	});

	test("a tag written inside inline code is text, not a block, and gets nothing", () => {
		const html = renderBlocksHtml("Use `<p>` for paragraphs.", false);
		expect(html).toContain("&lt;p&gt;");
		expect(html.match(/ dir="/g)).toHaveLength(1); // the paragraph itself
	});
});

// The note that replaces an answer groundcheck emptied, rendered the way the chat renders it.
// Two chunks of one url-less document, as a demo chat retrieves them. (CUR-2614)
describe("groundcheck's emptied-answer note, rendered", () => {
	test("names a url-less source once, with no bracketed copy beside it", () => {
		const sources = [
			{ title: "About AI Potluck", link: "" },
			{ title: "About AI Potluck", link: "" },
		];
		const note = groundcheckEmptiedText(sources.map((s, i) => ({ n: i + 1, title: s.title })));
		const text = renderHtmlWithSources(note, sources).replace(/<[^>]+>/g, "");
		expect(text.match(/About AI Potluck/g)).toHaveLength(1);
		expect(text).not.toContain("[About AI Potluck]");
	});
});
