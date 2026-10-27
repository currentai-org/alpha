import { describe, it, expect } from "vitest";
import { cacheIsFresh, toCommunitySource, type AdminChunk } from "./adminStore";

// The admin store's in-process chunk cache is reused across turns ONLY while a cheap DB watermark
// — `count:sum:max` of the active updatedAt epochs — is unchanged. This proves the serverless
// invariant: a retire/activate/edit on instance A changes the watermark, so instance B reloads on
// its next turn instead of serving a stale chunk. Pure decision — no DB needed.
describe("cacheIsFresh — serverless-safe cross-instance invalidation", () => {
	const ttl = 60_000;

	it("reuses the cache when the watermark is unchanged and within the TTL backstop", () => {
		const cache = { watermark: "3:5100:1800", at: 1_000 };
		expect(cacheIsFresh(cache, "3:5100:1800", 1_000 + 5_000, ttl)).toBe(true);
	});

	it("RELOADS when a document is retired — active count drops", () => {
		const cache = { watermark: "3:5100:1800", at: 1_000 };
		// count 3 → 2, sum and max also change.
		expect(cacheIsFresh(cache, "2:3300:1800", 1_000 + 5_000, ttl)).toBe(false);
	});

	it("RELOADS when a NON-NEWEST active doc is edited — count+max fixed but sum increases", () => {
		// The hole a count+max-only watermark would miss: an edit to
		// a doc that is neither the newest nor changes the count still bumps its updatedAt to now(),
		// so the sum strictly increases and the watermark differs.
		const cache = { watermark: "3:5100:1800", at: 1_000 };
		expect(cacheIsFresh(cache, "3:5108:1800", 1_000 + 5_000, ttl)).toBe(false);
	});

	it("RELOADS when the TTL backstop elapsed even if the watermark looks unchanged", () => {
		const cache = { watermark: "3:5100:1800", at: 1_000 };
		expect(cacheIsFresh(cache, "3:5100:1800", 1_000 + ttl + 1, ttl)).toBe(false);
	});

	it("never reuses a null cache (a cold instance always loads)", () => {
		expect(cacheIsFresh(null, "3:5100:1800", 5_000, ttl)).toBe(false);
	});
});

describe("toCommunitySource — admin provenance shaping", () => {
	const base: AdminChunk = {
		id: "c1",
		documentId: "d1",
		title: "Community note",
		url: "https://example.org/n",
		text: "   open   inference    stack   ",
		vector: [1, 0],
		sourceDate: "2026-06-01T00:00:00.000Z",
		version: 3,
	};

	it("labels the engine Potluck:Community and carries chunk/document provenance", () => {
		const s = toCommunitySource(base, 0.91);
		expect(s.engine).toBe("Potluck:Community");
		expect(s.chunkId).toBe("c1");
		expect(s.documentId).toBe("d1");
		expect(s.sourceDate).toBe("2026-06-01T00:00:00.000Z");
		expect(s.version).toBe(3);
		expect(s.score).toBe(0.91);
		expect(s.title).toBe("Community note");
		expect(s.url).toBe("https://example.org/n");
		expect(s.snippet).toBe("open inference stack"); // whitespace collapsed
	});

	it("maps a null url to undefined and a null sourceDate to undefined", () => {
		const s = toCommunitySource({ ...base, url: null, sourceDate: null }, 0.5);
		expect(s.url).toBeUndefined();
		expect(s.sourceDate).toBeUndefined();
	});
});
