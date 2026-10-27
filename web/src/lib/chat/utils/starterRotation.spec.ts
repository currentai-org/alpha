import { describe, expect, it } from "vitest";
import {
	decodeStarterHistory,
	encodeStarterHistory,
	pickRotatingStarters,
} from "./starterRotation";

const POOL = ["a", "b", "c", "d", "e", "f"];

describe("pickRotatingStarters", () => {
	it("returns count items from the pool", () => {
		expect(pickRotatingStarters(POOL, 3, [], () => 0)).toHaveLength(3);
	});

	it("never repeats the exact previous set when the pool has room to avoid it", () => {
		const previous = ["a", "b", "c"];
		for (const rng of [() => 0, () => 0.25, () => 0.5, () => 0.75, () => 0.99]) {
			const shown = pickRotatingStarters(POOL, 3, previous, rng);
			expect(new Set(shown)).not.toEqual(new Set(previous));
		}
	});

	it("draws only from the pool minus previous when there's enough left (disjoint, not just distinct)", () => {
		const previous = ["a", "b", "c"];
		const shown = pickRotatingStarters(POOL, 3, previous, () => 0);
		expect(shown.every((s) => !previous.includes(s))).toBe(true);
	});

	it("falls back to the full pool when excluding previous would starve the pick", () => {
		// Pool of 4, want 3, previous already covers 3 of the 4 — only 1 fresh item exists, so a
		// disjoint pick is impossible and the function must still return 3 items.
		const smallPool = ["a", "b", "c", "d"];
		const shown = pickRotatingStarters(smallPool, 3, ["a", "b", "c"], () => 0);
		expect(shown).toHaveLength(3);
	});

	it("returns the whole pool, unshuffled-safe, when the pool is at or under count", () => {
		expect(pickRotatingStarters(["x", "y"], 3)).toEqual(["x", "y"]);
		expect(pickRotatingStarters(["x", "y", "z"], 3)).toEqual(["x", "y", "z"]);
	});
});

describe("starter history cookie encode/decode", () => {
	it("round-trips shown prompts through indices into the pool", () => {
		const shown = ["c", "a"];
		const encoded = encodeStarterHistory(shown, POOL);
		expect(encoded).toBe("2,0");
		expect(decodeStarterHistory(encoded, POOL)).toEqual(["c", "a"]);
	});

	it("drops out-of-range or malformed indices instead of throwing (pool edited since the cookie was set)", () => {
		expect(decodeStarterHistory("2,99,-1,abc,3", POOL)).toEqual(["c", "d"]);
	});

	it("treats missing/empty cookie as no history", () => {
		expect(decodeStarterHistory(undefined, POOL)).toEqual([]);
		expect(decodeStarterHistory("", POOL)).toEqual([]);
	});

	it("drops a prompt from encoding if it's no longer in the pool", () => {
		expect(encodeStarterHistory(["a", "not-in-pool", "b"], POOL)).toBe("0,1");
	});
});
