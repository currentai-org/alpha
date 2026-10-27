import { describe, it, expect } from "vitest";
import { citationSourceList, parseVisitorSources, visitorSourcesNote } from "./visitorSources";

describe("parseVisitorSources reads the person's own numbered sources (CUR-3844)", () => {
	it("reads [1] and [2] at line start, in order, with their text", () => {
		const msg = "Summarize with citations.\n\n[1] Smith 2021, Open models\n[2] Jones 2023, Data commons";
		expect(parseVisitorSources(msg)).toEqual([
			{ n: 1, text: "Smith 2021, Open models" },
			{ n: 2, text: "Jones 2023, Data commons" },
		]);
	});

	it("accepts a list bullet and indent before the marker", () => {
		expect(parseVisitorSources("  - [1] A\n  * [2] B").map((s) => s.n)).toEqual([1, 2]);
	});

	it("returns nothing when the list does not start at [1]", () => {
		expect(parseVisitorSources("[2] B\n[3] C")).toEqual([]);
	});

	it("stops at a gap, and skips a repeat of an earlier number", () => {
		expect(parseVisitorSources("[1] A\n[1] again\n[2] B\n[4] D").map((s) => s.n)).toEqual([1, 2]);
	});

	it("ignores markers inside a fenced code block", () => {
		expect(parseVisitorSources("```\n[1] x = 1\n```\nexplain")).toEqual([]);
	});

	it("does not count an inline [1] in prose as a source", () => {
		expect(parseVisitorSources("Is the interval [1] closed?")).toEqual([]);
	});

	it("truncates a long source to 120 characters", () => {
		const text = parseVisitorSources(`[1] ${"a".repeat(300)}`)[0].text;
		expect(text).toHaveLength(120);
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("visitorSourcesNote", () => {
	it("says nothing when the person pasted no numbered sources", () => {
		expect(visitorSourcesNote(0)).toBeUndefined();
	});
	it("names the person's range and where ours start", () => {
		const note = visitorSourcesNote(2) ?? "";
		expect(note).toContain("[1] to [2]");
		expect(note).toContain("[3]");
	});
});

describe("citationSourceList lines [n] up with the right source (CUR-3844)", () => {
	const web = (n: number) => ({ n, title: `web ${n}`, link: `https://example.org/${n}` });

	it("puts the visitor's [1]..[k] ahead of sources the server numbered after them", () => {
		const list = citationSourceList(2, [web(4), web(3)]);
		expect(list.map((s) => s.link)).toEqual(["", "", "https://example.org/3", "https://example.org/4"]);
	});

	it("leaves a message saved before the change alone: its sources numbered from [1] keep [1] and [2]", () => {
		const list = citationSourceList(2, [web(1), web(2), web(3)]);
		expect(list.map((s) => s.link)).toEqual([
			"https://example.org/1",
			"https://example.org/2",
			"https://example.org/3",
		]);
	});

	it("treats stored sources with no n as numbered from the start, so no visitor entries go ahead of them", () => {
		const list = citationSourceList(1, [{ title: "old", link: "https://example.org/old" }]);
		expect(list).toEqual([{ title: "old", link: "https://example.org/old" }]);
	});

	it("gives the visitor's sources unlinked entries when nothing was retrieved", () => {
		expect(citationSourceList(2, [])).toEqual([
			{ title: "", link: "" },
			{ title: "", link: "" },
		]);
	});
});
