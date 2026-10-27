import { describe, it, expect, vi, beforeEach } from "vitest";

// Catalog PRE-gate wiring (preGateCatalog → querySyftSources): the whole scoped catalog is scored by
// the cross-encoder BEFORE the LLM router, so a verified all-below-floor query skips the router,
// discovery, pick gate, and metered retrieval outright — and verified survivors shrink the router's
// catalog and replace the redundant post-router rerank with set membership. Mocks mirror
// syftSources.spec.ts (leaf modules with their own unit specs are stubbed; this exercises ORDERING
// and SKIP behavior only).
const h = vi.hoisted(() => {
	const hubSearch = vi.fn();
	const searchQuery = vi.fn();
	const getSyftCatalog = vi.fn();
	const routeEndpoints = vi.fn();
	const logRouterShadow = vi.fn();
	const rerankByRelevance = vi.fn();
	return {
		hubSearch,
		searchQuery,
		getSyftCatalog,
		routeEndpoints,
		logRouterShadow,
		rerankByRelevance,
		rerank: { enabled: true },
		client: { hub: { search: hubSearch }, search: { query: searchQuery } } as unknown,
		clientRef: { v: null as unknown },
		buildKey: { v: "build-1" },
		config: {} as Record<string, unknown>,
		router: {} as Record<string, unknown>,
	};
});

vi.mock("./syftClient", () => ({
	getSyftClient: () => h.clientRef.v,
	syftClientBuildKey: () => h.buildKey.v,
}));
vi.mock("./env", () => ({ syft: () => h.config, syftRouter: () => h.router }));
vi.mock("./syftCatalog", () => ({ getSyftCatalog: h.getSyftCatalog }));
vi.mock("$lib/chat/server/search/rerank", () => ({
	rerankEnabled: () => h.rerank.enabled,
	rerankByRelevance: (...args: unknown[]) => h.rerankByRelevance(...args),
}));
vi.mock("./syftRouter", () => ({
	routeEndpoints: h.routeEndpoints,
	logRouterShadow: h.logRouterShadow,
}));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { querySyftSources, _resetDiscoveryCache } from "./syftSources";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";

const entry = (path: string, over: Record<string, unknown> = {}) => ({
	path,
	name: path.split("/")[1],
	description: `${path} description`,
	metered: false,
	tags: [] as string[],
	...over,
});

const CATALOG = {
	entries: [entry("acme/news"), entry("acme/papers"), entry("other/blog")],
	buildKey: "build-1",
};

const endpoint = (over: Record<string, unknown> = {}) => ({
	ownerUsername: "acme",
	slug: "news",
	name: "Acme News",
	relevanceScore: 0.9,
	tags: [] as string[],
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	_resetDiscoveryCache();
	h.clientRef.v = h.client;
	h.buildKey.v = "build-1";
	h.rerank.enabled = true;
	for (const k of Object.keys(h.config)) delete h.config[k];
	Object.assign(h.config, {
		token: "tok",
		baseUrl: "http://localhost:8080",
		discoveryTopK: 5,
		discoveryMinScore: 0.4,
		retrieveTopK: 5,
		similarityThreshold: 0.5,
		retrieveTimeoutMs: 9000,
		discoverTimeoutMs: 3000,
		guestMode: false,
		discoveryCacheTtlMs: 300000,
		scopeTag: "",
		scopeOwner: "",
		sourceBlocklist: [],
		pickMinRerank: 0.2,
		catalogPregate: true,
	});
	for (const k of Object.keys(h.router)) delete h.router[k];
	Object.assign(h.router, {
		enabled: false,
		shadow: false,
		honorEmpty: false,
		model: "m",
		timeoutMs: 4000,
		maxEndpoints: 3,
		catalogTtlMs: 3600000,
	});
	h.getSyftCatalog.mockResolvedValue(CATALOG);
	h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [] });
});

describe("querySyftSources — catalog pre-gate (verified-empty skips everything)", () => {
	it("VERIFIED all-below-floor → returns [] without router, discovery, or the metered call", async () => {
		h.router.enabled = true;
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: true });
		const spans: TurnSpans = {};
		expect(await querySyftSources("whats up bro", spans)).toEqual([]);
		expect(h.rerankByRelevance).toHaveBeenCalledTimes(1); // the pre-gate pass — and ONLY it
		expect(h.routeEndpoints).not.toHaveBeenCalled(); // no LLM router
		expect(h.hubSearch).not.toHaveBeenCalled(); // no embedding discovery
		expect(h.searchQuery).not.toHaveBeenCalled(); // no metered retrieve
		expect(spans.syftPregateMs).toBeTypeOf("number"); // the skip is visible in the decomposition
	});

	it("scores the catalog entries' name+description (the same text the pick gate scores)", async () => {
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: true });
		await querySyftSources("q");
		expect(h.rerankByRelevance).toHaveBeenCalledWith(
			"q",
			CATALOG.entries.map((e) => ({
				path: e.path,
				title: e.name,
				snippet: e.description,
				metered: e.metered,
			})),
			expect.objectContaining({ minScore: 0.2, allowEmpty: true })
		);
	});
});

describe("querySyftSources — catalog pre-gate (verified survivors)", () => {
	it("router reasons over ONLY the survivors; no second rerank; picks flow to the metered call", async () => {
		h.router.enabled = true;
		h.rerankByRelevance.mockResolvedValue({
			items: [{ path: "acme/news", title: "news", snippet: "acme/news description" }],
			verified: true,
		});
		h.routeEndpoints.mockResolvedValue({
			kind: "picks",
			picks: [{ path: "acme/news", name: "Acme News", score: 1 }],
		});
		await querySyftSources("acme news question");
		// The router saw the survivor subset, not the full 3-entry catalog.
		expect(h.routeEndpoints).toHaveBeenCalledWith(
			"acme news question",
			[expect.objectContaining({ path: "acme/news" })],
			expect.anything()
		);
		// Survivor membership replaced the post-router pick gate: ONE rerank total.
		expect(h.rerankByRelevance).toHaveBeenCalledTimes(1);
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ dataSources: ["acme/news"] })
		);
	});

	it("membership-filters embedding-discovery picks when the router is OFF (no post-gate rerank)", async () => {
		h.rerankByRelevance.mockResolvedValue({
			items: [{ path: "acme/news", title: "news", snippet: "acme/news description" }],
			verified: true,
		});
		h.hubSearch.mockResolvedValue([
			endpoint(), // acme/news — survivor
			endpoint({ ownerUsername: "other", slug: "blog" }), // not a survivor ⇒ dropped by membership
		]);
		await querySyftSources("acme news question");
		expect(h.rerankByRelevance).toHaveBeenCalledTimes(1);
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ dataSources: ["acme/news"] })
		);
	});
});

describe("querySyftSources — catalog pre-gate abstains (fail-open to today's path)", () => {
	it("UNVERIFIED pre-score (cold reranker) → discovery + post-gate run exactly as before", async () => {
		// Pre-gate abstains; the post-router pick gate then ALSO can't verify and fail-opens all picks.
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
		h.hubSearch.mockResolvedValue([endpoint()]);
		await querySyftSources("q");
		expect(h.hubSearch).toHaveBeenCalledTimes(1); // discovery ran — nothing was skipped
		expect(h.rerankByRelevance).toHaveBeenCalledTimes(2); // pre-gate + post-gate both attempted
		expect(h.searchQuery).toHaveBeenCalledTimes(1); // ungated picks reach retrieval (fail-open)
	});

	it("kill switch (catalogPregate=false) → no pre-gate call; post-gate remains the only gate", async () => {
		h.config.catalogPregate = false;
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: true }); // post-gate drops everything
		h.hubSearch.mockResolvedValue([endpoint()]);
		expect(await querySyftSources("q")).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(1); // discovery ran (no pre-skip)
		expect(h.rerankByRelevance).toHaveBeenCalledTimes(1); // the POST-gate pass only
		expect(h.searchQuery).not.toHaveBeenCalled(); // post-gate still protects the metered call
	});

	it("no catalog → abstain (today's path), never a throw", async () => {
		h.getSyftCatalog.mockResolvedValue(null);
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
		h.hubSearch.mockResolvedValue([endpoint()]);
		await expect(querySyftSources("q")).resolves.toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(1);
	});

	it("reranker disabled → abstain without touching the catalog or reranker", async () => {
		h.rerank.enabled = false;
		h.hubSearch.mockResolvedValue([endpoint()]);
		await querySyftSources("q");
		expect(h.rerankByRelevance).not.toHaveBeenCalled();
		expect(h.searchQuery).toHaveBeenCalledTimes(1); // pick gate also off (rerank disabled) ⇒ fail-open
	});
});

// ── auto-pick from pre-gate scores (router acceleration) ─────────────────────────────────────
type PreCandidate = { path: string; title: string; snippet: string; metered: boolean };
/** Mock ONE verified pre-gate pass: `survivors` (path+score) are returned as items, and each gets its
 *  score delivered through the scoreAdjust capture hook exactly like the real reranker does. */
const verifiedPre = (survivors: Array<{ path: string; score: number }>) =>
	h.rerankByRelevance.mockImplementationOnce(
		async (
			_q: string,
			cands: PreCandidate[],
			opts: { scoreAdjust?: (c: PreCandidate, s: number) => number }
		) => {
			const byPath = new Map(cands.map((c) => [c.path, c]));
			const items = survivors.map((s) => byPath.get(s.path));
			for (const s of survivors) {
				const c = byPath.get(s.path);
				if (c) opts.scoreAdjust?.(c, s.score);
			}
			return { items: items.filter(Boolean), verified: true };
		}
	);

describe("querySyftSources — auto-pick from pre-gate scores (SYFTHUB_ROUTER_AUTOPICK_SCORE)", () => {
	beforeEach(() => {
		h.config.routerAutopickScore = 0.9;
		h.router.enabled = true;
		h.routeEndpoints.mockResolvedValue({
			kind: "picks",
			picks: [{ path: "acme/news", name: "Acme News", score: 1 }],
		});
	});

	it("a DECISIVE survivor (≥ threshold) is picked directly — the router LLM never runs", async () => {
		verifiedPre([{ path: "acme/news", score: 0.97 }]);
		await querySyftSources("acme news question");
		expect(h.routeEndpoints).not.toHaveBeenCalled();
		expect(h.hubSearch).not.toHaveBeenCalled();
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ dataSources: ["acme/news"] })
		);
	});

	it("an AMBIGUOUS multi-survivor field (all sub-decisive) still consults the LLM", async () => {
		verifiedPre([
			{ path: "acme/news", score: 0.3 },
			{ path: "acme/papers", score: 0.2 },
		]);
		await querySyftSources("which acme source?");
		expect(h.routeEndpoints).toHaveBeenCalledTimes(1);
	});

	it("a LONE FREE survivor is picked without the LLM even below the decisive threshold", async () => {
		verifiedPre([{ path: "acme/news", score: 0.3 }]);
		await querySyftSources("acme news question");
		expect(h.routeEndpoints).not.toHaveBeenCalled();
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ dataSources: ["acme/news"] })
		);
	});

	it("a LONE METERED survivor keeps the LLM in the loop (its decline is a cost veto)", async () => {
		h.getSyftCatalog.mockResolvedValue({
			entries: [entry("acme/paid", { metered: true }), entry("acme/news")],
			buildKey: "build-1",
		});
		verifiedPre([{ path: "acme/paid", score: 0.3 }]);
		await querySyftSources("paid source question");
		expect(h.routeEndpoints).toHaveBeenCalledTimes(1);
	});

	it("knob ≤ 0 disables BOTH rules — even a 0.97 lone free survivor goes to the LLM", async () => {
		h.config.routerAutopickScore = 0;
		verifiedPre([{ path: "acme/news", score: 0.97 }]);
		await querySyftSources("acme news question");
		expect(h.routeEndpoints).toHaveBeenCalledTimes(1);
	});

	it("SHADOW mode never auto-picks (the real router must run for the comparison)", async () => {
		h.router.shadow = true;
		verifiedPre([{ path: "acme/news", score: 0.97 }]);
		h.hubSearch.mockResolvedValue([endpoint()]);
		await querySyftSources("acme news question");
		expect(h.routeEndpoints).toHaveBeenCalledTimes(1); // shadow-logged, not skipped
	});

	it("a client rebuild since the pre-gate scored (buildKey drift) disables the auto-pick", async () => {
		h.buildKey.v = "build-2"; // catalog scored under build-1
		verifiedPre([{ path: "acme/news", score: 0.97 }]);
		await querySyftSources("acme news question");
		expect(h.routeEndpoints).toHaveBeenCalledTimes(1); // fell back to the routed path
	});
});
