import { describe, it, expect } from "vitest";
import { stripDanglingCitations, stripUnbackedSourceClaims } from "./citationGuard";

describe("stripDanglingCitations", () => {
	it("strips a marker past the source count", () => {
		const r = stripDanglingCitations("The treaty entered into force in 2024 [2].", 1);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).toBe("The treaty entered into force in 2024.");
	});

	it("keeps in-range markers, strips only the dangling one in a run", () => {
		expect(stripDanglingCitations("It passed [1][2].", 1).cleaned).toBe("It passed [1].");
		expect(stripDanglingCitations("Both [1] and [2] agree [3].", 2).cleaned).toBe(
			"Both [1] and [2] agree."
		);
	});

	it("strips a stray [0]", () => {
		expect(stripDanglingCitations("As shown [0], it holds [1].", 1).cleaned).toBe(
			"As shown, it holds [1]."
		);
	});

	it("leaves everything alone when every marker is in range", () => {
		const r = stripDanglingCitations("First [1], second [2], third [3].", 3);
		expect(r.stripped).toBe(false);
		expect(r.cleaned).toBe("First [1], second [2], third [3].");
	});

	it("is a no-op on an ungrounded turn (sourceCount 0) — '[2]' is ordinary text", () => {
		const r = stripDanglingCitations("See footnote [2] in the book.", 0);
		expect(r.stripped).toBe(false);
		expect(r.cleaned).toBe("See footnote [2] in the book.");
	});

	it("does NOT touch a markdown link or reference definition", () => {
		expect(stripDanglingCitations("see [2](https://x.io/a)", 1).cleaned).toBe(
			"see [2](https://x.io/a)"
		);
		expect(stripDanglingCitations("ref [2]: https://x.io/a", 1).cleaned).toBe(
			"ref [2]: https://x.io/a"
		);
	});

	it("does NOT touch an array index in code or a [n] in a URL", () => {
		expect(stripDanglingCitations("call `arr[2]` to index", 1).cleaned).toBe(
			"call `arr[2]` to index"
		);
		const fenced = "```\nx = arr[2]\n```";
		expect(stripDanglingCitations(fenced, 1).cleaned).toBe(fenced);
		expect(stripDanglingCitations("https://x.io/p[2]/q here", 1).cleaned).toBe(
			"https://x.io/p[2]/q here"
		);
	});

	it("strips a dangling marker in prose while leaving an in-code [n] alone in the same text", () => {
		const r = stripDanglingCitations("Result [2] from `data[2]`.", 1);
		expect(r.cleaned).toBe("Result from `data[2]`.");
	});

	it("empty / bracketless input is a clean no-op", () => {
		expect(stripDanglingCitations("", 3)).toEqual({ stripped: false, cleaned: "" });
		expect(stripDanglingCitations("no markers here", 3)).toEqual({
			stripped: false,
			cleaned: "no markers here",
		});
	});
});

describe("stripUnbackedSourceClaims (ungrounded, no retrieved sources)", () => {
	it("removes a fabricated 'for sources, check [1] or [2]' promise on a no-source turn", () => {
		const t =
			"The OSI published a report. A coalition pledged support.\nFor detailed sources, check [1] or [2].";
		const r = stripUnbackedSourceClaims(t, 0);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).not.toMatch(/\[1\]|\[2\]/);
		expect(r.cleaned).not.toMatch(/for detailed sources/i);
		expect(r.cleaned).toContain("The OSI published a report.");
	});

	it("leaves a plain numbered list alone (no citation-intent language)", () => {
		const t = "Steps:\n[1] open the file\n[2] save it";
		expect(stripUnbackedSourceClaims(t, 0)).toEqual({ stripped: false, cleaned: t });
	});

	it("defers to the grounded guards when real sources exist (sourceCount > 0)", () => {
		const t = "See sources [1] and [2].";
		expect(stripUnbackedSourceClaims(t, 2)).toEqual({ stripped: false, cleaned: t });
	});

	it("never touches a [n] inside code/URLs even with citation language present", () => {
		const t = "Check the sources in `refs[1]` and https://x.io/a[2]/b for more.";
		const r = stripUnbackedSourceClaims(t, 0);
		expect(r.cleaned).toContain("`refs[1]`");
		expect(r.cleaned).toContain("https://x.io/a[2]/b");
	});

	it("is conservative — does not gut the answer on an over-broad match", () => {
		const t = "sources [1]";
		const r = stripUnbackedSourceClaims(t, 0);
		expect(r.cleaned).toBe(t); // < 40% would remain → keep original
	});

	it("strips a fabricated inline [1] with NO source-language (the 'Shakespeare. [1]' bug)", () => {
		const t = 'The play "Romeo and Juliet" was written by William Shakespeare. [1]';
		const r = stripUnbackedSourceClaims(t, 0);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).toBe('The play "Romeo and Juliet" was written by William Shakespeare.');
	});

	it("keeps a line-start list marker but strips an inline citation in the same text", () => {
		const t = "Steps:\n[1] open the file\nIt was authored by Smith. [2]";
		const r = stripUnbackedSourceClaims(t, 0);
		expect(r.cleaned).toContain("[1] open the file"); // list marker kept
		expect(r.cleaned).not.toContain("[2]"); // inline citation dropped
	});

	// The strip must leave code blocks intact. It must not fire on any "[" plus the word
	// "sources", collapse runs of spaces in the restored text (a Python dict keeps its indentation), or
	// leave a fence unclosed when a stream is cut off by the token cap. (CUR-3874)
	const dict = [
		"```python",
		"recipe_book = {",
		'    "sources": {',
		'        "books": [',
		'            "The Silver Spoon (Italian',
	].join("\n");

	it("leaves an unclosed code block whole, indentation included, on source wording plus a list", () => {
		expect(stripUnbackedSourceClaims(dict, 0)).toEqual({ stripped: false, cleaned: dict });
	});

	it("keeps a closed code block's indentation when it strips a citation from the prose", () => {
		const code = "```python\nif x:\n    y = [1]\n```";
		const r = stripUnbackedSourceClaims(`It was written by Smith. [2]\n\n${code}`, 0);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).toBe(`It was written by Smith.\n\n${code}`);
	});

	it("changes nothing, and reports no strip, when source wording and a [ remove nothing", () => {
		const t = "Good sources  include books [the classics] and  journals.";
		expect(stripUnbackedSourceClaims(t, 0)).toEqual({ stripped: false, cleaned: t });
	});

	it("strips a no-space inline citation (Word[1])", () => {
		expect(stripUnbackedSourceClaims("It was Shakespeare[1].", 0).cleaned).toBe(
			"It was Shakespeare."
		);
	});
});

describe("the visitor's own numbered sources (CUR-3844)", () => {
	it("drops a bolded fabricated marker with its emphasis, leaving no empty ****", () => {
		const r = stripUnbackedSourceClaims("Apertus is open **[1]**.", 0);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).toBe("Apertus is open.");
		expect(r.cleaned).not.toContain("**");
	});

	it("keeps an inline marker that points at a source the person pasted", () => {
		const t = "Open weights matter for audits [1], and data commons for reuse [2].";
		expect(stripUnbackedSourceClaims(t, 0, 2)).toEqual({ stripped: false, cleaned: t });
	});

	it("still strips a fabricated [0] when the person pasted sources, since theirs start at [1]", () => {
		const r = stripUnbackedSourceClaims("Open weights matter [0], as [1] says.", 0, 2);
		expect(r.stripped).toBe(true);
		expect(r.cleaned).toContain("[1]");
		expect(r.cleaned).not.toContain("[0]");
	});

	it("still strips a marker past the person's sources", () => {
		expect(stripUnbackedSourceClaims("Audits need open weights [1]. Reuse needs commons [3].", 0, 2).cleaned).toBe(
			"Audits need open weights [1]. Reuse needs commons."
		);
	});

	it("keeps a source sentence that cites only the person's own sources", () => {
		const t = "Both points come from the sources you gave, [1] and [2].";
		expect(stripUnbackedSourceClaims(t, 0, 2).cleaned).toBe(t);
	});
});
