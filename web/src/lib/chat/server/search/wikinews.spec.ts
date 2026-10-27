import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWikinews } from "./openSearch";

// Minimal MediaWiki generator-search response shape (same surface Wikipedia uses).
function mwResponse(
	pages: Array<{ title: string; extract?: string; fullurl?: string; touched?: string }>
) {
	return {
		query: {
			pages: Object.fromEntries(pages.map((p, i) => [String(i), { index: i + 1, ...p }])),
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("searchWikinews", () => {
	it("queries the en.wikinews.org MediaWiki API and labels sources 'Wikinews'", async () => {
		let calledUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calledUrl = url;
				return {
					ok: true,
					json: async () =>
						mwResponse([
							{
								title: "EU adopts AI Act enforcement timeline",
								extract: "The European Union set out the enforcement schedule for its AI Act.",
								fullurl: "https://en.wikinews.org/wiki/EU_adopts_AI_Act_enforcement_timeline",
								touched: "2026-06-28T10:00:00Z",
							},
						]),
				};
			})
		);

		const out = await searchWikinews("EU AI Act", 5);

		expect(calledUrl).toContain("en.wikinews.org/w/api.php");
		expect(calledUrl).not.toContain("wikipedia.org");
		expect(out).toHaveLength(1);
		expect(out[0].engine).toBe("Wikinews");
		expect(out[0].url).toContain("en.wikinews.org/wiki/");
		// No `asOf`: the API's `touched` is a maintenance-edit timestamp (bots re-touch old
		// articles), so we deliberately omit it rather than stamp an old story as current.
		expect(out[0].asOf).toBeUndefined();
	});

	it("drops pages without an extract (no empty snippets injected into grounding)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () =>
					mwResponse([
						{ title: "Stub with no body", extract: "" },
						{ title: "Real item", extract: "Body text here." },
					]),
			}))
		);

		const out = await searchWikinews("anything", 5);
		expect(out).toHaveLength(1);
		expect(out[0].title).toBe("Real item");
	});
});
