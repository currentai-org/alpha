import { describe, it, expect } from "vitest";
import { verifyCitationLabels, type CitationLabelSource } from "./citationLabelGuard";

// A confabulated label: the model writes "[1] (European Commission), [2] (White House), [3] (OpenAI
// blog)…" but sources 1–3 are actually unrelated retrieved pages, so the labels lie about the link target.
describe("verifyCitationLabels — strip confabulated labels the retrieved source contradicts", () => {
	const src = (title: string, url: string | null): CitationLabelSource => ({ title, url });

	it("strips a label whose named publisher does not match the real source", () => {
		const sources = [src("Quantum computing — Wikipedia", "https://en.wikipedia.org/wiki/Quantum")];
		const out = verifyCitationLabels("See [1] (European Commission) for details.", sources);
		expect(out.flagged).toBe(true);
		expect(out.count).toBe(1);
		expect(out.cleaned).toBe("See [1] for details."); // marker kept, lying label gone
	});

	it("keeps a faithful label (publisher↔domain fuzzy: European ~ europa)", () => {
		const sources = [src("New AI funding package announced", "https://ec.europa.eu/news/ai")];
		const out = verifyCitationLabels("Reports from [1] (European Commission) say so.", sources);
		expect(out.flagged).toBe(false);
		expect(out.cleaned).toBe("Reports from [1] (European Commission) say so.");
	});

	it("keeps a faithful label via substring (White ⊂ whitehouse)", () => {
		const sources = [src("Executive order on AI", "https://www.whitehouse.gov/eo")];
		const out = verifyCitationLabels("[1] (White House) issued an order.", sources);
		expect(out.flagged).toBe(false);
		expect(out.cleaned).toBe("[1] (White House) issued an order.");
	});

	it("does NOT let a generic word ('blog') alone vouch for a label", () => {
		const sources = [src("Random musings blog", "https://someblog.example.com/post")];
		const out = verifyCitationLabels("[1] (OpenAI blog) claims X.", sources);
		expect(out.flagged).toBe(true); // 'openai' unmatched; 'blog' is generic → not faithful
		expect(out.cleaned).toBe("[1] claims X.");
	});

	it("leaves non-name parentheticals alone (year, aside)", () => {
		const sources = [src("EU AI Act", "https://ec.europa.eu/ai-act")];
		expect(verifyCitationLabels("The rule [1] (2024) applies.", sources).cleaned).toBe(
			"The rule [1] (2024) applies."
		);
		expect(verifyCitationLabels("See [1] (see below) too.", sources).cleaned).toBe(
			"See [1] (see below) too."
		);
	});

	it("never touches a markdown link [n](url) (no space)", () => {
		const sources = [src("X", "https://x.example")];
		const md = "Here [1](https://x.example) is a link.";
		expect(verifyCitationLabels(md, sources).cleaned).toBe(md);
	});

	it("can't verify a source with no title/url → leaves the label", () => {
		const sources: CitationLabelSource[] = [{ title: "", url: null }];
		const txt = "[1] (European Commission) ran it.";
		expect(verifyCitationLabels(txt, sources).flagged).toBe(false);
		expect(verifyCitationLabels(txt, sources).cleaned).toBe(txt);
	});

	it("strips only the unfaithful labels in a mixed roll-call; keeps faithful + counts", () => {
		const sources = [
			src("AI funding package", "https://ec.europa.eu/news"), // [1] → European Commission OK
			src("Quantum — Wikipedia", "https://en.wikipedia.org/wiki/Quantum"), // [2] → White House LIE
		];
		const out = verifyCitationLabels(
			"From [1] (European Commission) and [2] (White House) we learn X.",
			sources
		);
		expect(out.count).toBe(1);
		expect(out.cleaned).toBe("From [1] (European Commission) and [2] we learn X.");
	});

	it("out-of-range marker is left to citationGuard (no source to verify against)", () => {
		const sources = [src("Only one", "https://a.example")];
		const txt = "[3] (Made Up Org) said so.";
		expect(verifyCitationLabels(txt, sources).flagged).toBe(false);
	});

	it("no sources → no-op", () => {
		expect(verifyCitationLabels("[1] (Anything) here.", []).flagged).toBe(false);
	});
});

describe("verifyCitationLabels with the visitor's own sources first (CUR-3844)", () => {
	it("checks [k+1] against the first retrieved source and leaves the person's [1] alone", () => {
		const sources = [{ title: "Quantum — Wikipedia", url: "https://en.wikipedia.org/wiki/Quantum" }];
		const out = verifyCitationLabels("[1] (Smith Report) and [2] (White House) say X.", sources, 1);
		expect(out.count).toBe(1);
		expect(out.cleaned).toBe("[1] (Smith Report) and [2] say X.");
	});
});
