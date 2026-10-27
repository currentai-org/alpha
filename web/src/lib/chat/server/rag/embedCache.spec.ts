import { describe, it, expect } from "vitest";
import { EmbedCache } from "./embedCache";

describe("EmbedCache", () => {
	it("returns a cached vector for the same model+text", () => {
		const c = new EmbedCache();
		const k = EmbedCache.key("m", "hello world");
		expect(c.get(k)).toBeUndefined();
		c.set(k, [1, 2, 3]);
		expect(c.get(k)).toEqual([1, 2, 3]);
	});

	it("normalizes whitespace and case into one entry", () => {
		const c = new EmbedCache();
		c.set(EmbedCache.key("m", "Hello   World"), [9]);
		expect(c.get(EmbedCache.key("m", "  hello world "))).toEqual([9]);
	});

	it("keys by model — a model swap misses", () => {
		const c = new EmbedCache();
		c.set(EmbedCache.key("model-a", "q"), [1]);
		expect(c.get(EmbedCache.key("model-b", "q"))).toBeUndefined();
	});

	it("evicts the least-recently-used entry past the cap", () => {
		const c = new EmbedCache(2);
		c.set("a", [1]);
		c.set("b", [2]);
		c.get("a"); // touch a → b is now LRU
		c.set("c", [3]); // evicts b
		expect(c.get("a")).toEqual([1]);
		expect(c.get("b")).toBeUndefined();
		expect(c.get("c")).toEqual([3]);
		expect(c.size).toBe(2);
	});

	it("overwriting a key refreshes its recency and value", () => {
		const c = new EmbedCache(2);
		c.set("a", [1]);
		c.set("b", [2]);
		c.set("a", [11]); // a is now MRU
		c.set("c", [3]); // evicts b, not a
		expect(c.get("a")).toEqual([11]);
		expect(c.get("b")).toBeUndefined();
	});

	it("clear empties the cache", () => {
		const c = new EmbedCache();
		c.set("a", [1]);
		c.clear();
		expect(c.size).toBe(0);
		expect(c.get("a")).toBeUndefined();
	});
});
