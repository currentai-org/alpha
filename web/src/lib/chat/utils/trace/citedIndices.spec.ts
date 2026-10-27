import { describe, it, expect } from "vitest";
import { extractCitedIndices } from "./citedIndices";

describe("extractCitedIndices", () => {
	it("collects every cited marker", () => {
		expect(extractCitedIndices("First [1], second [2], third [3].")).toEqual(new Set([1, 2, 3]));
	});

	it("dedupes a marker cited more than once", () => {
		expect(extractCitedIndices("As [1] shows, [1] confirms it.")).toEqual(new Set([1]));
	});

	it("returns an empty set for prose with no markers", () => {
		expect(extractCitedIndices("No citations here.")).toEqual(new Set());
	});

	it("returns an empty set for empty/undefined text", () => {
		expect(extractCitedIndices("")).toEqual(new Set());
		expect(extractCitedIndices(undefined as unknown as string)).toEqual(new Set());
	});

	it("does not treat a markdown link or reference definition as a citation", () => {
		expect(extractCitedIndices("see [2](https://x.io/a)")).toEqual(new Set());
		expect(extractCitedIndices("ref [2]: https://x.io/a")).toEqual(new Set());
	});

	it("ignores a marker-shaped string inside a fenced code block", () => {
		const text = "```\nconst a = arr[1];\n```\nReal citation [2].";
		expect(extractCitedIndices(text)).toEqual(new Set([2]));
	});

	it("ignores a marker-shaped string inside an inline code span", () => {
		expect(extractCitedIndices("Use `arr[1]` then see [2].")).toEqual(new Set([2]));
	});

	it("ignores a marker-shaped string inside a bare URL", () => {
		expect(extractCitedIndices("https://example.com/[1]/page see [2].")).toEqual(new Set([2]));
	});
});
