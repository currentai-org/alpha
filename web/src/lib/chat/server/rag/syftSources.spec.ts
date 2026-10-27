import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable fakes for the SyftHub client, env config, and logger. vi.hoisted so the mock
// factories below can close over them.
const h = vi.hoisted(() => {
	const hubSearch = vi.fn();
	const searchQuery = vi.fn();
	const loggerWarn = vi.fn();
	// The catalog + router are leaf modules with their OWN unit specs (syftCatalog.spec / syftRouter.spec);
	// here they are MOCKED so these tests exercise the discoverSources WIRING (budget, placement, shadow,
	// build-key, fall-through) without the real hub.browse / LLM fetch, and so loading syftSources doesn't
	// drag their import graphs into this hermetic spec.
	const getSyftCatalog = vi.fn();
	const routeEndpoints = vi.fn();
	const logRouterShadow = vi.fn();
	// Pick relevance gate collaborators (search/rerank is mocked the same hermetic way): disabled by
	// default so every existing test runs the ungated path byte-for-byte.
	const rerankByRelevance = vi.fn();
	return {
		hubSearch,
		searchQuery,
		loggerWarn,
		getSyftCatalog,
		routeEndpoints,
		logRouterShadow,
		rerank: { enabled: false },
		rerankByRelevance,
		client: { hub: { search: hubSearch }, search: { query: searchQuery } } as unknown,
		clientRef: { v: null as unknown },
		throwOnClient: { v: false },
		// When set, getSyftClient() bumps the build key (models a concurrent client rebuild).
		buildKeyOnAcquire: { v: "" },
		buildKey: { v: "build-1" },
		config: {} as Record<string, unknown>,
		// syftRouter() return — default OFF so existing tests are byte-for-byte the embedding path.
		router: {} as Record<string, unknown>,
	};
});

vi.mock("./syftClient", () => ({
	// The client carries the PAT as the aggregator's MPP user_token (injected in syftClient.ts), so the
	// same client serves discovery and retrieval. May perform a (re)build that moves the build key.
	getSyftClient: () => {
		if (h.throwOnClient.v) {
			throw new Error("client construction blew up");
		}
		if (h.buildKeyOnAcquire.v) {
			h.buildKey.v = h.buildKeyOnAcquire.v;
		}
		return h.clientRef.v;
	},
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
	logger: { warn: h.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	discoverSources,
	querySyftSources,
	effectiveRouterCap,
	discoverCapMs,
	_resetDiscoveryCache,
} from "./syftSources";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";

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
	h.throwOnClient.v = false;
	h.buildKeyOnAcquire.v = "";
	h.buildKey.v = "build-1";
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
	});
	h.rerank.enabled = false;
	h.rerankByRelevance.mockReset();
	for (const k of Object.keys(h.router)) delete h.router[k];
	Object.assign(h.router, {
		enabled: false,
		shadow: false,
		honorEmpty: false,
		model: "",
		timeoutMs: 4000,
		maxEndpoints: 3,
		catalogTtlMs: 3600000,
	});
});

describe("discoverSources", () => {
	it("returns [] (and never calls the SDK) when no client is configured", async () => {
		h.clientRef.v = null;
		expect(await discoverSources("a real query")).toEqual([]);
		expect(h.hubSearch).not.toHaveBeenCalled();
	});

	it("drops below-threshold sources and maps to owner/slug picks", async () => {
		h.hubSearch.mockResolvedValue([
			endpoint({ ownerUsername: "a", slug: "x", relevanceScore: 0.9 }),
			endpoint({ ownerUsername: "b", slug: "y", relevanceScore: 0.2 }), // below 0.4
		]);
		const picks = await discoverSources("q-threshold");
		expect(picks.map((p) => p.path)).toEqual(["a/x"]);
		expect(h.hubSearch).toHaveBeenCalledWith(
			"q-threshold",
			expect.objectContaining({ type: "data_source", topK: 5, minScore: 0.4 })
		);
	});

	it("applies an owner/tag scope filter with over-fetch on a shared hub", async () => {
		h.config.scopeOwner = "ours";
		h.config.scopeTag = "potluck";
		h.hubSearch.mockResolvedValue([
			endpoint({ ownerUsername: "ours", slug: "ok", tags: ["potluck"] }),
			endpoint({ ownerUsername: "ours", slug: "notag", tags: ["other"] }),
			endpoint({ ownerUsername: "theirs", slug: "x", tags: ["potluck"] }),
		]);
		const picks = await discoverSources("q-scope");
		expect(picks.map((p) => p.path)).toEqual(["ours/ok"]);
		// over-fetched topK = discoveryTopK * 4 when a scope filter is active
		expect(h.hubSearch).toHaveBeenCalledWith("q-scope", expect.objectContaining({ topK: 20 }));
	});

	it("drops blocklisted owner/slug paths from discovery (with over-fetch)", async () => {
		h.config.sourceBlocklist = ["tempo/news", "tempo/plus"];
		h.hubSearch.mockResolvedValue([
			endpoint({ ownerUsername: "tempo", slug: "news", relevanceScore: 0.9 }),
			endpoint({ ownerUsername: "tempo", slug: "plus", relevanceScore: 0.8 }),
			endpoint({ ownerUsername: "epfl-news", slug: "epfl-news", relevanceScore: 0.7 }),
		]);
		const picks = await discoverSources("q-blocklist");
		expect(picks.map((p) => p.path)).toEqual(["epfl-news/epfl-news"]);
		// blocklist counts as a scope filter for over-fetch, so filtered rows don't starve topK
		expect(h.hubSearch).toHaveBeenCalledWith("q-blocklist", expect.objectContaining({ topK: 20 }));
	});

	it("caches picks so a repeat query skips the second hub.search", async () => {
		h.hubSearch.mockResolvedValue([endpoint()]);
		await discoverSources("same-query");
		await discoverSources("same-query");
		expect(h.hubSearch).toHaveBeenCalledTimes(1);
	});

	it("invalidates the cache when the client rebuilds (build key changes)", async () => {
		h.hubSearch.mockResolvedValue([endpoint()]);
		await discoverSources("q-rebuild");
		h.buildKey.v = "build-2"; // token/base changed → new client
		await discoverSources("q-rebuild");
		expect(h.hubSearch).toHaveBeenCalledTimes(2);
	});

	it("cache key varies on discovery config — topK / minScore / scope each force a fresh search", async () => {
		h.hubSearch.mockResolvedValue([endpoint()]);
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(1); // baseline cached
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(1); // identical → cache hit
		h.config.discoveryTopK = 9;
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(2);
		h.config.discoveryMinScore = 0.7;
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(3);
		h.config.scopeOwner = "ours";
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(4);
		h.config.scopeTag = "potluck";
		await discoverSources("q-cfg");
		expect(h.hubSearch).toHaveBeenCalledTimes(5);
	});

	it("fails open to [] when hub.search throws", async () => {
		h.hubSearch.mockRejectedValue(new Error("network"));
		expect(await discoverSources("q-err")).toEqual([]);
		expect(h.loggerWarn).toHaveBeenCalled();
	});
});

describe("querySyftSources", () => {
	it("returns [] without retrieving when discovery is empty", async () => {
		h.hubSearch.mockResolvedValue([]);
		expect(await querySyftSources("nothing relevant")).toEqual([]);
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	describe("pick relevance gate", () => {
		it("skips the metered search.query entirely when a VERIFIED rerank drops every pick", async () => {
			h.rerank.enabled = true;
			h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
			h.rerankByRelevance.mockResolvedValue({ items: [], verified: true });
			expect(await querySyftSources("q-gate-empty")).toEqual([]);
			expect(h.searchQuery).not.toHaveBeenCalled();
		});

		it("retrieves ONLY the picks that survive a verified rerank", async () => {
			h.rerank.enabled = true;
			h.hubSearch.mockResolvedValue([
				endpoint({ ownerUsername: "a", slug: "x" }),
				endpoint({ ownerUsername: "b", slug: "y" }),
			]);
			h.rerankByRelevance.mockImplementation((_q: string, candidates: { pick: unknown }[]) =>
				Promise.resolve({
					items: candidates.filter((c) => (c.pick as { path: string }).path === "b/y"),
					verified: true,
				})
			);
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-gate-filter");
			expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["b/y"] }));
		});

		it("degrades to ALL picks when the rerank is UNVERIFIED (cold/failed lane) — default 'off'", async () => {
			h.rerank.enabled = true;
			h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
			h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-gate-unverified");
			expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["a/x"] }));
		});

		// §3.4 — fail-closed-for-metered when the reranker can't verify.
		const catalog = (entries: { path: string; metered: boolean }[]) => ({
			entries: entries.map((e) => ({ path: e.path, name: e.path, description: "", tags: [], metered: e.metered })),
			buildKey: "build-1",
		});

		it("fail-closed 'on': an UNVERIFIED rerank drops METERED picks, keeps FREE ones", async () => {
			h.rerank.enabled = true;
			h.config.pickGateFailClosed = "on";
			h.hubSearch.mockResolvedValue([
				endpoint({ ownerUsername: "a", slug: "x" }), // metered
				endpoint({ ownerUsername: "b", slug: "y" }), // free
			]);
			h.getSyftCatalog.mockResolvedValue(
				catalog([
					{ path: "a/x", metered: true },
					{ path: "b/y", metered: false },
				])
			);
			h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-failclosed-on");
			// only the FREE source reaches the metered call; the metered one is dropped (unverifiable).
			expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["b/y"] }));
		});

		it("fail-closed 'on': an UNKNOWN metered pick (catalog miss) is treated as metered and dropped", async () => {
			h.rerank.enabled = true;
			h.config.pickGateFailClosed = "on";
			h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
			h.getSyftCatalog.mockResolvedValue(catalog([])); // no metered info for a/x
			h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-failclosed-unknown");
			expect(h.searchQuery).not.toHaveBeenCalled(); // all-unknown ⇒ all-metered ⇒ dropped ⇒ no metered call
		});

		it("fail-closed 'shadow': logs the would-drop set but keeps ALL picks (behavior unchanged)", async () => {
			h.rerank.enabled = true;
			h.config.pickGateFailClosed = "shadow";
			h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
			h.getSyftCatalog.mockResolvedValue(catalog([{ path: "a/x", metered: true }]));
			h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-failclosed-shadow");
			// shadow never changes retrieval: the metered pick still reaches search.query.
			expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["a/x"] }));
		});

		it("is a no-op when the floor is 0 or the reranker is disabled", async () => {
			h.config.pickMinRerank = 0;
			h.rerank.enabled = true;
			h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
			h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
			await querySyftSources("q-gate-off");
			expect(h.rerankByRelevance).not.toHaveBeenCalled();
			expect(h.searchQuery).toHaveBeenCalled();
		});
	});

	it("maps SearchDocument{title,slug,content} → RagSource (no url/score; sourceName=slug)", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue({
			documents: [{ title: "Doc1", slug: "a/x", content: "<p>Body   text</p>" }],
			retrievalInfo: [{ path: "a/x", documentsRetrieved: 1, status: "success" }],
			metadata: {},
		});
		const out = await querySyftSources("q-map");
		expect(out).toEqual([
			{ title: "Doc1", snippet: "Body text", engine: "SyftHub", sourceName: "a/x" },
		]);
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "q-map", dataSources: ["a/x"], guestMode: undefined })
		);
	});

	it("drops docs from a source we couldn't read (non-success retrievalInfo status)", async () => {
		h.hubSearch.mockResolvedValue([
			endpoint({ ownerUsername: "a", slug: "x" }),
			endpoint({ ownerUsername: "b", slug: "y" }),
		]);
		h.searchQuery.mockResolvedValue({
			documents: [
				{ title: "Good", slug: "a/x", content: "real content" },
				{ title: "Denied", slug: "b/y", content: "<!DOCTYPE html>Just a moment..." },
			],
			retrievalInfo: [
				{ path: "a/x", documentsRetrieved: 1, status: "success" },
				{ path: "b/y", documentsRetrieved: 0, status: "access_denied" },
			],
			metadata: {},
		});
		const out = await querySyftSources("q");
		// Only the readable source's doc survives; the access_denied source's failure page is dropped.
		expect(out).toEqual([
			{ title: "Good", snippet: "real content", engine: "SyftHub", sourceName: "a/x" },
		]);
	});

	it("caps a megabyte-sized document so the snippet can't overflow the injected prompt", async () => {
		// A federated source can return a whole un-chunked corpus as one document (~26 MB).
		// The snippet lands verbatim in the system prompt, so it MUST be clamped — never the raw blob.
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		const huge = "word ".repeat(5_000_000); // ~25 MB of content
		h.searchQuery.mockResolvedValue({
			documents: [{ title: "Huge", slug: "a/x", content: huge }],
			retrievalInfo: [{ path: "a/x", documentsRetrieved: 1, status: "success" }],
			metadata: {},
		});
		const out = await querySyftSources("q-huge");
		expect(out).toHaveLength(1);
		// toSnippet caps at 480 chars + a one-char ellipsis — orders of magnitude below the raw input.
		expect(out[0].snippet.length).toBeLessThanOrEqual(481);
		expect(out[0].snippet.endsWith("…")).toBe(true);
	});

	it("caps the prompt-facing LABELS (title, sourceName) too, not just the snippet body", async () => {
		// mergeRagEvidence renders `[n] {title} ({SyftHub:sourceName})` ahead of the snippet, so a
		// misbehaving source could blow the prompt via a megabyte title/slug despite the snippet cap.
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		const huge = "T".repeat(2_000_000);
		h.searchQuery.mockResolvedValue({
			documents: [{ title: huge, slug: huge, content: "real body text" }],
			retrievalInfo: [{ path: "a/x", documentsRetrieved: 1, status: "success" }],
			metadata: {},
		});
		const out = await querySyftSources("q-huge-label");
		expect(out).toHaveLength(1);
		expect(out[0].title.length).toBeLessThanOrEqual(201); // LABEL_CAP + ellipsis
		expect((out[0].sourceName ?? "").length).toBeLessThanOrEqual(201);
	});

	it("title fallback resolves AFTER capping: whitespace/tags title yields to slug, 'Source' only if both empty", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue({
			documents: [
				{ title: "", slug: "", content: "kept body" }, // both empty → "Source"
				{ title: "   ", slug: "a/keep", content: "body two" }, // title cleans to "" → fall back to slug
				{ title: "Tagsonly", slug: "a/x", content: "<div><span></span></div>" }, // body strips to "" → dropped
			],
			retrievalInfo: [{ path: "a/x", documentsRetrieved: 3, status: "success" }],
			metadata: {},
		});
		const out = await querySyftSources("q-empty");
		expect(out).toHaveLength(2); // the all-tags-body doc is filtered out
		expect(out[0]).toMatchObject({ title: "Source", snippet: "kept body", sourceName: "" });
		expect(out[1]).toMatchObject({ title: "a/keep", snippet: "body two", sourceName: "a/keep" });
	});

	it("fails open to [] when search.query throws", async () => {
		h.hubSearch.mockResolvedValue([endpoint()]);
		h.searchQuery.mockRejectedValue(new Error("retrieve down"));
		expect(await querySyftSources("q-retrieve-err")).toEqual([]);
		expect(h.loggerWarn).toHaveBeenCalled();
	});

	it("requests guest mode (no payment) only when SYFTHUB_GUEST_MODE is set", async () => {
		h.config.guestMode = true; // opt out of paying → unauthenticated access to policy-free sources
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
		await querySyftSources("q-guest");
		expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ guestMode: true }));
	});

	it("aborts the metered retrieval when the deadline fires, resolving []", async () => {
		h.config.retrieveTimeoutMs = 10;
		h.hubSearch.mockResolvedValue([endpoint()]);
		let captured: { signal: AbortSignal } | undefined;
		h.searchQuery.mockImplementation((opts: { signal: AbortSignal }) => {
			captured = opts;
			return new Promise(() => {}); // never resolves — must be aborted by the deadline
		});
		const out = await querySyftSources("q-timeout");
		expect(out).toEqual([]);
		expect(captured?.signal.aborted).toBe(true);
	});

	it("a SLOW discovery finishing AFTER the deadline never enters the metered search.query", async () => {
		// If discovery is the slow part, the deadline aborts + resolves [], but the
		// orphaned work must NOT go on to call (and pay for) search.query.
		h.config.retrieveTimeoutMs = 20;
		h.hubSearch.mockImplementation(
			() => new Promise((r) => setTimeout(() => r([endpoint()]), 60)) // resolves AFTER the deadline
		);
		const out = await querySyftSources("q-slow-discovery");
		expect(out).toEqual([]);
		// let the orphaned discovery resolve (~60ms) and the work hit its aborted-guard
		await new Promise((r) => setTimeout(r, 80));
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("does not query when the client is rebuilt DURING hub.search (picks are from the old hub)", async () => {
		// The build key must track the client the picks came from: a rebuild mid-hub.search means the
		// picks belong to the old hub, so discovery discards them and retrieval never runs.
		h.hubSearch.mockImplementation(async () => {
			h.buildKey.v = "gen-2"; // a concurrent rebuild lands while hub.search is in flight
			return [endpoint({ ownerUsername: "a", slug: "x" })];
		});
		h.searchQuery.mockResolvedValue({ documents: [], retrievalInfo: [], metadata: {} });
		const out = await querySyftSources("q-rebuild-during-search");
		expect(out).toEqual([]);
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("fails open to [] even if client/config acquisition throws (no Promise.all rejection)", async () => {
		// discoverSources' getSyftClient() can throw; the whole body is catch-wrapped and must fail open.
		h.throwOnClient.v = true;
		await expect(querySyftSources("q-throw")).resolves.toEqual([]);
		expect(h.loggerWarn).toHaveBeenCalled();
	});

	it("logs non-success retrievalInfo without dropping the returned docs", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue({
			documents: [{ title: "D", slug: "a/x", content: "ok" }],
			retrievalInfo: [
				{ path: "a/x", documentsRetrieved: 1, status: "success" },
				{ path: "b/y", documentsRetrieved: 0, status: "error", errorMessage: "boom" },
			],
			metadata: {},
		});
		const out = await querySyftSources("q-partial");
		expect(out).toHaveLength(1);
		expect(h.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({ path: "b/y", status: "error" }),
			expect.any(String)
		);
	});
});

// ── pre-flight router wiring (catalog + routeEndpoints are MOCKED — see the spec header) ─────────
const catalogOf = (paths: string[], buildKey = "build-1") => ({
	entries: paths.map((p) => ({ path: p, name: p, description: "", tags: [], metered: false })),
	buildKey,
});
const doc = (slug: string) => ({
	documents: [{ title: "D", slug, content: "body" }],
	retrievalInfo: [{ path: slug, documentsRetrieved: 1, status: "success" }],
	metadata: {},
});

describe("effectiveRouterCap (pure budget helper)", () => {
	it("returns 0 for a standalone call (no deadlineAt) so the router is skipped", () => {
		expect(effectiveRouterCap(undefined, 9000, 4000)).toBe(0);
	});
	it("caps to the requested value when the deadline affords it", () => {
		const cap = effectiveRouterCap(Date.now() + 9000, 9000, 4000);
		expect(cap).toBeGreaterThan(3000);
		expect(cap).toBeLessThanOrEqual(4000);
	});
	it("is bound by the fallback reserve: retrieveTimeoutMs − MIN_FALLBACK_BUDGET_MS", () => {
		// requested 8000 but only 9000−4000=5000 may be spent on the router.
		expect(effectiveRouterCap(Date.now() + 9000, 9000, 8000)).toBeLessThanOrEqual(5000);
	});
	it("goes ≤ 0 (router disabled) when retrieveTimeoutMs can't afford both budgets", () => {
		expect(effectiveRouterCap(Date.now() + 3000, 3000, 4000)).toBeLessThanOrEqual(0);
	});
});

describe("discoverCapMs (budget-aware discovery cap)", () => {
	it("returns the full configured cap for a standalone call (no deadline)", () => {
		expect(discoverCapMs(undefined, 3000)).toBe(3000);
	});
	it("caps at the configured value when there is plenty of budget", () => {
		// remaining ~9000 ⇒ half is 4500, so the 3000 config cap binds.
		expect(discoverCapMs(Date.now() + 9000, 3000)).toBe(3000);
	});
	it("never gives discovery more than half the remaining budget (retrieval keeps the rest)", () => {
		// A router fall-through leaves ~4000ms: discovery must not take the full 3000 and starve retrieval.
		const cap = discoverCapMs(Date.now() + 4000, 3000);
		expect(cap).toBeGreaterThan(1500);
		expect(cap).toBeLessThanOrEqual(2000);
	});
	it("returns 0 once the deadline has passed", () => {
		expect(discoverCapMs(Date.now() - 1, 3000)).toBe(0);
	});
});

describe("discovery timeout + circuit breaker (dark-hub fast-fail)", () => {
	// A live deadline in the far future so discoverCapMs is bound by discoverTimeoutMs (20ms), not budget.
	const withDeadline = (q: string) => discoverSources(q, undefined, Date.now() + 9000, 9000);

	it("a hung hub.search yields [] at the discovery cap, NOT the retrieve timeout", async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockImplementation(() => new Promise(() => {})); // never resolves
		const started = Date.now();
		expect(await withDeadline("q-hang")).toEqual([]);
		expect(Date.now() - started).toBeLessThan(9000); // capped by discovery (~20ms), not retrieveTimeoutMs
	});

	it("does not cache a timed-out discovery — a later live search for the same query still runs", async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockImplementationOnce(() => new Promise(() => {})); // 1st probe hangs → timeout
		expect(await withDeadline("q-recache")).toEqual([]);
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]); // hub recovers
		const picks = await withDeadline("q-recache");
		expect(picks.map((p) => p.path)).toEqual(["a/x"]);
		expect(h.hubSearch).toHaveBeenCalledTimes(2); // timeout wasn't cached → re-probed
	});

	it("opens after 3 consecutive timeouts, then skips hub.search entirely (fail fast)", async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockImplementation(() => new Promise(() => {}));
		await withDeadline("q-breaker");
		await withDeadline("q-breaker");
		await withDeadline("q-breaker");
		expect(h.hubSearch).toHaveBeenCalledTimes(3); // three probes, each timed out (uncached)
		expect(await withDeadline("q-breaker")).toEqual([]);
		expect(await withDeadline("q-breaker")).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(3); // circuit OPEN ⇒ no further probes issued
	});

	it("never opens on fast-empty discoveries (empty ≠ dark backend)", async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockResolvedValue([]); // fast, genuine empty every time
		for (const q of ["e1", "e2", "e3", "e4", "e5"]) {
			expect(await withDeadline(q)).toEqual([]); // distinct queries so the cache never short-circuits
		}
		expect(h.hubSearch).toHaveBeenCalledTimes(5); // every probe ran; the breaker stayed closed
	});

	it("resets the breaker on a client rebuild so a healthy new hub isn't held open", async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockImplementation(() => new Promise(() => {}));
		await withDeadline("q-rb");
		await withDeadline("q-rb");
		await withDeadline("q-rb"); // opens
		expect(await withDeadline("q-rb")).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(3); // 4th skipped while open
		h.buildKey.v = "build-2"; // client rebuilt (token/base change)
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		const picks = await withDeadline("q-rb");
		expect(picks.map((p) => p.path)).toEqual(["a/x"]); // reset ⇒ probes again and succeeds
		expect(h.hubSearch).toHaveBeenCalledTimes(4);
	});
});

// The half-open transitions and the negative-cache TTL turn on wall-clock (30s cooldown, 15s empty TTL),
// so these use fake timers to travel past those thresholds deterministically. `Date.now()` is faked too,
// so deadlineAt/openUntil/cache-expiry all move together.
describe("discovery breaker — half-open + negative-cache (fake timers)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const at = () => Date.now() + 9000; // a live far-future deadline (cap bound by discoverTimeoutMs)
	// Trip the breaker OPEN with 3 hung probes (each timed out at the 20ms discovery cap).
	const tripOpen = async () => {
		h.config.discoverTimeoutMs = 20;
		h.hubSearch.mockImplementation(() => new Promise(() => {})); // hangs → local timeout
		for (let i = 0; i < 3; i++) {
			const p = discoverSources("q-ho", undefined, at(), 9000);
			await vi.advanceTimersByTimeAsync(20); // fire the discovery cap
			expect(await p).toEqual([]);
		}
		expect(h.hubSearch).toHaveBeenCalledTimes(3);
	};

	it("skips while open, then admits exactly ONE probe when half-open (single-flight)", async () => {
		await tripOpen();
		expect(await discoverSources("q-ho", undefined, at(), 9000)).toEqual([]); // within cooldown
		expect(h.hubSearch).toHaveBeenCalledTimes(3); // open ⇒ skipped
		await vi.advanceTimersByTimeAsync(31_000); // past the 30s cooldown ⇒ half-open
		const a = discoverSources("q-ho", undefined, at(), 9000);
		const b = discoverSources("q-ho", undefined, at(), 9000); // concurrent
		expect(h.hubSearch).toHaveBeenCalledTimes(4); // single-flight: only one probe admitted
		await vi.advanceTimersByTimeAsync(20);
		expect(await a).toEqual([]);
		expect(await b).toEqual([]);
	});

	it("a timed-out half-open probe RE-opens the breaker", async () => {
		await tripOpen();
		await vi.advanceTimersByTimeAsync(31_000); // half-open
		const probe = discoverSources("q-ho", undefined, at(), 9000);
		await vi.advanceTimersByTimeAsync(20); // still dark ⇒ times out
		expect(await probe).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(4); // the one half-open probe
		expect(await discoverSources("q-ho", undefined, at(), 9000)).toEqual([]); // within NEW cooldown
		expect(h.hubSearch).toHaveBeenCalledTimes(4); // re-opened ⇒ skipped again
	});

	it("a successful half-open probe CLOSES the breaker (concurrency no longer single-flighted)", async () => {
		await tripOpen();
		await vi.advanceTimersByTimeAsync(31_000); // half-open
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]); // hub recovered
		const recovered = await discoverSources("q-hoS", undefined, at(), 9000);
		expect(recovered.map((p) => p.path)).toEqual(["a/x"]); // half-open probe succeeds ⇒ closes
		expect(h.hubSearch).toHaveBeenCalledTimes(4);
		// CLOSED now: two concurrent distinct-query probes BOTH run (no single-flight gate).
		const a = discoverSources("q-hoA", undefined, at(), 9000);
		const b = discoverSources("q-hoB", undefined, at(), 9000);
		await Promise.all([a, b]);
		expect(h.hubSearch).toHaveBeenCalledTimes(6); // 3 trip + 1 recover + 2 concurrent
	});

	it("negative-caches a raw-empty discovery briefly, but a non-empty result for the full TTL", async () => {
		h.config.discoveryCacheTtlMs = 300_000;
		h.config.discoverTimeoutMs = 3000;
		h.hubSearch.mockResolvedValue([]); // fast, ambiguous empty
		expect(await discoverSources("q-empty", undefined, at(), 9000)).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000); // < 15s empty-TTL ⇒ still cached
		expect(await discoverSources("q-empty", undefined, at(), 9000)).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(1); // cache hit
		await vi.advanceTimersByTimeAsync(6_000); // now > 15s total ⇒ empty entry expired
		expect(await discoverSources("q-empty", undefined, at(), 9000)).toEqual([]);
		expect(h.hubSearch).toHaveBeenCalledTimes(2); // re-probed (transient empty can't shadow for 300s)

		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]); // non-empty
		expect((await discoverSources("q-full", undefined, at(), 9000)).map((p) => p.path)).toEqual([
			"a/x",
		]);
		const calls = h.hubSearch.mock.calls.length;
		await vi.advanceTimersByTimeAsync(20_000); // > 15s but << 300s
		expect((await discoverSources("q-full", undefined, at(), 9000)).map((p) => p.path)).toEqual([
			"a/x",
		]);
		expect(h.hubSearch).toHaveBeenCalledTimes(calls); // non-empty still cached at the full TTL
	});
});

describe("discoverSources — pre-flight router wiring", () => {
	it("router OFF (default) never touches the catalog — pure embedding path", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue(doc("a/x"));
		await querySyftSources("q-off");
		expect(h.getSyftCatalog).not.toHaveBeenCalled();
		expect(h.hubSearch).toHaveBeenCalled();
	});

	it("standalone discoverSources(query) skips the router even when enabled (no deadlineAt ⇒ cap 0)", async () => {
		h.router.enabled = true;
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		await discoverSources("q-standalone");
		expect(h.getSyftCatalog).not.toHaveBeenCalled();
		expect(h.hubSearch).toHaveBeenCalled();
	});

	it("router picks drive retrieval; embedding discovery is bypassed", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({
			kind: "picks",
			picks: [{ path: "a/x", name: "X", score: 1 }],
		});
		h.searchQuery.mockResolvedValue(doc("a/x"));
		const out = await querySyftSources("q-picks");
		expect(out).toHaveLength(1);
		expect(h.hubSearch).not.toHaveBeenCalled(); // embedding bypassed
		expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["a/x"] }));
	});

	it("router UNDECIDED falls through to embedding discovery", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({ kind: "undecided" });
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		await querySyftSources("q-undecided");
		expect(h.hubSearch).toHaveBeenCalled();
		expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ dataSources: ["e/y"] }));
	});

	it("null catalog falls through to embedding discovery (routeEndpoints never called)", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(null);
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		await querySyftSources("q-null-cat");
		expect(h.routeEndpoints).not.toHaveBeenCalled();
		expect(h.hubSearch).toHaveBeenCalled();
	});

	it("confident EMPTY with HONOR_EMPTY=false falls through; =true grounds nothing", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({ kind: "empty" });

		// honorEmpty false → fall through to embedding
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		await querySyftSources("q-empty-fallthrough");
		expect(h.hubSearch).toHaveBeenCalled();

		// honorEmpty true → [] (no retrieval, no embedding)
		vi.clearAllMocks();
		h.router.honorEmpty = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({ kind: "empty" });
		const out = await querySyftSources("q-empty-honored");
		expect(out).toEqual([]);
		expect(h.hubSearch).not.toHaveBeenCalled();
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("a rebuild AFTER routing (build key moved) suppresses routed picks → []", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"], "build-1")); // catalog fetched under build-1
		h.routeEndpoints.mockImplementation(async () => {
			h.buildKey.v = "build-2"; // a concurrent rebuild lands between routing and returning picks
			return { kind: "picks", picks: [{ path: "a/x", name: "X", score: 1 }] };
		});
		const out = await querySyftSources("q-stale-picks");
		expect(out).toEqual([]);
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("budget too small (retrieveTimeoutMs ≤ reserve) disables the router for the turn", async () => {
		h.router.enabled = true;
		h.config.retrieveTimeoutMs = 3000; // ≤ MIN_FALLBACK_BUDGET_MS ⇒ effective cap ≤ 0
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		await querySyftSources("q-no-budget");
		expect(h.getSyftCatalog).not.toHaveBeenCalled();
		expect(h.hubSearch).toHaveBeenCalled();
	});

	it("soft cap fires on a slow catalog → undecided, fall through; the metered call is NOT aborted", async () => {
		h.router.enabled = true;
		h.router.timeoutMs = 20; // tiny soft cap
		h.config.retrieveTimeoutMs = 4030; // > reserve so the router is active, cap ≈ 20ms
		// Catalog resolves slowly; respects the child abort so no timer dangles past the test.
		h.getSyftCatalog.mockImplementation(
			(signal: AbortSignal) =>
				new Promise((resolve) => {
					const t = setTimeout(() => resolve(catalogOf(["a/x"])), 200);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(t);
							resolve(null);
						},
						{ once: true }
					);
				})
		);
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		let captured: { signal: AbortSignal } | undefined;
		h.searchQuery.mockImplementation((opts: { signal: AbortSignal }) => {
			captured = opts;
			return Promise.resolve(doc("e/y"));
		});
		const out = await querySyftSources("q-softcap");
		expect(out).toHaveLength(1); // fall-through retrieval succeeded
		expect(h.routeEndpoints).not.toHaveBeenCalled(); // catalog never settled before the cap
		expect(h.hubSearch).toHaveBeenCalled(); // embedding fall-through ran
		expect(captured?.signal.aborted).toBe(false); // the metered call kept the outer deadline
	});

	it("SHADOW: router runs + logs, but embedding discovery drives retrieval", async () => {
		h.router.shadow = true; // shadow activates the router independently of `enabled`
		h.router.enabled = false;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({
			kind: "picks",
			picks: [{ path: "a/x", name: "X", score: 1 }],
		});
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		const out = await querySyftSources("q-shadow");
		expect(h.getSyftCatalog).toHaveBeenCalled();
		expect(h.routeEndpoints).toHaveBeenCalled();
		expect(h.logRouterShadow).toHaveBeenCalled();
		expect(h.hubSearch).toHaveBeenCalled(); // embedding drives retrieval
		expect(h.searchQuery).toHaveBeenCalledWith(
			expect.objectContaining({ dataSources: ["e/y"] }) // embedding picks, NOT routed a/x
		);
		expect(out).toHaveLength(1);
	});

	it("SHADOW invokes the catalog/router BEFORE the embedding cache read, even when DISCOVERY_CACHE is warm", async () => {
		// Warm the embedding cache with a first OFF turn, then shadow must STILL run the router.
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		await querySyftSources("warm-q"); // router off → caches embedding picks for "warm-q"

		h.router.shadow = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({ kind: "empty" });
		await querySyftSources("warm-q"); // same query, now shadow
		expect(h.getSyftCatalog).toHaveBeenCalled(); // not short-circuited by the warm embedding cache
		expect(h.routeEndpoints).toHaveBeenCalled();
		expect(h.logRouterShadow).toHaveBeenCalled();
	});

	it("router branch exception falls through to embedding (does not surface as querySyftSources [])", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockRejectedValue(new Error("catalog blew up"));
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "e", slug: "y" })]);
		h.searchQuery.mockResolvedValue(doc("e/y"));
		const out = await querySyftSources("q-router-throw");
		expect(out).toHaveLength(1); // fell through, retrieved
		expect(h.hubSearch).toHaveBeenCalled();
		expect(h.loggerWarn).toHaveBeenCalled();
	});
});

// ── stage timing spans (Phase 1.1: decompose the opaque ragMs into catalog/router/pickGate/metered) ──
describe("SyftHub stage timing spans", () => {
	it("records catalog/router/pickGate/metered into a passed sink on the router path", async () => {
		h.router.enabled = true;
		h.getSyftCatalog.mockResolvedValue(catalogOf(["a/x"]));
		h.routeEndpoints.mockResolvedValue({
			kind: "picks",
			picks: [{ path: "a/x", name: "X", score: 1 }],
		});
		h.searchQuery.mockResolvedValue(doc("a/x"));
		const spans: TurnSpans = {};
		await querySyftSources("q-spans-router", spans);
		expect(typeof spans.syftCatalogMs).toBe("number");
		expect(typeof spans.syftRouterMs).toBe("number");
		expect(typeof spans.syftPickGateMs).toBe("number");
		expect(typeof spans.syftMeteredMs).toBe("number");
	});

	it("records only pickGate + metered on the embedding path (no catalog/router ran)", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue(doc("a/x"));
		const spans: TurnSpans = {};
		await querySyftSources("q-spans-embed", spans);
		expect(spans.syftCatalogMs).toBeUndefined();
		expect(spans.syftRouterMs).toBeUndefined();
		expect(typeof spans.syftPickGateMs).toBe("number");
		expect(typeof spans.syftMeteredMs).toBe("number");
	});

	it("leaves the metered span unset when discovery finds nothing (no paid call was made)", async () => {
		h.hubSearch.mockResolvedValue([]); // empty discovery ⇒ never enters search.query
		const spans: TurnSpans = {};
		expect(await querySyftSources("q-spans-empty", spans)).toEqual([]);
		expect(spans.syftMeteredMs).toBeUndefined();
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("is backward-compatible: no sink argument still retrieves normally", async () => {
		h.hubSearch.mockResolvedValue([endpoint({ ownerUsername: "a", slug: "x" })]);
		h.searchQuery.mockResolvedValue(doc("a/x"));
		await expect(querySyftSources("q-no-sink")).resolves.toHaveLength(1);
	});
});
