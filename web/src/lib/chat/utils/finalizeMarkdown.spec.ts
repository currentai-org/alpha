import { describe, expect, test } from "vitest";
import { marked } from "marked";
import { finalizeMarkdown } from "./finalizeMarkdown";

describe("finalizeMarkdown — the reported defect", () => {
	test("run-on `N. **` list embedded in a paragraph is split and each bold closed", () => {
		const input =
			"Here are five topics: 1. **Climate Change: temps. " +
			"2. **Space Exploration: Mars. 3. **Quantum Computing: fast.";
		expect(finalizeMarkdown(input)).toBe(
			"Here are five topics:\n" +
				"1. **Climate Change: temps.**\n" +
				"2. **Space Exploration: Mars.**\n" +
				"3. **Quantum Computing: fast.**"
		);
	});

	test("run-on `N. **` list that starts at the line (mis-lexed as one list item) is rebuilt", () => {
		const input = "1. **Climate: temps. 2. **Space: Mars. 3. **Quantum: fast.";
		expect(finalizeMarkdown(input)).toBe(
			"1. **Climate: temps.**\n2. **Space: Mars.**\n3. **Quantum: fast.**"
		);
	});

	test("a standalone paragraph with a dangling bold is closed", () => {
		expect(finalizeMarkdown("**Note: remember this.")).toBe("**Note: remember this.**");
	});

	test("an ordered list item that runs its siblings on is split (mixed bold labels, already closed)", () => {
		// The second reported case: items 1 and 2 render, but item 2's text runs on
		// with 3./4./5. — one of which (3.) has no bold label, so the `N. **` signature
		// alone misses it. It's anchored at the item's own marker, so it still splits.
		const input =
			"1. **Global Politics**: tensions.\n\n" +
			"2. **Economy**: digital growth. 3. Privacy concerns remain a focus. " +
			"4. **Environment**: sustainability. 5. **Society**: social movements.";
		expect(finalizeMarkdown(input)).toBe(
			"1. **Global Politics**: tensions.\n\n" +
				"2. **Economy**: digital growth.\n" +
				"3. Privacy concerns remain a focus.\n" +
				"4. **Environment**: sustainability.\n" +
				"5. **Society**: social movements."
		);
	});

	test("a run-on with unclosed bold labels where one item is plain is still split", () => {
		// 3 of 4 items carry an unclosed ** label; the plain item (2.) rides along.
		expect(
			finalizeMarkdown("1. **Alpha here 2. Beta plain 3. **Gamma here 4. **Delta here")
		).toBe("1. **Alpha here**\n2. Beta plain\n3. **Gamma here**\n4. **Delta here**");
	});
});

describe("finalizeMarkdown — leaves valid / ambiguous markdown untouched", () => {
	const unchanged: [string, string][] = [
		["a proper multi-line list", "1. **Climate:** hot\n2. **Space:** far"],
		["a balanced multi-line bold span", "This is **bold text\nthat continues** here."],
		["already-closed bold in prose", "This is **bold** and normal."],
		["a trailing single-dash setext heading", "Some conclusion\n-"],
		["a literal ** surrounded by spaces (flanking-aware)", "Type ** to start bold in markdown"],
		["a Python exponent operator written in prose", "The formula 5**2 equals 25 in code"],
		["an intra-word double asterisk", "an un**even distribution of results"],
		["inline code that contains **", "Use `a ** b` in code."],
		["prose that enumerates section numbers", "See Section 1. Introduction and Section 2. Methods for details."],
		["prose with figure references", "See figures 1. 2. and 3. for details."],
		["a dollar amount followed by a number", "It cost $5. 3 apples were left."],
		["a year followed by a number", "In 2020. 1 thing changed."],
		["links whose labels contain `N.`", "Read [Section 1. Intro](https://a.example) and [Section 2. Methods](https://b.example)."],
		["a GFM table row that looks like a run-on", "| Ref |\n| --- |\n| See Section 1. Intro and Section 2. Methods |"],
		["a blockquote that enumerates section numbers", "> See Section 1. Intro and Section 2. Methods."],
		["a multi-line strong span inside a list item", "- **Important:\n  continues here**"],
		["a multi-line strong span inside a task-list item", "- [ ] **Write docs:\n  include API examples**"],
		["a multi-line strong span inside an ordered item with a citation", "1. **Claim [1]\n   continues here**"],
		["a fenced code block containing a fake run-on list", "```\n1. **one 2. **two 3. **three\n```"],
		["a standalone literal ** in a blockquote", "> **x"],
		["math with an unbalanced ** is left to KaTeX", "$$ a ** b $$"],
		// A run with no (or a minority of) bold labels is ambiguous with a single list item
		// whose prose carries a continuing number or a sub-enumeration, so it is not split.
		["a list item whose prose contains a continuing number", "1. In 2023, 2. it was rewritten again"],
		["a list item with an inline sub-enumeration", "1. Sub-options: 2. alpha 3. beta remain examples"],
		["a bare one-line run-on with no bold labels", "1. First point here 2. Second point here 3. Third point"],
		// Prose that CLOSES its bold after inline numbers is not a malformed list, so it is left alone.
		["prose with closed bold titles after numbers", "See Section 1. **Introduction** and Section 2. **Methods** for details."],
		["a single list item with a closed-bold sub-reference", "1. **Note:** see 2. **also** below"],
		["prose weaving closed bold and numbers with conjunctions", "See 1. **Alpha** and 2. beta; then 3. **Gamma** and 4. delta."],
		// A list-continuation item (num≠1) whose prose references bold sections has no
		// colon labels, so it is not mistaken for a run-on labeled list.
		["a list item referencing bold sections with numbers", "1. **Topic**: t.\n\n2. See Section 3. **Alpha** and Section 4. **Beta** for details."],
		// A 2-item run (item + one continuing marker) is below the ≥3 floor, so it is not split.
		["a two-item colon-labeled continuation (below the ≥3 floor)", "1. **First**: ok.\n\n2. **Second:** ok. 3. **Third:** ok."],
		// Faithfulness guard — Lexer.lex hoists these out of the token stream / rewrites CRLF,
		// so finalizeMarkdown must leave the whole message untouched.
		["a link reference definition (hoisted into tokens.links)", "[id]: https://example.com\n\nUse [id]."],
		["CRLF line endings", "plain paragraph\r\n\r\nsecond paragraph"],
		// A footnote definition is a bare paragraph to plain Lexer.lex; must not be split.
		["a footnote definition containing a run-on", "[^1]: 1. **One 2. **Two 3. **Three"],
		// A run-on entangled with a link can't be split safely, so it's left whole (not half-fixed).
		["a run-on bold list in a paragraph that also has a link", "See [docs](https://u.example): 1. **One 2. **Two 3. **Three"],
		// Inline raw HTML content is literal — never split or bold-close inside it.
		["a run-on inside inline raw HTML", "<span> Intro 1. **x 2. **y</span>"],
		["a literal ** inside inline raw HTML", "<span>literal **not emphasis</span>"],
		["a literal ** inside an HTML comment", "Intro <!-- comment **literal --> outro"],
		["a literal ** inside an HTML declaration", "See <!DOCTYPE **html> here"],
		["plain prose", "just some plain text with no markdown"],
		["the empty string", ""],
	];

	for (const [name, input] of unchanged) {
		test(name, () => {
			expect(finalizeMarkdown(input)).toBe(input);
		});
	}
});

describe("finalizeMarkdown — repairs that change output", () => {
	test("a run-on inside a nested list keeps its indentation (stays nested)", () => {
		const input = "- Parent\n  1. **One here 2. **Two here 3. **Three here";
		expect(finalizeMarkdown(input)).toBe(
			"- Parent\n  1. **One here**\n  2. **Two here**\n  3. **Three here**"
		);
	});

	test("a dangling bold in a paragraph that also has a link is still closed", () => {
		expect(finalizeMarkdown("See [docs](https://u.example) and **note")).toBe(
			"See [docs](https://u.example) and **note**"
		);
	});
});

describe("finalizeMarkdown — does not fire on run-ons without the bold signature", () => {
	test("a non-1-based run-on after prose text is not split (would only make a <br> paragraph)", () => {
		// A list starting at 3 can't interrupt a paragraph, so splitting would not
		// produce an <ol>; leave it untouched rather than emit a half-formatted block.
		const input = "See 3. **Three 4. **Four 5. **Five";
		expect(finalizeMarkdown(input)).toBe(input);
	});

	test("a plain run-on ordered list (no bold) is not restructured", () => {
		// Only the `N. **` bug is in scope; a plain run-on has no literal ** to break,
		// and splitting arbitrary `N.` sequences risks corrupting prose.
		const input = "Steps: 1. boil water 2. add pasta 3. wait.";
		expect(finalizeMarkdown(input)).toBe(input);
	});
});

// A reply of exactly `4417.` (the answer to "What is the door code?") is read by marked
// as an ordered list starting at 4417 with one empty item, so the bubble would show nothing.
describe("finalizeMarkdown — a bare number with a period is text, not an empty list", () => {
	const render = (md: string) => marked.parse(finalizeMarkdown(md)) as string;

	test("a reply that is only `4417.` renders the number", () => {
		expect(render("4417.")).toContain("4417.");
		expect(render("4417.")).not.toContain("<ol");
	});

	test("the same after a lead-in paragraph, and with a `)` delimiter", () => {
		expect(render("The code:\n\n4417.")).toContain("4417.");
		expect(render("42)")).toContain("42)");
	});

	test("a real ordered list, even a one-item one, is left a list", () => {
		expect(finalizeMarkdown("1. Buy milk")).toBe("1. Buy milk");
		expect(render("1. Buy milk\n2. Bread")).toContain("<ol>");
	});
});

// A model that brackets a drafted letter in --- rules puts the closing one straight under
// the signature, and CommonMark reads every line above it as one setext heading. (CUR-3662)
describe("finalizeMarkdown — a multi-line setext heading is a paragraph and a rule", () => {
	const render = (md: string) => marked.parse(finalizeMarkdown(md)) as string;

	test("a signature followed directly by --- renders as a paragraph and an <hr>, not a heading", () => {
		const input = "Best regards,\n[Your Full Name]\n[Your Address]\n---";
		expect(finalizeMarkdown(input)).toBe("Best regards,\n[Your Full Name]\n[Your Address]\n\n---");
		const html = render(input);
		expect(html).not.toMatch(/<h\d/);
		expect(html).toContain("<hr");
	});

	test("the rewrite keeps what follows the rule", () => {
		expect(finalizeMarkdown("Thanks,\nJane\n---\n\nP.S. Call me.")).toBe("Thanks,\nJane\n\n---\n\nP.S. Call me.");
	});

	test("a one-line setext heading stays a heading", () => {
		expect(finalizeMarkdown("Title\n---")).toBe("Title\n---");
		expect(finalizeMarkdown("Title\n-")).toBe("Title\n-");
	});

	test("a multi-line heading over one or two dashes is left alone, since fewer than three dashes is not a rule", () => {
		expect(finalizeMarkdown("Line one\nLine two\n-")).toBe("Line one\nLine two\n-");
		expect(finalizeMarkdown("Line one\nLine two\n--")).toBe("Line one\nLine two\n--");
		expect(render("Line one\nLine two\n-")).not.toContain("<li");
	});

	test("a multi-line === heading is left alone, since === is not a rule", () => {
		expect(finalizeMarkdown("Line one\nLine two\n===")).toBe("Line one\nLine two\n===");
	});
});
