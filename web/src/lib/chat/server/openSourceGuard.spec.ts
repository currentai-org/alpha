import { describe, it, expect } from "vitest";
import { dehyphenateOpenSource } from "./openSourceGuard";

describe("dehyphenateOpenSource", () => {
	it("rewrites the compound-adjective hyphenation", () => {
		const r = dehyphenateOpenSource("Apertus is an open-source model.");
		expect(r.rewritten).toBe(true);
		expect(r.cleaned).toBe("Apertus is an open source model.");
	});

	it("preserves case (Open-Source, OPEN-SOURCE)", () => {
		expect(dehyphenateOpenSource("Open-Source software").cleaned).toBe("Open Source software");
		expect(dehyphenateOpenSource("OPEN-SOURCE").cleaned).toBe("OPEN SOURCE");
	});

	it("handles the suffix forms (sourced/sources/sourcing)", () => {
		expect(dehyphenateOpenSource("they open-sourced it").cleaned).toBe("they open sourced it");
		expect(dehyphenateOpenSource("open-sourcing the weights").cleaned).toBe(
			"open sourcing the weights"
		);
	});

	it("leaves a non-match untouched and reports rewritten:false", () => {
		const r = dehyphenateOpenSource("a fully open source, closed-source comparison");
		expect(r.rewritten).toBe(false);
		expect(r.cleaned).toBe("a fully open source, closed-source comparison");
	});

	it("does NOT touch 'closed-source'", () => {
		expect(dehyphenateOpenSource("closed-source rivals").cleaned).toBe("closed-source rivals");
	});

	it("does NOT rewrite inside a URL (load-bearing hyphen)", () => {
		const url = "See https://github.com/foo/open-source-tool for the code.";
		const r = dehyphenateOpenSource(url);
		expect(r.cleaned).toBe(url);
		expect(r.rewritten).toBe(false);
	});

	it("does NOT rewrite inside inline code or a fenced block", () => {
		expect(dehyphenateOpenSource("run `npm i open-source`").cleaned).toBe(
			"run `npm i open-source`"
		);
		const fenced = "```\n--open-source\n```";
		expect(dehyphenateOpenSource(fenced).cleaned).toBe(fenced);
	});

	it("rewrites prose but leaves a code span in the SAME text untouched", () => {
		const r = dehyphenateOpenSource("It is open-source; install with `pip install open-source`.");
		expect(r.cleaned).toBe("It is open source; install with `pip install open-source`.");
	});

	it("does not mistake a literal ' 0 ' in prose for a mask placeholder", () => {
		const r = dehyphenateOpenSource(
			"Section 0 covers open-source; see https://x.io/a for 1 example."
		);
		expect(r.cleaned).toBe("Section 0 covers open source; see https://x.io/a for 1 example.");
	});

	it("empty / hyphenless input is a clean no-op", () => {
		expect(dehyphenateOpenSource("")).toEqual({ rewritten: false, cleaned: "" });
		expect(dehyphenateOpenSource("no hyphens here")).toEqual({
			rewritten: false,
			cleaned: "no hyphens here",
		});
	});
});
