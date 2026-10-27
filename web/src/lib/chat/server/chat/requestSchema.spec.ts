import { describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { chatRequestSchema } from "./requestSchema";

describe("chatRequestSchema", () => {
	it("accepts a minimal valid turn and normalizes CRLF in the prompt", () => {
		const parsed = chatRequestSchema.parse({ inputs: "line one\r\nline two" });
		expect(parsed.inputs).toBe("line one\nline two");
		// selectedMcpServers defaults to [] so the handler can spread it safely
		expect(parsed.selectedMcpServers).toEqual([]);
	});

	it("accepts an attached search context within the size caps", () => {
		const parsed = chatRequestSchema.parse({
			inputs: "what happened today",
			generationId: uuid(),
			searchContext: {
				query: "today news",
				asOf: "2026-06-21",
				evidence: "some evidence",
				sources: [{ n: 1, title: "T", url: "https://x", snippet: "s", engine: "Wikipedia" }],
			},
		});
		expect(parsed.searchContext?.sources).toHaveLength(1);
	});

	it("rejects an over-long evidence blob (payload cap)", () => {
		expect(() =>
			chatRequestSchema.parse({
				inputs: "x",
				searchContext: {
					query: "q",
					asOf: "now",
					evidence: "z".repeat(20_001),
					sources: [],
				},
			})
		).toThrow();
	});

	it("rejects a non-uuid generationId", () => {
		expect(() => chatRequestSchema.parse({ inputs: "x", generationId: "not-a-uuid" })).toThrow();
	});

	it("rejects an unknown search engine", () => {
		expect(() =>
			chatRequestSchema.parse({
				inputs: "x",
				searchContext: {
					query: "q",
					asOf: "now",
					evidence: "e",
					sources: [{ n: 1, title: "T", url: "https://x", snippet: "s", engine: "bing" }],
				},
			})
		).toThrow();
	});
});
