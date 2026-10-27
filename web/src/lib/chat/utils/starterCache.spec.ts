import { describe, it, expect, vi, afterEach } from "vitest";
import {
	findCachedAnswer,
	normalizePrompt,
	getCachedAnswer,
	__resetStarterCacheForTests,
	type CachedAnswer,
} from "./starterCache";

const mk = (prompt: string, answer: string, model = "m1"): CachedAnswer => ({
	prompt,
	answer,
	sources: [],
	asOf: null,
	grounded: false,
	model,
	generatedAt: "t",
});

const entries: Record<string, CachedAnswer> = {
	a: mk("What is open-source AI?", "A."),
	b: mk("EU AI Act status?", "B.", "m2"),
};

describe("normalizePrompt", () => {
	it("collapses whitespace and lowercases", () => {
		expect(normalizePrompt("  Hello   World  ")).toBe("hello world");
	});
});

describe("findCachedAnswer", () => {
	it("matches case- and whitespace-insensitively", () => {
		expect(findCachedAnswer(entries, "  what is   OPEN-source ai? ")?.answer).toBe("A.");
	});
	it("returns null on a miss", () => {
		expect(findCachedAnswer(entries, "an unrelated prompt")).toBeNull();
	});
	it("filters by model when given", () => {
		expect(findCachedAnswer(entries, "EU AI Act status?", "m2")?.answer).toBe("B.");
		expect(findCachedAnswer(entries, "EU AI Act status?", "m1")).toBeNull();
	});
});

describe("getCachedAnswer (lazy load, fail-closed)", () => {
	afterEach(() => {
		__resetStarterCacheForTests();
		vi.unstubAllGlobals();
	});

	it("loads the artifact once (memoised) and looks up", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ entries }) }));
		vi.stubGlobal("fetch", fetchMock);
		expect((await getCachedAnswer("what is open-source ai?"))?.answer).toBe("A.");
		expect((await getCachedAnswer("EU AI Act status?", { model: "m2" }))?.answer).toBe("B.");
		expect(fetchMock).toHaveBeenCalledTimes(1); // memoised: fetched only once
	});

	it("fails closed to null when the cache is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			})
		);
		expect(await getCachedAnswer("anything")).toBeNull();
	});

	it("loads from site-root /data/starterCache.json", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ entries }) }));
		vi.stubGlobal("fetch", fetchMock);
		await getCachedAnswer("what is open-source ai?");
		expect(fetchMock).toHaveBeenCalledWith("/data/starterCache.json");
	});
});
