import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock config object — tests flip LOCALITY_SEMANTIC_ENABLED between cases the same way
// semanticHedge.spec.ts overrides embedTexts per-test, just via plain-object mutation since config
// reads happen through Reflect.get rather than a vi.fn(). vi.hoisted: the vi.mock factory below is
// hoisted above this module's top-level consts, so the object it closes over must be too.
const mockConfig = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));

// Same fixture-vector approach as semanticHedge.spec.ts: a locality-ish text → [1,0,0] (cosine 1 to
// the example set, also locality-ish → [1,0,0]); anything else → [0,1,0] (cosine 0). The substring
// test below must match EVERY LOCALITY_EXAMPLES sentence so the whole example set maps to [1,0,0].
vi.mock("$lib/chat/server/rag/embed", () => ({
	embedTexts: vi.fn((texts: string[]) =>
		Promise.resolve(
			texts.map((t) =>
				/plead|crisis|permit|legal|nuclear|banned|speed limit|reimbursed/i.test(t)
					? [1, 0, 0]
					: [0, 1, 0]
			)
		)
	),
	cosine: (a: number[], b: number[]) => {
		let d = 0,
			na = 0,
			nb = 0;
		for (let i = 0; i < a.length; i++) {
			d += a[i] * b[i];
			na += a[i] * a[i];
			nb += b[i] * b[i];
		}
		return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
	},
}));

// §4.4 precompute seam mocked so these cases exercise the RUNTIME-embed path against the fixture vectors
// above (the committed guard-vectors.json would otherwise short-circuit the example embed with real
// 384-dim vectors and break the deterministic cosine math). Default null = "no precompute → embed".
const precomputedGuardVecs = vi.hoisted(() =>
	vi.fn<(set: string, texts: string[]) => number[][] | null>(() => null)
);
vi.mock("./guardVectors", () => ({ precomputedGuardVecs }));

import { isLocalityQuerySemantic, _resetLocalityCache } from "./localitySemantic";
import { embedTexts } from "$lib/chat/server/rag/embed";
import localityExamples from "./data/localityExamples.json";

describe("isLocalityQuerySemantic — hybrid regex + embedding locality check", () => {
	beforeEach(() => {
		_resetLocalityCache();
		for (const k of Object.keys(mockConfig)) delete mockConfig[k];
		vi.mocked(embedTexts).mockClear();
		precomputedGuardVecs.mockReset();
		precomputedGuardVecs.mockReturnValue(null);
	});

	it("regex hit short-circuits — true without needing the semantic pass at all", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "false";
		expect(await isLocalityQuerySemantic("What are my rights as a citizen here?")).toBe(true);
	});

	it("disabled by default — a regex-missed phrasing returns false (today's behavior)", async () => {
		// mockConfig left empty: LOCALITY_SEMANTIC_ENABLED reads "" !== "true" → disabled.
		expect(await isLocalityQuerySemantic("Should I plead guilty?")).toBe(false);
	});

	it("enabled: catches the dogfood-reported phrasing the regex misses (the hybrid's whole point)", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		expect(await isLocalityQuerySemantic("Should I plead guilty?")).toBe(true);
		expect(await isLocalityQuerySemantic("Is nuclear energy a good idea?")).toBe(true);
	});

	it("enabled: leaves a context-free general-knowledge question untouched (no blanket caveating)", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		expect(await isLocalityQuerySemantic("What is photosynthesis?")).toBe(false);
	});

	it("FAILS OPEN to false when the example-set embedding is unavailable", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		vi.mocked(embedTexts).mockResolvedValueOnce(null); // example-set embed fails
		expect(await isLocalityQuerySemantic("Should I plead guilty?")).toBe(false);
	});

	it("empty text never reaches the embedding pass", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		expect(await isLocalityQuerySemantic("")).toBe(false);
		expect(embedTexts).not.toHaveBeenCalled();
	});

	it("uses precomputed example vectors when available — embeds ONLY the query, not the set (§4.4)", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		// Precompute returns the same [1,0,0] the mock embed would for each locality example.
		precomputedGuardVecs.mockReturnValue(localityExamples.map(() => [1, 0, 0]));
		expect(await isLocalityQuerySemantic("Should I plead guilty?")).toBe(true);
		expect(precomputedGuardVecs).toHaveBeenCalledWith("locality", localityExamples);
		// The example set was NOT embedded at runtime — the only embed is the query itself.
		expect(embedTexts).toHaveBeenCalledTimes(1);
		expect(vi.mocked(embedTexts).mock.calls[0][0]).toEqual(["Should I plead guilty?"]);
	});

	it("re-embeds the examples when precomputed vecs have a mismatched dimension (§4.4 dim self-heal)", async () => {
		mockConfig.LOCALITY_SEMANTIC_ENABLED = "true";
		// Precompute returns 2-dim vecs (a different-dim model's artifact); the live endpoint returns 3-dim.
		// The dim cross-check must re-embed the examples live (→ 3-dim [1,0,0]) so cosine stays in one space.
		precomputedGuardVecs.mockReturnValue(localityExamples.map(() => [1, 0]));
		expect(await isLocalityQuerySemantic("Should I plead guilty?")).toBe(true);
		// query embed + live example re-embed = 2 calls (the precomputed set was rejected on dimension).
		expect(embedTexts).toHaveBeenCalledTimes(2);
	});
});
