import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RagSource } from "$lib/chat/types/Rag";

// Mock the shared reranker transport + the RAG env knobs so these tests exercise ONLY the
// enabled / verified / degrade policy in rerankRagHits — no network, no config proxy.
const rerankByRelevance = vi.fn();
const rerankEnabled = vi.fn();
vi.mock("$lib/chat/server/search/rerank", () => ({
	rerankByRelevance: (...args: unknown[]) => rerankByRelevance(...args),
	rerankEnabled: () => rerankEnabled(),
}));
// Controllable skip-floor (RAG_RERANK_SKIP_COSINE_BELOW); 0 = disabled, the default, so every
// pre-existing test runs the unskipped path byte-for-byte.
const skipBelow = { v: 0 };
vi.mock("./env", () => ({
	ragRerankMinScore: () => 0.02,
	ragRerankTimeoutMs: () => 3000,
	ragRerankSkipBelow: () => skipBelow.v,
}));

vi.mock("$lib/chat/server/failOpen", () => ({ failOpenDeparture: vi.fn() }));
import { rerankRagHits } from "./rerankRag";
import { failOpenDeparture } from "$lib/chat/server/failOpen";

const hit = (over: Partial<Omit<RagSource, "n">>): Omit<RagSource, "n"> => ({
	title: "T",
	snippet: "S",
	engine: "Potluck",
	...over,
});

const A = hit({ title: "A" });
const B = hit({ title: "B" });
const C = hit({ title: "C" });
// A federated SyftHub hit — reranked on its snippet like every other source (NOT keep-only).
const S = hit({ title: "S", engine: "SyftHub", sourceName: "acme/x" });

beforeEach(() => {
	rerankByRelevance.mockReset();
	rerankEnabled.mockReset();
	skipBelow.v = 0;
});

describe("rerankRagHits — enabled / verified / degrade policy", () => {
	it("reranker DISABLED → passes hits through unchanged, unverified, never calls the reranker", async () => {
		rerankEnabled.mockReturnValue(false);
		const res = await rerankRagHits("q", [A, B]);
		expect(res).toEqual({ hits: [A, B], relevanceVerified: false });
		expect(rerankByRelevance).not.toHaveBeenCalled();
	});

	it("empty hits → returns [] unverified without calling the reranker (nothing to score)", async () => {
		rerankEnabled.mockReturnValue(true);
		const res = await rerankRagHits("q", []);
		expect(res).toEqual({ hits: [], relevanceVerified: false });
		expect(rerankByRelevance).not.toHaveBeenCalled();
	});

	it("VERIFIED + items → returns the reranked/floored items, verified true", async () => {
		rerankEnabled.mockReturnValue(true);
		// Cross-encoder reordered (B outranks A) and dropped C below the floor.
		rerankByRelevance.mockResolvedValue({ items: [B, A], verified: true });
		const res = await rerankRagHits("q", [A, B, C]);
		expect(res).toEqual({ hits: [B, A], relevanceVerified: true });
	});

	it("VERIFIED + empty items (all below floor) → returns [] verified (caller answers ungrounded)", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockResolvedValue({ items: [], verified: true });
		const res = await rerankRagHits("q", [A, B]);
		expect(res).toEqual({ hits: [], relevanceVerified: true });
	});

	it("UNVERIFIED (cold/failed/timeout) → DEGRADES to the input hits unchanged, ignoring the fail-closed []", async () => {
		rerankEnabled.mockReturnValue(true);
		// rerankByRelevance fails closed on the gate path to items:[] with verified:false.
		rerankByRelevance.mockResolvedValue({ items: [], verified: false });
		const res = await rerankRagHits("q", [A, B, C]);
		// The degrade must keep ALL input hits (the cosine/similarity floor already vetted them), NOT [].
		expect(res).toEqual({ hits: [A, B, C], relevanceVerified: false });
	});

	it("passes the RAG floor, allowEmpty, and timeout through to the shared reranker", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockResolvedValue({ items: [A], verified: true });
		await rerankRagHits("the query", [A]);
		expect(rerankByRelevance).toHaveBeenCalledWith("the query", [A], {
			minScore: 0.02,
			allowEmpty: true,
			timeoutMs: 3000,
		});
	});

	it("rerankByRelevance THROWS → degrades to the input hits, never rejects (fail-open contract)", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockRejectedValue(new Error("boom"));
		const res = await rerankRagHits("q", [A, B]);
		// A thrown reranker must NOT reject the promise (that would break maybeRagGrounding's fail-open) —
		// it degrades to the cosine/similarity-floored hits unchanged.
		expect(res).toEqual({ hits: [A, B], relevanceVerified: false });
		// The throw is a departure from "the wrapper returns without throwing". (CUR-68)
		expect(vi.mocked(failOpenDeparture)).toHaveBeenCalledWith("rag-rerank", "threw", { hits: 2 });
	});

	it("records no departure when the reranker is disabled (the designed fallback)", async () => {
		vi.mocked(failOpenDeparture).mockClear();
		rerankEnabled.mockReturnValue(false);
		await rerankRagHits("q", [A, B]);
		expect(vi.mocked(failOpenDeparture)).not.toHaveBeenCalled();
	});
});

describe("rerankRagHits — similarity skip-floor (RAG_RERANK_SKIP_COSINE_BELOW, default off)", () => {
	const weak1 = hit({ title: "W1", score: 0.05 });
	const weak2 = hit({ title: "W2", score: 0.12 });
	const strong = hit({ title: "ST", score: 0.61 });
	const unscored = hit({ title: "U" }); // no store-reported score

	it("default (0) → never skips: weak hits still go to the reranker", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockResolvedValue({ items: [], verified: true });
		await rerankRagHits("q", [weak1, weak2]);
		expect(rerankByRelevance).toHaveBeenCalledTimes(1);
	});

	it("EVERY hit scored below the floor → skips the reranker and answers ungrounded (unverified)", async () => {
		rerankEnabled.mockReturnValue(true);
		skipBelow.v = 0.3;
		const res = await rerankRagHits("yes u can", [weak1, weak2]);
		expect(res).toEqual({ hits: [], relevanceVerified: false });
		expect(rerankByRelevance).not.toHaveBeenCalled();
	});

	it("ONE hit at/above the floor → full rerank runs (the skip is all-or-nothing)", async () => {
		rerankEnabled.mockReturnValue(true);
		skipBelow.v = 0.3;
		rerankByRelevance.mockResolvedValue({ items: [strong], verified: true });
		const res = await rerankRagHits("q", [weak1, strong]);
		expect(res).toEqual({ hits: [strong], relevanceVerified: true });
		expect(rerankByRelevance).toHaveBeenCalledTimes(1);
	});

	it("a hit MISSING a score disables the skip (unknown similarity is never assumed weak)", async () => {
		rerankEnabled.mockReturnValue(true);
		skipBelow.v = 0.3;
		rerankByRelevance.mockResolvedValue({ items: [unscored], verified: true });
		const res = await rerankRagHits("q", [weak1, unscored]);
		expect(res).toEqual({ hits: [unscored], relevanceVerified: true });
		expect(rerankByRelevance).toHaveBeenCalledTimes(1);
	});

	it("skip fires only when the reranker is enabled (disabled path keeps today's pass-through)", async () => {
		rerankEnabled.mockReturnValue(false);
		skipBelow.v = 0.3;
		const res = await rerankRagHits("q", [weak1]);
		// Disabled ⇒ the upstream floor is the gate; the skip must not turn a grounded turn ungrounded.
		expect(res).toEqual({ hits: [weak1], relevanceVerified: false });
	});
});

describe("rerankRagHits — SyftHub is reranked like every other source (not keep-only)", () => {
	it("sends federated hits to the reranker alongside catalog hits", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockResolvedValue({ items: [A, S], verified: true });
		await rerankRagHits("q", [A, S]);
		// S (SyftHub) must be scored, not held out.
		expect(rerankByRelevance).toHaveBeenCalledWith("q", [A, S], expect.any(Object));
	});

	it("DROPS an off-topic federated hit below the floor (the epfl-news-for-a-greeting regression)", async () => {
		rerankEnabled.mockReturnValue(true);
		// Query is a greeting; both the catalog hit and the SyftHub news doc score below the floor.
		rerankByRelevance.mockResolvedValue({ items: [], verified: true });
		const res = await rerankRagHits("whats up bro", [A, S]);
		// Verified all-below-floor → [] → maybeRagGrounding answers ungrounded (no irrelevant epfl-news).
		expect(res).toEqual({ hits: [], relevanceVerified: true });
	});

	it("keeps a genuinely-relevant federated hit that clears the floor", async () => {
		rerankEnabled.mockReturnValue(true);
		rerankByRelevance.mockResolvedValue({ items: [S], verified: true });
		const res = await rerankRagHits("federated topic", [A, S]);
		expect(res).toEqual({ hits: [S], relevanceVerified: true });
	});
});
