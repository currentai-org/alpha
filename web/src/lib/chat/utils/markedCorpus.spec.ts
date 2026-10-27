import { describe, expect, test } from "vitest";
import { Lexer } from "marked";
import { processBlocksSync, processTokensSync } from "./marked";
import { UNVERIFIED_TITLE } from "$lib/chat/constants/unverifiedHref";

// A rendering SNAPSHOT across the markdown a model actually emits, plus one invariant.
//
// marked sits in dependabot.yml's npm-major exclude-patterns because "bad output renders; it does not
// throw" — a renderer change produces wrong HTML on the chat surface and nothing goes red. The
// assertions in marked.spec.ts each pin one named property, which is the right shape for behaviour we
// chose deliberately; they cannot tell you that a bump left everything ELSE alone. That is what a
// snapshot is for: the diff IS the review, and a reviewer sees the changed HTML rather than a
// pass/fail.
//
// Across a major bump the rendered HTML here stays byte-identical except for extra empty `space` tokens —
// marked 13 adds a space token after blockquote and hr when there are multiple newlines, its renderer
// returns "", and MarkdownBlock.svelte emits no wrapper, so they produce no DOM. The per-property
// assertions in marked.spec.ts cannot tell a bump apart from that.
//
// Sync paths only, deliberately: processTokensSync renders before KaTeX and highlight.js load, so
// output is deterministic (math shows its pending fallback, code is unhighlighted). The async path
// would make the snapshot depend on dynamic-import timing.

const SOURCES = [
	{ title: "Apertus paper", link: "https://example.com/apertus?a=1&b=2" },
	{ title: "No-url doc <script>", link: "" },
];

const CASES: Array<[string, string]> = [
	["heading-atx", "# One\n## Two\n### Three"],
	["heading-setext", "Title\n=====\n\nSub\n-----"],
	["para-breaks", "line one\nline two\n\nnew para"],
	["emphasis", "*em* **strong** ***both*** ~~struck~~ `code`"],
	["link-plain", "[link](https://example.com)"],
	["link-title", '[link](https://example.com "a title")'],
	["link-unverified-title", `[gh](https://example.com "${UNVERIFIED_TITLE}")`],
	["link-unverified-legacy", "See [github.com/x](unverified:) here."],
	["link-bad-scheme", "[x](javascript:alert(1))"],
	["link-nested-markup", "[**bold** and `code`](https://example.com)"],
	["link-media", "[clip](https://example.com/a.mp4)"],
	["autolink", "visit https://example.com and <https://b.example>"],
	["image", "![alt text](https://example.com/pic.png)"],
	["image-title", '![alt](https://example.com/pic.png "cap")'],
	["image-video", "![](https://example.com/clip.mp4)"],
	["list-tight", "- a\n- b\n- c"],
	["list-loose", "- a\n\n- b\n\n- c"],
	["list-nested", "- a\n  - a1\n  - a2\n- b"],
	["list-ordered", "1. one\n2. two\n3. three"],
	["list-ordered-start", "5. five\n6. six"],
	["list-task", "- [ ] todo\n- [x] done"],
	["list-multiline-item", "- first line\n  continued here\n- second"],
	["list-citation-leading", "- [1] leading citation moves\n- [2] and this one."],
	["blockquote", "> quoted\n> more"],
	["blockquote-nested", "> outer\n> > inner"],
	["blockquote-code", "> ```\n> code\n> ```"],
	["hr", "above\n\n---\n\nbelow"],
	["hr-multi-newline", "above\n\n\n***\n\n\nbelow"],
	["table", "| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 | 4 |"],
	["table-trailing-newlines", "| a | b |\n|---|---|\n| 1 | 2 |\n\n\nafter"],
	["table-inline", "| a | b |\n|---|---|\n| **x** | [l](https://e.com) |"],
	["code-fence", "```js\nconst a = 1;\n```"],
	["code-fence-nolang", "```\nplain\n```"],
	["code-indented", "    indented code"],
	["html-video", '<video controls><source src="https://e.com/a.mp4"></video>'],
	["html-audio", '<audio controls src="https://e.com/a.mp3"></audio>'],
	["html-video-relative-source", '<video controls><source src="/chat/conversation/abc/output/a.mp4"></video>'],
	["html-disallowed", "<script>alert(1)</script>"],
	["html-inline-tag", "text <b>bold</b> more"],
	["entities", "AT&T &amp; &lt;tag&gt; &copy;"],
	["katex-inline", "the value $x^2$ here"],
	["katex-block", "$$\n\\frac{a}{b}\n$$"],
	["currency", "it costs $1 more, together $1.10"],
	["citations", "See [1] and [2] for detail."],
	["citation-in-code", "`[1]` stays literal"],
	["mixed-doc", "# T\n\npara with [1].\n\n- item\n- item2\n\n```py\nx=1\n```\n\n> q\n\n| a |\n|---|\n| 1 |"],
];

function render(md: string) {
	const one = (t: { type: string; html?: string | Promise<string> }) =>
		t.type === "text" && typeof t.html === "string" ? t.html : `[[${t.type}]]`;
	const blocks = (streaming: boolean) =>
		processBlocksSync(md, SOURCES, streaming)
			.flatMap((b) => b.tokens)
			.map(one)
			.join("\n");
	return {
		tokens: processTokensSync(md, SOURCES).map(one).join("\n"),
		blocksFinal: blocks(false),
		blocksStreaming: blocks(true),
	};
}

describe("marked rendering corpus", () => {
	for (const [name, md] of CASES) {
		test(name, () => {
			expect(render(md)).toMatchSnapshot();
		});
	}
});

// finalizeMarkdown (finalizeMarkdown.ts:243-267) rewrites `paragraph` and `list` tokens to repair a
// completed message, but ONLY when the block tokens' `raw` values concatenate back to the input
// exactly. When they don't it returns the content untouched — every repair silently stops happening,
// with no error and no log line.
//
// That guard is one `!==` away from disabling a feature, and marked's own release notes keep touching
// exactly what feeds it: 18.0.0 alone shipped "trim blank lines from block tokens", "prevent GFM table
// tokens from greedily capturing trailing newlines", and "prevent heading and def tokens from greedily
// capturing multiple newlines". Every corpus case is LOSSLESS on marked 12 and 18. Asserted here so a
// future bump that flips any case to BAILS is a red test rather than a feature that quietly left.
describe("finalizeMarkdown's faithfulness guard holds for the whole corpus", () => {
	test("every case reconstructs losslessly from its block tokens", () => {
		const bails = CASES.filter(([, md]) => {
			let rebuilt = "";
			try {
				for (const t of Lexer.lex(md, { gfm: true })) rebuilt += t.raw;
			} catch {
				return true;
			}
			return rebuilt !== md;
		}).map(([name]) => name);
		// Not toHaveLength(0) — naming them is what makes the failure diagnosable, since the effect is
		// "finalization stopped happening for this input shape" rather than an exception.
		expect(bails).toEqual([]);
	});
});
