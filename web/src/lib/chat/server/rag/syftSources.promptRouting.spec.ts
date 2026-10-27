import { describe, it, expect, vi, beforeEach } from "vitest";

// PROMPT-ROUTED retrieval (SYFTHUB_PROMPT_ROUTING): when querySyftSources is handed the endpoints for a
// matched prompt, it must query those `owner/slug` data stores DIRECTLY and skip the ENTIRE discovery
// stack (catalog pre-gate, LLM router, embedding discovery, pick gate). Mocks mirror
// syftSources.pregate.spec.ts; isSyftEndpointPath is the REAL pure validator (syftPrompts is not mocked).
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

const SOCIAL = "cantonal-social-services/cantonal-social-services-fsio-casework";
const MIGRATION = "cantonal-migration-office/state-secretariat-migration-public";

const doc = (slug: string, content: string, title = "") => ({ slug, content, title });

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
	Object.assign(h.router, { enabled: true, shadow: false, honorEmpty: false, maxEndpoints: 3 });
	h.searchQuery.mockResolvedValue({
		documents: [doc(SOCIAL, "Chronic Care Supplement eligibility text.", "Supplement rules")],
		retrievalInfo: [{ path: SOCIAL, status: "success" }],
	});
});

describe("querySyftSources — prompt-routed (forced endpoints)", () => {
	it("queries the attached data stores DIRECTLY and skips the whole discovery stack", async () => {
		const spans: TurnSpans = {};
		const out = await querySyftSources("any unconfigured text", spans, [SOCIAL, MIGRATION]);

		// The metered call went to EXACTLY the forced stores, in order.
		expect(h.searchQuery).toHaveBeenCalledTimes(1);
		expect(h.searchQuery.mock.calls[0][0].dataSources).toEqual([SOCIAL, MIGRATION]);

		// Nothing in the discovery stack ran: no pre-gate/pick-gate rerank, no router LLM, no hub.search.
		expect(h.rerankByRelevance).not.toHaveBeenCalled();
		expect(h.routeEndpoints).not.toHaveBeenCalled();
		expect(h.hubSearch).not.toHaveBeenCalled();
		expect(h.getSyftCatalog).not.toHaveBeenCalled();

		// The retrieved doc is mapped to a citable SyftHub source.
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ engine: "SyftHub", sourceName: SOCIAL });
		expect(out[0].snippet.length).toBeGreaterThan(0);
	});

	it("de-duplicates and drops invalid paths before the metered call", async () => {
		await querySyftSources("q", undefined, [SOCIAL, SOCIAL, "not-a-path", "too/many/slashes"]);
		expect(h.searchQuery.mock.calls[0][0].dataSources).toEqual([SOCIAL]);
	});

	it("honors SYFTHUB_SOURCE_BLOCKLIST on the forced path (never queries a blocklisted source)", async () => {
		h.config.sourceBlocklist = [SOCIAL.toLowerCase()];
		// Only the blocklisted source is forced ⇒ fail closed, no metered call.
		expect(await querySyftSources("q", undefined, [SOCIAL])).toEqual([]);
		expect(h.searchQuery).not.toHaveBeenCalled();
		// A mix ⇒ the blocklisted one is dropped, the other is still queried.
		await querySyftSources("q", undefined, [SOCIAL, MIGRATION]);
		expect(h.searchQuery.mock.calls[0][0].dataSources).toEqual([MIGRATION]);
	});

	it("drops docs from a source that reported a non-success retrieval status", async () => {
		h.searchQuery.mockResolvedValue({
			documents: [doc(SOCIAL, "should be dropped")],
			retrievalInfo: [{ path: SOCIAL, status: "access_denied" }],
		});
		expect(await querySyftSources("q", undefined, [SOCIAL])).toEqual([]);
	});

	it("forced mode with an all-invalid / empty list FAILS CLOSED — never rediscovers", async () => {
		// Once a caller opts into forced mode, an empty-after-validation list must
		// return [] rather than fall back to the discovery stack (which in prompt-only mode would fire
		// SyftHub on a non-matched turn).
		expect(await querySyftSources("q", undefined, [])).toEqual([]);
		expect(await querySyftSources("q", undefined, ["not-a-path"])).toEqual([]);
		expect(h.getSyftCatalog).not.toHaveBeenCalled();
		expect(h.hubSearch).not.toHaveBeenCalled();
		expect(h.searchQuery).not.toHaveBeenCalled();
	});

	it("with forcedEndpoints OMITTED (undefined), the ordinary discovery-driven path still runs", async () => {
		h.getSyftCatalog.mockResolvedValue({ entries: [], buildKey: "build-1" });
		h.rerankByRelevance.mockResolvedValue({ items: [], verified: false });
		h.hubSearch.mockResolvedValue([]);
		await querySyftSources("q"); // no 3rd arg ⇒ not opted into forced mode
		expect(h.hubSearch).toHaveBeenCalledTimes(1);
	});
});
