import { describe, expect, it, vi, beforeEach } from "vitest";

// Tested through decideSearchViaIntent rather than against the scoring helpers directly: the helpers
// are internal (knip's production pass correctly calls an export nothing but a spec imports dead), and
// the verdict carries `margin`, so every scoring property below is observable on the real path.

// Unit vectors in a tiny space, so each expected cosine is checkable by hand.
const FRESH_VEC = [1, 0, 0];
const EVERGREEN_VEC = [0, 1, 0];
const ORTHOGONAL = [0, 0, 1];

const realCosine = (a: number[], b: number[]) => {
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		d += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** Wire the module with stubbed embeddings so the contract is testable without the network. */
async function withEmbeddings(opts: {
	queryVec: number[] | null;
	fresh?: number[][] | null;
	evergreen?: number[][] | null;
	batch?: number[][] | null;
	activeModel?: string;
}) {
	vi.doMock("$lib/chat/server/rag/env", () => ({
		embeddingModel: vi.fn(() => opts.activeModel ?? "sentence-transformers/all-MiniLM-L6-v2"),
	}));
	vi.doMock("$lib/chat/server/rag/embed", async () => ({
		embedText: vi.fn(async () => opts.queryVec),
		embedTexts: vi.fn(async () => opts.batch ?? null),
		cosine: realCosine,
		// The real one: the scoring under test lives in it.
		maxCosine: (await vi.importActual<typeof import("$lib/chat/server/rag/embed")>(
			"$lib/chat/server/rag/embed"
		)).maxCosine,
	}));
	vi.doMock("$lib/chat/server/guardVectors", () => ({
		precomputedGuardVecs: vi.fn((setName: string) =>
			setName === "search_fresh" ? (opts.fresh ?? null) : (opts.evergreen ?? null)
		),
	}));
	return import("./searchIntent");
}

describe("decideSearchViaIntent", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("searches when the query is nearer the fresh exemplars", async () => {
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		const v = await decideSearchViaIntent("what happened in the news today?");
		expect(v).toMatchObject({ ok: true, shouldSearch: true });
		expect(v.margin).toBeGreaterThan(0);
	});

	it("does not search when the query is nearer the evergreen exemplars", async () => {
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: EVERGREEN_VEC,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		const v = await decideSearchViaIntent("explain how a hash map works");
		expect(v).toMatchObject({ ok: true, shouldSearch: false });
		expect(v.margin).toBeLessThan(0);
	});

	it("scores an equidistant query at zero — the two sides cancel rather than one deciding", async () => {
		// The point of the two-sided form over a bare cosine threshold: looking equally like both is a
		// non-answer, not a weak yes. At a threshold of 0 it is excluded; the shipped threshold is
		// slightly negative, which is a calibration choice, not this property.
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: ORTHOGONAL,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		const v = await decideSearchViaIntent("something unlike either side", 0);
		expect(v.margin).toBeCloseTo(0, 6);
		expect(v.shouldSearch).toBe(true); // margin >= threshold, i.e. 0 >= 0
	});

	it("takes the CLOSEST exemplar on each side, not the first or the average", async () => {
		// A set holds many phrasings and only the nearest should speak for it — otherwise adding a
		// distant phrasing to broaden an intent would weaken it instead.
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: [ORTHOGONAL, EVERGREEN_VEC, FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		expect((await decideSearchViaIntent("q")).margin).toBeCloseTo(1, 6);
	});

	it("says ok:false — NOT shouldSearch:false — when the embedding endpoint returns nothing", async () => {
		// The contract that matters. `ok:false` routes runSearch to the recency heuristic; a bare
		// `shouldSearch:false` would silently mean "nothing on earth needs searching", indistinguishable
		// from a healthy gate answering no to every query. Same distinction the deleted logprob gate made
		// on absent logprobs.
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: null,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		const v = await decideSearchViaIntent("what happened in the news today?");
		expect(v.ok).toBe(false);
		expect(v.shouldSearch).toBe(false);
	});

	it("says ok:false when neither the artifact nor the runtime fallback yields exemplars", async () => {
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: null,
			evergreen: null,
			batch: null,
		});
		expect((await decideSearchViaIntent("anything")).ok).toBe(false);
	});

	it("says ok:false on empty input rather than deciding about nothing", async () => {
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
		});
		expect((await decideSearchViaIntent("   ")).ok).toBe(false);
	});

	it("falls back to a runtime batch embed when the precomputed artifact is unusable", async () => {
		// precomputedGuardVecs returns null on a model mismatch or an exemplar file edited without a
		// rebuild. That must degrade to a correct answer, not to no answer.
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: null,
			evergreen: null,
			batch: Array.from({ length: 51 }, (_, i) => (i < 25 ? FRESH_VEC : EVERGREEN_VEC)),
		});
		const v = await decideSearchViaIntent("what is the latest news?");
		expect(v).toMatchObject({ ok: true, shouldSearch: true });
	});

	it("stays OFF when PostHog has no such flag yet, leaving the old gate deciding", async () => {
		// The safety property of flagEnabledOr's fallback. A migration gate whose flag does not exist
		// must leave the incumbent path in charge — never turn search triggering off, and never switch
		// itself on by default before anyone has watched a rollout.
		vi.doMock("$lib/chat/server/flags", () => ({
			flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
		}));
		const { searchIntentEnabled } = await import("./searchIntent");
		expect(searchIntentEnabled()).toBe(false);
	});

	it("declines to decide when the embedding model changed but the threshold did not", async () => {
		// The failure this gate exists to not repeat. A cosine margin is a number in ONE model's vector
		// space — under a different encoder it is not a weaker signal, it is a meaningless one. The
		// exemplars here are perfectly usable and the query is squarely on the fresh side, so a gate
		// without this check would happily return shouldSearch:true computed in the wrong units. That is
		// how the old logprob gate's constant went stale against its checkpoint.
		const { decideSearchViaIntent } = await withEmbeddings({
			queryVec: FRESH_VEC,
			fresh: [FRESH_VEC],
			evergreen: [EVERGREEN_VEC],
			activeModel: "BAAI/bge-large-en-v1.5",
		});
		const v = await decideSearchViaIntent("what happened in the news today?");
		expect(v.ok).toBe(false);
		expect(v.shouldSearch).toBe(false);
	});
});
