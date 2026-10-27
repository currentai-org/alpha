import { describe, it, expect } from "vitest";
import { hasUnsafePathSegment } from "./pathSafety";

describe("hasUnsafePathSegment", () => {
	it("rejects a single .. segment", () => {
		expect(hasUnsafePathSegment("..")).toBe(true);
	});

	it("rejects .. buried in the middle of a longer path", () => {
		expect(hasUnsafePathSegment("../../some-other-conversation-id/artifacts/secret.txt")).toBe(true);
	});

	it("rejects a bare . segment", () => {
		expect(hasUnsafePathSegment("./file.txt")).toBe(true);
	});

	it("rejects an empty segment from a leading, trailing, or doubled slash", () => {
		expect(hasUnsafePathSegment("/file.txt")).toBe(true);
		expect(hasUnsafePathSegment("file.txt/")).toBe(true);
		expect(hasUnsafePathSegment("dir//file.txt")).toBe(true);
	});

	it("accepts a plain filename", () => {
		expect(hasUnsafePathSegment("report.csv")).toBe(false);
	});

	it("accepts a real nested path with no traversal", () => {
		expect(hasUnsafePathSegment("exports/2026/report.csv")).toBe(false);
	});

	it("accepts unicode and spaces (CUR-571: real agent-chosen filenames)", () => {
		expect(hasUnsafePathSegment("Café notes été.txt")).toBe(false);
	});

	it("does not false-positive on a filename that merely CONTAINS dots", () => {
		expect(hasUnsafePathSegment("archive.tar.gz")).toBe(false);
		expect(hasUnsafePathSegment("...hidden")).toBe(false);
	});
});
